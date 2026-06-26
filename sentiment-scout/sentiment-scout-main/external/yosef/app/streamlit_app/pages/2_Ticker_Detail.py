"""
2_Ticker_Detail.py

Detailed ticker analysis page for the IST495 dashboard.

This page:
- lets the user deeply inspect one ticker
- supports current-day, historical preset, and fully custom windows
- overlays price action with message density and sentiment
- highlights one active rumor for the selected time range
- provides rolling-window graph controls
- displays filtered message tables for traditional vs rumor/social sources

Only comments were added here; ticker detail logic is unchanged.
"""
import streamlit as st
import pandas as pd
from pathlib import Path
import sys
import plotly.express as px
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from zoneinfo import ZoneInfo
from datetime import datetime, timedelta, timezone

# =========================
# PATH FIX (CRITICAL)
# =========================
PROJECT_ROOT = Path(__file__).resolve().parents[3]
SRC_ROOT = PROJECT_ROOT / "src"
MONGO_ROOT = SRC_ROOT / "mongo"
FINVIZ_ROOT = SRC_ROOT / "finviz"

for p in [PROJECT_ROOT, SRC_ROOT, MONGO_ROOT, FINVIZ_ROOT]:
    if str(p) not in sys.path:
        sys.path.append(str(p))

# =========================
# IMPORTS
# =========================
# Pylance may show unresolved-import warnings because sys.path is modified at runtime.
from mongo_rt import ( #type: ignore
    MongoCfg,
    parse_window,
    agg_ticker_summary,
    agg_time_buckets_for_ticker,
    get_latest_messages,
    ticker_summary,
    get_active_rumor_for_ticker,
)
ET = ZoneInfo("America/New_York")

try:
    from streamlit_autorefresh import st_autorefresh
except Exception:
    st_autorefresh = None
# Yahoo Finance is used to pull historical price data for overlay graphs.
# If yfinance is unavailable, price overlays are disabled gracefully.
try:
    import yfinance as yf
except Exception:
    yf = None

# Helper functions generate commonly used Eastern Time timestamps
# for dashboard presets such as today's window and yesterday windows.
def now_et_str() -> str:
    return datetime.now(ET).strftime("%Y-%m-%d %H:%M")


def today_6am_et_str() -> str:
    now_et = datetime.now(ET)
    return now_et.replace(hour=6, minute=0, second=0, microsecond=0).strftime("%Y-%m-%d %H:%M")


def yesterday_0001_et_str() -> str:
    y = datetime.now(ET) - timedelta(days=1)
    return y.replace(hour=0, minute=1, second=0, microsecond=0).strftime("%Y-%m-%d %H:%M")


def yesterday_4am_et_str() -> str:
    y = datetime.now(ET) - timedelta(days=1)
    return y.replace(hour=4, minute=0, second=0, microsecond=0).strftime("%Y-%m-%d %H:%M")


def yesterday_end_et_str() -> str:
    y = datetime.now(ET) - timedelta(days=1)
    return y.replace(hour=23, minute=59, second=0, microsecond=0).strftime("%Y-%m-%d %H:%M")

# Convert rolling-window labels from the UI into numeric minute values
# used for MongoDB time-bucket aggregation.
def rolling_label_to_minutes(label: str) -> int:
    mapping = {
        "1m": 1,
        "3m": 3,
        "5m": 5,
        "10m": 10,
        "30m": 30,
        "1h": 60,
        "4h": 240,
        "1D": 1440,
        "1W": 10080,
    }
    return mapping.get(label, 10)

# Automatically choose a Yahoo Finance interval based on
# selected time range and rolling-window size.
def choose_price_interval(start_utc, end_utc, bucket_minutes: int) -> str:
    span_days = max((end_utc - start_utc).total_seconds() / 86400.0, 0.0)

    if span_days > 60:
        return "1d"
    if bucket_minutes <= 2:
        return "1m"
    if bucket_minutes <= 5:
        return "5m"
    if bucket_minutes <= 15:
        return "15m"
    if bucket_minutes <= 30:
        return "30m"
    if bucket_minutes <= 60:
        return "60m"
    return "1d"

# Download ticker price history from Yahoo Finance and
# convert timestamps into Eastern Time for graph overlays.
def fetch_price_history(ticker: str, start_utc, end_utc, bucket_minutes: int) -> pd.DataFrame:
    if yf is None:
        return pd.DataFrame()

    interval = choose_price_interval(start_utc, end_utc, bucket_minutes)

    try:
        df = yf.download(
            tickers=ticker,
            start=start_utc,
            end=end_utc,
            interval=interval,
            auto_adjust=False,
            progress=False,
            prepost=True,
            threads=False,
        )
    except Exception:
        return pd.DataFrame()

    if df is None or df.empty:
        return pd.DataFrame()

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [c[0] if isinstance(c, tuple) else c for c in df.columns]

    df = df.reset_index()

    datetime_col = None
    for c in ["Datetime", "Date", "index"]:
        if c in df.columns:
            datetime_col = c
            break

    if datetime_col is None:
        return pd.DataFrame()

    df["price_time"] = pd.to_datetime(df[datetime_col], errors="coerce", utc=True)

    if df["price_time"].isna().all():
        return pd.DataFrame()

    df["price_time_et"] = df["price_time"].dt.tz_convert(ET)

    keep_cols = [c for c in ["Open", "High", "Low", "Close", "Volume"] if c in df.columns]
    out = df[["price_time_et"] + keep_cols].copy()

    for c in keep_cols:
        out[c] = pd.to_numeric(out[c], errors="coerce")

    return out.dropna(subset=["price_time_et"])


st.set_page_config(page_title="Ticker Detail", layout="wide")

st.markdown(
    """
    <style>
    .stApp {
        background: linear-gradient(180deg, #0b1020 0%, #111827 45%, #1e1b4b 100%);
    }
    [data-testid="stSidebar"] {
        background: linear-gradient(180deg, #111827 0%, #1f2937 100%);
        border-right: 1px solid rgba(255,255,255,0.08);
    }
    .block-container {
        padding-top: 1.2rem;
        padding-bottom: 2rem;
    }
    .hero-card {
        background: linear-gradient(135deg, #7c3aed 0%, #2563eb 100%);
        padding: 1.2rem 1.5rem;
        border-radius: 18px;
        color: white;
        margin-bottom: 1rem;
        box-shadow: 0 10px 30px rgba(0,0,0,0.22);
    }
    .hero-title {
        font-size: 1.85rem;
        font-weight: 800;
        margin: 0;
    }
    .hero-subtitle {
        font-size: 0.96rem;
        opacity: 0.92;
        margin-top: 0.3rem;
    }
    .section-title {
        font-size: 1.12rem;
        font-weight: 700;
        margin-top: 0.2rem;
        margin-bottom: 0.55rem;
        color: #f8fafc;
    }
    .mini-card {
        border-radius: 16px;
        padding: 0.8rem 1rem;
        color: white;
        margin-bottom: 0.6rem;
        box-shadow: 0 8px 22px rgba(0,0,0,0.18);
    }
    .mini-blue { background: linear-gradient(135deg, #2563eb, #06b6d4); }
    .mini-green { background: linear-gradient(135deg, #059669, #22c55e); }
    .mini-orange { background: linear-gradient(135deg, #ea580c, #f59e0b); }
    .mini-red { background: linear-gradient(135deg, #dc2626, #ef4444); }
    .mini-purple { background: linear-gradient(135deg, #7c3aed, #a855f7); }
    .mini-label {
        font-size: 0.82rem;
        opacity: 0.92;
        margin-bottom: 0.2rem;
    }
    .mini-value {
        font-size: 1.35rem;
        font-weight: 800;
        line-height: 1.1;
    }
    .rumor-banner {
        border-radius: 16px;
        padding: 1rem 1.15rem;
        color: white;
        margin-bottom: 1rem;
        box-shadow: 0 8px 20px rgba(0,0,0,0.2);
    }
    .rumor-buy {
        background: linear-gradient(135deg, #16a34a, #22c55e);
    }
    .rumor-leave {
        background: linear-gradient(135deg, #dc2626, #ef4444);
    }
    .rumor-neutral {
        background: linear-gradient(135deg, #334155, #475569);
    }
    .rumor-title {
        font-size: 1.02rem;
        font-weight: 800;
        margin-bottom: 0.3rem;
    }
    .rumor-meta {
        font-size: 0.92rem;
        opacity: 0.95;
        margin-bottom: 0.35rem;
    }
    .rumor-text {
        font-size: 0.96rem;
        line-height: 1.45;
    }
    </style>
    """,
    unsafe_allow_html=True,
)

st.markdown(
    """
    <div class="hero-card">
        <div class="hero-title">📌 Ticker Detail Dashboard</div>
        <div class="hero-subtitle">
            Drill down into one ticker using historical windows, graph-level rolling controls, sentiment, rumors, and price action
        </div>
    </div>
    """,
    unsafe_allow_html=True,
)
# MongoCfg stores MongoDB connection settings used throughout this page.
cfg = MongoCfg()
# Default settings for the ticker detail page.
# These are loaded when the page opens or after reset.
DETAIL_DEFAULTS = dict(
    window_mode="Today",
    historical_preset="Yesterday 12:01 AM",
    custom_start=today_6am_et_str(),
    custom_end=now_et_str(),
    max_messages=200,
    auto_refresh=False,
    refresh_seconds=10,
)

if "ticker_detail_filters" not in st.session_state:
    st.session_state["ticker_detail_filters"] = DETAIL_DEFAULTS.copy()

detail_filters = st.session_state["ticker_detail_filters"]

st.sidebar.header("Ticker Controls")
# Sidebar form controls:
# - time window selection
# - historical presets
# - custom ET windows
# - refresh settings
# - message limits
with st.sidebar.form("ticker_detail_controls", clear_on_submit=False):
    window_mode = st.radio(
        "Main analysis window",
        ["Today", "Historical Preset", "Custom"],
        index=["Today", "Historical Preset", "Custom"].index(detail_filters["window_mode"]),
    )

    historical_preset = st.selectbox(
        "Historical preset",
        ["Yesterday 12:01 AM", "Yesterday 4:00 AM"],
        index=["Yesterday 12:01 AM", "Yesterday 4:00 AM"].index(
            detail_filters.get("historical_preset", "Yesterday 12:01 AM")
        ),
        disabled=(window_mode != "Historical Preset"),
    )

    custom_start = st.text_input(
        'Custom start (ET) "YYYY-MM-DD HH:MM"',
        value=detail_filters["custom_start"],
        disabled=(window_mode != "Custom"),
    )

    custom_end = st.text_input(
        'Custom end (ET) "YYYY-MM-DD HH:MM"',
        value=detail_filters["custom_end"],
        disabled=(window_mode != "Custom"),
    )

    max_messages = st.slider(
        "Messages to show",
        50,
        500,
        int(detail_filters["max_messages"]),
        25,
    )

    st.markdown("---")
    auto_refresh = st.checkbox("Enable auto-refresh", value=bool(detail_filters["auto_refresh"]))
    refresh_seconds = st.slider("Refresh every (seconds)", 3, 120, int(detail_filters["refresh_seconds"]), 1)

    c1, c2 = st.columns(2)
    apply_clicked = c1.form_submit_button("✅ Apply")
    reset_clicked = c2.form_submit_button("↩️ Reset")
# Save user-selected settings into Streamlit session state
# so selections persist after reruns.
if apply_clicked:
    st.session_state["ticker_detail_filters"] = dict(
        window_mode=window_mode,
        historical_preset=historical_preset,
        custom_start=custom_start.strip(),
        custom_end=custom_end.strip(),
        max_messages=int(max_messages),
        auto_refresh=bool(auto_refresh),
        refresh_seconds=int(refresh_seconds),
    )
    st.rerun()

if reset_clicked:
    st.session_state["ticker_detail_filters"] = DETAIL_DEFAULTS.copy()
    st.rerun()

detail_filters = st.session_state["ticker_detail_filters"]
# Convert the selected dashboard window into UTC timestamps
# used by MongoDB queries and graph aggregation.
try:
    if detail_filters["window_mode"] == "Today":
        start_utc, end_utc = parse_window(
            "custom_et",
            start_et=today_6am_et_str(),
            end_et=now_et_str(),
        )

    elif detail_filters["window_mode"] == "Historical Preset":
        if detail_filters.get("historical_preset") == "Yesterday 4:00 AM":
            start_utc, end_utc = parse_window(
                "custom_et",
                start_et=yesterday_4am_et_str(),
                end_et=yesterday_end_et_str(),
            )
        else:
            start_utc, end_utc = parse_window(
                "custom_et",
                start_et=yesterday_0001_et_str(),
                end_et=yesterday_end_et_str(),
            )

    else:
        if not detail_filters["custom_start"] or not detail_filters["custom_end"]:
            st.warning('Enter Custom start/end in ET (YYYY-MM-DD HH:MM), then click Apply.')
            st.stop()

        start_utc, end_utc = parse_window(
            "custom_et",
            start_et=detail_filters["custom_start"],
            end_et=detail_filters["custom_end"],
        )

except Exception as e:
    st.error(f"Window error: {e}")
    st.stop()

st.markdown('<div class="section-title">Choose a Ticker</div>', unsafe_allow_html=True)

# Important fix:
# Build candidate tickers from the selected historical/current window, not only today's Live Dashboard list.

# Build ticker candidates dynamically from the selected window.
# This allows historical tickers to appear even if they are not active today.
tmp = agg_ticker_summary(cfg, start_utc, end_utc)

window_candidates = []
if not tmp.empty and "stream_symbol" in tmp.columns:
    window_candidates = (
        tmp["stream_symbol"]
        .dropna()
        .astype(str)
        .str.upper()
        .sort_values()
        .unique()
        .tolist()
    )

live_candidates = st.session_state.get("last_live_tickers", [])
live_candidates = [str(t).strip().upper() for t in live_candidates if str(t).strip()]

combined_candidates = sorted(set(window_candidates + live_candidates))

manual = st.text_input("Or type a ticker", value="").strip().upper()

if combined_candidates:
    current = (st.session_state.get("ticker") or "").strip().upper()
    default_index = combined_candidates.index(current) if current in combined_candidates else 0
    picked = st.selectbox("Select ticker", combined_candidates, index=default_index)
else:
    picked = ""

ticker = manual if manual else picked
ticker = ticker.strip().upper()

if not ticker:
    st.info("Select or type a ticker first.")
    st.stop()

st.session_state["ticker"] = ticker

st.markdown(f"### Ticker: **{ticker}**")

nav_a, nav_b = st.columns(2)
if nav_a.button("⬅️ Back to Live"):
    st.switch_page("pages/1_Live_Dashboard.py")
    st.stop()

if nav_b.button("🔁 Refresh now"):
    st.rerun()

if detail_filters["auto_refresh"]:
    if st_autorefresh is None:
        st.sidebar.warning("Install streamlit-autorefresh")
    else:
        st_autorefresh(interval=int(detail_filters["refresh_seconds"]) * 1000, key=f"refresh_{ticker}")
# Load summary statistics and active rumor information
# for the selected ticker and selected time range.
summary = ticker_summary(cfg, ticker, start_utc, end_utc)
active_rumor = get_active_rumor_for_ticker(cfg, ticker, start_utc, end_utc)
# Metric cards summarize ticker activity, sentiment,
# rumor activity, and message density.
m1, m2, m3, m4 = st.columns(4)
with m1:
    st.markdown(
        f'<div class="mini-card mini-blue"><div class="mini-label">Total Posts</div><div class="mini-value">{int(summary.get("total_posts", 0))}</div></div>',
        unsafe_allow_html=True,
    )
with m2:
    st.markdown(
        f'<div class="mini-card mini-green"><div class="mini-label">Bullish</div><div class="mini-value">{int(summary.get("bullish", 0))}</div></div>',
        unsafe_allow_html=True,
    )
with m3:
    st.markdown(
        f'<div class="mini-card mini-red"><div class="mini-label">Bearish</div><div class="mini-value">{int(summary.get("bearish", 0))}</div></div>',
        unsafe_allow_html=True,
    )
with m4:
    st.markdown(
        f'<div class="mini-card mini-purple"><div class="mini-label">Sentiment Score</div><div class="mini-value">{float(summary.get("sentiment_score", 0)):.4f}</div></div>',
        unsafe_allow_html=True,
    )

m5, m6, m7, m8 = st.columns(4)
with m5:
    st.markdown(
        f'<div class="mini-card mini-green"><div class="mini-label">Traditional Posts</div><div class="mini-value">{int(summary.get("traditional_posts", 0))}</div></div>',
        unsafe_allow_html=True,
    )
with m6:
    st.markdown(
        f'<div class="mini-card mini-orange"><div class="mini-label">Social Posts</div><div class="mini-value">{int(summary.get("social_posts", 0))}</div></div>',
        unsafe_allow_html=True,
    )
with m7:
    st.markdown(
        f'<div class="mini-card mini-red"><div class="mini-label">Rumor Posts</div><div class="mini-value">{int(summary.get("rumor_posts", 0))}</div></div>',
        unsafe_allow_html=True,
    )
with m8:
    st.markdown(
        f'<div class="mini-card mini-blue"><div class="mini-label">Density / Min</div><div class="mini-value">{float(summary.get("density_per_min", 0)):.4f}</div></div>',
        unsafe_allow_html=True,
    )

st.caption(
    f"Window: {start_utc.astimezone(ET).strftime('%Y-%m-%d %I:%M %p')} → "
    f"{end_utc.astimezone(ET).strftime('%Y-%m-%d %I:%M %p')} ET"
)

st.markdown("---")
# Display one active rumor detected for the selected ticker and window.
# The backend classifies whether the rumor suggests buying in or leaving.
st.markdown('<div class="section-title">Active Rumor for Selected Window</div>', unsafe_allow_html=True)

rumor_direction = active_rumor.get("rumor_direction", "")
rumor_class = "rumor-buy" if rumor_direction == "Buy-In" else "rumor-leave" if rumor_direction == "Leave" else "rumor-neutral"
rumor_title = "🟢 Buy-In Rumor" if rumor_direction == "Buy-In" else "🔴 Leave Rumor" if rumor_direction == "Leave" else "ℹ️ No Actionable Rumor"

if active_rumor.get("active_rumor"):
    st.markdown(
        f"""
        <div class="rumor-banner {rumor_class}">
            <div class="rumor-title">{rumor_title}</div>
            <div class="rumor-meta">
                {active_rumor.get("rumor_time_label", "")} &nbsp;|&nbsp;
                {active_rumor.get("rumor_author", "") or "Unknown author"}
            </div>
            <div class="rumor-text">{active_rumor.get("active_rumor", "")}</div>
        </div>
        """,
        unsafe_allow_html=True,
    )
else:
    st.markdown(
        """
        <div class="rumor-banner rumor-neutral">
            <div class="rumor-title">ℹ️ No Actionable Rumor</div>
            <div class="rumor-text">No buy-in or leave rumor was found for this ticker in the selected window.</div>
        </div>
        """,
        unsafe_allow_html=True,
    )

st.markdown('<div class="section-title">🧭 Rumor vs Traditional Driver View</div>', unsafe_allow_html=True)
# Compare traditional-source discussion versus rumor/social discussion
# to understand what is driving conversation around the ticker.
driver_left, driver_right = st.columns([1, 1.2])

with driver_left:
    driver_df = pd.DataFrame(
        {
            "Category": ["Traditional", "Social / Rumor-Social", "Rumor-Flagged"],
            "Posts": [
                int(summary.get("traditional_posts", 0)),
                int(summary.get("social_posts", 0)),
                int(summary.get("rumor_posts", 0)),
            ],
        }
    )

    fig_driver = px.bar(
        driver_df,
        x="Category",
        y="Posts",
        title=f"{ticker}: Source Driver Comparison",
        text="Posts",
        color="Category",
        color_discrete_sequence=["#22c55e", "#f59e0b", "#ef4444"],
    )
    fig_driver.update_layout(xaxis_title="", yaxis_title="Post Count", showlegend=False)
    st.plotly_chart(fig_driver, use_container_width=True)

with driver_right:
    total_posts = max(int(summary.get("total_posts", 0)), 1)
    traditional_ratio = int(summary.get("traditional_posts", 0)) / total_posts
    social_ratio = int(summary.get("social_posts", 0)) / total_posts
    rumor_ratio = int(summary.get("rumor_posts", 0)) / total_posts

    ratio_df = pd.DataFrame(
        {
            "Metric": ["Traditional Share", "Social Share", "Rumor Share"],
            "Ratio": [traditional_ratio, social_ratio, rumor_ratio],
        }
    )

    fig_ratio = px.bar(
        ratio_df,
        x="Metric",
        y="Ratio",
        title=f"{ticker}: Driver Share of Conversation",
        text="Ratio",
        color="Metric",
        color_discrete_sequence=["#22c55e", "#f59e0b", "#ef4444"],
    )
    fig_ratio.update_traces(texttemplate="%{text:.2%}")
    fig_ratio.update_layout(xaxis_title="", yaxis_title="Share of Posts", yaxis_tickformat=".0%", showlegend=False)
    st.plotly_chart(fig_ratio, use_container_width=True)

st.markdown("---")
st.markdown('<div class="section-title">Price + Social Overlay</div>', unsafe_allow_html=True)
# Graph-level rolling window control for the price + social overlay chart.
# Users can dynamically adjust aggregation granularity.
overlay_rolling_label = st.select_slider(
    "Rolling window size for Price + Social Overlay",
    options=["1m", "3m", "5m", "10m", "30m", "1h", "4h", "1D", "1W"],
    value="10m",
)

overlay_bucket_minutes = rolling_label_to_minutes(overlay_rolling_label)

bucket_df_overlay = agg_time_buckets_for_ticker(
    cfg,
    ticker,
    start_utc,
    end_utc,
    bucket_minutes=overlay_bucket_minutes,
)

if not bucket_df_overlay.empty:
    bucket_df_overlay["bucket_start_et"] = pd.to_datetime(bucket_df_overlay["bucket_start_et"], errors="coerce")
    bucket_df_overlay["density_per_min"] = bucket_df_overlay["total_posts"] / max(overlay_bucket_minutes, 1)
# Pull historical market price data used for overlaying
# stock price with social sentiment and message activity.
price_df = fetch_price_history(
    ticker=ticker,
    start_utc=start_utc,
    end_utc=end_utc,
    bucket_minutes=overlay_bucket_minutes,
)

overlay_mode = st.radio(
    "Overlay mode",
    ["Price + Density", "Price + Sentiment", "Price + Both"],
    horizontal=True,
)

if yf is None:
    st.warning("yfinance is not installed. Run: python -m pip install yfinance")
elif price_df.empty:
    st.info("No price history available for this ticker/window. Try a different ticker or a shorter window.")
elif bucket_df_overlay.empty:
    st.info("No message bucket data available for this ticker/window.")
else:
    rumor_time = active_rumor.get("rumor_time_et", None)
    rumor_color = "#22c55e" if rumor_direction == "Buy-In" else "#ef4444"
# Combined overlay graph:
# - stock price
# - message density
# - sentiment score
# - active rumor timing
    fig_overlay = make_subplots(specs=[[{"secondary_y": True}]])

    fig_overlay.add_trace(
        go.Scatter(
            x=price_df["price_time_et"],
            y=price_df["Close"],
            mode="lines",
            name="Price",
            line=dict(width=3),
        ),
        secondary_y=False,
    )

    if overlay_mode in ("Price + Density", "Price + Both"):
        fig_overlay.add_trace(
            go.Bar(
                x=bucket_df_overlay["bucket_start_et"],
                y=bucket_df_overlay["density_per_min"],
                name="Density / Min",
                opacity=0.35,
            ),
            secondary_y=True,
        )

    if overlay_mode in ("Price + Sentiment", "Price + Both"):
        fig_overlay.add_trace(
            go.Scatter(
                x=bucket_df_overlay["bucket_start_et"],
                y=bucket_df_overlay["sentiment_score"],
                mode="lines+markers",
                name="Sentiment",
                line=dict(width=2, dash="dot"),
                marker=dict(size=6),
            ),
            secondary_y=True,
        )

    if rumor_time is not None and pd.notna(rumor_time):
        price_min = float(price_df["Close"].min()) if not price_df["Close"].dropna().empty else None
        price_max = float(price_df["Close"].max()) if not price_df["Close"].dropna().empty else None

        if price_min is not None and price_max is not None:
            fig_overlay.add_trace(
                go.Scatter(
                    x=[rumor_time, rumor_time],
                    y=[price_min, price_max],
                    mode="lines",
                    name="Active Rumor",
                    line=dict(color=rumor_color, width=2, dash="dash"),
                    hovertext=[active_rumor.get("active_rumor", ""), active_rumor.get("active_rumor", "")],
                    hoverinfo="text",
                ),
                secondary_y=False,
            )

    fig_overlay.update_layout(
        title=f"{ticker}: Price Overlay with Social Activity ({overlay_rolling_label})",
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        margin=dict(l=10, r=10, t=50, b=10),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="left", x=0),
    )

    fig_overlay.update_xaxes(title_text="Time (ET)")
    fig_overlay.update_yaxes(title_text="Price", secondary_y=False)
    fig_overlay.update_yaxes(title_text="Social Signal", secondary_y=True)

    st.plotly_chart(fig_overlay, use_container_width=True)

st.markdown("---")
st.markdown('<div class="section-title">Ticker Time Window</div>', unsafe_allow_html=True)
# Independent rolling-window control for the ticker timeline graphs.
timeline_rolling_label = st.select_slider(
    "Rolling window size for Ticker Time Window",
    options=["1m", "3m", "5m", "10m", "30m", "1h", "4h", "1D", "1W"],
    value="10m",
)

timeline_bucket_minutes = rolling_label_to_minutes(timeline_rolling_label)

bucket_df_timeline = agg_time_buckets_for_ticker(
    cfg,
    ticker,
    start_utc,
    end_utc,
    bucket_minutes=timeline_bucket_minutes,
)

view_mode = st.radio(
    "Chart view",
    ["Sentiment", "Message Volume"],
    horizontal=True,
)

if not bucket_df_timeline.empty:
    bucket_df_timeline["bucket_start_et"] = pd.to_datetime(bucket_df_timeline["bucket_start_et"], errors="coerce")

    rumor_time = active_rumor.get("rumor_time_et", None)
    rumor_color = "#22c55e" if rumor_direction == "Buy-In" else "#ef4444"
# Timeline can switch between:
# - sentiment trend view
# - raw message volume view
    if view_mode == "Sentiment":
        fig = go.Figure()

        fig.add_trace(
            go.Scatter(
                x=bucket_df_timeline["bucket_start_et"],
                y=bucket_df_timeline["sentiment_score"],
                mode="lines+markers",
                name="Sentiment",
                line=dict(color="#a855f7", width=3),
                marker=dict(size=7),
            )
        )

        if rumor_time is not None and pd.notna(rumor_time):
            y_min = float(bucket_df_timeline["sentiment_score"].min())
            y_max = float(bucket_df_timeline["sentiment_score"].max())

            if y_min == y_max:
                y_min -= 0.1
                y_max += 0.1

            fig.add_trace(
                go.Scatter(
                    x=[rumor_time, rumor_time],
                    y=[y_min, y_max],
                    mode="lines",
                    name="Active Rumor",
                    line=dict(color=rumor_color, width=2, dash="dash"),
                    hovertext=[active_rumor.get("active_rumor", ""), active_rumor.get("active_rumor", "")],
                    hoverinfo="text",
                    showlegend=True,
                )
            )

        fig.update_layout(
            title=f"{ticker}: Sentiment Timeline ({timeline_rolling_label})",
            xaxis_title="Time (ET)",
            yaxis_title="Sentiment Score",
            paper_bgcolor="rgba(0,0,0,0)",
            plot_bgcolor="rgba(0,0,0,0)",
            margin=dict(l=10, r=10, t=50, b=10),
        )

        st.plotly_chart(fig, use_container_width=True)

    else:
        fig = go.Figure()

        bar_colors = ["#22c55e" if val >= 0 else "#ef4444" for val in bucket_df_timeline["sentiment_score"]]

        fig.add_trace(
            go.Bar(
                x=bucket_df_timeline["bucket_start_et"],
                y=bucket_df_timeline["total_posts"],
                marker_color=bar_colors,
                name="Messages",
            )
        )

        if rumor_time is not None and pd.notna(rumor_time):
            y_max = float(bucket_df_timeline["total_posts"].max())
            if y_max <= 0:
                y_max = 1.0

            fig.add_trace(
                go.Scatter(
                    x=[rumor_time, rumor_time],
                    y=[0, y_max],
                    mode="lines",
                    name="Active Rumor",
                    line=dict(color=rumor_color, width=2, dash="dash"),
                    hovertext=[active_rumor.get("active_rumor", ""), active_rumor.get("active_rumor", "")],
                    hoverinfo="text",
                    showlegend=True,
                )
            )

        fig.update_layout(
            title=f"{ticker}: Message Volume Timeline ({timeline_rolling_label})",
            xaxis_title="Time (ET)",
            yaxis_title="Messages",
            paper_bgcolor="rgba(0,0,0,0)",
            plot_bgcolor="rgba(0,0,0,0)",
            margin=dict(l=10, r=10, t=50, b=10),
        )

        st.plotly_chart(fig, use_container_width=True)

else:
    st.info("No bucket data in this window.")

st.markdown("---")
st.markdown('<div class="section-title">Latest Messages</div>', unsafe_allow_html=True)
# Load latest clean messages for the selected ticker and window.
# Messages are split into traditional vs rumor/social tabs.
msgs = get_latest_messages(cfg, ticker, start_utc, end_utc, limit=int(detail_filters["max_messages"]))

if msgs.empty:
    st.info("No messages in this window.")
else:
    msgs = msgs.copy()

    msg_display_map = {
        "created_at_et": "Time (ET)",
        "author": "Author",
        "sentiment": "Sentiment",
        "source_type": "Source Type",
        "rumor_flag": "Rumor Flag",
        "rumor_reason": "Rumor Reason",
        "post": "Post",
        "link": "Link",
    }
# Separate message tabs improve readability and allow
# focused analysis of traditional versus rumor/social posts.
    tab1, tab2, tab3 = st.tabs(["All Clean Messages", "Traditional Only", "Rumor / Social Only"])

    with tab1:
        show_cols = ["created_at_et", "author", "sentiment", "source_type", "rumor_flag", "rumor_reason", "post", "link"]
        show_cols = [c for c in show_cols if c in msgs.columns]
        st.dataframe(msgs[show_cols].rename(columns=msg_display_map), use_container_width=True, hide_index=True)

    with tab2:
        trad_df = msgs.copy()
        if "source_type" in trad_df.columns:
            trad_df = trad_df[trad_df["source_type"] == "Traditional"]

        show_cols = ["created_at_et", "author", "sentiment", "source_type", "post", "link"]
        show_cols = [c for c in show_cols if c in trad_df.columns]

        if trad_df.empty:
            st.info("No traditional-source messages in this window.")
        else:
            st.dataframe(trad_df[show_cols].rename(columns=msg_display_map), use_container_width=True, hide_index=True)

    with tab3:
        rumor_df = msgs.copy()

        if "source_type" in rumor_df.columns:
            rumor_df = rumor_df[
                (rumor_df["source_type"] == "Rumor/Social")
                | (rumor_df.get("rumor_flag", False) == True)
            ]

        show_cols = ["created_at_et", "author", "sentiment", "source_type", "rumor_flag", "rumor_reason", "post", "link"]
        show_cols = [c for c in show_cols if c in rumor_df.columns]

        if rumor_df.empty:
            st.info("No rumor/social messages in this window.")
        else:
            st.dataframe(rumor_df[show_cols].rename(columns=msg_display_map), use_container_width=True, hide_index=True)

st.caption("Ticker Detail now uses selected historical/current windows and graph-level rolling controls.")