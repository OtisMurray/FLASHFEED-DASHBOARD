import pandas as pd
import pandas_ta as ta
import numpy as np
import logging
import pytz
import yfinance as yf
from datetime import timedelta, date
from sqlalchemy import text
from tqdm import tqdm
from concurrent.futures import ThreadPoolExecutor

# Import your existing project modules
from db_sqlite import get_engine, executemany_update
from unified_price_scripts import get_price_history

# === CONFIGURATION ===
MAX_WORKERS = 8
BATCH_SIZE = 500
LOOKBACK_DAYS = 365 * 5 
EASTERN = pytz.timezone('US/Eastern')

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("Phase3_Final_Fix")

# ==========================================
#        HELPER: YFINANCE FIXER
# ==========================================
def fix_yf_data(df):
    """
    Standardizes yfinance data to handle recent API changes (MultiIndex columns).
    Ensures columns are simple strings: 'open', 'high', 'low', 'close', 'volume'.
    """
    if df.empty:
        return df
    
    # Flatten MultiIndex columns if present (e.g., ('Close', 'SPY') -> 'Close')
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    
    # Normalize column names to lowercase
    df.columns = [c.lower() for c in df.columns]
    
    # Ensure index is timezone-naive
    if df.index.tz is not None:
        df.index = df.index.tz_localize(None)
        
    return df

# ==========================================
#        SCHEMA CHECK & SELF-HEALING
# ==========================================
def ensure_all_columns_exist():
    engine = get_engine()
    columns = [
        # Raw Prices
        "price_close DOUBLE DEFAULT NULL",
        "price_open DOUBLE DEFAULT NULL",
        "price_high DOUBLE DEFAULT NULL",
        "price_low DOUBLE DEFAULT NULL",
        "volume BIGINT DEFAULT NULL",
        # STD Channels
        "std_upper DOUBLE DEFAULT NULL",
        "std_lower DOUBLE DEFAULT NULL",
        "std_channel_width DOUBLE DEFAULT NULL",
        # Technical Indicators
        "rsi_14 DOUBLE DEFAULT NULL",
        "macd DOUBLE DEFAULT NULL",
        "macd_hist DOUBLE DEFAULT NULL",
        "price_vs_sma50 DOUBLE DEFAULT NULL",
        # Market Context
        "vix_close DOUBLE DEFAULT NULL",
        "spy_daily_return DOUBLE DEFAULT NULL",
        # Temporal Features
        "hour_sin DOUBLE DEFAULT NULL",
        "hour_cos DOUBLE DEFAULT NULL",
        "day_of_week INT DEFAULT NULL",
        # Outcome Columns
        "pct_change_1h DOUBLE DEFAULT NULL",
        "pct_change_4h DOUBLE DEFAULT NULL",
        "pct_change_eod DOUBLE DEFAULT NULL",
        "pct_change_eow DOUBLE DEFAULT NULL"
    ]
    with engine.connect() as conn:
        for col in columns:
            col_name = col.split()[0]
            try:
                result = conn.execute(text(f"SHOW COLUMNS FROM articles LIKE '{col_name}'"))
                if not result.fetchone():
                    logger.info(f"🔧 Adding missing column: {col_name}...")
                    conn.execute(text(f"ALTER TABLE articles ADD COLUMN {col}"))
                    conn.commit()
            except Exception as e:
                logger.debug(f"Column check failed for {col_name}: {e}")

# ==========================================
#          PRICE & TECHNICALS REPAIR
# ==========================================
def get_all_tickers():
    engine = get_engine()
    with engine.connect() as conn:
        result = conn.execute(text(
            "SELECT DISTINCT ticker FROM articles WHERE ticker IS NOT NULL AND ticker != ''"
        ))
        return [r[0] for r in result]

def get_articles_for_ticker(ticker):
    engine = get_engine()
    # Only select articles that DON'T have a price yet (Optimization)
    query = text("""
        SELECT id, datetime FROM articles 
        WHERE ticker = :t AND (price_close IS NULL OR rsi_14 IS NULL)
    """)
    return pd.read_sql(query, engine, params={"t": ticker})

def fetch_continuous_market_data(ticker):
    yahoo_ticker = ticker.replace('.', '-')
    end_date = pd.Timestamp.now().strftime('%Y-%m-%d')
    start_date = (pd.Timestamp.now() - timedelta(days=LOOKBACK_DAYS)).strftime('%Y-%m-%d')
    try:
        # We rely on 'unified_price_scripts' or standard yf
        df = get_price_history(yahoo_ticker, start_date, end_date, interval="1d")
        
        if df.empty: return df
        
        # Standardize index
        if 'date' in df.columns:
            df['date'] = pd.to_datetime(df['date']).dt.tz_localize(None).dt.normalize()
            df = df.set_index('date').sort_index()
        elif not isinstance(df.index, pd.DatetimeIndex):
             df.index = pd.to_datetime(df.index).normalize()
        else:
             df.index = df.index.tz_localize(None).normalize()
             
        return df
    except Exception:
        return pd.DataFrame()

def process_ticker_repair(ticker):
    try:
        articles_df = get_articles_for_ticker(ticker)
        if articles_df.empty: return []

        # 1. Fetch Raw Market Data
        prices_df = fetch_continuous_market_data(ticker)
        if prices_df.empty or len(prices_df) < 15: 
            return []

        # 2. Calculate Technicals (ON TRADING DAYS FIRST)
        prices_df['rsi_14'] = ta.rsi(prices_df['close'], length=14)
        macd = ta.macd(prices_df['close'])
        prices_df['macd'] = macd['MACD_12_26_9'] if macd is not None else None
        prices_df['macd_hist'] = macd['MACDh_12_26_9'] if macd is not None else None
        sma50 = ta.sma(prices_df['close'], length=50)
        prices_df['price_vs_sma50'] = (prices_df['close'] - sma50) / sma50 if sma50 is not None else None

        rolling_mean = prices_df['close'].rolling(20).mean()
        rolling_std = prices_df['close'].rolling(20).std()
        prices_df['std_upper'] = rolling_mean + 2 * rolling_std
        prices_df['std_lower'] = rolling_mean - 2 * rolling_std
        prices_df['std_channel_width'] = np.where(
            prices_df['close'] != 0,
            (prices_df['std_upper'] - prices_df['std_lower']) / prices_df['close'],
            0
        )

        # 3. === THE FIX: FORCE EXTEND TO TODAY+1 ===
        # This ensures if today is Sunday, we create Saturday and Sunday rows
        # populated with Friday's data.
        last_date = prices_df.index.max()
        # "Tomorrow" covers UTC timezone overlaps
        target_end_date = pd.Timestamp.now().normalize() + timedelta(days=1)
        
        if last_date < target_end_date:
            # Create a full daily range from start to tomorrow
            full_idx = pd.date_range(start=prices_df.index.min(), end=target_end_date, freq='D')
            # Reindex creates the new rows (as NaN), ffill fills them with Friday data
            prices_df = prices_df.reindex(full_idx).ffill()
        else:
            # Just fill gaps if the data is already current
            prices_df = prices_df.resample('D').ffill()

        # 4. Map back to articles
        updates = []
        price_dates_np = np.array(prices_df.index.values, dtype='datetime64[D]') # Optimized to Days
        
        for _, row in articles_df.iterrows():
            try:
                ts = pd.to_datetime(row['datetime'])
                # Convert article time to Eastern Date to match Market Data
                utc_dt = ts if ts.tzinfo else ts.tz_localize('UTC')
                target_date = utc_dt.astimezone(EASTERN).date()
                target_np = np.datetime64(target_date)

                # Find exact date match
                loc_idx = np.searchsorted(price_dates_np, target_np)
                
                # Validation: Index must be within bounds and match the date exactly
                if loc_idx >= len(price_dates_np) or price_dates_np[loc_idx] != target_np:
                    continue

                day_data = prices_df.iloc[loc_idx]
                
                def val(col): 
                    return float(day_data[col]) if col in day_data and not pd.isna(day_data[col]) else None

                updates.append((
                    val('std_upper'), val('std_lower'), val('std_channel_width'),
                    val('rsi_14'), val('macd'), val('macd_hist'), val('price_vs_sma50'),
                    val('close'), val('open'), val('high'), val('low'), val('volume'),
                    int(row['id'])
                ))
            except Exception: continue

        return updates
    except Exception:
        return []

def push_price_updates(updates):
    clean_updates = [u for u in updates if u[-1] is not None]
    sql = """
        UPDATE articles 
        SET std_upper=%s, std_lower=%s, std_channel_width=%s,
            rsi_14=%s, macd=%s, macd_hist=%s, price_vs_sma50=%s,
            price_close=%s, price_open=%s, price_high=%s, price_low=%s, volume=%s
        WHERE id=%s
    """
    try:
        executemany_update(sql, clean_updates)
        logger.info(f"💾 Saved {len(clean_updates)} price/technical records.")
    except Exception as e:
        logger.error(f"Write Error: {e}")

# ==========================================
#            TEMPORAL FEATURES
# ==========================================
def calculate_temporal_features():
    engine = get_engine()
    query = text("SELECT id, datetime FROM articles WHERE hour_sin IS NULL AND datetime IS NOT NULL")
    with engine.connect() as conn:
        result = conn.execute(query).fetchall()
    if not result: return
    updates = []
    for row in tqdm(result, desc="Temporal"):
        try:
            article_id, dt = row[0], row[1]
            dt_obj = pd.to_datetime(dt)
            hour = dt_obj.hour
            updates.append((
                float(np.sin(2*np.pi*hour/24)),
                float(np.cos(2*np.pi*hour/24)),
                int(dt_obj.dayofweek),
                int(article_id)
            ))
            if len(updates) >= BATCH_SIZE:
                push_temporal_updates(updates)
                updates = []
        except Exception: continue
    if updates: push_temporal_updates(updates)

def push_temporal_updates(updates):
    sql = "UPDATE articles SET hour_sin=%s, hour_cos=%s, day_of_week=%s WHERE id=%s"
    try:
        executemany_update(sql, updates)
    except Exception as e:
        logger.error(f"Temporal Write Error: {e}")

# ==========================================
#            MARKET CONTEXT (VIX/SPY)
# ==========================================
def process_market_context():
    engine = get_engine()
    with engine.connect() as conn:
        if conn.execute(text("SELECT count(*) FROM articles WHERE vix_close IS NULL")).scalar() == 0:
            return

    end_date = pd.Timestamp.now()
    start_date = end_date - timedelta(days=LOOKBACK_DAYS)
    try:
        vix = yf.download("^VIX", start=start_date, end=end_date, progress=False)
        spy = yf.download("SPY", start=start_date, end=end_date, progress=False)
        
        vix = fix_yf_data(vix)['close']
        spy = fix_yf_data(spy)['close']
        spy_returns = spy.pct_change()
        
        vix.index = pd.to_datetime(vix.index).normalize()
        spy_returns.index = pd.to_datetime(spy_returns.index).normalize()

        # === FIX: FORCE EXTEND VIX/SPY TO TODAY ===
        target_end = pd.Timestamp.now().normalize() + timedelta(days=1)
        full_idx = pd.date_range(start=vix.index.min(), end=target_end, freq='D')
        
        vix = vix.reindex(full_idx).ffill()
        spy_returns = spy_returns.reindex(full_idx).ffill().fillna(0)
        # ==========================================

        dates_query = "SELECT DISTINCT DATE(datetime) as date_str FROM articles WHERE vix_close IS NULL"
        dates = pd.read_sql(dates_query, engine)['date_str'].tolist()

        vix_dates_np = np.array(vix.index.date, dtype='datetime64[D]')
        
        updates = []
        for d in tqdm(dates, desc="Market Context"):
            try:
                target_np = np.datetime64(pd.to_datetime(d).date())
                idx = np.searchsorted(vix_dates_np, target_np)
                
                # Loose check for context
                if idx < len(vix_dates_np) and abs((vix_dates_np[idx] - target_np).astype(int)) <= 5:
                    v_val = vix.iloc[idx].item()
                    s_val = spy_returns.iloc[idx].item() if idx < len(spy_returns) else 0.0
                    
                    with engine.begin() as conn:
                        conn.execute(text(
                            "UPDATE articles SET vix_close=:v, spy_daily_return=:s WHERE DATE(datetime)=:d"
                        ), {"v": float(v_val), "s": float(s_val), "d": d})
            except Exception: continue
                
    except Exception as e:
        logger.error(f"Market Context Error: {e}")

# ==========================================
#       OUTCOME CALCULATIONS (NEW!)
# ==========================================

def fetch_spy_intraday_data():
    logger.info("📥 Fetching SPY intraday data (limit 7 days for 1m data)...")
    end_date = pd.Timestamp.now()
    start_date = end_date - timedelta(days=5) # Reduced to 5 to be safe with YF API
    
    try:
        spy_1m = yf.download("SPY", start=start_date, end=end_date, interval="1m", progress=False)
        spy_1m = fix_yf_data(spy_1m)
        if not spy_1m.empty and 'close' in spy_1m.columns:
            return spy_1m[['close']]
        return pd.DataFrame()
    except Exception:
        return pd.DataFrame()

def fetch_spy_daily_data():
    logger.info("📥 Fetching SPY daily data...")
    end_date = pd.Timestamp.now()
    start_date = end_date - timedelta(days=LOOKBACK_DAYS)
    try:
        spy_daily = yf.download("SPY", start=start_date, end=end_date, interval="1d", progress=False)
        spy_daily = fix_yf_data(spy_daily)
        if not spy_daily.empty and 'close' in spy_daily.columns:
            # Force extend daily data to today as well for calculations
            full_idx = pd.date_range(start=spy_daily.index.min(), end=pd.Timestamp.now().normalize()+timedelta(days=1), freq='D')
            spy_daily = spy_daily.reindex(full_idx).ffill()
            return spy_daily[['close']]
        return pd.DataFrame()
    except Exception:
        return pd.DataFrame()

def calculate_outcomes_for_articles():
    engine = get_engine()
    
    with engine.connect() as conn:
        count = conn.execute(text(
            "SELECT COUNT(*) FROM articles WHERE pct_change_eod IS NULL AND datetime IS NOT NULL"
        )).scalar()
        if count == 0:
            logger.info("✅ All articles already have outcomes calculated")
            return
    
    logger.info(f"🎯 Calculating outcomes for {count} articles...")
    
    spy_intraday = fetch_spy_intraday_data()
    spy_daily = fetch_spy_daily_data()
    
    if spy_daily.empty:
        logger.error("❌ Cannot calculate outcomes without SPY data")
        return
    
    query = """
        SELECT id, datetime 
        FROM articles 
        WHERE pct_change_eod IS NULL 
        AND datetime IS NOT NULL
        ORDER BY datetime ASC
    """
    articles = pd.read_sql(query, engine)
    articles['datetime'] = pd.to_datetime(articles['datetime'])
    
    if spy_daily.index.tz is not None: spy_daily.index = spy_daily.index.tz_localize(None)
    if not spy_intraday.empty and spy_intraday.index.tz is not None: spy_intraday.index = spy_intraday.index.tz_localize(None)

    updates = []
    for _, row in tqdm(articles.iterrows(), total=len(articles), desc="Calculating Outcomes"):
        try:
            article_dt = row['datetime']
            if article_dt.tzinfo is not None: article_dt = article_dt.tz_localize(None)

            current_price = None

            # 1. Determine Current Price
            if not spy_intraday.empty and article_dt >= spy_intraday.index[0] and article_dt <= spy_intraday.index[-1]:
                # Find closest 1m candle
                idx = spy_intraday.index.get_indexer([article_dt], method='nearest')[0]
                current_price = spy_intraday.iloc[idx]['close'].item()
            
            if current_price is None:
                # Fallback to Daily (using ffill logic we added)
                idx = spy_daily.index.get_indexer([article_dt.normalize()], method='ffill')[0]
                if idx >= 0:
                    current_price = spy_daily.iloc[idx]['close'].item()
            
            if current_price is None: continue

            # 2. Calculate Outcomes (PCT Change)
            pct_1h, pct_4h, pct_eod, pct_eow = None, None, None, None

            # ... [Intraday logic remains same] ...
            if not spy_intraday.empty:
                try:
                    target_1h = article_dt + timedelta(hours=1)
                    idx_1h = spy_intraday.index.get_indexer([target_1h], method='nearest')[0]
                    # Only use if within reasonable time distance (e.g. 5 mins)
                    if abs((spy_intraday.index[idx_1h] - target_1h).total_seconds()) < 300:
                        pct_1h = ((spy_intraday.iloc[idx_1h]['close'].item() - current_price) / current_price) * 100
                    
                    target_4h = article_dt + timedelta(hours=4)
                    idx_4h = spy_intraday.index.get_indexer([target_4h], method='nearest')[0]
                    if abs((spy_intraday.index[idx_4h] - target_4h).total_seconds()) < 300:
                        pct_4h = ((spy_intraday.iloc[idx_4h]['close'].item() - current_price) / current_price) * 100
                except: pass

            # EOD
            target_eod = article_dt.normalize()
            if article_dt.hour >= 16: target_eod += timedelta(days=1)
            
            # Using searchsorted for speed/robustness on Daily
            idx_eod = spy_daily.index.searchsorted(target_eod)
            if idx_eod < len(spy_daily):
                 pct_eod = ((spy_daily.iloc[idx_eod]['close'].item() - current_price) / current_price) * 100

            # EOW
            days_to_fri = (4 - article_dt.weekday()) % 7
            if days_to_fri == 0 and article_dt.hour >= 16: days_to_fri = 7
            target_eow = (article_dt + timedelta(days=days_to_fri)).normalize()
            
            idx_eow = spy_daily.index.searchsorted(target_eow)
            if idx_eow < len(spy_daily):
                 pct_eow = ((spy_daily.iloc[idx_eow]['close'].item() - current_price) / current_price) * 100
            
            if pct_eod is not None:
                updates.append((pct_1h, pct_4h, pct_eod, pct_eow, int(row['id'])))
                
            if len(updates) >= BATCH_SIZE:
                push_outcome_updates(updates)
                updates = []
                
        except Exception: continue
    
    if updates: push_outcome_updates(updates)

def push_outcome_updates(updates):
    if not updates: return
    sql = "UPDATE articles SET pct_change_1h=%s, pct_change_4h=%s, pct_change_eod=%s, pct_change_eow=%s WHERE id=%s"
    try:
        val = lambda x: float(x) if x is not None and not pd.isna(x) else None
        clean_updates = [(val(u[0]), val(u[1]), val(u[2]), val(u[3]), u[4]) for u in updates]
        executemany_update(sql, clean_updates)
    except Exception as e:
        logger.error(f"Outcome write error: {e}")

# ==========================================
#                MAIN
# ==========================================
def main():
    logger.info("🚀 Starting Phase 3 Final Integration (Full Fix)")
    ensure_all_columns_exist()

    logger.info("\n📈 Step 1: Processing Price & Technical Indicators...")
    tickers = get_all_tickers()
    update_buffer = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        results = list(tqdm(executor.map(process_ticker_repair, tickers), total=len(tickers), desc="Tickers"))
        for res in results:
            if res:
                update_buffer.extend(res)
                if len(update_buffer) >= BATCH_SIZE:
                    push_price_updates(update_buffer)
                    update_buffer = []
    if update_buffer:
        push_price_updates(update_buffer)

    logger.info("\n🕐 Step 2: Processing Temporal Features...")
    calculate_temporal_features()

    logger.info("\n📊 Step 3: Processing Market Context (VIX/SPY)...")
    process_market_context()
    
    logger.info("\n🎯 Step 4: Calculating Future Outcomes...")
    calculate_outcomes_for_articles()

    logger.info("\n✅ Phase 3 Fully Complete!")

if __name__ == "__main__":
    main()