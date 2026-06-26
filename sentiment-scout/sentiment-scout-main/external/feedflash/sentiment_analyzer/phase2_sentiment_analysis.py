import time
import logging
import nltk
import numpy as np
from tqdm import tqdm
from sqlalchemy import text
from concurrent.futures import ProcessPoolExecutor
from nltk.sentiment.vader import SentimentIntensityAnalyzer

# Import your custom modules
from db_sqlite import get_engine, executemany_update
from integrated_processor import FinancialSentimentProcessor

# === CONFIGURATION ===
BATCH_SIZE = 5000
MAX_WORKERS = 8 # Set to how many CPU cores available on your machine
CONFIDENCE_THRESHOLD = 0.40  # Threshold to mark as 'Signal' for the dashboard

# Setup Logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("Phase2_Sentiment")

# Ensure VADER lexicon is downloaded
try:
    nltk.data.find('sentiment/vader_lexicon.zip')
except LookupError:
    nltk.download('vader_lexicon', quiet=True)

# Global processor for workers
worker_processor = None
worker_vader = None

def init_worker():
    """Initialize the heavy NLP models once per process."""
    global worker_processor, worker_vader
    worker_processor = FinancialSentimentProcessor()
    worker_vader = SentimentIntensityAnalyzer()

def get_unprocessed_articles():
    """Fetch articles that have NO sentiment score OR NO category yet."""
    engine = get_engine()
    with engine.connect() as conn:
        query = text("""
            SELECT id, headline, `text` 
            FROM articles 
            WHERE sentiment_combined IS NULL OR sentiment_category IS NULL
            ORDER BY datetime DESC
        """)
        result = conn.execute(query).fetchall()
        return [{'id': r[0], 'headline': r[1], 'text': r[2]} for r in result]

def process_single_row_worker(row):
    """
    Worker function to calculate sentiment AND assign Signal/Noise category.
    FIXED VERSION with improved confidence calculation.
    """
    global worker_processor, worker_vader
    
    try:
        # Combine headline and body for full context
        text_content = f"{row['headline']} {row['text'] if row['text'] else ''}".strip()
        
        if not text_content:
            return None

        # 1. Run integrated processor (FinBERT, Dictionary, Kris ML, Question Detection)
        scores = worker_processor.calculate_enhanced_sentiment(text_content)
        
        # 2. Run VADER (Headline & Full)
        vader_full_score = worker_vader.polarity_scores(text_content)['compound']
        headline_score = worker_vader.polarity_scores(row['headline'])['compound']

        # Extract values
        sent_ml = float(scores.get('ml_prediction', 0) or 0)       # FinBERT
        sent_keyword = float(scores.get('keyword_based', 0) or 0)  # Dictionary
        sent_question = float(scores.get('question_bias', 0) or 0) # Question detection
        sent_combined = float(scores.get('combined', 0) or 0)      # Weighted average
        sent_dynamic = sent_ml  # Using FinBERT as dynamic proxy
        
        # --- FIXED CONFIDENCE CALCULATION ---
        
        # 1. Model Agreement (comparing core models only, not combined)
        # Use FinBERT, Dictionary, VADER, and Question Bias
        model_scores = [sent_ml, sent_keyword, vader_full_score]
        
        # Add question bias if present (helps with question-format headlines)
        if abs(sent_question) > 0.1:
            model_scores.append(sent_question)
        
        # Calculate normalized standard deviation
        # Max possible std for range [-1, 1] is ~0.816
        raw_std = np.std(model_scores)
        normalized_std = min(raw_std / 0.816, 1.0)  # Normalize to [0, 1]
        agreement_score = 1.0 - normalized_std
        
        # 2. Signal Magnitude (how strong is the sentiment?)
        magnitude_score = abs(sent_combined)
        
        # 3. Check for "weak signal" (all models near zero)
        max_signal = max(abs(s) for s in model_scores)
        weak_signal_penalty = 1.0 if max_signal >= 0.15 else 0.5
        
        # 4. Keyword Strength Bonus (strong keywords = more confidence)
        keyword_bonus = 0.15 if abs(sent_keyword) > 0.8 else 0.0
        
        # 5. Question Pattern Bonus (if question detection fired, boost confidence)
        question_bonus = 0.10 if abs(sent_question) > 0.3 else 0.0
        
        # Final Confidence Calculation
        ml_confidence = (
            (agreement_score * 0.30) +      # Models agree on direction
            (magnitude_score * 0.35) +      # Strong sentiment
            keyword_bonus +                  # Strong keywords present
            question_bonus                   # Question pattern detected
        ) * weak_signal_penalty             # Penalize if all models are weak
        
        # Clamp to [0, 1]
        ml_confidence = min(max(ml_confidence, 0.0), 1.0)

        # Assign Category (Signal vs Noise)
        # ADAPTIVE THRESHOLD: Lower threshold for high-magnitude signals
        # Strong sentiment (>0.45 or <-0.45) gets easier pass
        effective_threshold = CONFIDENCE_THRESHOLD
        if abs(sent_combined) > 0.45:
            effective_threshold = max(0.35, CONFIDENCE_THRESHOLD - 0.05)
        
        if ml_confidence >= effective_threshold:
            sentiment_category = "Signal"
        else:
            sentiment_category = "Noise"

        article_id = row['id']  # SQLite ids are UUID strings, not integers

        # Return tuple matching SQL column order
        return (
            sent_dynamic, 
            sent_ml, 
            sent_keyword, 
            sent_combined, 
            vader_full_score, 
            headline_score,
            sentiment_category,
            ml_confidence,
            article_id
        )
    except Exception as e:
        logger.error(f"Processing error for article {row.get('id')}: {e}")
        # Return None to skip this article rather than crashing the batch
        return None

def update_db_sentiment(updates):
    """Bulk update the database with calculated scores AND category."""
    sql = """
        UPDATE articles
        SET sentiment_dynamic = ?,
            sentiment_ml = ?,
            sentiment_keyword = ?,
            sentiment_combined = ?,
            sentiment_vader = ?,
            headline_sentiment = ?,
            sentiment_category = ?,
            ml_confidence = ?
        WHERE id = ?
    """
    try:
        executemany_update(sql, updates)
        logger.info(f"💾 Saved batch of {len(updates)} articles (Signal/Noise assigned).")
    except Exception as e:
        logger.error(f"DB Write Error: {e}")

def main():
    logger.info("=" * 60)
    logger.info("🚀 Starting Phase 2: FIXED Sentiment + Lite Gatekeeper")
    logger.info("=" * 60)
    
    # 1. Get unprocessed articles
    articles = get_unprocessed_articles()
    total = len(articles)
    
    if total == 0:
        logger.info("✅ No new articles to process.")
        return

    logger.info(f"📝 Found {total} articles needing classification.")
    logger.info(f"🎯 Threshold for Signal: {CONFIDENCE_THRESHOLD}")
    logger.info(f"⚙️ Using {MAX_WORKERS} worker processes")
    
    start_time = time.time()

    # 2. Process in batches with multiprocessing
    update_buffer = []
    processed = 0
    signal_count = 0
    noise_count = 0
    
    with ProcessPoolExecutor(max_workers=MAX_WORKERS, initializer=init_worker) as executor:
        results_generator = executor.map(process_single_row_worker, articles)
        
        for res in tqdm(results_generator, total=total, unit="articles", desc="Classifying"):
            if res:
                update_buffer.append(res)
                processed += 1
                
                # Track Signal vs Noise counts
                if res[6] == "Signal":  # sentiment_category is at index 6
                    signal_count += 1
                else:
                    noise_count += 1
                
                if len(update_buffer) >= BATCH_SIZE:
                    update_db_sentiment(update_buffer)
                    update_buffer = []

    # 3. Final flush
    if update_buffer:
        update_db_sentiment(update_buffer)

    elapsed_time = time.time() - start_time
    articles_per_second = processed / elapsed_time if elapsed_time > 0 else 0
    signal_percentage = (signal_count / processed * 100) if processed > 0 else 0
    
    logger.info("=" * 60)
    logger.info(f"✅ Phase 2 Complete!")
    logger.info(f"✅ Processed {processed} articles with FIXED scoring.")
    logger.info(f"📊 Signals: {signal_count} ({signal_percentage:.1f}%)")
    logger.info(f"📊 Noise: {noise_count} ({100-signal_percentage:.1f}%)")
    logger.info(f"⏱️ Time elapsed: {elapsed_time:.1f}s ({articles_per_second:.1f} articles/sec)")
    logger.info(f"💡 Dashboard should now show accurate 'Signals'.")
    logger.info("=" * 60)

if __name__ == "__main__":
    main()