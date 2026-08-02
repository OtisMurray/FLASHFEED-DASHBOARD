#!/usr/bin/env python3
"""
Write live short-interest estimates into the short_interest_snapshots collection.

The screener's squeeze evidence already reads short_interest_snapshots -- it just
never had a producer, so every ticker fell back to Finviz's settlement figure,
which is up to a month stale by the end of a settlement cycle. This fills that
gap: FINRA's daily short-volume file layered on top of the last official figure.

Nothing downstream changes. verifiedShortInterest and the v11 evidence gate read
the same fields they always have; only the freshness of the number improves.
Every row carries its own provenance so a live estimate is always distinguishable
from a passed-through settlement figure.

Environment:
  SI_MAX_TICKERS         cap on tickers processed per run (default 3000)
  SI_CALIBRATION_PATH    override for config/si_calibration.json
  FINRA_MAX_WORKERS      parallel FINRA day downloads (default 6)
"""

from __future__ import annotations

import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from pymongo import MongoClient, UpdateOne

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "1_News" / "pipeline"))

import finra_short_volume as finra
import si_estimate as si

try:
    from source_status import record_source_status
except Exception:  # pragma: no cover - matches the other collectors' fallback
    def record_source_status(*_args, **_kwargs):
        return None

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", os.getenv("MONGO_DB", "feedflash"))
MONGO_TIMEOUT_MS = int(os.getenv("MONGO_SERVER_SELECTION_TIMEOUT_MS", "3000"))
MAX_TICKERS = int(os.getenv("SI_MAX_TICKERS", "3000"))
# Snapshots are dated in market time, matching the session date_key the screener
# reports; a UTC date would stamp an evening run with tomorrow's date.
MARKET_TIMEZONE = ZoneInfo(os.getenv("MARKET_WINDOW_TIMEZONE", "America/New_York"))

SOURCE_LIVE = "finra_daily_short_volume_estimate"
SOURCE_SETTLEMENT = "finviz_settlement_passthrough"
SOURCE_LABEL = "FINRA Daily Short Volume"


def _num(value):
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None


def load_screener_candidates(db) -> list[dict]:
    """Screener rows that carry the inputs an estimate needs."""
    cursor = db.screeners.find(
        {
            "ticker": {"$ne": None},
            "float_short": {"$ne": None},
            "shares_float": {"$gt": 0},
        },
        {
            "ticker": 1,
            "float_short": 1,
            "shares_float": 1,
            "short_ratio": 1,
            "short_interest": 1,
            "rel_volume": 1,
            "avg_volume": 1,
            "_id": 0,
        },
    ).limit(max(1, MAX_TICKERS))
    rows = []
    for doc in cursor:
        ticker = str(doc.get("ticker") or "").upper()
        if ticker:
            rows.append({**doc, "ticker": ticker})
    return rows


def build_snapshot_doc(row: dict, estimate, *, settlement_ymd: str, now: datetime) -> dict:
    """One short_interest_snapshots document.

    The first block is the contract the screener already reads. The si_* block is
    additive provenance so a live estimate is never mistaken for a settlement
    figure -- and so an uncalibrated estimate is never mistaken for a fitted one.
    """
    ticker = row["ticker"]
    official = _num(row.get("float_short"))
    days_to_cover = _num(row.get("short_ratio"))
    float_shares = _num(row.get("shares_float"))
    live = estimate is not None

    pct = estimate.estimated_pct if live else official
    shares = None
    if pct is not None and float_shares:
        shares = int(round(pct / 100.0 * float_shares))

    doc = {
        # ---- fields the existing screener evidence path already consumes ----
        "ticker": ticker,
        "as_of_date": now.astimezone(MARKET_TIMEZONE).strftime("%Y-%m-%d"),
        "fetched_sec": int(now.timestamp()),
        "fetched_at": now,
        "short_interest_pct": pct,
        "short_interest_pct_float": pct,
        "short_interest_shares": shares,
        "days_to_cover": days_to_cover,
        "source": SOURCE_LIVE if live else SOURCE_SETTLEMENT,

        # ---- additive provenance: which number is this, and how good is it ----
        "si_data_mode": "live_estimated" if live else "settlement_only",
        "si_official_pct": official,
        "si_settlement_date": settlement_ymd,
        "si_float_shares": float_shares,
    }

    if live:
        doc.update({
            "si_estimated_pct": estimate.estimated_pct,
            "si_delta_pct": estimate.delta_pct,
            "si_k": estimate.k,
            "si_calibration_status": estimate.calibration_status,
            "si_uncalibrated": estimate.calibration_status != si.CALIBRATION_STATUS_CALIBRATED,
            "si_baseline_svr": estimate.baseline_svr,
            "si_baseline_is_ticker_specific": estimate.baseline_is_ticker_specific,
            "si_observed_days": estimate.observed_days,
            "si_sanity_band_clamped": estimate.clamped,
            "si_borrow_multiplier": estimate.borrow_multiplier,
            "si_estimate_note": (
                "FINRA daily short volume layered on the "
                f"{settlement_ymd} settlement figure; k={estimate.k} "
                f"({estimate.calibration_status})"
            ),
        })
    else:
        doc.update({
            "si_uncalibrated": None,
            "si_estimate_note": (
                "no FINRA daily coverage since settlement; passing through the "
                "official settlement figure unchanged"
            ),
        })

    return doc


def ensure_indexes(collection) -> None:
    try:
        collection.create_index([("ticker", 1), ("as_of_date", -1)])
        collection.create_index([("fetched_sec", -1)])
    except Exception:
        pass


def main() -> None:
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=MONGO_TIMEOUT_MS)
    db = client[DB_NAME]

    # An UNPARSEABLE calibration file is an operational fault, not something to
    # paper over: fail before writing anything rather than emit fitted-looking rows.
    # Individual unusable constants inside a well-formed file are handled below --
    # those degrade the affected lookups and keep the feed alive.
    try:
        calibration, calibration_status = si.load_calibration()
    except si.CalibrationError as exc:
        message = f"calibration file invalid: {exc}"
        print(f"SI estimate ERROR — {message}", file=sys.stderr)
        record_source_status(
            db, SOURCE_LABEL, "error", detail=message, count=0, source_type="short_interest"
        )
        client.close()
        raise SystemExit(1)

    if calibration_status == si.CALIBRATION_STATUS_UNCALIBRATED:
        print(
            "SI estimate WARNING — no calibration file; using documented fallback "
            f"k={si.UNCALIBRATED_K}. Every row is stamped si_uncalibrated=true.",
            file=sys.stderr,
        )
    elif calibration_status == si.CALIBRATION_STATUS_REJECTED:
        print(
            "SI estimate WARNING — a calibration file was found but nothing in it is "
            f"usable; falling back to k={si.UNCALIBRATED_K}. Every row is stamped "
            "si_uncalibrated=true.",
            file=sys.stderr,
        )

    # Partial degradation is the dangerous case: the run still reports "calibrated"
    # while some lookups quietly use a different constant. Say exactly what was
    # dropped, every run, rather than leaving it to be inferred from the numbers.
    calibration_rejections = list(getattr(calibration, "rejected", ()) or ())
    for reason in calibration_rejections:
        print(f"SI estimate WARNING — calibration: {reason}", file=sys.stderr)

    candidates = load_screener_candidates(db)
    if not candidates:
        record_source_status(
            db, SOURCE_LABEL, "error",
            detail="no screener rows carried float_short + shares_float",
            count=0, source_type="short_interest",
        )
        print("SI estimate — no eligible screener rows")
        client.close()
        return

    today = date.today()
    settlement = finra.latest_published_settlement(today)
    settlement_ymd = settlement.strftime("%Y-%m-%d")

    since_days = finra.trading_days_between(settlement, today)
    baseline_days = finra.trading_days_between(
        settlement - timedelta(days=finra.BASELINE_WINDOW_DAYS),
        settlement + timedelta(days=1),
    )

    since_files = finra.load_days(db, since_days)
    baseline_files = finra.load_days(db, baseline_days)

    now = datetime.now(timezone.utc)
    operations: list[UpdateOne] = []
    live_count = 0
    clamped_count = 0

    for row in candidates:
        ticker = row["ticker"]
        since_rows = finra.series_for(since_files, ticker)
        baseline_rows = finra.series_for(baseline_files, ticker)

        estimate = None
        if since_rows:
            estimate = si.estimate_si_pct(
                official_pct=row.get("float_short"),
                float_shares=row.get("shares_float"),
                since_settlement_rows=since_rows,
                baseline_rows=baseline_rows,
                rel_volume=row.get("rel_volume"),
                avg_volume_shares=row.get("avg_volume"),
                calibration=calibration,
                calibration_status=calibration_status,
                borrow_multiplier=1.0,  # IBKR borrow pressure is out of scope
            )

        if estimate is not None:
            live_count += 1
            if estimate.clamped:
                clamped_count += 1

        doc = build_snapshot_doc(row, estimate, settlement_ymd=settlement_ymd, now=now)
        operations.append(
            UpdateOne(
                {"ticker": ticker, "as_of_date": doc["as_of_date"]},
                {"$set": doc},
                upsert=True,
            )
        )

    collection = db.short_interest_snapshots
    ensure_indexes(collection)

    written = 0
    if operations:
        result = collection.bulk_write(operations, ordered=False)
        written = (result.upserted_count or 0) + (result.modified_count or 0)

    calibrated = calibration_status == si.CALIBRATION_STATUS_CALIBRATED
    status = "working" if live_count else "working_public" if operations else "error"
    detail = "; ".join(part for part in [
        f"settlement={settlement_ymd}",
        f"finra_days_since_settlement={len(since_files)}",
        f"baseline_days={len(baseline_files)}",
        f"live_estimated={live_count}/{len(candidates)}",
        f"sanity_band_clamped={clamped_count}",
        "UNCALIBRATED (fallback k=%s)" % si.UNCALIBRATED_K if not calibrated else "calibrated",
        # A partially-degraded calibration still reports "calibrated"; without this
        # the status row would not show that some lookups used a different constant.
        f"calibration_rejections={len(calibration_rejections)}" if calibration_rejections else "",
    ] if part)

    record_source_status(
        db, SOURCE_LABEL, status,
        detail=detail,
        count=len(operations),
        source_type="short_interest",
        metrics={
            "records_received": len(candidates),
            "records_accepted": len(operations),
            "live_estimated": live_count,
            "sanity_band_clamped": clamped_count,
            "finra_days_loaded": len(since_files),
            "calibrated": calibrated,
            "calibration_status": calibration_status,
            "calibration_rejections": calibration_rejections,
        },
    )

    print(
        f"SI estimate — {written} snapshots written, {live_count} live-estimated, "
        f"{len(candidates) - live_count} settlement-only, settlement {settlement_ymd}, "
        f"{len(since_files)} FINRA days since, calibrated={calibrated}"
    )
    client.close()


if __name__ == "__main__":
    main()
