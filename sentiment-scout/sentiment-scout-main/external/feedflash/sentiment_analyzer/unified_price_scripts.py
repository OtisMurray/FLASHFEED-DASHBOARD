"""
unified_price_scripts.py
Robust price loader with Rate Limit protection.
"""

import os
import time
import random
import logging
from datetime import datetime, timedelta
import pandas as pd
import yfinance as yf

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("UnifiedPrices")

# Where we cache price data on disk
DEFAULT_CACHE_DIR = "price_data_cache"

def _ensure_cache_dir(cache_dir: str = DEFAULT_CACHE_DIR) -> str:
    if not os.path.isdir(cache_dir):
        os.makedirs(cache_dir, exist_ok=True)
    return cache_dir

def _build_cache_path(ticker: str, start_date: str, end_date: str, interval: str, cache_dir: str = DEFAULT_CACHE_DIR) -> str:
    _ensure_cache_dir(cache_dir)
    safe_ticker = ticker.replace("/", "_").upper()
    fname = f"{safe_ticker}_{interval}_{start_date}_{end_date}.csv"
    return os.path.join(cache_dir, fname)

def _is_cache_fresh(cache_path: str, max_age_hours: int = 6) -> bool:
    if not os.path.isfile(cache_path):
        return False
    mtime = datetime.fromtimestamp(os.path.getmtime(cache_path))
    age = datetime.now() - mtime
    return age.total_seconds() < max_age_hours * 3600

def get_price_history(
    ticker: str,
    start_date: str,
    end_date: str,
    interval: str = "1d",
    cache_dir: str = DEFAULT_CACHE_DIR,
    max_cache_age_hours: int = 24, # Increased cache life to reduce API hits
) -> pd.DataFrame:
    """
    Robust price loader with Rate Limit Handling.
    """
    cache_path = _build_cache_path(ticker, start_date, end_date, interval, cache_dir)

    # 1) Try cache first
    if _is_cache_fresh(cache_path, max_cache_age_hours):
        try:
            df = pd.read_csv(cache_path, parse_dates=["date"])
            df = df.sort_values("date").reset_index(drop=True)
            return df
        except Exception:
            pass

    # 2) Download with Retry Logic
    max_retries = 3
    for attempt in range(max_retries):
        try:
            # Politeness delay: Random sleep 0.5s - 1.5s to avoid hitting limits
            time.sleep(random.uniform(0.5, 1.5))
            
            df = yf.download(
                ticker,
                start=start_date,
                end=end_date,
                interval=interval,
                auto_adjust=False,
                progress=False,
                threads=False # Disable YF internal threading to control rate limit
            )

            if df.empty:
                return pd.DataFrame(columns=["date", "open", "high", "low", "close", "adj_close", "volume"])

            # Normalize columns
            df = df.rename(columns={
                "Open": "open", "High": "high", "Low": "low",
                "Close": "close", "Adj Close": "adj_close", "Volume": "volume",
            })

            # Handle MultiIndex if present
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = [col[0] for col in df.columns]

            if not isinstance(df.index, pd.DatetimeIndex):
                df.index = pd.to_datetime(df.index, errors="coerce")

            df["date"] = df.index
            df = df[["date", "open", "high", "low", "close", "adj_close", "volume"]]
            df = df.sort_values("date").reset_index(drop=True)

            # Save to cache
            try:
                df.to_csv(cache_path, index=False)
            except Exception:
                pass

            return df

        except Exception as e:
            error_msg = str(e).lower()
            if "rate limit" in error_msg or "too many requests" in error_msg:
                wait_time = 15 * (attempt + 1) # Backoff: 15s, 30s, 45s
                logger.warning(f"⚠️ Rate limit hit for {ticker}. Sleeping {wait_time}s...")
                time.sleep(wait_time)
            else:
                # If it's not a rate limit (e.g. delisted ticker), stop trying
                break

    # Return empty if all retries failed
    return pd.DataFrame(columns=["date", "open", "high", "low", "close", "adj_close", "volume"])

# SILENCE YFINANCE NOISE
logging.getLogger('yfinance').setLevel(logging.CRITICAL)
logging.getLogger('urllib3').setLevel(logging.CRITICAL)