import streamlit as st
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from sqlalchemy import text
from datetime import timedelta
import time

# Import your database module
from db_sqlite import get_engine

# === CONFIGURATION ===
st.set_page_config(page_title="Financial Sentiment Dashboard", layout="wide")

# === DATA LOADING ===
@st.cache_data(ttl=60)
def load_data():
    engine = get_engine()
    # NEW SQLITE QUERY: Maps C++ backend schema to dashboard expected schema
    # Returns NULL for missing ML/Technical Indicator features to allow graceful degradation
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
    LIMIT 2000
    """
    with engine.connect() as conn:
        df = pd.read_sql(query, conn)
    return df

# === SIDEBAR FILTERS ===
st.sidebar.header("🔍 Filters")

try:
    df = load_data()
except Exception as e:
    st.error(f"⚠️ Database Error: {e}")
    st.stop()

# 1. Ticker Filter
all_tickers = ["All"] + sorted(df['ticker'].dropna().unique().tolist())
selected_ticker = st.sidebar.selectbox("Select Ticker", all_tickers)

# 2. Gatekeeper Filter
df['sentiment_category'] = df['sentiment_category'].fillna("Unprocessed")
cats = df['sentiment_category'].unique().tolist()
categories = ["All"] + sorted(cats)
selected_category = st.sidebar.selectbox("Sentiment Category", categories)

# 3. Confidence Threshold
min_conf = st.sidebar.slider("Minimum AI Confidence", 0.0, 1.0, 0.5)

# 4. Auto-Refresh Settings
refresh_options = {"Off": None, "10 seconds": 10, "30 seconds": 30, "1 minute": 60, "5 minutes": 300}
refresh_label = st.sidebar.selectbox("⏱️ Auto-Refresh Rate", list(refresh_options.keys()), index=0)
refresh_interval = refresh_options[refresh_label]

# === APPLY FILTERS ===
filtered_df = df.copy()

if selected_ticker != "All":
    filtered_df = filtered_df[filtered_df['ticker'] == selected_ticker]

if selected_category != "All":
    filtered_df = filtered_df[filtered_df['sentiment_category'] == selected_category]

if 'ml_confidence' in filtered_df.columns:
    filtered_df = filtered_df[filtered_df['ml_confidence'].fillna(0) >= min_conf]

# === MAIN DASHBOARD ===
st.title("🚀 AI Financial Sentiment Dashboard")

# Top Metrics
col1, col2, col3, col4 = st.columns(4)
col1.metric("Total Articles", len(filtered_df))
col2.metric("High Confidence Signals", len(filtered_df[filtered_df['sentiment_category'] == 'Signal']))
avg_sent = filtered_df['sentiment_combined'].mean() if not filtered_df.empty else 0
col3.metric("Avg Sentiment", f"{avg_sent:.2f}")
latest_vix = filtered_df['vix_close'].iloc[0] if not filtered_df.empty and 'vix_close' in filtered_df.columns else 0
col4.metric("Market VIX", f"{latest_vix:.2f}")

st.markdown("---")

# --- SECTION 1: WATCHLIST ---
st.header("🔮 Top Picks for Next Market Open")
st.caption("Articles with High AI Confidence waiting for market reaction")

# Filter for Inference Rows (No Future Price Yet)
watchlist = filtered_df[filtered_df['pct_change_eod'].isna()]

if not watchlist.empty:
    watchlist = watchlist.sort_values(by='ml_confidence', ascending=False)
    display_cols = ['ticker', 'datetime', 'headline', 'sentiment_combined', 'ml_confidence', 'sentiment_category']
    st.dataframe(
        watchlist[display_cols].head(20),
        use_container_width=True,
        column_config={
            "ml_confidence": st.column_config.ProgressColumn("Confidence", min_value=0, max_value=1, format="%.2f"),
            "sentiment_combined": st.column_config.NumberColumn("Sentiment", format="%.2f")
        }
    )
else:
    st.info("No active watchlist items found (all loaded articles have past price data).")

st.markdown("---")

# --- SECTION 2: AI INSIGHTS ---
st.header("📊 AI Insights & Distribution")
col_left, col_right = st.columns(2)

with col_left:
    st.subheader("Sentiment Distribution")
    if not filtered_df.empty:
        fig_hist = px.histogram(filtered_df, x="sentiment_combined", nbins=20, title="Sentiment Score Spread", color_discrete_sequence=['#3366cc'])
        st.plotly_chart(fig_hist, use_container_width=True)

with col_right:
    st.subheader("AI Confidence vs. Sentiment")
    if not filtered_df.empty and 'ml_confidence' in filtered_df.columns:
        fig_scatter = px.scatter(
            filtered_df, 
            x="sentiment_combined", 
            y="ml_confidence", 
            color="sentiment_category",
            hover_data=["ticker", "headline"],
            title="Does the AI trust the Sentiment?",
            color_discrete_map={"Signal": "green", "Noise": "gray", "Unprocessed": "blue"}
        )
        st.plotly_chart(fig_scatter, use_container_width=True)

st.markdown("---")

# --- SECTION 3: TECHNICAL CHARTS ---
st.header("📈 Technical Analysis & Price Action")

if selected_ticker == "All":
    st.info("👈 Please select a specific Ticker in the sidebar to view Technical Charts.")
else:
    # Sort by date for charting
    chart_df = filtered_df.sort_values("datetime", ascending=True)
    
    # Create Candlestick with Bollinger Bands
    fig = go.Figure()

    # 1. Candlestick
    fig.add_trace(go.Candlestick(
        x=chart_df['datetime'],
        open=chart_df['price_open'], high=chart_df['price_high'],
        low=chart_df['price_low'], close=chart_df['price_close'],
        name="Price"
    ))

    # 2. Bollinger Bands
    if 'std_upper' in chart_df.columns:
        fig.add_trace(go.Scatter(
            x=chart_df['datetime'], y=chart_df['std_upper'],
            line=dict(color='gray', width=1), name="Upper Band"
        ))
        fig.add_trace(go.Scatter(
            x=chart_df['datetime'], y=chart_df['std_lower'],
            line=dict(color='gray', width=1), fill='tonexty', name="Lower Band"
        ))

    fig.update_layout(height=600, title=f"{selected_ticker} - Price vs. News Events", xaxis_rangeslider_visible=False)
    st.plotly_chart(fig, use_container_width=True)
    
    # 3. RSI / MACD Sub-chart
    col_t1, col_t2 = st.columns(2)
    with col_t1:
        if 'rsi_14' in chart_df.columns:
            st.line_chart(chart_df.set_index("datetime")['rsi_14'])
            st.caption("RSI (14)")
    with col_t2:
        if 'macd' in chart_df.columns:
            st.line_chart(chart_df.set_index("datetime")['macd'])
            st.caption("MACD")

st.markdown("---")

# --- SECTION 4: DATA EXPLORER ---
st.header("📝 Raw Data Inspector")
st.dataframe(filtered_df, use_container_width=True)

if refresh_interval:
    time.sleep(refresh_interval)
    st.cache_data.clear()
    st.rerun()