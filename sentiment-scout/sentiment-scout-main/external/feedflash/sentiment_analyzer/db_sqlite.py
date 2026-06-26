import os
import pandas as pd
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError
from dotenv import load_dotenv
import logging
import uuid

logger = logging.getLogger(__name__)
load_dotenv()

def get_engine():
    """Returns a SQLAlchemy engine connected to the local SQLite database."""
    # Integration shim (Sentiment Scout): honor the FEEDFLASH_DB env var so the
    # writable DB lives in a gitignored runtime dir outside this vendored code
    # tree. The Flask adapter (priyanshu_adapter) sets it; the scraper subprocess
    # inherits it. Falls back to the original in-tree resolution when unset.
    db_path = os.environ.get("FEEDFLASH_DB")
    if db_path:
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        if not os.path.exists(db_path):
            open(db_path, 'a').close()
    else:
        base_dir = os.path.dirname(os.path.abspath(__file__))
        project_root = os.path.abspath(os.path.join(base_dir, ".."))
        db_path = os.path.join(project_root, "data", "feedflash.db")
        if not os.path.exists(db_path):
            db_path = os.path.join(project_root, "feedflash.db")
            if not os.path.exists(db_path):
                # Create the file if it doesn't exist
                open(db_path, 'a').close()

    connection_string = f"sqlite:///{db_path}"
    try:
        engine = create_engine(connection_string, pool_recycle=3600)
        
        # Ensure WAL mode is active for concurrency
        with engine.begin() as conn:
            conn.execute(text("PRAGMA journal_mode=WAL;"))
            
        return engine
    except Exception as e:
        logger.error(f"Error creating sqlite engine: {e}")
        return None

def executemany_update(sql, params):
    engine = get_engine()
    if not engine:
        return False
    if not params:
        return True

    try:
        # For sqlite + sqlalchemy, we can just use engine.execute
        with engine.begin() as conn:
            # sqlalchemy 2.0 style executemany: conn.execute(text(sql), params)
            # but usually params should be a list of dicts. If it's a list of tuples,
            # raw DBAPI is better.
            raw_conn = engine.raw_connection()
            try:
                cursor = raw_conn.cursor()
                cursor.executemany(sql, params)
                raw_conn.commit()
                return True
            except Exception as e:
                raw_conn.rollback()
                logger.error(f"Cursor error: {e}")
                return False
            finally:
                cursor.close()
                raw_conn.close()
    except Exception as e:
        logger.error(f"Error executing batch update: {e}")
        return False

def execute_update(sql, params=None):
    engine = get_engine()
    if not engine:
        return False
    try:
        with engine.begin() as conn:
            if params:
                if isinstance(params, (list, tuple)) and not isinstance(params[0], dict) and not isinstance(params, dict):
                     # convert tuple to dict or just use raw if it's positional
                     raw_conn = engine.raw_connection()
                     cur = raw_conn.cursor()
                     cur.execute(sql, params)
                     raw_conn.commit()
                     raw_conn.close()
                else:
                     conn.execute(text(sql), params)
            else:
                conn.execute(text(sql))
        return True
    except Exception as e:
        logger.error(f"Error executing update: {e}")
        return False

def ensure_articles_table():
    """
    Creates the 'articles' table if it doesn't exist, using SQLite types.
    Combines C++ schema with Python ML schema.
    """
    engine = get_engine()
    if not engine:
        return

    # SQLite schema incorporating both C++ fields and Python ML fields
    create_table_sql = """
    CREATE TABLE IF NOT EXISTS articles (
        -- Core C++ & Python columns
        id TEXT PRIMARY KEY,
        ticker TEXT,
        title TEXT,
        headline TEXT, -- Keeping for backwards compat with Python scrapers
        url TEXT UNIQUE,
        content TEXT,
        `text` TEXT, -- Python scrapers use 'text' instead of 'content'
        source TEXT,
        category TEXT,
        publish_date INTEGER, -- Unix timestamp (C++)
        `datetime` TEXT, -- Python ISO string
        fetched_date INTEGER,

        -- KRIS & JOSH FEATURES
        tokens TEXT,
        mentions TEXT,
        pos_keywords TEXT,
        neg_keywords TEXT,
        total_keywords INTEGER,
        text_length INTEGER,
        keyword_density REAL,
        sentiment_dynamic REAL,
        sentiment_ml REAL,
        sentiment_keyword REAL,
        sentiment_combined REAL,
        headline_sentiment REAL,
        prediction_confidence REAL,
        sentiment_category TEXT,
        ml_confidence REAL,
        sentiment_strength REAL,
        sentiment_score REAL,
        sentiment TEXT, -- Used by C++ also
        sentiment_at INTEGER,

        -- BATES (GPT) & MIRZA (Prosus) FEATURES
        sentiment_gpt REAL,
        gpt_reasoning TEXT,
        sentiment_vader REAL,
        sentiment_finbert_tone REAL,
        sentiment_finbert_prosus REAL,
        
        -- MARKET DATA
        price_close REAL,
        price_open REAL,
        price_high REAL,
        price_low REAL,
        volume INTEGER,
        adj_close REAL,
        
        -- Legacy columns (Volume/Adj_Close removed: SQLite column names are
        -- case-insensitive, so they collide with `volume`/`adj_close` above)
        `Close` REAL,
        `Open` REAL,
        `High` REAL,
        `Low` REAL,
        
        -- Outcome columns
        pct_change_1h REAL,
        pct_change_4h REAL,
        pct_change_eod REAL,
        pct_change_eow REAL,
        direction_1h TEXT,
        direction_4h TEXT,
        direction_eod TEXT,
        direction_eow TEXT,
        
        -- Technical indicators
        rsi_14 REAL,
        macd REAL,
        macd_hist REAL,
        price_vs_sma50 REAL,
        std_upper REAL,
        std_lower REAL,
        std_channel_width REAL,
        
        -- Market context
        vix_close REAL,
        spy_daily_return REAL,
        
        -- Temporal features
        hour_sin REAL,
        hour_cos REAL,
        day_of_week INTEGER,
        
        -- DS440 Specific Features
        author TEXT,
        is_duplicate INTEGER DEFAULT NULL,
        is_spam INTEGER DEFAULT NULL,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """
    
    indexes_sql = [
        "CREATE INDEX IF NOT EXISTS idx_ticker ON articles (ticker);",
        "CREATE INDEX IF NOT EXISTS idx_datetime ON articles (`datetime`);",
        "CREATE INDEX IF NOT EXISTS idx_sentiment_category ON articles (sentiment_category);",
        "CREATE INDEX IF NOT EXISTS idx_pct_change_eod ON articles (pct_change_eod);",
        "CREATE INDEX IF NOT EXISTS idx_source ON articles (source);",
        "CREATE INDEX IF NOT EXISTS idx_publish_date ON articles (publish_date DESC);",
        "CREATE INDEX IF NOT EXISTS idx_fetched_date ON articles (fetched_date DESC);"
    ]
    
    try:
        with engine.begin() as conn:
            conn.execute(text(create_table_sql))
            for idx in indexes_sql:
                conn.execute(text(idx))
            
            # Robust schema upgrade: add missing columns if C++ created the table first
            # We fetch existing columns
            result = conn.execute(text("PRAGMA table_info(articles)"))
            existing_cols = {row[1].lower() for row in result.fetchall()}
            
            # Define all required columns and their types
            required_cols = {
                "headline": "TEXT", "text": "TEXT", "datetime": "TEXT",
                "tokens": "TEXT", "mentions": "TEXT", "pos_keywords": "TEXT", "neg_keywords": "TEXT",
                "total_keywords": "INTEGER", "text_length": "INTEGER", "keyword_density": "REAL",
                "sentiment_dynamic": "REAL", "sentiment_ml": "REAL", "sentiment_keyword": "REAL",
                "sentiment_combined": "REAL", "headline_sentiment": "REAL", "prediction_confidence": "REAL",
                "sentiment_category": "TEXT", "ml_confidence": "REAL", "sentiment_strength": "REAL",
                "sentiment_score": "REAL", "sentiment": "TEXT", "sentiment_at": "INTEGER",
                "sentiment_gpt": "REAL", "gpt_reasoning": "TEXT", "sentiment_vader": "REAL",
                "sentiment_finbert_tone": "REAL", "sentiment_finbert_prosus": "REAL",
                "price_close": "REAL", "price_open": "REAL", "price_high": "REAL", "price_low": "REAL",
                "volume": "INTEGER", "adj_close": "REAL", "Close": "REAL", "Open": "REAL",
                "High": "REAL", "Low": "REAL",
                "pct_change_1h": "REAL", "pct_change_4h": "REAL", "pct_change_eod": "REAL", "pct_change_eow": "REAL",
                "direction_1h": "TEXT", "direction_4h": "TEXT", "direction_eod": "TEXT", "direction_eow": "TEXT",
                "rsi_14": "REAL", "macd": "REAL", "macd_hist": "REAL", "price_vs_sma50": "REAL",
                "std_upper": "REAL", "std_lower": "REAL", "std_channel_width": "REAL",
                "vix_close": "REAL", "spy_daily_return": "REAL", "hour_sin": "REAL", "hour_cos": "REAL",
                "day_of_week": "INTEGER", "author": "TEXT", "is_duplicate": "INTEGER DEFAULT NULL",
                "is_spam": "INTEGER DEFAULT NULL", "created_at": "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
            }
            
            for col, dtype in required_cols.items():
                if col.lower() not in existing_cols:
                    try:
                        conn.execute(text(f"ALTER TABLE articles ADD COLUMN `{col}` {dtype}"))
                    except Exception as e:
                        logger.error(f"Failed to add column {col}: {e}")
                        
    except SQLAlchemyError as e:
        logger.error(f"Error creating table/indexes: {e}")

def bulk_insert_articles(articles_list):
    if not articles_list:
        return

    # Add UUIDs for Python inserts where ID is missing
    for article in articles_list:
        if 'id' not in article or not article['id']:
            article['id'] = str(uuid.uuid4())

    df = pd.DataFrame(articles_list)
    engine = get_engine()
    
    if not engine:
        return

    try:
        df.to_sql('articles', con=engine, if_exists='append', index=False, chunksize=1000)
    except Exception as e:
        if "UNIQUE constraint failed" in str(e) or "1062" in str(e):
            with engine.begin() as conn:
                for _, row in df.iterrows():
                    try:
                        single_row_df = pd.DataFrame([row])
                        single_row_df.to_sql('articles', con=conn, if_exists='append', index=False)
                    except Exception:
                        pass
        else:
            logger.error(f"Critical DB Error during bulk insert: {e}")

def verify_outcomes_exist():
    engine = get_engine()
    if not engine:
        return 0
    try:
        with engine.connect() as conn:
            result = conn.execute(text("SELECT COUNT(*) FROM articles WHERE pct_change_eod IS NOT NULL"))
            return result.scalar()
    except Exception as e:
        logger.error(f"Error checking outcomes: {e}")
        return 0

if __name__ == "__main__":
    print("Initializing SQLite connection…")
    engine = get_engine()
    if engine:
        print("Connected to SQLite!")
        ensure_articles_table()
        print("Table schema checked.")
        outcome_count = verify_outcomes_exist()
        print(f"Articles with outcomes: {outcome_count}")
    else:
        print("Failed to connect to SQLite.")
