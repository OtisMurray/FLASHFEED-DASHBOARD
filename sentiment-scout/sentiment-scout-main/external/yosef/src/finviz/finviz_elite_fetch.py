from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

import pandas as pd
import requests
from pymongo import MongoClient


DEFAULT_BASE_DIR = Path(r"C:\Users\yosef\OneDrive\Desktop\Research Internship IST495")
DEFAULT_FINVIZ_DIR = DEFAULT_BASE_DIR / "finviz_daily"
DEFAULT_LATEST_CSV = DEFAULT_BASE_DIR / "export.csv"

DEFAULT_MONGO_URI = "mongodb://localhost:27017/"
DEFAULT_MONGO_DB = "ist495"
DEFAULT_MONGO_COLLECTION = "finviz_elite"


def ensure_dirs(path_obj: Path) -> None:
    path_obj.mkdir(parents=True, exist_ok=True)


def clean_column_name(col: str) -> str:
    return (
        str(col)
        .strip()
        .lower()
        .replace(" ", "_")
        .replace("/", "_")
        .replace("-", "_")
        .replace("%", "pct")
    )


def parse_numeric_series(series: pd.Series) -> pd.Series:
    return pd.to_numeric(
        series.astype(str).str.replace(",", "", regex=False).str.strip(),
        errors="coerce",
    )


def build_finviz_url_from_base_and_token(base_url: str, token: str) -> str:
    parsed = urlparse(base_url.strip())
    q = parse_qs(parsed.query, keep_blank_values=True)

    if token.strip():
        q["auth"] = [token.strip()]

    new_query = urlencode(q, doseq=True)
    rebuilt = parsed._replace(query=new_query)
    return urlunparse(rebuilt)


def fetch_finviz_csv_direct(final_url: str, latest_csv_path: Path) -> bytes:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/136.0.0.0 Safari/537.36"
        ),
        "Accept": "text/csv,application/octet-stream,text/plain,*/*",
        "Referer": "https://elite.finviz.com/",
    }

    response = requests.get(final_url, headers=headers, timeout=30)
    response.raise_for_status()

    with open(latest_csv_path, "wb") as f:
        f.write(response.content)

    content_type = response.headers.get("Content-Type", "").lower()
    content = response.content

    looks_like_csv = (
        "csv" in content_type
        or content.startswith(b"Ticker")
        or content.startswith(b"\xef\xbb\xbfTicker")
    )

    if not looks_like_csv:
        preview = content[:300].decode("utf-8", errors="ignore")
        raise ValueError(
            "Finviz returned HTML or non-CSV content instead of the export file.\n"
            f"Content-Type: {content_type}\n"
            f"Preview: {preview}\n"
            "This usually means the screener page loaded instead of a direct CSV export."
        )

    return content


def save_dated_copy(csv_bytes: bytes, finviz_dir: Path) -> Path:
    now = datetime.now()
    dated_name = f"finviz_{now:%Y_%m_%d}.csv"
    dated_path = finviz_dir / dated_name

    with open(dated_path, "wb") as f:
        f.write(csv_bytes)

    return dated_path


def load_and_clean_csv(csv_path: Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path, encoding="utf-8-sig")
    df.columns = [clean_column_name(c) for c in df.columns]

    rename_map = {
        "ticker": "stream_symbol",
        "rel_volume": "relative_volume",
        "change": "price_change",
    }
    df.rename(columns=rename_map, inplace=True)

    if "stream_symbol" in df.columns:
        df["stream_symbol"] = df["stream_symbol"].astype(str).str.strip().str.upper()

    if "price_change" in df.columns:
        df["price_change_num"] = (
            df["price_change"]
            .astype(str)
            .str.replace("%", "", regex=False)
            .str.replace(",", "", regex=False)
            .str.strip()
        )
        df["price_change_num"] = pd.to_numeric(df["price_change_num"], errors="coerce")

    if "relative_volume" in df.columns:
        df["relative_volume"] = parse_numeric_series(df["relative_volume"])

    if "volume" in df.columns:
        df["volume"] = parse_numeric_series(df["volume"])

    if "price" in df.columns:
        df["price"] = parse_numeric_series(df["price"])

    if "market_cap" in df.columns:
        df["market_cap_raw"] = df["market_cap"].astype(str)

    now_utc = datetime.utcnow()
    df["fetched_at_utc"] = now_utc
    df["fetch_date"] = now_utc.strftime("%Y-%m-%d")

    return df


def store_in_mongo(
    df: pd.DataFrame,
    mongo_uri: str = DEFAULT_MONGO_URI,
    mongo_db: str = DEFAULT_MONGO_DB,
    mongo_collection: str = DEFAULT_MONGO_COLLECTION,
) -> int:
    client = MongoClient(mongo_uri)
    db = client[mongo_db]
    col = db[mongo_collection]

    col.delete_many({})

    if df.empty:
        return 0

    records = df.where(pd.notnull(df), None).to_dict("records")
    col.insert_many(records)
    return len(records)


def fetch_and_store_finviz_from_inputs(
    screener_url: str,
    token: str,
    base_dir: str | Path = DEFAULT_BASE_DIR,
    mongo_uri: str = DEFAULT_MONGO_URI,
    mongo_db: str = DEFAULT_MONGO_DB,
    mongo_collection: str = DEFAULT_MONGO_COLLECTION,
) -> dict:
    """
    Main function for Streamlit Live Dashboard.

    User enters:
    - Finviz screener URL
    - Finviz token

    Function:
    - builds final URL
    - attempts direct CSV fetch
    - saves latest export.csv
    - saves dated CSV in finviz_daily
    - cleans CSV
    - stores latest Finviz snapshot in MongoDB
    """
    if not screener_url.strip():
        raise ValueError("Missing Finviz screener URL.")

    base_dir = Path(base_dir)
    finviz_dir = base_dir / "finviz_daily"
    latest_csv = base_dir / "export.csv"

    ensure_dirs(finviz_dir)
    ensure_dirs(latest_csv.parent)

    final_url = build_finviz_url_from_base_and_token(screener_url, token)
    csv_bytes = fetch_finviz_csv_direct(final_url, latest_csv)
    dated_path = save_dated_copy(csv_bytes, finviz_dir)

    df = load_and_clean_csv(latest_csv)
    inserted = store_in_mongo(
        df=df,
        mongo_uri=mongo_uri,
        mongo_db=mongo_db,
        mongo_collection=mongo_collection,
    )

    return {
        "success": True,
        "rows_loaded": len(df),
        "rows_inserted": inserted,
        "latest_csv": str(latest_csv),
        "dated_csv": str(dated_path),
        "final_url": final_url,
    }


def load_manual_finviz_csv_to_mongo(
    csv_path: str | Path,
    mongo_uri: str = DEFAULT_MONGO_URI,
    mongo_db: str = DEFAULT_MONGO_DB,
    mongo_collection: str = DEFAULT_MONGO_COLLECTION,
) -> dict:
    """
    Backup function for Streamlit:
    If Finviz direct URL returns HTML, user can manually export CSV,
    enter the file path in dashboard, and load it into Mongo.
    """
    csv_path = Path(csv_path)

    if not csv_path.exists():
        raise FileNotFoundError(f"CSV file not found: {csv_path}")

    df = load_and_clean_csv(csv_path)
    inserted = store_in_mongo(
        df=df,
        mongo_uri=mongo_uri,
        mongo_db=mongo_db,
        mongo_collection=mongo_collection,
    )

    return {
        "success": True,
        "rows_loaded": len(df),
        "rows_inserted": inserted,
        "manual_csv": str(csv_path),
    }


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Fetch/load Finviz screener data and store latest snapshot in MongoDB."
    )

    ap.add_argument("--screener_url", default="", help="Full Finviz screener URL copied by the client.")
    ap.add_argument("--token", default="", help="Finviz auth token supplied by the client.")
    ap.add_argument("--manual_csv", default="", help="Optional manual Finviz CSV path fallback.")

    ap.add_argument("--base_dir", default=str(DEFAULT_BASE_DIR), help="Base project directory.")
    ap.add_argument("--mongo_uri", default=DEFAULT_MONGO_URI, help="MongoDB URI")
    ap.add_argument("--mongo_db", default=DEFAULT_MONGO_DB, help="Mongo DB name")
    ap.add_argument("--mongo_collection", default=DEFAULT_MONGO_COLLECTION, help="Mongo collection name")

    args = ap.parse_args()

    try:
        if args.manual_csv.strip():
            result = load_manual_finviz_csv_to_mongo(
                csv_path=args.manual_csv,
                mongo_uri=args.mongo_uri,
                mongo_db=args.mongo_db,
                mongo_collection=args.mongo_collection,
            )
        else:
            result = fetch_and_store_finviz_from_inputs(
                screener_url=args.screener_url,
                token=args.token,
                base_dir=args.base_dir,
                mongo_uri=args.mongo_uri,
                mongo_db=args.mongo_db,
                mongo_collection=args.mongo_collection,
            )

        print("Finviz load complete.")
        for k, v in result.items():
            print(f"{k}: {v}")

    except Exception as e:
        print(f"Finviz fetch/load failed: {e}")
        print(
            "\nPossible reasons:\n"
            "- Finviz returned an HTML page instead of CSV\n"
            "- token expired\n"
            "- Finviz requires browser cookies/session in addition to auth\n"
            "- copied screener URL is a page view, not a true export endpoint\n"
            "- if this happens, manually export the CSV and use --manual_csv\n"
        )


if __name__ == "__main__":
    main()