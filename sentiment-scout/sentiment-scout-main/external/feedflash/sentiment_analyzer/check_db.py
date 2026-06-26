import pandas as pd
from sqlalchemy import text
from db_sqlite import get_engine

def check_mysql_db():
    engine = get_engine()
    
    print("\n" + "="*60)
    print(" 📊 SYSTEM STATUS REPORT (ALL PHASES)")
    print("="*60)
    
    try:
        with engine.connect() as conn:
            # --- 1. GLOBAL COUNTS ---
            stats_query = text("""
            SELECT 
                COUNT(*) as Total,
                COUNT(DISTINCT ticker) as Tickers,
                COUNT(sentiment_combined) as Phase2_Sentiment,
                COUNT(Close) as Phase3_Prices,
                COUNT(std_upper) as Phase3_STD_Logic,
                MIN(datetime) as Earliest,
                MAX(datetime) as Latest
            FROM articles
            """)
            
            row = conn.execute(stats_query).fetchone()
            total = row[0]
            
            print(f"Total Articles:      {total}")
            print(f"Unique Tickers:      {row[1]}")
            print(f"Data Span:           {row[5]}  <-->  {row[6]}")
            print("-" * 40)
            
            # Calculate percentages
            if total > 0:
                p2 = round(row[2]/total * 100, 1)
                p3_price = round(row[3]/total * 100, 1)
                p3_std = round(row[4]/total * 100, 1)
            else:
                p2 = p3_price = p3_std = 0

            print(f"✅ Phase 2 (Sentiment):   {row[2]} rows ({p2}%)")
            print(f"✅ Phase 3 (Prices):      {row[3]} rows ({p3_price}%)")
            print(f"✅ Phase 3 (STD Chan):    {row[4]} rows ({p3_std}%)")
            print("="*60)

            # --- 2. DATA SAMPLE (EVERYTHING) ---
            print("\n🔍 RECENT DATA SAMPLE (Price + Sentiment + Technicals)")
            
            # Fixed the typo in column alias below
            sample_query = text("""
            SELECT 
                ticker, 
                DATE_FORMAT(datetime, '%Y-%m-%d') as date,
                LEFT(headline, 25) as headline_short,
                ROUND(sentiment_combined, 3) as Sent,
                ROUND(Close, 2) as Price,
                ROUND(pct_change_eod, 2) as 'Chg%',
                ROUND(std_upper, 2) as Upper,
                ROUND(std_lower, 2) as Lower,
                ROUND(std_channel_width, 3) as Width
            FROM articles 
            WHERE Close IS NOT NULL 
            ORDER BY id DESC 
            LIMIT 15
            """)
            
            df = pd.read_sql(sample_query, conn)
            
            if df.empty:
                print("⚠️ No completed records found. (Is Phase 3 finished?)")
            else:
                # Format for clean printing
                pd.set_option('display.max_columns', 20)
                pd.set_option('display.width', 2000)
                pd.set_option('display.expand_frame_repr', False)
                print(df.to_string(index=False))
                
            print("\n" + "="*60)

    except Exception as e:
        print(f"❌ Database Error: {e}")

if __name__ == "__main__":
    check_mysql_db()