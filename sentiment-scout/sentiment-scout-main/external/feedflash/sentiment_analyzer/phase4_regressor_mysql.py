import pandas as pd
import numpy as np
import joblib
import os
import sys
import logging
from sqlalchemy import text
from sklearn.ensemble import RandomForestRegressor, GradientBoostingRegressor
from sklearn.linear_model import Lasso
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.preprocessing import StandardScaler
from sklearn.impute import SimpleImputer
import warnings
from db_sqlite import get_engine

warnings.filterwarnings('ignore')

# === CONFIGURATION ===
MODEL_DIR = "models"
TARGET_MAP = {
    "1hr": "pct_change_1h",
    "4hr": "pct_change_4h",
    "eod": "pct_change_eod"
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("Phase4_Regressor")

def check_available_features(required_features):
    """Check which features actually exist in the database."""
    engine = get_engine()
    with engine.connect() as conn:
        result = conn.execute(text("SHOW COLUMNS FROM articles"))
        existing_cols = {row[0] for row in result.fetchall()}
    
    available = [f for f in required_features if f in existing_cols]
    missing = [f for f in required_features if f not in existing_cols]
    
    if missing:
        logger.warning(f"⚠️ Missing features in database: {missing}")
    
    logger.info(f"✅ Using {len(available)} available features")
    return available

def get_data_from_db(target_col, feature_cols):
    """Fetch training data from MySQL."""
    engine = get_engine()
    
    # Verify columns exist
    with engine.connect() as conn:
        result = conn.execute(text("SHOW COLUMNS FROM articles"))
        existing_cols = {row[0] for row in result.fetchall()}
    
    valid_features = [f for f in feature_cols if f in existing_cols]
    
    cols = ", ".join([f"`{c}`" for c in valid_features])
    query = f"""
        SELECT id, `datetime`, ticker, headline, {cols}, `{target_col}`
        FROM articles
        WHERE `{target_col}` IS NOT NULL
        ORDER BY `datetime` ASC
    """
    logger.info(f"⏳ Fetching regression training data...")
    df = pd.read_sql(query, engine)
    
    return df, valid_features

def load_gatekeeper_model(target_horizon):
    """Load the pre-trained gatekeeper classifier."""
    gk_path = f"{MODEL_DIR}/gatekeeper_{target_horizon}.pkl"
    
    if not os.path.exists(gk_path):
        raise FileNotFoundError(f"❌ Gatekeeper model not found at {gk_path}. Run classifier first!")
    
    logger.info(f"📦 Loading gatekeeper model from {gk_path}")
    gk_package = joblib.load(gk_path)
    
    return gk_package

def add_gatekeeper_confidence(df, gk_package):
    """Add gatekeeper confidence scores as a feature."""
    gk_model = gk_package["model"]
    gk_scaler = gk_package["scaler"]
    gk_imputer = gk_package["imputer"]
    gk_feats = gk_package["features"]
    
    # Handle both old and new gatekeeper models
    actual_gk_features = gk_package.get("actual_features", gk_feats)
    
    logger.info(f"🔮 Generating gatekeeper confidence scores...")
    
    # Check which gatekeeper features are available in current dataframe
    available_gk_features = [f for f in actual_gk_features if f in df.columns]
    
    if len(available_gk_features) < len(gk_feats):
        logger.warning(f"⚠️ Some gatekeeper features missing. Using {len(available_gk_features)}/{len(actual_gk_features)}")
    
    # Apply same preprocessing pipeline as classifier
    X_raw = df[available_gk_features].copy()
    
    # Check for completely null columns
    null_counts = X_raw.isnull().sum()
    all_null_cols = null_counts[null_counts == len(X_raw)].index.tolist()
    
    if all_null_cols:
        logger.warning(f"⚠️ Dropping NULL columns for gatekeeper: {all_null_cols}")
        available_gk_features = [f for f in available_gk_features if f not in all_null_cols]
        X_raw = X_raw[available_gk_features]
    
    # Impute - handle potential shape mismatch
    try:
        X_imp = gk_imputer.transform(X_raw)
        X_imp = pd.DataFrame(X_imp, columns=available_gk_features)
    except ValueError as e:
        logger.warning(f"⚠️ Imputer shape mismatch. Re-fitting imputer...")
        # If there's a mismatch, create a new imputer with current features
        new_imputer = SimpleImputer(strategy="median")
        X_imp = new_imputer.fit_transform(X_raw)
        X_imp = pd.DataFrame(X_imp, columns=available_gk_features)
    
    # Select features and scale
    gk_feats_available = [f for f in gk_feats if f in X_imp.columns]
    
    if len(gk_feats_available) < len(gk_feats):
        logger.warning(f"⚠️ Only {len(gk_feats_available)}/{len(gk_feats)} selected features available")
    
    X_sel = X_imp[gk_feats_available]
    
    # Handle scaling shape mismatch
    try:
        X_scaled = gk_scaler.transform(X_sel)
    except ValueError as e:
        logger.warning(f"⚠️ Scaler shape mismatch: {e}")
        # Create new scaler if needed
        new_scaler = StandardScaler()
        X_scaled = new_scaler.fit_transform(X_sel)
    
    # Generate confidence scores
    df['gatekeeper_confidence'] = gk_model.predict_proba(X_scaled)[:, 1]
    
    logger.info(f"✅ Added gatekeeper confidence. Mean: {df['gatekeeper_confidence'].mean():.3f}")
    
    return df

def train_regressor(df, target_col):
    """Train the regression model to predict actual price changes."""
    
    # Define regression features
    base_features = [
        "gatekeeper_confidence",  # Most important!
        "sentiment_combined", "sentiment_dynamic", "sentiment_ml",
        "sentiment_keyword", "headline_sentiment", "sentiment_vader",
        "std_channel_width",
        "rsi_14", "macd", "macd_hist", "price_vs_sma50",
        "vix_close", "spy_daily_return",
        "hour_sin", "hour_cos", "day_of_week"
    ]
    
    # Check which are actually available
    available_features = [f for f in base_features if f in df.columns]
    logger.info(f"📊 Regression features: {len(available_features)} available")
    
    # Clean data - drop rows with missing target or features
    df_clean = df.dropna(subset=[target_col])
    
    X = df_clean[available_features]
    y = df_clean[target_col].values
    
    # Clip extreme outliers (±10% moves)
    y = np.clip(y, -0.1, 0.1)
    
    # Handle missing values in features
    imputer = SimpleImputer(strategy="median")
    X_imputed = imputer.fit_transform(X)
    X_imputed = pd.DataFrame(X_imputed, columns=available_features)
    
    # Scale features
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X_imputed)
    
    # Time series split
    split = int(0.8 * len(X_scaled))
    X_train, X_test = X_scaled[:split], X_scaled[split:]
    y_train, y_test = y[:split], y[split:]
    
    logger.info(f"📉 Training Regressor on {len(X_train)} samples...")
    logger.info(f"📊 Target range: [{y_train.min():.4f}, {y_train.max():.4f}]")
    
    # Train Random Forest Regressor
    model = RandomForestRegressor(
        n_estimators=200,
        max_depth=8,
        min_samples_leaf=20,
        min_samples_split=50,
        random_state=42,
        n_jobs=-1
    )
    model.fit(X_train, y_train)
    
    # Evaluate
    train_preds = model.predict(X_train)
    test_preds = model.predict(X_test)
    
    train_mae = mean_absolute_error(y_train, train_preds)
    test_mae = mean_absolute_error(y_test, test_preds)
    test_r2 = r2_score(y_test, test_preds)
    
    # Directional accuracy (did we get the sign right?)
    direction_acc = np.mean(np.sign(test_preds) == np.sign(y_test))
    
    # Feature importance
    feature_importance = pd.DataFrame({
        'feature': available_features,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)
    
    logger.info("\n📈 Model Performance:")
    logger.info(f"  Train MAE: {train_mae:.5f} ({train_mae*100:.3f}%)")
    logger.info(f"  Test MAE:  {test_mae:.5f} ({test_mae*100:.3f}%)")
    logger.info(f"  Test R²:   {test_r2:.4f}")
    logger.info(f"  Direction Accuracy: {direction_acc:.2%}")
    
    logger.info("\n🏆 Top 10 Features:")
    for idx, row in feature_importance.head(10).iterrows():
        logger.info(f"  {row['feature']}: {row['importance']:.4f}")
    
    return model, scaler, imputer, available_features

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
    target_col = TARGET_MAP.get(target_horizon, "pct_change_eod")
    
    logger.info("=" * 60)
    logger.info(f"🚀 Starting Regressor Training ({target_horizon.upper()})")
    logger.info("=" * 60)
    
    # 1. Load Gatekeeper Model
    try:
        gk_package = load_gatekeeper_model(target_horizon)
    except FileNotFoundError as e:
        logger.error(str(e))
        logger.error("💡 Run the classifier first: python phase4_classifier_mysql.py")
        return
    
    # 2. Define features we want to use
    base_features = [
        "sentiment_combined", "sentiment_dynamic", "sentiment_ml",
        "sentiment_keyword", "headline_sentiment", "sentiment_vader",
        "std_channel_width",
        "rsi_14", "macd", "macd_hist", "price_vs_sma50",
        "vix_close", "spy_daily_return",
        "hour_sin", "hour_cos", "day_of_week"
    ]
    
    # 3. Load data
    df, valid_features = get_data_from_db(target_col, base_features)
    
    if len(df) < 100:
        logger.error(f"❌ Not enough data! Only {len(df)} rows found.")
        return
    
    # --- WEEKEND PATCH ---
    df = patch_weekend_data(df)
    # ---------------------

    logger.info(f"✅ Loaded {len(df)} training samples")
    
    # 4. Add Gatekeeper Confidence Scores
    df = add_gatekeeper_confidence(df, gk_package)
    
    # 5. Train Regressor
    model, scaler, imputer, features = train_regressor(df, target_col)
    
    # 6. Save Model
    os.makedirs(MODEL_DIR, exist_ok=True)
    model_path = f"{MODEL_DIR}/regressor_{target_horizon}.pkl"
    
    joblib.dump({
        "model": model,
        "scaler": scaler,
        "imputer": imputer,
        "features": features,
        "gatekeeper_package": gk_package  # Include for inference
    }, model_path)
    
    logger.info(f"💾 Model saved to {model_path}")
    
    # 7. Generate Sample Predictions
    logger.info("\n📄 Generating sample predictions...")
    recent_data = df.tail(100).copy()
    
    X_recent = recent_data[features]
    X_recent_imp = imputer.transform(X_recent)
    X_recent_scaled = scaler.transform(X_recent_imp)
    
    recent_data['predicted_change'] = model.predict(X_recent_scaled)
    recent_data['prediction_error'] = recent_data['predicted_change'] - recent_data[target_col]
    
    csv_name = f"predictions_check_{target_horizon}.csv"
    output_cols = ['ticker', 'datetime', 'headline', 'gatekeeper_confidence', 
                   target_col, 'predicted_change', 'prediction_error']
    recent_data[output_cols].to_csv(csv_name, index=False)
    
    logger.info(f"✅ Saved sample predictions to {csv_name}")
    logger.info("\n" + "=" * 60)
    logger.info("✅ Regressor Training Complete!")
    logger.info("=" * 60)

if __name__ == "__main__":
    main()