import pandas as pd
import numpy as np
import joblib
import os
import sys
import lightgbm as lgb
import optuna
import logging
import matplotlib.pyplot as plt
from sqlalchemy import text
from sklearn.model_selection import TimeSeriesSplit
from sklearn.preprocessing import StandardScaler
from sklearn.impute import SimpleImputer
from sklearn.metrics import classification_report, f1_score, precision_recall_curve
from sklearn.feature_selection import SelectKBest, f_classif, mutual_info_classif
import warnings
from db_sqlite import get_engine, executemany_update

warnings.filterwarnings('ignore')

# === Configuration ===
SIGNIFICANCE_THRESHOLD = 1.5
TARGET_COLUMN = "significant_move"
MODEL_DIR = "models"

TARGET_MAP = {
    "1hr": "pct_change_1h",
    "4hr": "pct_change_4h",
    "eod": "pct_change_eod"
}

# Features present in your MySQL Schema
FEATURE_COLUMNS = [
    "sentiment_combined", "sentiment_dynamic", "sentiment_ml",
    "sentiment_keyword", "headline_sentiment", "sentiment_vader",
    "total_keywords", "keyword_density",
    "std_channel_width",
    "rsi_14", "macd", "macd_hist", "price_vs_sma50"
]

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("Phase4_Classifier")

def check_available_features():
    """Check which features actually exist in the database."""
    engine = get_engine()
    with engine.connect() as conn:
        result = conn.execute(text("SHOW COLUMNS FROM articles"))
        existing_cols = [row[0] for row in result.fetchall()]
    
    available_features = [f for f in FEATURE_COLUMNS if f in existing_cols]
    missing_features = [f for f in FEATURE_COLUMNS if f not in existing_cols]
    
    if missing_features:
        logger.warning(f"⚠️ Missing features in database: {missing_features}")
        logger.info(f"✅ Using {len(available_features)} available features: {available_features}")
    
    return available_features

def get_data_from_db(target_col, feature_cols):
    """Fetch training data (rows with known outcomes) from MySQL."""
    engine = get_engine()
    
    # First verify all columns exist
    with engine.connect() as conn:
        result = conn.execute(text("SHOW COLUMNS FROM articles"))
        existing_cols = {row[0] for row in result.fetchall()}
    
    # Filter to only columns that actually exist
    valid_features = [f for f in feature_cols if f in existing_cols]
    
    if len(valid_features) != len(feature_cols):
        missing = set(feature_cols) - set(valid_features)
        logger.warning(f"⚠️ Skipping missing columns in query: {missing}")
    
    cols = ", ".join([f"`{c}`" for c in valid_features])
    query = f"""
        SELECT id, `datetime`, {cols}, `{target_col}`
        FROM articles
        WHERE `{target_col}` IS NOT NULL
        ORDER BY `datetime` ASC
    """
    logger.info(f"⏳ Fetching training data for target: {target_col}...")
    df = pd.read_sql(query, engine)
    
    # Return df and the actual columns we got
    return df, valid_features

def get_inference_data_from_db(target_col, feature_cols):
    """Fetch 'Weekend' data (rows with NO outcome yet) for prediction."""
    engine = get_engine()
    
    # Verify columns exist
    with engine.connect() as conn:
        result = conn.execute(text("SHOW COLUMNS FROM articles"))
        existing_cols = {row[0] for row in result.fetchall()}
    
    valid_features = [f for f in feature_cols if f in existing_cols]
    
    cols = ", ".join([f"`{c}`" for c in valid_features])
    query = f"""
        SELECT id, `datetime`, {cols}
        FROM articles
        WHERE `{target_col}` IS NULL
        AND sentiment_combined IS NOT NULL
    """
    logger.info("⏳ Fetching new data for inference...")
    df = pd.read_sql(query, engine)
    return df, valid_features

def update_db_predictions(updates):
    """Write predictions back to MySQL."""
    if not updates: return
    sql = """
        UPDATE articles 
        SET sentiment_category = %s,
            ml_confidence = %s
        WHERE id = %s
    """
    try:
        executemany_update(sql, updates)
        logger.info(f"💾 Updated {len(updates)} articles with Gatekeeper status.")
    except Exception as e:
        logger.error(f"❌ DB Write Error: {e}")

def select_best_features(X, y, feature_names, max_features=20):
    """Select best features, handling cases where we have fewer features than max."""
    max_features = min(max_features, len(feature_names))
    sel_f = SelectKBest(f_classif, k='all').fit(X, y)
    scores = sel_f.scores_
    scores = np.nan_to_num(scores)
    top_idx = np.argsort(scores)[-max_features:]
    return [feature_names[i] for i in top_idx]

def objective(trial, X_train, y_train, X_val, y_val):
    params = {
        "objective": "binary",
        "metric": "binary_logloss",
        "boosting_type": "gbdt",
        "verbosity": -1,
        "n_estimators": trial.suggest_int("n_estimators", 100, 500),
        "num_leaves": trial.suggest_int("num_leaves", 20, 60),
        "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.1),
        "subsample": trial.suggest_float("subsample", 0.6, 1.0),
        "colsample_bytree": trial.suggest_float("colsample_bytree", 0.6, 1.0),
    }
    model = lgb.LGBMClassifier(**params, random_state=42, class_weight="balanced")
    model.fit(X_train, y_train)
    y_probs = model.predict_proba(X_val)[:, 1]
    
    precisions, recalls, thresholds = precision_recall_curve(y_val, y_probs)
    f1_scores = 2 * (precisions * recalls) / (precisions + recalls + 1e-8)
    return np.max(f1_scores)

def patch_weekend_data(df):
    """
    Logic: If a row is on a weekend (Sat/Sun), forward-fill market data 
    from the last available trading day (Friday).
    """
    logger.info("🛠️ Patching weekend data: Syncing Sat/Sun market features to Friday close...")
    
    # 1. Ensure strictly sorted by time so ffill works correctly
    df = df.sort_values(by='datetime').reset_index(drop=True)
    
    # 2. List of Market/Technical columns to carry forward
    # (Do NOT patch 'sentiment' or 'headline'—those are specific to the article)
    market_cols = [
        "price_vs_sma50", "rsi_14", "macd", "macd_hist", 
        "vix_close", "spy_daily_return", "std_channel_width", 
        "hour_sin", "hour_cos"
    ]
    
    # Filter for columns that actually exist in this dataframe
    cols_to_patch = [c for c in market_cols if c in df.columns]
    
    if not cols_to_patch:
        return df

    # 3. Forward Fill specific columns
    df[cols_to_patch] = df[cols_to_patch].ffill()
    
    return df

def main():
    target_horizon = sys.argv[1].lower() if len(sys.argv) > 1 else "eod"
    target_price_col = TARGET_MAP.get(target_horizon, "pct_change_eod")
    
    logger.info(f"🚀 Starting Gatekeeper Training ({target_horizon.upper()})")

    # 1. Check which features are available FIRST
    available_features = check_available_features()
    if len(available_features) < 5:
        logger.error(f"❌ Not enough features! Only found {len(available_features)}.")
        return
    
    logger.info(f"📊 Will use {len(available_features)} features for training")

    # 2. Load Training Data with only available features
    df, actual_features = get_data_from_db(target_price_col, available_features)
    if len(df) < 100:
        logger.error(f"Not enough data to train! Found {len(df)} rows.")
        return

    # --- WEEKEND PATCH ---
    df = patch_weekend_data(df)
    # ---------------------
    
    logger.info(f"✅ Loaded data with {len(actual_features)} features: {actual_features}")

    # 3. Create Target
    df[TARGET_COLUMN] = (df[target_price_col].abs() >= (SIGNIFICANCE_THRESHOLD/100.0)).astype(int)
    
    logger.info(f"Training on {len(df)} samples. Signal Rate: {df[TARGET_COLUMN].mean():.1%}")

    # 4. Preprocessing - use actual_features, not available_features
    X = df[actual_features]
    y = df[TARGET_COLUMN]

    logger.info(f"🔍 X shape before imputation: {X.shape}")
    
    # Check for completely null columns
    null_counts = X.isnull().sum()
    all_null_cols = null_counts[null_counts == len(X)].index.tolist()
    
    if all_null_cols:
        logger.warning(f"⚠️ Dropping completely NULL columns: {all_null_cols}")
        actual_features = [f for f in actual_features if f not in all_null_cols]
        X = X[actual_features]
        logger.info(f"✅ Remaining features: {len(actual_features)}")

    # Handle missing data - use add_indicator=False to prevent dimension changes
    imputer = SimpleImputer(strategy="median", add_indicator=False)
    X_imputed = imputer.fit_transform(X)
    
    logger.info(f"🔍 X_imputed shape after transform: {X_imputed.shape}")
    logger.info(f"🔍 Expected columns: {len(actual_features)}")
    
    # Convert back to DataFrame with ACTUAL column names
    X_imputed = pd.DataFrame(X_imputed, columns=actual_features)
    
    # Feature Selection
    max_feats = min(15, len(actual_features))
    selected_feats = select_best_features(X_imputed, y, actual_features, max_features=max_feats)
    X_sel = X_imputed[selected_feats]
    
    logger.info(f"📊 Selected {len(selected_feats)} features: {selected_feats}")
    
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X_sel)

    # 5. Split & Optimize
    split = int(0.8 * len(X_scaled))
    X_train, X_val = X_scaled[:split], X_scaled[split:]
    y_train, y_val = y[:split], y[split:]

    logger.info("🧠 Optimizing Hyperparameters...")
    study = optuna.create_study(direction="maximize")
    study.optimize(lambda t: objective(t, X_train, y_train, X_val, y_val), n_trials=15, show_progress_bar=True)

    # 6. Train Final Model
    logger.info(f"✅ Best F1 Score: {study.best_value:.3f}")
    best_model = lgb.LGBMClassifier(**study.best_params, random_state=42, class_weight="balanced")
    best_model.fit(X_train, y_train)

    # 7. Evaluate
    y_pred = best_model.predict(X_val)
    logger.info("\n📈 Validation Performance:")
    print(classification_report(y_val, y_pred, target_names=["Noise", "Signal"]))

    # 8. Save Model Artifacts
    os.makedirs(MODEL_DIR, exist_ok=True)
    model_path = f"{MODEL_DIR}/gatekeeper_{target_horizon}.pkl"
    joblib.dump({
        "model": best_model,
        "scaler": scaler,
        "imputer": imputer,
        "features": selected_feats,
        "available_features": available_features  # Store for inference
    }, model_path)
    logger.info(f"✅ Model saved to {model_path}")

    # 9. RUN INFERENCE on New Data
    df_new, inference_features = get_inference_data_from_db(target_price_col, actual_features)
    if not df_new.empty:
        # --- WEEKEND PATCH FOR INFERENCE ---
        df_new = patch_weekend_data(df_new)
        # -----------------------------------

        logger.info(f"🔮 Predicting on {len(df_new)} new articles...")
        X_new = df_new[inference_features]
        X_new_imp = imputer.transform(X_new)
        X_new_imp = pd.DataFrame(X_new_imp, columns=inference_features)
        X_new_sel = X_new_imp[selected_feats]
        X_new_scaled = scaler.transform(X_new_sel)
        
        probs = best_model.predict_proba(X_new_scaled)[:, 1]
        
        updates = []
        for idx, row in df_new.iterrows():
            prob = float(probs[idx])
            art_id = row['id']
            
            # Logic: If Prob > 0.6 it's a "Signal", else "Noise"
            cat = "Signal" if prob > 0.6 else "Noise"
            updates.append((cat, prob, art_id))
        
        update_db_predictions(updates)
    else:
        logger.info("No new data needing predictions.")

if __name__ == "__main__":
    main()