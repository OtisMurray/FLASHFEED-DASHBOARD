"""
scrapers/ib_news.py — Interactive Brokers news feed scraper.

Connects to a locally-running TWS or IB Gateway instance via ib_insync,
fetches recent news headlines for active tickers, and upserts them into the
shared MongoDB posts collection so the rest of the pipeline (ticker extraction,
dedup, sentiment scoring, rolling windows) picks them up automatically.

Prerequisites:
  1. TWS or IB Gateway must be running locally.
  2. Enable API access in TWS: Edit → Global Configuration → API → Settings
       ✓ Enable ActiveX and Socket Clients
       Port: 7497 (paper) or 7496 (live)
       ✓ Trusted IPs includes 127.0.0.1
  3. IB_ENABLED=true in your .env

Run standalone:
    IB_ENABLED=true python -m scrapers.ib_news

Integrated (via run_pipeline.py --scrape):
    IB_ENABLED=true python scripts/run_pipeline.py --once --scrape
"""

from __future__ import annotations

import hashlib
import logging
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from pymongo.collection import Collection

from scrapers.config import (
    IB_CLIENT_ID,
    IB_ENABLED,
    IB_FETCH_ARTICLE_BODY,
    IB_HEADLINES_PER_TICKER,
    IB_HOST,
    IB_LOOKBACK_HOURS,
    IB_MAX_TICKERS,
    IB_PORT,
    IB_REQUEST_DELAY,
    IB_TICKERS_FALLBACK,
    REDIS_URL,
)
from scrapers.db import upsert_posts

log = logging.getLogger(__name__)

# UTC timezone constant
_UTC = timezone.utc

# IB returns abbreviated US timezone names — map to UTC offsets
_TZ_OFFSETS: dict[str, int] = {
    "EST": -5, "EDT": -4,
    "CST": -6, "CDT": -5,
    "MST": -7, "MDT": -6,
    "PST": -8, "PDT": -7,
    "UTC": 0,  "GMT": 0,
}

# Fallback provider codes known to be available on most IB accounts
_DEFAULT_PROVIDERS = "BRFG+DJNL+BRFUPDN"


# ---------------------------------------------------------------------------
# Custom exception
# ---------------------------------------------------------------------------

class IBConnectionError(Exception):
    """Raised when TWS/Gateway is unreachable or connection is refused."""


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _parse_ib_time(time_str: str) -> datetime:
    """
    Parse IB's 'YYYYMMDD HH:MM:SS TZ' format into a UTC-aware datetime.
    Example: '20250411 09:23:15 EST' → datetime(2025, 4, 11, 14, 23, 15, tzinfo=UTC)
    Falls back to datetime.now(UTC) on any parse error.
    """
    try:
        parts = time_str.strip().split()
        # Parts: ['20250411', '09:23:15', 'EST']  or  ['20250411', '09:23:15']
        date_part = parts[0]   # YYYYMMDD
        time_part = parts[1]   # HH:MM:SS
        tz_abbr   = parts[2].upper() if len(parts) > 2 else "EST"

        year  = int(date_part[0:4])
        month = int(date_part[4:6])
        day   = int(date_part[6:8])

        h, m, s = (int(x) for x in time_part.split(":"))

        offset_hours = _TZ_OFFSETS.get(tz_abbr, -5)   # default to EST if unknown
        naive_dt     = datetime(year, month, day, h, m, s)
        return naive_dt.replace(tzinfo=_UTC) - timedelta(hours=offset_hours)
    except Exception:
        log.debug("Could not parse IB time string %r — using now(UTC)", time_str)
        return datetime.now(_UTC)


def _content_hash(title: str, text: str) -> str:
    """SHA-256(title + '\\x00' + text) — matches the hash formula used by all other scrapers."""
    return hashlib.sha256((title + "\x00" + text).encode()).hexdigest()


# ---------------------------------------------------------------------------
# TWS connection
# ---------------------------------------------------------------------------

def connect_tws(
    host: str = IB_HOST,
    port: int = IB_PORT,
    client_id: int = IB_CLIENT_ID,
    timeout: float = 5.0,
) -> Any:
    """
    Connect to TWS/Gateway. Returns a connected ib_insync.IB object.
    Raises IBConnectionError if the connection cannot be established.

    timeout controls how long ib_insync waits before giving up — keeping it
    short prevents the pipeline from blocking for a long time in CI.
    """
    try:
        from ib_insync import IB  # lazy import: don't crash if not installed
    except ImportError as exc:
        raise IBConnectionError("ib_insync is not installed — run: pip install ib_insync") from exc

    ib = IB()
    try:
        ib.connect(host, port, clientId=client_id, timeout=timeout)
    except Exception as exc:
        raise IBConnectionError(
            f"Cannot connect to TWS/Gateway at {host}:{port} (clientId={client_id}): {exc}"
        ) from exc

    log.info("Connected to IB TWS/Gateway at %s:%d (clientId=%d)", host, port, client_id)
    return ib


# ---------------------------------------------------------------------------
# Ticker resolution
# ---------------------------------------------------------------------------

def get_tickers(
    redis_client: Any | None,
    fallback: list[str] | None = None,
    max_tickers: int = IB_MAX_TICKERS,
) -> list[str]:
    """
    Return the list of tickers to fetch news for.

    Primary:  top `max_tickers` by score from Redis sorted set 'active_tickers'
              (written by the rolling-windows stage every cycle).
    Fallback: IB_TICKERS_FALLBACK config list (used when Redis is unavailable
              or the set is empty, e.g. on first run).
    """
    if redis_client is not None:
        try:
            raw = redis_client.zrevrange("active_tickers", 0, max_tickers - 1)
            if raw:
                tickers = [t.decode() if isinstance(t, bytes) else t for t in raw]
                log.info("IB news: using %d active tickers from Redis", len(tickers))
                return tickers
        except Exception:
            log.debug("Could not read active_tickers from Redis — using fallback", exc_info=True)

    tickers = (fallback or IB_TICKERS_FALLBACK)[:max_tickers]
    log.info("IB news: using %d fallback tickers (Redis unavailable or empty)", len(tickers))
    return tickers


def resolve_contracts(ib: Any, tickers: list[str]) -> dict[str, int]:
    """
    Resolve ticker symbols to IB contract IDs (conId) in a single batch call.
    Returns {ticker: conId} for successfully resolved contracts only.
    Tickers IB does not recognise are silently dropped.
    """
    try:
        from ib_insync import Stock
    except ImportError:
        return {}

    contracts = [Stock(ticker, "SMART", "USD") for ticker in tickers]
    try:
        qualified = ib.qualifyContracts(*contracts)
    except Exception:
        log.warning("IB qualifyContracts failed", exc_info=True)
        return {}

    result: dict[str, int] = {}
    for contract in qualified:
        if contract.conId:
            result[contract.symbol] = contract.conId

    skipped = len(tickers) - len(result)
    if skipped:
        log.debug("IB contract resolution: %d resolved, %d not found", len(result), skipped)
    return result


# ---------------------------------------------------------------------------
# News fetching
# ---------------------------------------------------------------------------

def get_provider_codes(ib: Any) -> str:
    """
    Query IB for available news providers and return them as a '+'-joined string.
    Falls back to a hardcoded default if the API call fails.
    """
    try:
        providers = ib.reqNewsProviders()
        if providers:
            codes = "+".join(p.code for p in providers)
            log.info("IB news providers available: %s", codes)
            return codes
    except Exception:
        log.debug("reqNewsProviders failed — using default provider codes", exc_info=True)

    log.info("IB news: using default provider codes: %s", _DEFAULT_PROVIDERS)
    return _DEFAULT_PROVIDERS


def fetch_headlines(
    ib: Any,
    con_id: int,
    provider_codes: str,
    since_dt: datetime,
    max_results: int = IB_HEADLINES_PER_TICKER,
) -> list[Any]:
    """
    Fetch up to `max_results` recent headlines for the given conId.
    Client-side filters to only return articles published after `since_dt`.
    """
    try:
        raw = ib.reqHistoricalNews(
            conId=con_id,
            providerCodes=provider_codes,
            startDateTime="",
            endDateTime="",
            totalResults=max_results,
        )
    except Exception:
        log.debug("reqHistoricalNews failed for conId=%d", con_id, exc_info=True)
        return []

    filtered = []
    for article in raw:
        pub_dt = _parse_ib_time(article.time)
        if pub_dt >= since_dt:
            filtered.append(article)

    return filtered


def fetch_article_body(ib: Any, provider_code: str, article_id: str) -> str:
    """
    Fetch the full article text via reqNewsArticle.
    Returns an empty string on any failure so callers can proceed without body.
    Only called when IB_FETCH_ARTICLE_BODY=True.
    """
    try:
        article = ib.reqNewsArticle(providerCode=provider_code, articleId=article_id)
        return article.articleText or ""
    except Exception:
        log.debug("reqNewsArticle failed for %s/%s", provider_code, article_id, exc_info=True)
        return ""


# ---------------------------------------------------------------------------
# Normalisation
# ---------------------------------------------------------------------------

def normalize_headline(
    headline: Any,
    ticker: str,
    article_text: str = "",
) -> dict:
    """
    Map an ib_insync NewsArticle headline to the shared MongoDB post schema.

    Field mapping:
      id               → "ib_news:{headline.articleId}"   (globally unique per article)
      source           → "ib_news"
      subreddit        → ""
      author           → headline.providerCode            (e.g. "BRFG", "DJNL")
      title            → headline.headline
      text             → article_text (body, or "" if not fetched)
      url              → ""  (IB does not expose public URLs)
      score            → 0
      num_comments     → 0
      published_at     → parsed UTC datetime from headline.time
      detected_at      → now(UTC)
      content_hash     → SHA-256(title + "\\x00" + text)
      tickers_mentioned→ [ticker]  (pre-populated, skips Stage 1 ticker extraction)
    """
    title = headline.headline or ""
    text  = article_text or ""

    return {
        "id":               f"ib_news:{headline.articleId}",
        "source":           "ib_news",
        "subreddit":        "",
        "author":           headline.providerCode or "",
        "title":            title,
        "text":             text,
        "url":              "",
        "score":            0,
        "num_comments":     0,
        "published_at":     _parse_ib_time(headline.time),
        "detected_at":      datetime.now(_UTC),
        "content_hash":     _content_hash(title, text),
        "tickers_mentioned": [ticker.upper()],
    }


# ---------------------------------------------------------------------------
# Main scrape cycle
# ---------------------------------------------------------------------------

def scrape_cycle(
    collection: Collection,
    redis_client: Any | None = None,
) -> int:
    """
    Execute one full IB news scrape pass.

    1. Connect to TWS (raises IBConnectionError if unreachable — caller handles)
    2. Resolve active tickers from Redis (or fallback list)
    3. Resolve IB contract IDs for those tickers
    4. Fetch recent headlines per ticker
    5. Optionally fetch article bodies
    6. Upsert to MongoDB (existing articles silently skipped via unique index on 'id')

    Returns the number of newly inserted posts.
    """
    ib = connect_tws()  # raises IBConnectionError if TWS is unreachable

    try:
        tickers = get_tickers(redis_client)
        if not tickers:
            log.info("IB news: no tickers to fetch — skipping cycle")
            return 0

        con_id_map     = resolve_contracts(ib, tickers)
        provider_codes = get_provider_codes(ib)
        since_dt       = datetime.now(_UTC) - timedelta(hours=IB_LOOKBACK_HOURS)
        total_inserted = 0

        log.info(
            "IB news: fetching for %d/%d resolved tickers since %s",
            len(con_id_map), len(tickers),
            since_dt.strftime("%Y-%m-%d %H:%M UTC"),
        )

        for ticker, con_id in con_id_map.items():
            try:
                raw_headlines = fetch_headlines(
                    ib, con_id, provider_codes, since_dt,
                    max_results=IB_HEADLINES_PER_TICKER,
                )

                posts: list[dict] = []
                for h in raw_headlines:
                    body = ""
                    if IB_FETCH_ARTICLE_BODY:
                        body = fetch_article_body(ib, h.providerCode, h.articleId)
                        time.sleep(IB_REQUEST_DELAY)
                    posts.append(normalize_headline(h, ticker, body))

                if posts:
                    inserted = upsert_posts(collection, posts)
                    total_inserted += inserted
                    log.info(
                        "IB news [%s]: %d headlines fetched, %d new",
                        ticker, len(posts), inserted,
                    )
                else:
                    log.debug("IB news [%s]: no headlines in window", ticker)

            except Exception:
                log.warning("IB news [%s]: error fetching headlines — skipping", ticker, exc_info=True)

            time.sleep(IB_REQUEST_DELAY)  # 1 req/sec between tickers to respect IB rate limits

        log.info("IB news cycle complete — %d new posts across %d tickers", total_inserted, len(con_id_map))
        return total_inserted

    finally:
        ib.disconnect()
        log.debug("Disconnected from IB TWS/Gateway")


# ---------------------------------------------------------------------------
# Standalone entry point
# ---------------------------------------------------------------------------

def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    if not IB_ENABLED:
        log.info(
            "IB_ENABLED=false — set IB_ENABLED=true in your .env to run this scraper. "
            "Requires TWS or IB Gateway running on %s:%d",
            IB_HOST, IB_PORT,
        )
        sys.exit(0)

    from scrapers.db import get_client, get_collection

    redis_client = None
    if REDIS_URL:
        try:
            from processing.redis_cache import get_redis_client
            redis_client = get_redis_client(REDIS_URL)
        except Exception:
            log.warning("Redis unavailable — will use fallback ticker list", exc_info=True)

    mongo_client = get_client()
    try:
        collection = get_collection(mongo_client)
        try:
            count = scrape_cycle(collection, redis_client)
            log.info("Done — %d new IB news posts inserted", count)
        except IBConnectionError as exc:
            log.error(
                "TWS/Gateway not reachable: %s\n"
                "Make sure TWS is running and API access is enabled:\n"
                "  Edit → Global Configuration → API → Settings\n"
                "  ✓ Enable ActiveX and Socket Clients\n"
                "  Port: %d (paper=7497, live=7496, gateway-paper=4002, gateway-live=4001)",
                exc, IB_PORT,
            )
            sys.exit(1)
    finally:
        mongo_client.close()
        if redis_client:
            try:
                redis_client.close()
            except Exception:
                pass


if __name__ == "__main__":
    main()
