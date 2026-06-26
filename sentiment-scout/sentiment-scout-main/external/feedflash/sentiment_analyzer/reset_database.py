from sqlalchemy import text
from db_sqlite import get_engine

def reset_all():
    engine = get_engine()
    if not engine:
        print("❌ Could not connect to database.")
        return

    print("🗑️ Performing HARD RESET (Keeping Headlines, URLs, & Dates ONLY)...")
    print("⚠️  This will wipe all Sentiment, Prices, and Technicals.")

    with engine.connect() as conn:
        # We update every derived column to NULL
        query = text("""
            UPDATE articles 
            SET 
                -- 1. Reset Sentiment & NLP
                sentiment_combined = NULL, 
                sentiment_dynamic = NULL, 
                sentiment_ml = NULL,
                sentiment_keyword = NULL, 
                sentiment_vader = NULL, 
                headline_sentiment = NULL,
                sentiment_category = NULL, 
                ml_confidence = NULL, 
                sentiment_strength = NULL,
                sentiment_score = NULL, 
                sentiment_gpt = NULL, 
                gpt_reasoning = NULL,
                sentiment_finbert_tone = NULL, 
                sentiment_finbert_prosus = NULL,
                tokens = NULL, 
                mentions = NULL, 
                pos_keywords = NULL, 
                neg_keywords = NULL, 
                total_keywords = NULL, 
                text_length = NULL, 
                keyword_density = NULL,
                prediction_confidence = NULL,

                -- 2. Reset Prices & Market Data
                `Close` = NULL, 
                `Open` = NULL, 
                `High` = NULL, 
                `Low` = NULL, 
                `Volume` = NULL, 
                `Adj_Close` = NULL,
                pct_change_1h = NULL, 
                pct_change_4h = NULL, 
                pct_change_eod = NULL, 
                pct_change_eow = NULL,
                direction_1h = NULL, 
                direction_4h = NULL, 
                direction_eod = NULL, 
                direction_eow = NULL,

                -- 3. Reset Technicals & Context
                rsi_14 = NULL, 
                macd = NULL, 
                macd_hist = NULL, 
                price_vs_sma50 = NULL,
                std_upper = NULL, 
                std_lower = NULL, 
                std_channel_width = NULL,
                vix_close = NULL, 
                spy_daily_return = NULL,
                hour_sin = NULL, 
                hour_cos = NULL, 
                day_of_week = NULL
        """)
        
        try:
            conn.execute(query)
            conn.commit()
            print("✅ Database wiped cleanly.")
            print("   - KEPT: Ticker, Date, Headline, URL, Text")
            print("   - WIPED: Sentiment, Prices, Technicals, ML Predictions")
        except Exception as e:
            print(f"❌ Error during reset: {e}")

if __name__ == "__main__":
    reset_all()