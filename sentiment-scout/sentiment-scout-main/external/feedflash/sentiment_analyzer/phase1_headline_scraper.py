# phase1_headline_scraper_mysql.py
import pandas as pd
import requests
import random
import time
import logging
import json
import os
import concurrent.futures
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from datetime import datetime, timedelta
from urllib.parse import urljoin
import pytz

from db_sqlite import ensure_articles_table, bulk_insert_articles, get_engine

# === CONFIGURATION ===
# Integration shim (Sentiment Scout): honor the FEEDFLASH_TICKERS env var so the
# adapter can point ingestion at the live screener universe (a gitignored var/
# path) instead of the bundled fixed list — same pattern as FEEDFLASH_DB.
FILTERED_LIST = os.environ.get("FEEDFLASH_TICKERS", "tickers_with_news.json")
BATCH_SIZE = 50
MAX_WORKERS = 5
DAYS_BACK_LIMIT = 30  # <--- NEW: Stop scraping if news is older than this
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
]

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("Phase1_Turbo")

def parse_datetime(s):
    """
    Robust date parser for Finviz formats. Returns US/Eastern localized datetime.
    """
    if not s: return None
    eastern = pytz.timezone('US/Eastern')
    now = datetime.now(eastern)
    s = s.strip()
    
    try:
        # Format 1: "Today 10:30AM"
        if s.lower().startswith("today"):
            time_part = s.lower().replace("today", "").strip()
            dt = datetime.strptime(time_part, "%I:%M%p")
            return now.replace(hour=dt.hour, minute=dt.minute, second=0, microsecond=0)
            
        # Format 2: "Yesterday 10:30AM"
        if s.lower().startswith("yesterday"):
            time_part = s.lower().replace("yesterday", "").strip()
            dt = datetime.strptime(time_part, "%I:%M%p")
            prev_day = now - timedelta(days=1)
            return prev_day.replace(hour=dt.hour, minute=dt.minute, second=0, microsecond=0)
            
        # Format 3: "May-12-24 05:45PM" (Full date with year)
        if '-' in s:
            dt = datetime.strptime(s, "%b-%d-%y %I:%M%p")
            return eastern.localize(dt)
            
        # Format 4: "Dec 11 04:50PM" (Missing year)
        dt = datetime.strptime(s, "%b %d %I:%M%p")
        year = now.year
        if dt.month > now.month:
            year -= 1
        dt = dt.replace(year=year)
        return eastern.localize(dt)

    except Exception as e:
        return None

def process_ticker(ticker, existing_urls):
    session = requests.Session()
    retry = Retry(total=3, backoff_factor=0.5, status_forcelist=[500,502,503,504])
    session.mount("http://", HTTPAdapter(max_retries=retry))
    session.mount("https://", HTTPAdapter(max_retries=retry))

    new_articles = []
    url = f"https://finviz.com/quote.ashx?t={ticker}"

    # === CUTOFF LOGIC ===
    eastern = pytz.timezone('US/Eastern')
    cutoff_date = datetime.now(eastern) - timedelta(days=DAYS_BACK_LIMIT)

    try:
        response = session.get(url, headers={"User-Agent": random.choice(USER_AGENTS)}, timeout=10)
        soup = BeautifulSoup(response.text, "html.parser")
        news_table = soup.select_one("#news-table")

        if news_table:
            rows = news_table.find_all("tr")
            current_date_str = None

            for row in rows:
                cols = row.find_all("td")
                if len(cols) < 2:
                    continue
                link_element = cols[1].find("a")
                if not link_element:
                    continue
                article_url = urljoin("https://finviz.com/", link_element["href"])
                
                # Check for duplicates immediately
                if article_url in existing_urls:
                    continue

                headline = link_element.get_text(strip=True)
                # Real publisher label from Finviz's news table (e.g. "(PR Newswire)",
                # "(Business Wire)", "(Benzinga)"). Sits in .news-link-right span,
                # wrapped in parens. Falls back to "Finviz" when absent.
                src_el = cols[1].select_one(".news-link-right span")
                source = src_el.get_text(strip=True).strip("()").strip() if src_el else "Finviz"
                if not source:
                    source = "Finviz"
                date_str = cols[0].get_text(strip=True)

                # Finviz logic: If date is "04:30PM", it belongs to the last seen "May-12-24" or "Today"
                if ' ' not in date_str and '-' not in date_str and not date_str.lower().startswith('today'):
                    # It's just a time, so use the previously stored full date string + this time
                    # Note: Ideally we pass the combined string to parse_datetime, but the parser handles raw strings well.
                    # For simplicity in this specific parser, we rely on it parsing the full date when it appears.
                    # However, Finviz puts the Date in the first row of the day, and only Time in subsequent rows.
                    # To fix this properly for the parser:
                    if current_date_str:
                         # Append the cached date part (e.g. "May-12-24") to this time (e.g. "04:00PM")
                         # But wait, existing parser expects specific formats. 
                         # Simpler trick: We can rely on the fact that if we hit a date older than cutoff, we break.
                         pass
                else:
                    current_date_str = date_str

                # Combine current_date_str (Day) with date_str (Time) if needed, 
                # but your parse_datetime handles the composite "Dec 11 04:50PM" format well.
                # If date_str is just time, we need to construct the full string for the parser.
                full_date_to_parse = date_str
                if ' ' not in date_str and '-' not in date_str and not date_str.lower().startswith('today') and current_date_str:
                     # Extract the date part from current_date_str (e.g., "May-12-24 06:00PM" -> "May-12-24")
                     date_part = current_date_str.split(' ')[0]
                     full_date_to_parse = f"{date_part} {date_str}"

                parsed_dt = parse_datetime(full_date_to_parse)

                # === SMART STOP LOGIC ===
                # If we parsed a valid date, check if it's too old
                if parsed_dt:
                    if parsed_dt < cutoff_date:
                        # Since Finviz is sorted Newest -> Oldest, we can stop entirely for this ticker
                        # logger.info(f"Reached limit ({DAYS_BACK_LIMIT} days) for {ticker}. Stopping.")
                        break
                
                if not parsed_dt:
                    continue

                new_articles.append({
                    "ticker": ticker,
                    "datetime": parsed_dt,
                    "headline": headline,
                    "url": article_url,
                    "text": "",
                    "source": source,
                })
        
        time.sleep(random.uniform(0.5, 1.0))
        return new_articles

    except Exception as e:
        logger.error(f"Error scraping {ticker}: {e}")
        return []

def run_scraper_threaded(tickers):
    # Ensure table exists
    ensure_articles_table()

    engine = get_engine()
    try:
        existing_urls_df = pd.read_sql("SELECT url FROM articles", con=engine)
        existing_urls = set(existing_urls_df['url'].tolist()) if not existing_urls_df.empty else set()
    except Exception:
        existing_urls = set()

    logger.info(f"Starting Multi-Threaded Scraper with {MAX_WORKERS} workers. Limit: {DAYS_BACK_LIMIT} days.")
    total_new = 0
    batch_results = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_ticker = {executor.submit(process_ticker, t, existing_urls): t for t in tickers}
        for i, future in enumerate(concurrent.futures.as_completed(future_to_ticker)):
            ticker = future_to_ticker[future]
            try:
                data = future.result()
                if data:
                    # Normalize datetimes to naive UTC-aware string for MySQL
                    for d in data:
                        dt = d.get("datetime")
                        if dt is not None:
                            if hasattr(dt, "astimezone"):
                                dt_utc = dt.astimezone(pytz.utc).replace(tzinfo=None)
                                d["datetime"] = dt_utc
                        
                        # Fill missing schema keys with None
                        for key in [
                            "tokens","mentions","pos_keywords","neg_keywords","total_keywords","text_length",
                            "keyword_density","sentiment_dynamic","sentiment_ml","sentiment_keyword",
                            "sentiment_combined","headline_sentiment","prediction_confidence","sentiment_category",
                            "ml_confidence","sentiment_strength","sentiment_score","Close","Open","High","Low",
                            "Volume","Adj_Close","pct_change_1h","pct_change_4h","pct_change_eod","pct_change_eow",
                            "direction_1h","direction_4h","direction_eod","direction_eow"
                        ]:
                            if key not in d:
                                d[key] = None

                    batch_results.extend(data)
                    logger.info(f"[{i+1}/{len(tickers)}] {ticker}: Found {len(data)} new.")
                else:
                    logger.info(f"[{i+1}/{len(tickers)}] {ticker}: No new data.")
            except Exception as e:
                logger.error(f"Thread error for {ticker}: {e}")

            # Save every BATCH_SIZE results
            if len(batch_results) >= BATCH_SIZE:
                try:
                    bulk_insert_articles(batch_results)
                    total_new += len(batch_results)
                    logger.info(f"💾 Saved batch of {len(batch_results)} articles.")
                    batch_results = []
                except Exception as e:
                    logger.error(f"Failed to save batch: {e}")

        if batch_results:
            try:
                bulk_insert_articles(batch_results)
                total_new += len(batch_results)
            except Exception as e:
                logger.error(f"Failed to save final batch: {e}")

    logger.info(f"✅ DONE. Total new headlines: {total_new}")

if __name__ == "__main__":
    target_tickers = []
    if os.path.exists(FILTERED_LIST):
        with open(FILTERED_LIST, 'r') as f:
            target_tickers = json.load(f)
    else:
        # Default fallback
        target_tickers = ['AAPL', 'NVDA', 'TSLA', 'AMD']

    run_scraper_threaded(target_tickers)