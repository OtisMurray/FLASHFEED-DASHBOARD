"""Configuration constants for the scraper pipeline."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

# Load .env from project root
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

# ---------------------------------------------------------------------------
# MongoDB
# ---------------------------------------------------------------------------
MONGO_URI: str = os.getenv("MONGO_URI", "mongodb://localhost:27017")
MONGO_DB: str = os.getenv("MONGO_DB", "ds440")
MONGO_COLLECTION: str = os.getenv("MONGO_COLLECTION", "posts")

# ---------------------------------------------------------------------------
# Reddit request settings
# ---------------------------------------------------------------------------
IMPERSONATE: str = "chrome124"
BASE_URL: str = "https://old.reddit.com"
POSTS_PER_REQUEST: int = 100
REQUEST_TIMEOUT: int = 15  # seconds

# ---------------------------------------------------------------------------
# Rate-limiting / backoff
# ---------------------------------------------------------------------------
DELAY_BETWEEN_SUBS: float = 4.0          # seconds between subreddit fetches
DELAY_JITTER: tuple[float, float] = (0.5, 2.0)  # random jitter added to delay
CYCLE_DELAY: tuple[int, int] = (30, 60)  # seconds to wait between full cycles
MAX_BACKOFF: int = 300                    # max back-off on repeated errors (seconds)

# ---------------------------------------------------------------------------
# Target subreddits (24)
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Bluesky settings
# ---------------------------------------------------------------------------
BLUESKY_HANDLE: str = os.getenv("BLUESKY_HANDLE", "")
BLUESKY_APP_PASSWORD: str = os.getenv("BLUESKY_APP_PASSWORD", "")

BLUESKY_SEARCH_QUERIES: list[str] = [
    "$TSLA", "$AAPL", "$GOOG", "$GOOGL", "$AMZN", "$MSFT", "$GME", "$AMC",
    "$NVDA", "$META", "$SPY", "$QQQ", "$AMD", "$INTC", "$NFLX", "$DIS",
    "$BA", "$PLTR", "$SOFI", "$NIO", "$RIVN", "$COIN", "$MARA", "$SQ", "$SHOP",
]

BLUESKY_ACCOUNTS: list[str] = [
    # Finance accounts to monitor — add handles as they're discovered on Bluesky.
]

BLUESKY_POSTS_PER_REQUEST: int = 100
BLUESKY_DELAY_BETWEEN_QUERIES: float = 1.0  # seconds between API calls
BLUESKY_CYCLE_DELAY: tuple[int, int] = (30, 60)  # seconds between full cycles

# ---------------------------------------------------------------------------
# Target subreddits (24)
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Sentiment engine (D5)
# ---------------------------------------------------------------------------
SENTIMENT_CONFIDENCE_THRESHOLD: float = 0.15

# ---------------------------------------------------------------------------
# Rolling windows (D6)
# ---------------------------------------------------------------------------
ROLLING_WINDOW_SIZES: list[int] = [1, 3, 5, 10, 15, 30, 60]
ROLLING_WINDOWS_COLLECTION: str = os.getenv("ROLLING_WINDOWS_COLLECTION", "rolling_windows")

# ---------------------------------------------------------------------------
# Finviz ingestion (D7)
# ---------------------------------------------------------------------------
FINVIZ_COLLECTION: str = os.getenv("FINVIZ_COLLECTION", "finviz_screener")

# ---------------------------------------------------------------------------
# Interactive Brokers TWS/Gateway
# ---------------------------------------------------------------------------
IB_ENABLED: bool = os.getenv("IB_ENABLED", "false").lower() in ("true", "1", "yes")
IB_HOST: str = os.getenv("IB_HOST", "127.0.0.1")
IB_PORT: int = int(os.getenv("IB_PORT", "7497"))          # 7497=paper TWS, 7496=live TWS
IB_CLIENT_ID: int = int(os.getenv("IB_CLIENT_ID", "10"))  # use 10+ to avoid collision with manual sessions

# Fallback ticker list used when Redis active_tickers is empty (e.g. first run)
IB_TICKERS_FALLBACK: list[str] = [
    t.strip() for t in os.getenv("IB_TICKERS_FALLBACK", "").split(",") if t.strip()
] or [
    "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "SPY", "QQQ",
    "AMD", "INTC", "NFLX", "BA", "PLTR", "GME", "AMC", "COIN", "SOFI",
]

IB_LOOKBACK_HOURS: int = int(os.getenv("IB_LOOKBACK_HOURS", "24"))
IB_MAX_TICKERS: int = int(os.getenv("IB_MAX_TICKERS", "50"))
IB_HEADLINES_PER_TICKER: int = int(os.getenv("IB_HEADLINES_PER_TICKER", "50"))
IB_REQUEST_DELAY: float = float(os.getenv("IB_REQUEST_DELAY", "1.0"))  # seconds between IB calls
IB_FETCH_ARTICLE_BODY: bool = os.getenv("IB_FETCH_ARTICLE_BODY", "false").lower() in ("true", "1", "yes")

# ---------------------------------------------------------------------------
# Redis — Upstash (D11)
# ---------------------------------------------------------------------------
REDIS_URL: str = os.getenv("REDIS_URL", "")

# ---------------------------------------------------------------------------
# PostgreSQL — Neon (D11)
# ---------------------------------------------------------------------------
POSTGRES_DSN: str = os.getenv("POSTGRES_DSN", "")

SUBREDDITS: list[str] = [
    "wallstreetbets",
    "wallstreetbets2",
    "wallstreetbets_wins",
    "wallstreetbetsELITE",
    "wallstreetbetsnew",
    "wallstreetelite",
    "wallstreetsmallcap",
    "smallstreetbets",
    "thewallstreet",
    "pennystocks",
    "pennystock",
    "10xpennystocks",
    "stockmarket",
    "stocks",
    "stocks_picks",
    "stocksandtrading",
    "stockstobuytoday",
    "stocktradingalerts",
    "swingtrading",
    "trading",
    "trakstocks",
    "shortsqueeze",
    "stockaday",
    "options",
]
