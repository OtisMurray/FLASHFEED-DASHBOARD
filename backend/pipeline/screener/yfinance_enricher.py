"""yfinance enricher: fetch live stock data for active tickers.

Fetches price, market cap, P/E ratio, and analyst recommendation from
Yahoo Finance via yfinance, and upserts into the ``finviz_screener``
MongoDB collection.  Designed to run after rolling windows computation
so only active (recently-mentioned) tickers are fetched.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone

from pymongo.collection import Collection

log = logging.getLogger(__name__)

# Analyst recommendation string → numeric scale (-1.0 to +1.0)
# Matches the Finviz normalization used by the dashboard.
ANALYST_MAP = {
    "strong_buy": 1.0,
    "buy": 0.5,
    "hold": 0.0,
    "underperform": -0.5,
    "sell": -1.0,
    "strong_sell": -1.0,
}


def fetch_ticker_data(ticker: str) -> dict | None:
    """Fetch fundamental data for a single ticker from Yahoo Finance.

    Returns a dict with price, market_cap, pe, analyst_recom,
    change_pct, volume, avg_volume, sector, industry, earnings_date,
    week_52_high, week_52_low, and structured_sentiment, or None
    if the ticker cannot be fetched.
    """
    import yfinance as yf

    try:
        t = yf.Ticker(ticker)
        info = t.info or {}
    except Exception:
        log.warning("yfinance lookup failed for %s", ticker, exc_info=True)
        return None

    if not info or info.get("quoteType") is None:
        log.debug("No yfinance data for %s", ticker)
        return None

    price = info.get("currentPrice") or info.get("regularMarketPrice")
    market_cap = info.get("marketCap")
    pe = info.get("trailingPE") or info.get("forwardPE")

    rec_key = info.get("recommendationKey", "")
    analyst_recom = ANALYST_MAP.get(rec_key)

    row: dict = {"ticker": ticker}

    if price is not None:
        row["price"] = float(price)
    if market_cap is not None:
        row["market_cap"] = float(market_cap)
    if pe is not None:
        row["pe"] = float(pe)
    if analyst_recom is not None:
        row["analyst_recom"] = analyst_recom
        row["structured_sentiment"] = analyst_recom

    # Additional Finviz-style fields
    change_pct = info.get("regularMarketChangePercent")
    if change_pct is not None:
        row["change_pct"] = round(float(change_pct), 4)

    volume = info.get("regularMarketVolume")
    if volume is not None:
        row["volume"] = int(volume)

    avg_volume = info.get("averageVolume") or info.get("averageDailyVolume10Day")
    if avg_volume is not None:
        row["avg_volume"] = int(avg_volume)

    sector = info.get("sector")
    if sector:
        row["sector"] = sector

    industry = info.get("industry")
    if industry:
        row["industry"] = industry

    week_52_high = info.get("fiftyTwoWeekHigh")
    if week_52_high is not None:
        row["week_52_high"] = float(week_52_high)

    week_52_low = info.get("fiftyTwoWeekLow")
    if week_52_low is not None:
        row["week_52_low"] = float(week_52_low)

    # Next earnings date from calendar
    earnings_date: str | None = None
    try:
        cal = t.calendar
        if cal is not None:
            ed_list = cal.get("Earnings Date")
            if ed_list:
                first = ed_list[0]
                earnings_date = first.isoformat() if hasattr(first, "isoformat") else str(first)
    except Exception:
        pass
    if earnings_date:
        row["earnings_date"] = earnings_date

    return row


def enrich_active_tickers(
    windows_coll: Collection,
    finviz_coll: Collection,
    max_age_hours: float = 1.0,
) -> int:
    """Fetch yfinance data for active tickers and upsert into *finviz_coll*.

    Skips tickers whose ``ingested_at`` is newer than *max_age_hours*.
    Returns the number of tickers enriched.
    """
    # Get distinct tickers from rolling windows
    tickers = windows_coll.distinct("ticker")
    if not tickers:
        log.info("No active tickers to enrich")
        return 0

    log.info("Found %d active ticker(s) for yfinance enrichment", len(tickers))

    # Filter out recently enriched tickers
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)
    recent = finviz_coll.find(
        {"ticker": {"$in": tickers}, "ingested_at": {"$gte": cutoff}},
        {"ticker": 1},
    )
    skip = {doc["ticker"] for doc in recent}
    to_fetch = [t for t in tickers if t not in skip]

    if not to_fetch:
        log.info("All %d ticker(s) already enriched within last %.0f hour(s)",
                 len(tickers), max_age_hours)
        return 0

    log.info("Fetching yfinance data for %d ticker(s) (skipping %d recent)",
             len(to_fetch), len(skip))

    now = datetime.now(timezone.utc)
    count = 0

    for symbol in to_fetch:
        data = fetch_ticker_data(symbol)
        if data is None:
            continue

        data["ingested_at"] = now

        finviz_coll.update_one(
            {"ticker": symbol},
            {"$set": data},
            upsert=True,
        )
        count += 1

        # Rate limit: 1 second between lookups
        time.sleep(1)

    log.info("Enriched %d/%d ticker(s) via yfinance", count, len(to_fetch))
    return count


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    """Enrich active tickers with yfinance data."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(name)-30s  %(levelname)-8s  %(message)s",
    )

    from scrapers.db import get_client
    from scrapers.config import MONGO_DB, ROLLING_WINDOWS_COLLECTION, FINVIZ_COLLECTION

    client = get_client()
    try:
        db = client[MONGO_DB]
        windows_coll = db[ROLLING_WINDOWS_COLLECTION]
        finviz_coll = db[FINVIZ_COLLECTION]

        count = enrich_active_tickers(windows_coll, finviz_coll)
        log.info("Done — %d ticker(s) enriched", count)
    finally:
        client.close()


if __name__ == "__main__":
    main()
