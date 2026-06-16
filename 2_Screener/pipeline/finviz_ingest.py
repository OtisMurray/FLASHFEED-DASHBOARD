"""D7: Finviz CSV Ingestion.

Parses Finviz screener CSV exports, normalizes column names to snake_case,
converts Market Cap (B/M/K suffixes), Change (%), and Analyst Recom.
(1.0–5.0 → -1.0 to +1.0), and upserts into MongoDB by ticker.
"""

from __future__ import annotations

import csv
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

from pymongo.collection import Collection

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Column name normalization
# ---------------------------------------------------------------------------

def normalize_column_name(name: str) -> str:
    """Convert a Finviz column header to snake_case.

    Examples: ``"Market Cap"`` → ``"market_cap"``,
    ``"Analyst Recom."`` → ``"analyst_recom"``,
    ``"P/E"`` → ``"p_e"``.
    """
    s = name.strip().lower()
    s = re.sub(r"[./]", "_", s)
    s = re.sub(r"[^a-z0-9_]", "_", s)
    s = re.sub(r"_+", "_", s)
    return s.strip("_")


# ---------------------------------------------------------------------------
# Value parsers
# ---------------------------------------------------------------------------

def parse_market_cap(value: str) -> float | None:
    """Parse a Finviz Market Cap string like ``"1.5B"`` into a float.

    Supports B (billions), M (millions), K (thousands).
    Returns ``None`` for ``"-"`` or empty values.
    """
    if not value or value.strip() in ("-", ""):
        return None

    value = value.strip()
    multipliers = {"B": 1_000_000_000, "M": 1_000_000, "K": 1_000}

    suffix = value[-1].upper()
    if suffix in multipliers:
        try:
            return float(value[:-1]) * multipliers[suffix]
        except ValueError:
            return None

    try:
        return float(value)
    except ValueError:
        return None


def parse_percentage(value: str) -> float | None:
    """Parse a percentage string like ``"5.23%"`` or ``"-2.10%"``.

    Returns the numeric value (e.g. ``5.23``).
    Returns ``None`` for ``"-"`` or empty values.
    """
    if not value or value.strip() in ("-", ""):
        return None

    value = value.strip().rstrip("%")
    try:
        return float(value)
    except ValueError:
        return None


def normalize_analyst_recom(value: float | str) -> float:
    """Normalize Finviz Analyst Recom. (1.0–5.0) to [-1.0, +1.0].

    Formula: ``(3.0 - value) / 2.0``
    - 1.0 (Strong Buy) → +1.0
    - 3.0 (Hold)       →  0.0
    - 5.0 (Sell)       → -1.0
    """
    v = float(value)
    return (3.0 - v) / 2.0


# ---------------------------------------------------------------------------
# CSV parsing
# ---------------------------------------------------------------------------

# Columns that contain percentage values
_PCT_COLUMNS = frozenset({
    "change", "dividend_yield", "short_float", "short_ratio",
    "perf_week", "perf_month", "perf_quarter", "perf_half_y",
    "perf_year", "perf_ytd", "volatility_w", "volatility_m",
    "sma20", "sma50", "sma200", "52w_high", "52w_low",
    "from_open", "gap", "recom", "insider_own", "inst_own",
    "insider_trans", "inst_trans", "roa", "roe", "roi",
    "gross_margin", "oper_margin", "profit_margin", "payout",
})


def parse_finviz_csv(filepath: str | Path) -> list[dict]:
    """Parse a Finviz CSV export into a list of normalized dicts.

    Raises ``ValueError`` if the CSV has no ``Ticker`` column.
    """
    filepath = Path(filepath)
    rows: list[dict] = []

    with open(filepath, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)

        if reader.fieldnames is None:
            raise ValueError("Empty CSV file")

        # Check for Ticker column (case-insensitive)
        raw_headers = list(reader.fieldnames)
        has_ticker = any(h.strip().lower() == "ticker" for h in raw_headers)
        if not has_ticker:
            raise ValueError("CSV must contain a 'Ticker' column")

        # Build header mapping
        header_map = {h: normalize_column_name(h) for h in raw_headers}

        for raw_row in reader:
            row: dict = {}
            for raw_key, norm_key in header_map.items():
                val = raw_row.get(raw_key, "")
                if val is None:
                    val = ""
                val = val.strip()

                # Special column handling
                if norm_key == "market_cap":
                    row[norm_key] = parse_market_cap(val)
                elif norm_key == "analyst_recom":
                    if val and val != "-":
                        row[norm_key] = normalize_analyst_recom(val)
                        row["structured_sentiment"] = row[norm_key]
                    else:
                        row[norm_key] = None
                        row["structured_sentiment"] = None
                elif norm_key in _PCT_COLUMNS:
                    row[norm_key] = parse_percentage(val)
                else:
                    row[norm_key] = val

            # Ensure ticker is uppercase
            if "ticker" in row and row["ticker"]:
                row["ticker"] = row["ticker"].upper()

            rows.append(row)

    return rows


# ---------------------------------------------------------------------------
# Ingestion
# ---------------------------------------------------------------------------

def ingest_finviz_data(filepath: str | Path, collection: Collection) -> int:
    """Parse *filepath* and upsert rows into *collection* by ticker.

    Returns the number of tickers upserted.
    """
    rows = parse_finviz_csv(filepath)

    if not rows:
        log.info("No rows parsed from %s", filepath)
        return 0

    count = 0
    now = datetime.now(timezone.utc)

    for row in rows:
        ticker = row.get("ticker")
        if not ticker:
            continue

        row["ingested_at"] = now

        collection.update_one(
            {"ticker": ticker},
            {"$set": row},
            upsert=True,
        )
        count += 1

    log.info("Upserted %d ticker(s) from %s", count, filepath)
    return count


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    """Ingest a Finviz CSV export into MongoDB."""
    import sys

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(name)-30s  %(levelname)-8s  %(message)s",
    )

    if len(sys.argv) < 2:
        print("Usage: finviz-ingest <path/to/finviz_export.csv>")
        sys.exit(1)

    filepath = sys.argv[1]

    from scrapers.db import get_client
    from scrapers.config import MONGO_DB, FINVIZ_COLLECTION

    client = get_client()
    try:
        collection = client[MONGO_DB][FINVIZ_COLLECTION]

        count = ingest_finviz_data(filepath, collection)
        log.info("Done — %d ticker(s) ingested", count)
    finally:
        client.close()


if __name__ == "__main__":
    main()
