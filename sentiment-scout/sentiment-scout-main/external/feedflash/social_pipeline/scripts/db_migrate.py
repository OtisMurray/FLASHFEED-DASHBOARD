"""
PostgreSQL schema migration — idempotent, safe to run repeatedly.
Creates tables for RSS articles and asset reports in Neon PostgreSQL.

Run once (and on every deploy to pick up new columns):
  python scripts/db_migrate.py
"""

import os
import sys
import logging
import psycopg
from dotenv import load_dotenv

load_dotenv()
log = logging.getLogger(__name__)

MIGRATION = """
-- ── RSS news articles ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS articles (
  id            TEXT    PRIMARY KEY,
  title         TEXT    NOT NULL,
  content       TEXT,
  url           TEXT    UNIQUE NOT NULL,
  source        TEXT    NOT NULL,
  category      TEXT,
  publish_date  BIGINT,
  fetched_date  BIGINT  NOT NULL,
  ticker        TEXT    DEFAULT '',
  sentiment     TEXT    DEFAULT NULL,
  sentiment_at  BIGINT  DEFAULT NULL,
  ml_confidence REAL    DEFAULT NULL,
  keyword_match TEXT    DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_articles_source       ON articles(source);
CREATE INDEX IF NOT EXISTS idx_articles_category     ON articles(category);
CREATE INDEX IF NOT EXISTS idx_articles_sentiment    ON articles(sentiment);
CREATE INDEX IF NOT EXISTS idx_articles_ticker       ON articles(ticker);
CREATE INDEX IF NOT EXISTS idx_articles_fetched      ON articles(fetched_date DESC);
CREATE INDEX IF NOT EXISTS idx_articles_publish      ON articles(publish_date DESC);
CREATE INDEX IF NOT EXISTS idx_articles_keyword      ON articles(keyword_match);

-- ── Aggregated daily sentiment reports per asset/ticker ───────────────────
CREATE TABLE IF NOT EXISTS asset_reports (
  id         SERIAL  PRIMARY KEY,
  asset      TEXT    NOT NULL,
  date       TEXT    NOT NULL,
  sentiment  TEXT    NOT NULL,
  report     TEXT,
  created_at BIGINT  NOT NULL,
  UNIQUE(asset, date)
);

CREATE INDEX IF NOT EXISTS idx_asset_reports_asset ON asset_reports(asset);
CREATE INDEX IF NOT EXISTS idx_asset_reports_date  ON asset_reports(date DESC);

-- ── Financial keyword filter list ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS filter_keywords (
  id         SERIAL  PRIMARY KEY,
  keyword    TEXT    UNIQUE NOT NULL,
  category   TEXT    NOT NULL DEFAULT 'general',
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_keywords_category ON filter_keywords(category);
CREATE INDEX IF NOT EXISTS idx_keywords_enabled  ON filter_keywords(enabled);

-- Seed default financial signal keywords (ON CONFLICT = skip if already exists)
INSERT INTO filter_keywords (keyword, category, created_at) VALUES
  ('earnings',      'fundamental', EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('ipo',           'fundamental', EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('listing',       'fundamental', EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('delisting',     'fundamental', EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('dividend',      'fundamental', EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('merger',        'fundamental', EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('acquisition',   'fundamental', EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('buyout',        'fundamental', EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('contract',      'fundamental', EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('partnership',   'fundamental', EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('fda approval',  'regulatory',  EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('fda rejection', 'regulatory',  EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('clinical trial','regulatory',  EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('sec filing',    'regulatory',  EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('short squeeze', 'momentum',    EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('price target',  'analyst',     EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('downgrade',     'analyst',     EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('upgrade',       'analyst',     EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('beat estimates','fundamental', EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('miss estimates','fundamental', EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('guidance',      'fundamental', EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('recall',        'regulatory',  EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('bankruptcy',    'fundamental', EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('layoffs',       'fundamental', EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('restructuring', 'fundamental', EXTRACT(EPOCH FROM NOW())::BIGINT)
ON CONFLICT (keyword) DO NOTHING;

-- ── Stocktwits posts ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stocktwits_posts (
  id              TEXT    PRIMARY KEY,
  ticker          TEXT    NOT NULL,
  body            TEXT,
  author          TEXT,
  sentiment       TEXT,
  sentiment_score REAL,
  created_at      BIGINT  NOT NULL,
  fetched_at      BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stocktwits_ticker  ON stocktwits_posts(ticker);
CREATE INDEX IF NOT EXISTS idx_stocktwits_created ON stocktwits_posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stocktwits_sentiment ON stocktwits_posts(sentiment);

-- ── Subreddit config (replaces hardcoded list in scrapers/config.py) ─────
CREATE TABLE IF NOT EXISTS subreddit_config (
  name       TEXT    PRIMARY KEY,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  added_at   BIGINT  NOT NULL
);

-- Seed default subreddits
INSERT INTO subreddit_config (name, enabled, added_at) VALUES
  ('wallstreetbets',       TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('wallstreetbets2',      TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('wallstreetbets_wins',  TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('wallstreetbetsELITE',  TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('wallstreetbetsnew',    TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('wallstreetelite',      TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('wallstreetsmallcap',   TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('smallstreetbets',      TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('thewallstreet',        TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('pennystocks',          TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('pennystock',           TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('10xpennystocks',       TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('stockmarket',          TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('stocks',               TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('stocks_picks',         TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('stocksandtrading',     TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('stockstobuytoday',     TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('stocktradingalerts',   TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('swingtrading',         TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('trading',              TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('trakstocks',           TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('shortsqueeze',         TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('stockaday',            TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT),
  ('options',              TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT)
ON CONFLICT (name) DO NOTHING;

-- ── RSS feed sources (managed from admin UI) ─────────────────────────────
CREATE TABLE IF NOT EXISTS rss_sources (
  id         SERIAL  PRIMARY KEY,
  name       TEXT    NOT NULL,
  url        TEXT    UNIQUE NOT NULL,
  category   TEXT    NOT NULL DEFAULT 'markets',
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_rss_sources_enabled  ON rss_sources(enabled);
CREATE INDEX IF NOT EXISTS idx_rss_sources_category ON rss_sources(category);

-- Seed default RSS sources
INSERT INTO rss_sources (name, url, category) VALUES
  ('CNBC Markets',          'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258',  'markets'),
  ('CNBC Finance',          'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664',  'markets'),
  ('MarketWatch Top',       'https://feeds.marketwatch.com/marketwatch/topstories/',                                'markets'),
  ('MarketWatch Breaking',  'https://feeds.marketwatch.com/marketwatch/bulletins/',                                 'markets'),
  ('Yahoo Finance',         'https://finance.yahoo.com/news/rssindex',                                              'markets'),
  ('Benzinga',              'https://www.benzinga.com/feed/',                                                       'markets'),
  ('Seeking Alpha',         'https://seekingalpha.com/market_currents.xml',                                         'markets'),
  ('The Motley Fool',       'https://www.fool.com/feeds/index.aspx?id=fool-headlines',                              'equities'),
  ('Investopedia',          'https://www.investopedia.com/feedbuilder/feed/getNewsFeed',                            'markets'),
  ('Reuters Business',      'https://feeds.reuters.com/reuters/businessNews',                                       'economy'),
  ('Reuters Finance',       'https://feeds.reuters.com/reuters/financialsNews',                                     'economy'),
  ('BBC Business',          'https://feeds.bbci.co.uk/news/business/rss.xml',                                      'economy'),
  ('Federal Reserve',       'https://www.federalreserve.gov/feeds/press_all.xml',                                   'economy'),
  ('Forbes Business',       'https://www.forbes.com/business/feed/',                                               'economy'),
  ('ZeroHedge',             'https://cms.zerohedge.com/fullrss2.xml',                                              'equities'),
  ('Business Insider',      'https://feeds2.feedburner.com/businessinsider',                                        'equities'),
  ('PR Newswire',           'https://www.prnewswire.com/rss/news-releases-list.rss',                               'press_releases'),
  ('BusinessWire',          'https://feed.businesswire.com/rss/home/?rss=G1',                                      'press_releases'),
  ('CoinDesk',              'https://www.coindesk.com/arc/outboundfeeds/rss/',                                     'crypto'),
  ('CoinTelegraph',         'https://cointelegraph.com/rss',                                                        'crypto'),
  ('OilPrice',              'https://oilprice.com/rss/main',                                                        'commodities'),
  ('AccessWire',            'https://www.accesswire.com/rss/default.aspx',                                         'press_releases')
ON CONFLICT (url) DO NOTHING;

-- ── Watched social accounts (for Twitter, Bluesky handles) ───────────────
CREATE TABLE IF NOT EXISTS watched_accounts (
  id         SERIAL  PRIMARY KEY,
  platform   TEXT    NOT NULL,
  handle     TEXT    NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  UNIQUE(platform, handle)
);

CREATE INDEX IF NOT EXISTS idx_watched_accts_platform ON watched_accounts(platform);
CREATE INDEX IF NOT EXISTS idx_watched_accts_enabled  ON watched_accounts(enabled);

-- Seed default Twitter accounts to watch
INSERT INTO watched_accounts (platform, handle) VALUES
  ('twitter', 'Benzinga'),
  ('twitter', 'CNBC'),
  ('twitter', 'unusual_whales'),
  ('twitter', 'ewhispers'),
  ('twitter', 'DeItaone'),
  ('twitter', 'FirstSquawk'),
  ('twitter', 'LiveSquawk'),
  ('twitter', 'MarketWatch'),
  ('twitter', 'WSJ'),
  ('twitter', 'Reuters'),
  ('twitter', 'Investingcom'),
  ('twitter', 'StockMKTNewz'),
  ('twitter', 'realwillmeade'),
  ('twitter', 'zerohedge'),
  ('twitter', 'BreakingMarkets')
ON CONFLICT (platform, handle) DO NOTHING;

-- ── Add detected_at for source latency tracking ─────────────────────────
ALTER TABLE articles ADD COLUMN IF NOT EXISTS detected_at BIGINT;
"""


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
    dsn = os.environ.get("POSTGRES_DSN")
    if not dsn:
        log.error("POSTGRES_DSN not set")
        sys.exit(1)

    with psycopg.connect(dsn) as conn:
        conn.execute(MIGRATION)
        conn.commit()
    log.info(
        "Migration complete — articles, asset_reports, filter_keywords, "
        "stocktwits_posts, subreddit_config, rss_sources, watched_accounts tables ready"
    )


if __name__ == "__main__":
    main()
