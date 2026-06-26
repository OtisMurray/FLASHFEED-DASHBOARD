"""Unified data fetcher — replaces 8 separate Python scripts with one optimized process.

Runs all ingestion in a single process with shared MongoDB connection:
  1. Finviz screener
  2. TradingView screener (full mode only)
  3. Quotes (yfinance)
  4. RSS/structured news
  5. TradingView news
  6. Benzinga news
  7. Social (Reddit/StockTwits/Twitter)
  8. Unstructured news (full mode only)

Outputs JSON summary to stdout for the Node.js backend to parse.
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Ensure project root is on sys.path
# unified_fetch.py is at /app/Infrastructure/pipeline/unified_fetch.py
# Project root (where 1_News/ and 2_Screener/ live) is /app
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from pymongo import MongoClient
import importlib.util

def _load_module(name, rel_path):
    """Load a Python module from a file path (handles numeric-prefixed dirs)."""
    path = PROJECT_ROOT / rel_path
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

# Load fetcher modules from their actual locations
_quotes_mod = _load_module("fetch_quotes_to_mongo", "1_News/pipeline/fetch_quotes_to_mongo.py")
fetch_quotes = _quotes_mod.fetch_quotes

_rss_mod = _load_module("fetch_rss_to_mongo", "1_News/pipeline/fetch_rss_to_mongo.py")
fetch_rss_main = _rss_mod.main

_social_mod = _load_module("fetch_social_to_mongo", "1_News/pipeline/fetch_social_to_mongo.py")
fetch_social = _social_mod.fetch_social

_tv_mod = _load_module("fetch_tradingview_to_mongo", "1_News/pipeline/fetch_tradingview_to_mongo.py")
fetch_tradingview_news = _tv_mod.fetch_tradingview_news

_benz_mod = _load_module("fetch_benzinga_to_mongo", "1_News/pipeline/fetch_benzinga_to_mongo.py")
fetch_benzinga = _benz_mod.fetch_benzinga

_unstruct_mod = _load_module("fetch_unstructured_news_titles_to_mongo", "1_News/pipeline/fetch_unstructured_news_titles_to_mongo.py")
fetch_unstructured = _unstruct_mod.fetch_unstructured

try:
    _finviz_mod = _load_module("fetch_finviz_elite_to_mongo", "2_Screener/pipeline/fetch_finviz_elite_to_mongo.py")
    fetch_finviz_elite = _finviz_mod.fetch_finviz_elite
except Exception:
    fetch_finviz_elite = None

try:
    _tv_screen_mod = _load_module("fetch_tradingview_screener_to_mongo", "2_Screener/pipeline/fetch_tradingview_screener_to_mongo.py")
    fetch_tradingview_screener = _tv_screen_mod.fetch_tradingview_screener
except Exception:
    fetch_tradingview_screener = None

try:
    _ibkr_mod = _load_module("fetch_ibkr_news_to_mongo", "1_News/pipeline/fetch_ibkr_news_to_mongo.py")
    fetch_ibkr_news = _ibkr_mod.fetch_ibkr_news
except Exception:
    fetch_ibkr_news = None

try:
    _schwab_mod = _load_module("fetch_schwab_signals_to_mongo", "2_Screener/pipeline/fetch_schwab_signals_to_mongo.py")
    fetch_schwab_signals = _schwab_mod.fetch_schwab_signals
except Exception:
    fetch_schwab_signals = None


def run_unified_fetch(mode: str = "fast") -> dict:
    """Run all fetchers in one process. Returns summary dict."""
    fast_mode = mode != "full"
    started = time.time()
    
    mongo_uri = os.environ.get("MONGODB_URI", "mongodb://localhost:27017/feedflash")
    client = MongoClient(mongo_uri, serverSelectionTimeoutMS=5000)
    db = client["feedflash"]
    
    summary = {
        "ok": True,
        "fetch_mode": mode,
        "timings": {},
        "errors": [],
    }
    
    # 1. Finviz (runs in both modes)
    t0 = time.time()
    try:
        if fetch_finviz_elite:
            finviz_result = fetch_finviz_elite(fast_mode=fast_mode)
            summary["finviz_rows"] = finviz_result.get("rows", 0)
            summary["finviz_updated"] = finviz_result.get("updated", 0)
        else:
            summary["finviz_rows"] = 0
            summary["finviz_updated"] = 0
    except Exception as e:
        summary["finviz_rows"] = 0
        summary["finviz_updated"] = 0
        summary["errors"].append(f"Finviz: {e}")
    summary["timings"]["finviz_ms"] = int((time.time() - t0) * 1000)
    
    # 2. TradingView screener (full mode only)
    t0 = time.time()
    if fast_mode:
        summary["tradingview_screener_rows"] = 0
        summary["tradingview_screener_updated"] = 0
    else:
        try:
            if fetch_tradingview_screener:
                tv_result = fetch_tradingview_screener()
                summary["tradingview_screener_rows"] = tv_result.get("rows", 0)
                summary["tradingview_screener_updated"] = tv_result.get("updated", 0)
            else:
                summary["tradingview_screener_rows"] = 0
                summary["tradingview_screener_updated"] = 0
        except Exception as e:
            summary["tradingview_screener_rows"] = 0
            summary["tradingview_screener_updated"] = 0
            summary["errors"].append(f"TradingView screener: {e}")
    summary["timings"]["tradingview_screener_ms"] = int((time.time() - t0) * 1000)
    
    # 3. Quotes
    t0 = time.time()
    try:
        quote_tickers_env = os.environ.get("QUOTE_TICKERS", "")
        quote_max = os.environ.get("QUOTE_MAX_TICKERS", "25" if fast_mode else "5000")
        quote_result = fetch_quotes(
            tickers=quote_tickers_env.split(",") if quote_tickers_env else None,
            max_tickers=int(quote_max),
        )
        summary["quotes_found"] = quote_result.get("found", 0)
        summary["quotes_updated"] = quote_result.get("updated", 0)
    except Exception as e:
        summary["quotes_found"] = 0
        summary["quotes_updated"] = 0
        summary["errors"].append(f"Quotes: {e}")
    summary["timings"]["quotes_ms"] = int((time.time() - t0) * 1000)
    
    # 4. RSS/structured news
    t0 = time.time()
    try:
        # Set env for fast mode
        if fast_mode:
            os.environ["RSS_FAST_MODE"] = "1"
        rss_result = fetch_rss_main()
        summary["new_articles"] = rss_result.get("new", 0)
        summary["updated_articles"] = rss_result.get("updated", 0)
        summary["unchanged_articles"] = rss_result.get("unchanged", 0)
    except Exception as e:
        summary["new_articles"] = 0
        summary["updated_articles"] = 0
        summary["unchanged_articles"] = 0
        summary["errors"].append(f"RSS: {e}")
    summary["timings"]["structured_ms"] = int((time.time() - t0) * 1000)
    
    # 5. TradingView news
    t0 = time.time()
    try:
        tv_result = fetch_tradingview_news()
        summary["tradingview_found"] = tv_result.get("found", 0)
        summary["tradingview_new"] = tv_result.get("new", 0)
        summary["tradingview_updated"] = tv_result.get("updated", 0)
    except Exception as e:
        summary["tradingview_found"] = 0
        summary["tradingview_new"] = 0
        summary["tradingview_updated"] = 0
        summary["errors"].append(f"TradingView news: {e}")
    summary["timings"]["tradingview_news_ms"] = int((time.time() - t0) * 1000)
    
    # 6. Benzinga (skip in fast mode without API key)
    t0 = time.time()
    if fast_mode and not os.environ.get("BENZINGA_API_KEY"):
        summary["benzinga_found"] = 0
        summary["benzinga_new"] = 0
        summary["benzinga_updated"] = 0
    else:
        try:
            benz_result = fetch_benzinga()
            summary["benzinga_found"] = benz_result.get("found", 0)
            summary["benzinga_new"] = benz_result.get("new", 0)
            summary["benzinga_updated"] = benz_result.get("updated", 0)
        except Exception as e:
            summary["benzinga_found"] = 0
            summary["benzinga_new"] = 0
            summary["benzinga_updated"] = 0
            summary["errors"].append(f"Benzinga: {e}")
    summary["timings"]["benzinga_ms"] = int((time.time() - t0) * 1000)
    
    # 7. IBKR News (full mode only)
    t0 = time.time()
    if fast_mode:
        summary["ibkr_found"] = 0
        summary["ibkr_new"] = 0
        summary["ibkr_updated"] = 0
    else:
        try:
            if fetch_ibkr_news:
                ibkr_result = fetch_ibkr_news()
                summary["ibkr_found"] = ibkr_result.get("found", 0)
                summary["ibkr_new"] = ibkr_result.get("new", 0)
                summary["ibkr_updated"] = ibkr_result.get("updated", 0)
            else:
                summary["ibkr_found"] = 0
                summary["ibkr_new"] = 0
                summary["ibkr_updated"] = 0
        except Exception as e:
            summary["ibkr_found"] = 0
            summary["ibkr_new"] = 0
            summary["ibkr_updated"] = 0
            summary["errors"].append(f"IBKR: {e}")
    summary["timings"]["ibkr_ms"] = int((time.time() - t0) * 1000)
    
    # 8. Schwab signals (full mode only)
    t0 = time.time()
    if fast_mode:
        summary["schwab_found"] = 0
        summary["schwab_new"] = 0
        summary["schwab_updated"] = 0
    else:
        try:
            if fetch_schwab_signals:
                schwab_result = fetch_schwab_signals()
                summary["schwab_found"] = schwab_result.get("found", 0)
                summary["schwab_new"] = schwab_result.get("new", 0)
                summary["schwab_updated"] = schwab_result.get("updated", 0)
            else:
                summary["schwab_found"] = 0
                summary["schwab_new"] = 0
                summary["schwab_updated"] = 0
        except Exception as e:
            summary["schwab_found"] = 0
            summary["schwab_new"] = 0
            summary["schwab_updated"] = 0
            summary["errors"].append(f"Schwab: {e}")
    summary["timings"]["schwab_ms"] = int((time.time() - t0) * 1000)
    
    # 9. Unstructured news (full mode only)
    t0 = time.time()
    if fast_mode:
        summary["unstructured_found"] = 0
        summary["unstructured_new"] = 0
        summary["unstructured_updated"] = 0
    else:
        try:
            unstruct_result = fetch_unstructured()
            summary["unstructured_found"] = unstruct_result.get("found", 0)
            summary["unstructured_new"] = unstruct_result.get("new", 0)
            summary["unstructured_updated"] = unstruct_result.get("updated", 0)
        except Exception as e:
            summary["unstructured_found"] = 0
            summary["unstructured_new"] = 0
            summary["unstructured_updated"] = 0
            summary["errors"].append(f"Unstructured: {e}")
    summary["timings"]["unstructured_ms"] = int((time.time() - t0) * 1000)
    
    # 10. Social
    t0 = time.time()
    try:
        social_tickers = os.environ.get("SOCIAL_TICKERS", "")
        social_result = fetch_social(
            tickers=social_tickers.split(",") if social_tickers else None,
            max_tickers=int(os.environ.get("SOCIAL_MAX_TICKERS", "10")),
        )
        summary["social_found"] = social_result.get("found", 0)
        summary["social_new"] = social_result.get("new", 0)
        summary["social_updated"] = social_result.get("updated", 0)
    except Exception as e:
        summary["social_found"] = 0
        summary["social_new"] = 0
        summary["social_updated"] = 0
        summary["errors"].append(f"Social: {e}")
    summary["timings"]["social_ms"] = int((time.time() - t0) * 1000)
    
    # Totals
    summary["total_articles"] = db["articles"].count_documents({})
    summary["total_social"] = db["socials"].count_documents({})
    summary["ms"] = int((time.time() - started) * 1000)
    summary["ok"] = len(summary["errors"]) == 0
    
    client.close()
    
    return summary


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "fast"
    result = run_unified_fetch(mode)
    print(json.dumps(result))
