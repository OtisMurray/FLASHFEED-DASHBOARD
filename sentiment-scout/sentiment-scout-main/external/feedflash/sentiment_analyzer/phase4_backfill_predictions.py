import pandas as pd
import joblib
import os
import sys
import logging
from sqlalchemy import text
from sklearn.preprocessing import StandardScaler
from sklearn.impute import SimpleImputer
from db_sqlite import get_engine, executemany_update

# === CONFIGURATION ===
MODEL_PATH = "models/gatekeeper_eod.pkl"
BATCH_SIZE = 5000

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("Phase4_Backfill")

def patch_weekend_data(df):
    """
    Apply the same weekend patch used in training.
    This ensures the features match what the model expects.
    """
    df = df.sort_values(by='datetime').reset_index(drop=True)
    market_cols = [
        "price_vs_sma50", "rsi_14", "macd", "macd_hist", 
        "vix_close", "spy_daily_return", "std_channel_width", 
        "hour_sin", "hour_cos"
    ]
    cols_to_patch = [c for c in market_cols if c in df.columns]
    if cols_to_patch:
        df[cols_to_patch] = df[cols_to_patch].ffill()
    return df

def main():
    logger.info("🚀 Starting Phase 4 Backfill: Updating Historical Confidence Scores...")
    
    # 1. Load Model
    if not os.path.exists(MODEL_PATH):
        logger.error(f"❌ Model not found: {MODEL_PATH}")
        logger.error("💡 Please run 'python phase4_classifier_mysql.py eod' first!")
        return

    logger.info(f"📦 Loading trained model from {MODEL_PATH}...")
    gk_package = joblib.load(MODEL_PATH)
    model = gk_package["model"]
    scaler = gk_package["scaler"]
    imputer = gk_package["imputer"]
    features = gk_package["features"]
    
    # Handle older model files that might not have this key
    actual_features = gk_package.get("available_features", features)

    # 2. Fetch ALL Data (Historical + New)
    engine = get_engine()
    cols = ", ".join([f"`{c}`" for c in actual_features])
    
    # We fetch ID and Features. We score EVERYTHING.
    query = f"""
        SELECT id, `datetime`, {cols}
        FROM articles
        ORDER BY datetime ASC
    """
    logger.info("⏳ Fetching entire article history from database...")
    df = pd.read_sql(query, engine)
    logger.info(f"✅ Loaded {len(df)} articles.")

    if df.empty:
        logger.warning("⚠️ No articles found in database.")
        return

    # 3. Apply Patch & Preprocessing
    logger.info("🛠️ Patching weekend gaps in history...")
    df = patch_weekend_data(df)
    
    X = df[actual_features]
    
    # Handle missing values (same logic as training)
    null_counts = X.isnull().sum()
    all_null_cols = null_counts[null_counts == len(X)].index.tolist()
    if all_null_cols:
        logger.warning(f"⚠️ Dropping empty columns: {all_null_cols}")
        actual_features = [f for f in actual_features if f not in all_null_cols]
        X = X[actual_features]

    # Impute
    logger.info("⚙️  Preprocessing features (Impute & Scale)...")
    try:
        X_imp = imputer.transform(X)
        X_imp = pd.DataFrame(X_imp, columns=actual_features)
        
        # Select Best Features
        X_sel = X_imp[features]
        
        # Scale
        X_scaled = scaler.transform(X_sel)
    except Exception as e:
        logger.error(f"❌ Preprocessing Error: {e}")
        logger.error("The features in the database might not match the trained model.")
        return

    # 4. Predict
    logger.info("🔮 Generating AI confidence scores for all history...")
    probs = model.predict_proba(X_scaled)[:, 1]

    # 5. Update Database in Batches
    updates = []
    logger.info("💾 Preparing database updates...")
    
    for idx, prob in enumerate(probs):
        art_id = df.iloc[idx]['id']
        # Recalculate Category based on the 0.6 threshold
        cat = "Signal" if prob > 0.6 else "Noise"
        updates.append((cat, float(prob), int(art_id)))

    logger.info(f"⚡ Pushing {len(updates)} updates to MySQL (Batch Size: {BATCH_SIZE})...")
    
    sql = """
        UPDATE articles 
        SET sentiment_category = %s,
            ml_confidence = %s
        WHERE id = %s
    """
    
    total = len(updates)
    for i in range(0, total, BATCH_SIZE):
        batch = updates[i:i+BATCH_SIZE]
        try:
            executemany_update(sql, batch)
            logger.info(f"   - Updated rows {i} to {min(i+BATCH_SIZE, total)}")
        except Exception as e:
            logger.error(f"❌ Batch write error at index {i}: {e}")

    logger.info("✅ Backfill Complete! Your dashboard should now show organic clouds.")

if __name__ == "__main__":
    main()