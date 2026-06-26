from db_sqlite import get_engine
import pandas as pd
engine = get_engine()
if engine:
    query = """
    SELECT 
        id, ticker, datetime(publish_date, 'unixepoch') as datetime,
        title as headline, url,
        CASE 
            WHEN sentiment = 'Positive' THEN 1.0 
            WHEN sentiment = 'Negative' THEN -1.0 
            ELSE 0.0 
        END as sentiment_combined,
        sentiment as sentiment_category,
        ml_confidence,
        price_at as price_close,
        NULL as price_open, NULL as price_high, NULL as price_low, NULL as volume,
        ((price_after_24h - price_at) / price_at * 100) as pct_change_eod,
        NULL as rsi_14, NULL as vix_close,
        NULL as std_upper, NULL as std_lower, NULL as macd, NULL as macd_hist
    FROM articles
    ORDER BY publish_date DESC
    LIMIT 3
    """
    with engine.connect() as conn:
        df = pd.read_sql(query, conn)
        print(df)
