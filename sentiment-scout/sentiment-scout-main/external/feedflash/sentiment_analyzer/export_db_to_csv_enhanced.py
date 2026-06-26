import pandas as pd
import logging
import sys
from sqlalchemy import text
from db_sqlite import get_engine

# === CONFIGURATION ===
OUTPUT_FILE = "final_integrated_dataset.csv"
BATCH_SIZE = 50000

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("Exporter")

def get_data_statistics(engine):
    """Show statistics about available data."""
    with engine.connect() as conn:
        stats = {}
        
        # Total articles
        result = conn.execute(text("SELECT COUNT(*) FROM articles"))
        stats['total'] = result.scalar()
        
        # Articles with sentiment
        result = conn.execute(text("SELECT COUNT(*) FROM articles WHERE sentiment_combined IS NOT NULL"))
        stats['with_sentiment'] = result.scalar()
        
        # Articles with price data (FIXED: Pointing to new 'price_close' column)
        result = conn.execute(text("SELECT COUNT(*) FROM articles WHERE price_close IS NOT NULL"))
        stats['with_price'] = result.scalar()
        
        # Articles with BOTH
        result = conn.execute(text("""
            SELECT COUNT(*) FROM articles 
            WHERE sentiment_combined IS NOT NULL 
            AND price_close IS NOT NULL
        """))
        stats['complete'] = result.scalar()
        
        # Articles with ML predictions
        result = conn.execute(text("SELECT COUNT(*) FROM articles WHERE sentiment_category IS NOT NULL"))
        stats['with_predictions'] = result.scalar()
        
    return stats

def export_db_to_csv(export_type='all'):
    """
    Export database to CSV.
    """
    engine = get_engine()
    
    logger.info("🚀 Starting Database Export (Updated Schema)...")
    logger.info(f"📊 Export Type: {export_type}")
    
    # Show statistics first
    stats = get_data_statistics(engine)
    logger.info("\n📈 Database Statistics:")
    logger.info(f"   Total Articles:          {stats['total']:,}")
    logger.info(f"   With Sentiment:          {stats['with_sentiment']:,} ({stats['with_sentiment']/stats['total']*100:.1f}%)")
    logger.info(f"   With Price Data:         {stats['with_price']:,} ({stats['with_price']/stats['total']*100:.1f}%)")
    logger.info(f"   Complete (Sent+Price):   {stats['complete']:,} ({stats['complete']/stats['total']*100:.1f}%)")
    logger.info(f"   With ML Predictions:     {stats['with_predictions']:,}\n")
    
    # Build WHERE clause based on export type
    where_clause = ""
    if export_type == 'complete':
        # FIXED: Use price_close
        where_clause = "WHERE sentiment_combined IS NOT NULL AND price_close IS NOT NULL"
        output_file = "dataset_complete.csv"
    elif export_type == 'predicted':
        where_clause = "WHERE sentiment_category IS NOT NULL"
        output_file = "dataset_predicted.csv"
    else:
        output_file = OUTPUT_FILE
    
    # Main query - FIXED column mapping
    query = text(f"""
        SELECT 
            id,
            ticker, 
            `datetime`, 
            headline, 
            url,
            
            -- Sentiment Scores
            sentiment_combined,
            sentiment_dynamic,
            sentiment_ml,
            sentiment_keyword,
            headline_sentiment,
            sentiment_vader,
            
            -- Market Data (FIXED: No longer aliasing 'Close', selecting real columns)
            price_close,
            price_open,
            price_high,
            price_low,
            volume,
            
            -- Outcomes
            pct_change_eod,
            pct_change_eow,
            pct_change_1h,  -- Added Phase 3 outcome
            pct_change_4h,  -- Added Phase 3 outcome
            
            -- Technical Indicators
            rsi_14,
            macd,
            macd_hist,
            price_vs_sma50,
            std_upper,
            std_lower,
            std_channel_width,
            
            -- Market Context
            vix_close,
            spy_daily_return,
            
            -- Temporal Features
            hour_sin,
            hour_cos,
            day_of_week,
            
            -- ML Predictions
            sentiment_category,
            ml_confidence
            
        FROM articles
        {where_clause}
        ORDER BY `datetime` DESC
    """)
    
    try:
        # Stream the results in chunks
        with engine.connect().execution_options(stream_results=True) as conn:
            chunks = pd.read_sql(query, conn, chunksize=BATCH_SIZE)
            
            first_chunk = True
            total_rows = 0
            
            for chunk in chunks:
                mode = 'w' if first_chunk else 'a'
                header = first_chunk
                
                chunk.to_csv(output_file, mode=mode, header=header, index=False)
                
                total_rows += len(chunk)
                logger.info(f"   Exported {total_rows:,} rows...")
                first_chunk = False
                
        logger.info(f"\n✅ Export Complete!")
        logger.info(f"📁 Saved {total_rows:,} rows to '{output_file}'")
        
        # Show sample of what was exported
        logger.info("\n📋 Sample of exported data:")
        if total_rows > 0:
            sample = pd.read_csv(output_file, nrows=3)
            # Show relevant columns to verify price data
            print(sample[['ticker', 'datetime', 'price_close', 'sentiment_combined']].to_string())
        
    except Exception as e:
        logger.error(f"❌ Export Failed: {e}")
        import traceback
        traceback.print_exc()

def main():
    export_type = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if export_type not in ['all', 'complete', 'predicted']:
        logger.error("Invalid export type. Use: 'all', 'complete', or 'predicted'")
        return
    export_db_to_csv(export_type)

if __name__ == "__main__":
    main()