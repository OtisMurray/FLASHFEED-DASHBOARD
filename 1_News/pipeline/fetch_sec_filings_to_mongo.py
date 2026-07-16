"""Fetch recent SEC EDGAR filings for the active dashboard universe.

The collector is intentionally capped and resumable. It targets active movers,
recent prediction candidates, and recently mentioned tickers instead of trying
to scan the entire SEC universe on every dashboard refresh.
"""

from __future__ import annotations

import hashlib
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from html import unescape
from typing import Any

from pymongo import MongoClient, UpdateOne

from sentiment_utils import sentiment_audit

try:
    from source_status import record_source_status
except Exception:
    def record_source_status(*_args, **_kwargs):
        return None

try:
    from curl_cffi import requests as http_requests
except Exception:
    import requests as http_requests


MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", os.getenv("MONGO_DB", "feedflash"))
SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
RECENT_DAYS = max(1, int(os.getenv("SEC_RECENT_DAYS", "7")))
ACTIVE_TICKER_LIMIT = max(1, int(os.getenv("SEC_ACTIVE_TICKER_LIMIT", "60")))
MAX_FILINGS_PER_TICKER = max(1, int(os.getenv("SEC_MAX_FILINGS_PER_TICKER", "4")))
MAX_WORKERS = max(1, min(8, int(os.getenv("SEC_MAX_WORKERS", "3"))))
REQUEST_TIMEOUT = max(3, int(os.getenv("SEC_REQUEST_TIMEOUT", "12")))
TICKER_COOLDOWN_SECONDS = max(0, int(os.getenv("SEC_TICKER_COOLDOWN_SECONDS", "300")))
MAX_CONTENT_CHARS = max(5_000, int(os.getenv("SEC_MAX_CONTENT_CHARS", "250000")))
MIN_CONTENT_CHARS = max(80, int(os.getenv("SEC_MIN_CONTENT_CHARS", "200")))
DEFAULT_FORMS = "8-K,10-Q,10-K,S-1,S-3,S-4,424B,425,4,144,13D,13G"
FORM_PREFIXES = tuple(
    form.strip().upper()
    for form in os.getenv("SEC_FORM_FILTER", DEFAULT_FORMS).split(",")
    if form.strip()
)
CONTACT_EMAIL = os.getenv("SEC_CONTACT_EMAIL", "otisemurray@icloud.com").strip()
USER_AGENT = os.getenv("SEC_USER_AGENT", f"FeedFlash/1.0 {CONTACT_EMAIL}").strip()
HEADERS = {
    "User-Agent": USER_AGENT,
    "From": CONTACT_EMAIL,
    "Accept": "application/json,text/html,application/xhtml+xml,text/plain,*/*",
}

_REQUEST_LOCK = threading.Lock()
_LAST_REQUEST_AT = 0.0
_MIN_REQUEST_GAP = float(os.getenv("SEC_MIN_REQUEST_GAP_SECONDS", "0.12"))


def _throttle() -> None:
    global _LAST_REQUEST_AT
    with _REQUEST_LOCK:
        elapsed = time.time() - _LAST_REQUEST_AT
        if elapsed < _MIN_REQUEST_GAP:
            time.sleep(_MIN_REQUEST_GAP - elapsed)
        _LAST_REQUEST_AT = time.time()


def _get(url: str):
    _throttle()
    return http_requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)


def _fetch_json(url: str) -> dict[str, Any]:
    response = _get(url)
    response.raise_for_status()
    return response.json()


def _fetch_text(url: str) -> str:
    response = _get(url)
    response.raise_for_status()
    return response.text


def _strip_html(raw: str) -> str:
    text = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", raw or "")
    text = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _parse_sec_time(value: str) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    normalized = raw.replace("Z", "+00:00")
    match = re.match(r"^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})(?:\.\d+)?(?:\+00:00)?$", normalized)
    if match:
        normalized = f"{match.group(1)}T{match.group(2)}:{match.group(3)}:{match.group(4)}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except Exception:
        try:
            return datetime.strptime(raw[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except Exception:
            return None


def _cik_padded(cik: Any) -> str:
    return re.sub(r"\D", "", str(cik or "")).zfill(10)


def _cik_plain(cik: Any) -> str:
    digits = re.sub(r"\D", "", str(cik or ""))
    return str(int(digits)) if digits else ""


def _accession_path(accession: str) -> str:
    return re.sub(r"[^0-9]", "", accession or "")


def _form_allowed(form_type: str) -> bool:
    form = str(form_type or "").upper().strip()
    return bool(form) and any(form == wanted or form.startswith(wanted) for wanted in FORM_PREFIXES)


def _impact_weight(form_type: str, content_status: str) -> float:
    if content_status != "content_extracted":
        return 0.02
    form = str(form_type or "").upper()
    if form == "8-K":
        return 0.75
    if form in {"10-Q", "10-K"}:
        return 0.35
    if form.startswith("S-") or form.startswith("F-") or form.startswith("424B"):
        return 0.42
    if form in {"4", "144"}:
        return 0.08
    if "13D" in form or "13G" in form:
        return 0.18
    if form == "425" or "14A" in form:
        return 0.25
    return 0.2


def _filing_title(ticker: str, form_type: str, accession: str, items: str, primary_doc: str) -> str:
    bits = [ticker, "SEC", form_type or "filing"]
    if items:
        bits.append(f"items {items}")
    bits.append(accession)
    if primary_doc:
        bits.append(primary_doc)
    return " ".join(str(bit) for bit in bits if bit)


def _load_active_tickers(db) -> list[str]:
    configured = [
        ticker.strip().upper()
        for ticker in os.getenv("SEC_TICKERS", "").split(",")
        if ticker.strip()
    ]
    if configured:
        return _dedupe_tickers(configured)[:ACTIVE_TICKER_LIMIT]

    candidates: list[str] = []
    try:
        projection = {"ticker": 1, "symbol": 1}
        rows = db.screeners.find(
            {"ticker": {"$exists": True, "$nin": ["", None], "$not": re.compile(r"\.")}},
            projection,
        ).sort([
            ("quote_updated_at", -1),
            ("finviz_seen_at", -1),
            ("change_pct", -1),
            ("change_percent", -1),
            ("rel_volume", -1),
            ("volume", -1),
        ]).limit(ACTIVE_TICKER_LIMIT * 3)
        candidates.extend(str(row.get("ticker") or row.get("symbol") or "") for row in rows)
    except Exception:
        pass

    try:
        rows = db.prediction_signals.find(
            {"ticker": {"$exists": True, "$nin": ["", None]}},
            {"ticker": 1},
        ).sort("signal_sec", -1).limit(ACTIVE_TICKER_LIMIT)
        candidates.extend(str(row.get("ticker") or "") for row in rows)
    except Exception:
        pass

    try:
        cutoff_sec = int((datetime.now(timezone.utc) - timedelta(days=RECENT_DAYS)).timestamp())
        rows = db.articles.aggregate([
            {"$match": {"publish_date": {"$gte": cutoff_sec}, "tickers": {"$exists": True, "$ne": []}}},
            {"$unwind": "$tickers"},
            {"$group": {"_id": "$tickers", "count": {"$sum": 1}}},
            {"$sort": {"count": -1}},
            {"$limit": ACTIVE_TICKER_LIMIT},
        ])
        candidates.extend(str(row.get("_id") or "") for row in rows)
    except Exception:
        pass

    return _dedupe_tickers(candidates)[:ACTIVE_TICKER_LIMIT]


def _dedupe_tickers(values: list[str]) -> list[str]:
    seen: set[str] = set()
    tickers: list[str] = []
    for value in values:
        ticker = str(value or "").upper().strip().replace("$", "")
        if ticker in seen:
            continue
        if not re.fullmatch(r"[A-Z][A-Z0-9]{0,5}", ticker):
            continue
        seen.add(ticker)
        tickers.append(ticker)
    return tickers


def _load_sec_ticker_map() -> dict[str, dict[str, Any]]:
    payload = _fetch_json(SEC_TICKERS_URL)
    output: dict[str, dict[str, Any]] = {}
    for row in (payload or {}).values():
        ticker = str(row.get("ticker") or "").upper()
        if ticker:
            output[ticker] = row
    return output


def _rows_from_submissions(recent: dict[str, list[Any]], cik: str) -> list[dict[str, Any]]:
    forms = recent.get("form") or []
    rows = []
    for index, form_type in enumerate(forms):
        accession = (recent.get("accessionNumber") or [None])[index]
        primary_doc = (recent.get("primaryDocument") or [None])[index]
        accepted_raw = (recent.get("acceptanceDateTime") or [None])[index]
        accepted_at = _parse_sec_time(accepted_raw)
        filing_date = (recent.get("filingDate") or [None])[index]
        if accepted_at is None:
            accepted_at = _parse_sec_time(filing_date)
        base = f"https://www.sec.gov/Archives/edgar/data/{_cik_plain(cik)}/{_accession_path(accession)}"
        rows.append({
            "formType": str(form_type or "").upper(),
            "accessionNumber": accession,
            "primaryDocument": primary_doc,
            "items": (recent.get("items") or [""])[index] if recent.get("items") else "",
            "filingDate": filing_date,
            "reportDate": (recent.get("reportDate") or [None])[index],
            "acceptedAt": accepted_at,
            "filingUrl": f"{base}/{accession}-index.html" if accession else None,
            "primaryDocumentUrl": f"{base}/{primary_doc}" if accession and primary_doc else None,
        })
    return rows


def _fetch_ticker_filings(ticker: str, meta: dict[str, Any]) -> dict[str, Any]:
    cik = _cik_padded(meta.get("cik_str"))
    submissions = _fetch_json(f"https://data.sec.gov/submissions/CIK{cik}.json")
    cutoff = datetime.now(timezone.utc) - timedelta(days=RECENT_DAYS)
    rows = [
        row for row in _rows_from_submissions(submissions.get("filings", {}).get("recent", {}), cik)
        if row["accessionNumber"] and _form_allowed(row["formType"]) and row["acceptedAt"] and row["acceptedAt"] >= cutoff
    ][:MAX_FILINGS_PER_TICKER]

    docs = []
    for row in rows:
        content_text = ""
        content_status = "missing_primary_document_url"
        content_char_length = 0
        if row.get("primaryDocumentUrl"):
            try:
                raw = _fetch_text(row["primaryDocumentUrl"])
                text = _strip_html(raw)
                content_char_length = len(text)
                content_status = "content_extracted" if content_char_length >= MIN_CONTENT_CHARS else "missing_or_weak"
                content_text = text[:MAX_CONTENT_CHARS] if content_status == "content_extracted" else ""
            except Exception as exc:
                content_status = f"fetch_failed:{str(exc)[:80]}"

        title = _filing_title(ticker, row["formType"], row["accessionNumber"], row.get("items") or "", row.get("primaryDocument") or "")
        audit = sentiment_audit(title, content_text[:6000])
        score = float(audit.get("score") or 0.0)
        impact_weight = _impact_weight(row["formType"], content_status)
        used_in_sentiment = bool(content_status == "content_extracted" and impact_weight >= 0.18)
        now = datetime.now(timezone.utc)
        accepted_at = row["acceptedAt"]
        docs.append({
            "article_id": f"sec:{ticker}:{row['accessionNumber']}",
            "ticker": ticker,
            "tickers": [ticker],
            "company": submissions.get("name") or meta.get("title") or "",
            "companyName": submissions.get("name") or meta.get("title") or "",
            "cik": cik,
            "title": title,
            "summary": content_text[:600] if content_text else title,
            "content": content_text[:6000],
            "contentText": content_text,
            "contentCharLength": content_char_length,
            "content_status": content_status,
            "filingContentStatus": content_status,
            "source": "SEC EDGAR",
            "source_type": "filing",
            "article_kind": "filings",
            "category": "filings",
            "event_type": "sec_filing",
            "event_score": audit.get("event_score", 0),
            "sentiment_reason": audit.get("event_reason", ""),
            "is_sec_filing": True,
            "isFiling": True,
            "accessionNumber": row["accessionNumber"],
            "formType": row["formType"],
            "filingDate": row["filingDate"],
            "reportDate": row["reportDate"],
            "acceptedAt": accepted_at,
            "fetchedAt": now,
            "publish_date": accepted_at,
            "fetched_date": now,
            "detected_at": now,
            "publish_time_trusted": True,
            "first_seen_at": now,
            "url": row["filingUrl"],
            "secUrl": row["filingUrl"],
            "primaryDocumentUrl": row["primaryDocumentUrl"],
            "primaryDocument": row["primaryDocument"],
            "filingItems": row.get("items") or "",
            "filingSentiment": score,
            "filingSentimentConfidence": min(0.75, abs(score) + 0.25) if used_in_sentiment else 0.05,
            "filingImpactWeight": impact_weight,
            "filingUsedInSentiment": used_in_sentiment,
            "filingUsedInPrediction": used_in_sentiment,
            "filingAgeHours": round((now - accepted_at).total_seconds() / 3600, 2),
            "sentiment": audit.get("label", "neutral"),
            "sentiment_score": score if used_in_sentiment else 0.0,
            "ml_confidence": min(0.75, abs(score) + 0.25) if used_in_sentiment else 0.05,
            "suppress_from_main_news": True,
            "feed_visibility": "filings",
            "stock_news_relevance": "sec_filing",
            "stock_news_filter_version": "sec_edgar_active_universe_v1",
            "updated_at": now,
        })
    return {"ticker": ticker, "cik": cik, "filings": docs}


def main() -> None:
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    db = client[DB_NAME]
    now = datetime.now(timezone.utc)
    tickers = _load_active_tickers(db)
    sec_map = _load_sec_ticker_map()
    matched = [ticker for ticker in tickers if ticker in sec_map]
    skipped_cooldown = 0
    fetch_targets = []

    for ticker in matched:
        state = db.source_fetch_state.find_one({"_id": f"sec_edgar:{ticker}"}, {"last_checked_at": 1})
        last_checked = state.get("last_checked_at") if state else None
        if isinstance(last_checked, datetime) and last_checked.tzinfo is None:
            last_checked = last_checked.replace(tzinfo=timezone.utc)
        if (
            TICKER_COOLDOWN_SECONDS
            and isinstance(last_checked, datetime)
            and (now - last_checked).total_seconds() < TICKER_COOLDOWN_SECONDS
        ):
            skipped_cooldown += 1
            continue
        fetch_targets.append(ticker)

    found = upserted = modified = failures = 0
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(_fetch_ticker_filings, ticker, sec_map[ticker]): ticker for ticker in fetch_targets}
        for future in as_completed(futures):
            ticker = futures[future]
            try:
                result = future.result()
                docs = result["filings"]
                found += len(docs)
                if docs:
                    bulk = [
                        UpdateOne(
                            {"source": "SEC EDGAR", "accessionNumber": doc["accessionNumber"], "ticker": doc["ticker"]},
                            {"$set": doc, "$setOnInsert": {"created_at": now}},
                            upsert=True,
                        )
                        for doc in docs
                    ]
                    write_result = db.articles.bulk_write(bulk, ordered=False)
                    upserted += write_result.upserted_count
                    modified += write_result.modified_count
                db.source_fetch_state.update_one(
                    {"_id": f"sec_edgar:{ticker}"},
                    {"$set": {"ticker": ticker, "last_checked_at": datetime.now(timezone.utc), "last_count": len(docs)}},
                    upsert=True,
                )
            except Exception as exc:
                failures += 1
                print(f"SEC EDGAR {ticker}: SKIP {exc}")

    db.articles.create_index([("source", 1), ("accessionNumber", 1), ("ticker", 1)], unique=False, background=True)
    db.articles.create_index([("category", 1), ("publish_date", -1)], background=True)
    status = "working" if found or upserted or modified or skipped_cooldown else "ready_no_rows_yet"
    record_source_status(
        db,
        "SEC EDGAR",
        status,
        detail=f"{found} filings found; {upserted} new; {modified} updated; {skipped_cooldown} skipped by cooldown; {failures} failures",
        count=found,
        source_type="filing",
    )
    print(
        "SEC EDGAR import complete — "
        f"{len(fetch_targets)} tickers fetched, {skipped_cooldown} cooldown, "
        f"{found} filings found, {upserted} new, {modified} updated, {failures} failed"
    )
    client.close()


if __name__ == "__main__":
    main()
