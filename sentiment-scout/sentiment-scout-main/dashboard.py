"""
Sentiment Scout — Flask dashboard v3
FeedFlash-style tab layout. All existing routes preserved.
"""

import csv
import hmac
import io
import json
import os
import re
import sqlite3
import threading
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path

from curl_cffi import requests as cffi_requests
from flask import Flask, jsonify, render_template_string, request

import config
import database
import health
import multicap_screener
import correlation_engine
import social_store
import priyanshu_adapter
import tradingview_adapter
import yosef_adapter
import bluesky_adapter
import reddit_adapter
import jeff_adapter
import credentials_store

database.init_db()   # apply additive schema migrations before any query
# A Finviz token saved via Settings → Credentials feeds the same config the app
# reads — re-apply it on startup so a UI-set token survives restarts.
credentials_store.apply_persisted_finviz_token()

app = Flask(__name__)
DB_PATH = Path(__file__).parent / "sentiment_screener.db"
LOG_PATH = Path(__file__).parent / "scheduler_log.txt"

# ── CORS ─────────────────────────────────────────────────────────────────────
# A deployed frontend (e.g. Vercel) calls this backend cross-origin, so the API
# must allow the frontend's origin. FRONTEND_ORIGIN is a comma-separated allowlist
# (env-driven); it defaults to the local Vite dev origin so local dev — where the
# Vite proxy makes calls same-origin anyway — is unchanged. Prefer flask-cors;
# fall back to manual headers if it isn't installed (keeps an old venv working).
_CORS_ORIGINS = [o.strip() for o in os.environ.get(
    "FRONTEND_ORIGIN", "http://localhost:5173").split(",") if o.strip()]
try:
    from flask_cors import CORS
    CORS(app, resources={r"/api/*": {"origins": _CORS_ORIGINS}},
         supports_credentials=False)
except ImportError:
    @app.after_request
    def _add_cors_headers(resp):
        origin = request.headers.get("Origin")
        if origin and origin in _CORS_ORIGINS:
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Vary"] = "Origin"
            resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        return resp


def _load_dotenv():
    """Tiny .env loader (no python-dotenv dependency). Existing env vars win."""
    env_file = Path(__file__).parent / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()

_run_lock  = threading.Lock()
_run_state = {"running": False, "started_at": None, "last_result": None}

# ─── HELPERS ──────────────────────────────────────────────────────────────────

def parse_cap_tier(s: str) -> str:
    """
    Classify a market cap into a tier. Accepts suffixed strings ("12.5B",
    "450M", "1.2T") and bare numbers, which Finviz export CSVs denominate
    in MILLIONS ("17973.39" = $17.97B).
    """
    s = str(s or "").strip().upper().replace(",", "")
    if not s or s in ("-", "N/A"):
        return "unknown"
    try:
        mult = {"T": 1e12, "B": 1e9, "M": 1e6, "K": 1e3}
        if s[-1] in mult:
            val = float(s[:-1]) * mult[s[-1]]
        else:
            val = float(s) * 1e6  # bare number = millions (Finviz export format)
        if val >= 200e9: return "mega"
        if val >= 10e9:  return "large"
        if val >= 2e9:   return "mid"
        if val >= 300e6: return "small"
        if val >= 50e6:  return "micro"
        return "nano"
    except Exception:
        return "unknown"


def num(val) -> float | None:
    """Parse Finviz-style numeric strings ("-11.43%", "3.5", "1,234") → float."""
    s = str(val if val is not None else "").replace(",", "").replace("%", "").strip()
    if not s or s in ("-", "N/A"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def pearson_r(xs: list, ys: list) -> float:
    n = len(xs)
    if n < 2:
        return 0.0
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = sum((x - mx) ** 2 for x in xs) ** 0.5
    dy = sum((y - my) ** 2 for y in ys) ** 0.5
    if dx * dy == 0:
        return 0.0
    return round(num / (dx * dy), 4)


def extract_trending_phrases(posts: list, top_n: int = 5) -> list:
    stop = {
        "the","a","an","is","it","to","in","of","and","or","for","on","at","with",
        "that","this","be","are","was","will","has","have","from","by","not","but",
        "if","as","do","did","so","up","out","my","we","im","its","i","me","you",
        "he","she","they","all","just","get","got","like","can","see","now","one",
        "its","be","been","had","would","could","should","very","more","after",
        "into","their","there","than","when","what","who","which","about","stock",
        "going","think","looks","good","great","nice","still","much","well","time",
    }
    counter: Counter = Counter()
    for p in posts:
        text = p.get("text", "") or ""
        words = [w for w in re.findall(r'\b[a-z]{3,}\b', text.lower()) if w not in stop]
        for i in range(len(words) - 1):
            counter[f"{words[i]} {words[i+1]}"] += 1
        for i in range(len(words) - 2):
            counter[f"{words[i]} {words[i+1]} {words[i+2]}"] += 1
    return [{"phrase": p, "count": c} for p, c in counter.most_common(top_n)]


# ─── DATA LAYER ───────────────────────────────────────────────────────────────

def query(sql: str, params: tuple = ()) -> list:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return rows


def get_stats() -> dict:
    latest = query("SELECT MAX(id) AS rid, total_tickers FROM screener_runs")[0]
    tickers_screened = latest["total_tickers"] or 0
    news_items = query("SELECT COUNT(*) AS n FROM rss_items")[0]["n"] or 0
    soc = query("""
        SELECT SUM(COALESCE(stocktwits_bull_count,0)+COALESCE(stocktwits_bear_count,0)) AS n
        FROM ticker_insights WHERE run_id=(SELECT MAX(id) FROM screener_runs)
    """)[0]
    social_signals = soc["n"] or 0
    acc = query("""
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN was_correct=1 THEN 1 ELSE 0 END) AS correct
        FROM ticker_insights WHERE was_correct IS NOT NULL
    """)[0]
    total_eval = acc["total"] or 0
    correct    = acc["correct"] or 0
    accuracy   = round(correct / total_eval * 100, 1) if total_eval else None
    total_runs = query("SELECT COUNT(*) AS n FROM screener_runs")[0]["n"] or 0
    return {
        "tickers_screened": tickers_screened,
        "new_adds": 0, "dropped": 0,
        "news_items": news_items,
        "social_signals": social_signals,
        "accuracy": accuracy,
        "total_eval": total_eval,
        "total_runs": total_runs,
    }


def get_insights_latest() -> list:
    rows = query("""
        SELECT ti.id, ti.ticker, ti.company, ti.sector,
               ti.market_cap, ti.price, ti.change_pct,
               ti.rel_volume, ti.rsi,
               ti.ah_close, ti.ah_change, ti.prev_close, ti.open_price,
               ti.capture_session,
               ti.direction, ti.conviction, ti.timing,
               ti.news_catalyst, ti.summary, ti.reason,
               ti.risk_factors, ti.news_sources,
               ti.high_conviction,
               ti.stocktwits_bull_count, ti.stocktwits_bear_count,
               ti.stocktwits_watchlist,
               ti.was_correct, ti.created_at
        FROM ticker_insights ti
        WHERE ti.run_id=(SELECT MAX(id) FROM screener_runs)
        ORDER BY ti.conviction DESC NULLS LAST
    """)
    out = []
    for r in rows:
        d = dict(r)
        for f in ("risk_factors", "news_sources"):
            try:    d[f] = json.loads(d.get(f) or "[]")
            except: d[f] = []
        d["cap_tier"] = parse_cap_tier(d.get("market_cap") or "")
        out.append(d)
    return out


def get_recent_picks(window_hours: int = 48, limit: int | None = None) -> list:
    """AI picks from screener runs within the last `window_hours` (not just the
    latest run), deduped by ticker keeping each ticker's MOST RECENT pick, ranked
    by conviction descending. Fills the Overview / Correlation board with genuinely
    CURRENT picks when the news-gated pipeline yields one pick per run — without
    relaxing the gate (every pick still carries its real news catalyst) and without
    surfacing stale runs (a time window drops old/seeded runs by their timestamp).
    Pure DB read of stored runs."""
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=window_hours)).isoformat()
    run_ids = [r["id"] for r in query(
        "SELECT id FROM screener_runs WHERE run_timestamp >= ? ORDER BY id DESC",
        (cutoff,))]
    if not run_ids:
        return []
    ph = ",".join("?" * len(run_ids))
    rows = query(f"""
        SELECT ti.id, ti.ticker, ti.company, ti.sector, ti.market_cap,
               ti.price, ti.change_pct, ti.rel_volume, ti.rsi,
               ti.direction, ti.conviction, ti.timing, ti.news_catalyst,
               ti.summary, ti.reason, ti.risk_factors, ti.news_sources,
               ti.high_conviction, ti.stocktwits_bull_count, ti.stocktwits_bear_count,
               ti.run_id, ti.created_at
        FROM ticker_insights ti
        WHERE ti.run_id IN ({ph}) AND ti.conviction IS NOT NULL
        ORDER BY ti.run_id DESC
    """, tuple(run_ids))
    # Rows are newest-run first, so the first time we see a ticker is its most
    # recent pick — keep that one.
    seen, deduped = set(), []
    for r in rows:
        if r["ticker"] in seen:
            continue
        seen.add(r["ticker"])
        d = dict(r)
        for f in ("risk_factors", "news_sources"):
            try:    d[f] = json.loads(d.get(f) or "[]")
            except: d[f] = []
        d["cap_tier"] = parse_cap_tier(d.get("market_cap") or "")
        deduped.append(d)
    deduped.sort(key=lambda d: (d.get("conviction") or 0), reverse=True)
    return deduped[:limit] if limit else deduped


def get_rss_feed(limit: int = 200) -> list:
    rows = query("SELECT * FROM rss_items ORDER BY id DESC LIMIT ?", (limit,))
    out = []
    for r in rows:
        d = dict(r)
        try:    d["extracted_tickers"] = json.loads(d.get("extracted_tickers") or "[]")
        except: d["extracted_tickers"] = []
        out.append(d)
    return out


def get_stocktwits_posts() -> list:
    rows = query("""
        SELECT ticker, stocktwits_posts, stocktwits_bull_count, stocktwits_bear_count
        FROM ticker_insights
        WHERE run_id=(SELECT MAX(id) FROM screener_runs)
          AND stocktwits_posts IS NOT NULL
        ORDER BY (COALESCE(stocktwits_bull_count,0)+COALESCE(stocktwits_bear_count,0)) DESC
    """)
    posts = []
    for r in rows:
        try:
            pl = json.loads(r["stocktwits_posts"] or "[]")
            for p in pl[:10]:
                posts.append({
                    "ticker":     r["ticker"],
                    "platform":   "Stocktwits",
                    "text":       p.get("text", "") or p.get("text_clean", ""),
                    "sentiment":  p.get("sentiment", ""),
                    "timestamp":  p.get("timestamp", ""),
                    "bull_count": r["stocktwits_bull_count"] or 0,
                    "bear_count": r["stocktwits_bear_count"] or 0,
                })
        except Exception:
            pass
    return posts


def get_social_panel() -> list:
    rows = query("""
        SELECT ticker, company,
               stocktwits_bull_count, stocktwits_bear_count,
               stocktwits_watchlist, stocktwits_posts,
               direction, conviction
        FROM ticker_insights
        WHERE run_id=(SELECT MAX(id) FROM screener_runs)
        ORDER BY (COALESCE(stocktwits_bull_count,0)+COALESCE(stocktwits_bear_count,0)) DESC
        LIMIT 8
    """)
    out = []
    for r in rows:
        d = dict(r)
        bulls = d.get("stocktwits_bull_count") or 0
        bears = d.get("stocktwits_bear_count") or 0
        d["total_posts"] = bulls + bears
        try:
            posts = json.loads(d.get("stocktwits_posts") or "[]")
            raw = posts[0].get("text", "") if posts else ""
            d["excerpt"] = (raw[:97] + "…") if len(raw) > 100 else raw
        except Exception:
            d["excerpt"] = ""
        out.append(d)
    return out


def get_top_ticker() -> dict | None:
    rows = query("""
        SELECT ticker, company, price, direction, conviction, rsi,
               stocktwits_bull_count, stocktwits_bear_count
        FROM ticker_insights
        WHERE run_id=(SELECT MAX(id) FROM screener_runs)
          AND conviction IS NOT NULL
        ORDER BY conviction DESC LIMIT 1
    """)
    return dict(rows[0]) if rows else None


def get_conviction_sparkline() -> dict:
    rows = query("""
        SELECT ticker, conviction, direction
        FROM ticker_insights
        WHERE run_id=(SELECT MAX(id) FROM screener_runs)
          AND conviction IS NOT NULL
        ORDER BY id ASC LIMIT 20
    """)
    return {
        "labels":     [r["ticker"] for r in rows],
        "conviction": [r["conviction"] for r in rows],
        "colors": [
            "#1d9e75" if (r["direction"] or "") == "long"
            else "#d85a30" if (r["direction"] or "") == "short"
            else "#555d6e"
            for r in rows
        ],
    }


def get_db_stats() -> dict:
    runs     = query("SELECT COUNT(*) AS n FROM screener_runs")[0]["n"] or 0
    insights = query("SELECT COUNT(*) AS n FROM ticker_insights")[0]["n"] or 0
    rss      = query("SELECT COUNT(*) AS n FROM rss_items")[0]["n"] or 0
    return {"total_runs": runs, "total_insights": insights, "total_rss": rss}


def get_log_tail(n: int = 30) -> list:
    if not LOG_PATH.exists():
        return []
    lines = LOG_PATH.read_text(encoding="utf-8").splitlines()
    return lines[-n:]


# ─── API ROUTES ───────────────────────────────────────────────────────────────

def get_news_items(limit: int = 200, source: str = "", date_from: str = "",
                   date_to: str = "", time_from: str = "", time_to: str = "") -> list:
    sql = "SELECT * FROM rss_items"
    conditions, params = [], []
    if source and source.lower() not in ("all", ""):
        conditions.append("source = ?")
        params.append(source)
    if date_from:
        conditions.append("published_at >= ?")
        params.append(f"{date_from}T{time_from or '00:00'}:00")
    if date_to:
        conditions.append("published_at <= ?")
        params.append(f"{date_to}T{time_to or '23:59'}:59")
    if conditions:
        sql += " WHERE " + " AND ".join(conditions)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit)

    rows = query(sql, tuple(params))
    out = []
    for r in rows:
        d = dict(r)
        try:    d["extracted_tickers"] = json.loads(d.get("extracted_tickers") or "[]")
        except: d["extracted_tickers"] = []
        out.append(d)
    return out


@app.route("/api/news")
def api_news():
    out = get_news_items(
        limit=int(request.args.get("limit", 200)),
        source=request.args.get("source", ""),
        date_from=request.args.get("date_from", ""),
        date_to=request.args.get("date_to", ""),
        time_from=request.args.get("time_from", ""),
        time_to=request.args.get("time_to", ""),
    )
    return jsonify({"items": out, "count": len(out)})


def _overview_pick(ins: dict) -> dict:
    """An AI insight row → the Overview 'AI Top Picks' card shape."""
    return {
        "ticker":        ins.get("ticker"),
        "company":       ins.get("company") or "",
        "direction":     ins.get("direction"),
        "conviction":    ins.get("conviction"),
        "news_catalyst": ins.get("news_catalyst"),
        "price":         ins.get("price"),
        "change_pct":    num(ins.get("change_pct")),
        "sector":        ins.get("sector"),
    }


@app.route("/api/screener")
def api_screener():
    # `items` = legacy inline-dashboard shape (unchanged); `tickers` = React Screener.
    # `top_picks` = Overview's AI Top Picks board, sourced across recent runs (deduped
    # by ticker, conviction-ranked). Widened to ~30 days / 50 so the bigger Overview
    # list (capped client-side by TOP_PICKS_COUNT) fills from real cached picks — the
    # news-gated pipeline yields ~1 pick/run, so a 48h window left the board nearly
    # empty. Pure cached DB read (no model call). Correlation's get_recent_picks call
    # is intentionally left at its own window.
    return jsonify({
        "items":     get_insights_latest(),
        "tickers":   _screener_rows_react(),
        "top_picks": [_overview_pick(p) for p in get_recent_picks(window_hours=720, limit=50)],
    })


@app.route("/api/social")
def api_social():
    posts = get_stocktwits_posts()
    trending = extract_trending_phrases(posts)
    return jsonify({"posts": posts, "count": len(posts), "trending": trending})


def build_correlation(ticker: str, date_val: str, t_from: str, t_to: str) -> dict:
    """Live correlation when ticker+date given, else historical DB fallback."""
    # Use live correlation engine when ticker + date are provided
    if ticker and date_val:
        try:
            result = correlation_engine.run_correlation(ticker, date_val, t_from, t_to)
            # Ensure chart has both 'sentiments' (legacy key) and 'sentiment' keys
            if "chart" in result:
                c = result["chart"]
                c.setdefault("sentiments", c.get("sentiment", []))
            return result
        except Exception as exc:
            print(f"  [api/correlation] live engine error: {exc}")
            return {"error": str(exc), "ticker": ticker}

    # Fallback: historical DB data
    conditions, params = [], []
    if ticker:
        conditions.append("ticker = ?")
        params.append(ticker)
    sql = "SELECT price, conviction, direction, stocktwits_bull_count, stocktwits_bear_count FROM ticker_insights"
    if conditions:
        sql += " WHERE " + " AND ".join(conditions)
    sql += " ORDER BY id DESC LIMIT 100"
    rows = query(sql, tuple(params))

    prices, sentiments, densities = [], [], []
    for r in rows:
        price = r["price"]
        conv  = r["conviction"]
        dirn  = (r["direction"] or "neutral").lower()
        bulls = r["stocktwits_bull_count"] or 0
        bears = r["stocktwits_bear_count"] or 0
        density = bulls + bears
        if price is None or conv is None:
            continue
        signed_conv = conv if dirn == "long" else (-conv if dirn == "short" else 0)
        prices.append(price)
        sentiments.append(signed_conv)
        densities.append(density)

    r_ps = pearson_r(prices, sentiments) if prices else 0.0
    r_pd = pearson_r(prices, densities)  if prices else 0.0
    r_sd = pearson_r(sentiments, densities) if sentiments else 0.0

    chart_labels = [str(i) for i in range(len(prices[:20]))]
    return {
        "ticker": ticker,
        "n": len(prices),
        "r_price_sentiment": r_ps,
        "r_price_density": r_pd,
        "r_sentiment_density": r_sd,
        "chart": {
            "labels":     chart_labels,
            "prices":     prices[:20],
            "sentiments": sentiments[:20],
            "sentiment":  sentiments[:20],
            "density":    densities[:20],
        },
    }


@app.route("/api/correlation")
def api_correlation():
    ticker = request.args.get("ticker", "").upper().strip()
    payload = build_correlation(
        ticker=ticker,
        date_val=request.args.get("date", "").strip(),
        t_from=request.args.get("time_from", "09:30").strip() or "09:30",
        t_to=request.args.get("time_to", "16:00").strip() or "16:00",
    )
    if not ticker:        # React CorrelationPage polls with no params → add `entries`
        payload = {**payload, "entries": _correlation_entries()}
    return jsonify(payload)


# Live price×sentiment correlation across all active screener tickers, for the
# sortable ranking table on the Correlation tab. One Finviz + one Stocktwits
# fetch per ticker, so results are cached for 5 minutes.
_corr_rank_cache = {"ts": 0.0, "data": None}
_CORR_RANK_TTL = 300


@app.route("/api/correlation/rank")
def api_correlation_rank():
    if (_corr_rank_cache["data"] is not None
            and time.time() - _corr_rank_cache["ts"] < _CORR_RANK_TTL
            and request.args.get("refresh") != "1"):
        return jsonify({**_corr_rank_cache["data"], "cached": True})

    date_val = datetime.now(correlation_engine.EDT).strftime("%Y-%m-%d")
    # Rank the recent AI universe (across runs, deduped) rather than only the last
    # run, so Correlation has a fuller set to analyze. Capped to keep the live walk
    # bounded.
    tickers = [r["ticker"] for r in get_recent_picks(window_hours=48, limit=15)]
    rows = []
    for t in tickers:
        try:
            res = correlation_engine.run_correlation(t, date_val, "09:30", "16:00")
        except Exception as exc:
            res = {"error": str(exc)}
        rows.append({
            "ticker": t,
            "n": res.get("n"),
            "r_price_sentiment":   res.get("r_price_sentiment"),
            "r_price_density":     res.get("r_price_density"),
            "r_sentiment_density": res.get("r_sentiment_density"),
            "error": res.get("error"),
        })
    payload = {"date": date_val, "count": len(rows), "items": rows, "cached": False}
    _corr_rank_cache["ts"] = time.time()
    _corr_rank_cache["data"] = payload
    return jsonify(payload)


@app.route("/api/health")
def api_health():
    """Cheap, read-only health snapshot for the Settings status panel: per-component
    OK / stale / down from already-stored data plus one cached Finviz probe. Open
    (GET only) like the other settings reads — it returns no secret (the Finviz line
    is 'Valid — N rows' / 'Rejected …', never the token). `?refresh=1` re-probes
    Finviz, bypassing the short cache, for a manual re-check."""
    refresh = request.args.get("refresh", "").strip() in ("1", "true", "yes")
    return jsonify(health.collect(refresh=refresh))


@app.route("/api/settings/stats")
def api_settings_stats():
    return jsonify(get_db_stats())


@app.route("/api/settings/logs")
def api_settings_logs():
    return jsonify({"lines": get_log_tail(30)})


@app.route("/api/settings/keywords", methods=["GET", "POST"])
def api_settings_keywords():
    """User keyword dictionary — persisted server-side so the pipeline's RSS
    filter matches on it (keyword_filter.load_user_keywords)."""
    import keyword_filter
    if request.method == "POST":
        raw = (request.json or {}).get("keywords", "")
        keyword_filter.USER_KEYWORDS_PATH.write_text(raw, encoding="utf-8")
        kws = keyword_filter.load_user_keywords()
        return jsonify({"saved": True, "count": len(kws), "keywords": kws})
    return jsonify({"keywords": keyword_filter.load_user_keywords(),
                    "raw": (keyword_filter.USER_KEYWORDS_PATH.read_text(encoding="utf-8")
                            if keyword_filter.USER_KEYWORDS_PATH.exists() else "")})


@app.route("/api/settings/sources", methods=["GET", "POST"])
def api_settings_sources():
    """News-source selection — which publishers the News feed and Charts detail
    news panel surface. The catalog is the eight wire/regulatory sources the
    professor wanted (Global Newswire, PR Newswire, Business Wire, Dow Jones
    Newswires, ACCESS Wire, Benzinga, SEC, FDA) plus an 'Other' bucket for
    aggregators/everything else. Persisted server-side in the gitignored var/
    store; default is all-enabled so nothing is hidden until the user narrows it."""
    if request.method == "POST":
        enabled = (request.json or {}).get("enabled", [])
        saved = priyanshu_adapter.save_selected_sources(enabled)
        return jsonify({"saved": True, "catalog": priyanshu_adapter.SOURCE_CATALOG,
                        "recognized": priyanshu_adapter.RECOGNIZED_SOURCES,
                        "enabled": saved})
    return jsonify({"catalog": priyanshu_adapter.SOURCE_CATALOG,
                    "recognized": priyanshu_adapter.RECOGNIZED_SOURCES,
                    "enabled": priyanshu_adapter.load_selected_sources()})


@app.route("/api/settings/credentials", methods=["GET", "POST"])
def api_settings_credentials():
    """Data-source / brokerage credentials (Finviz, TradingView, TD, IB) for the
    Settings page. Stored encrypted-at-rest in the gitignored var/ store — never
    in tracked source, never committed, never logged. Secrets are masked to last-4
    on read and never echoed in plaintext. Saving the Finviz token updates the
    running config the app reads. Scope: storage + UI only (no broker wiring).

    GET returns only the masked view (no secrets) and is open so the page loads.
    POST writes a secret, so it requires a valid SENTIMENT_SCOUT_API_KEYS key —
    a public backend must never accept an unauthenticated token write."""
    if request.method == "POST":
        err = _api_key_error()
        if err:
            return err
        updates = request.json or {}
        # Only field keys are accepted; anything else is ignored. No logging of
        # values — we deliberately never print/log the request body.
        view = credentials_store.save(updates)
        resp = {"saved": True, **view}
        # Validate a freshly-saved Finviz token against Finviz so the UI can show
        # "valid, N rows" or "rejected, 401" — the point of the feature.
        if credentials_store.FINVIZ_TOKEN_KEY in (updates or {}):
            resp["finviz_validation"] = credentials_store.validate_finviz_token()
        return jsonify(resp)
    return jsonify(credentials_store.masked_view())


@app.route("/api/settings/impersonate", methods=["GET", "POST"])
def api_settings_impersonate():
    if request.method == "POST":
        profile = (request.json or {}).get("profile", "chrome124")
        return jsonify({"profile": profile, "note": "Profile saved to localStorage only — full wiring in a future sprint."})
    return jsonify({"profile": "chrome124", "options": [
        "chrome99","chrome100","chrome104","chrome107","chrome110","chrome116",
        "chrome119","chrome120","chrome123","chrome124","chrome131",
        "firefox109","safari15_5","safari17_0",
    ]})


@app.route("/api/multicap")
def api_multicap():
    rows = multicap_screener.get_latest_multicap(limit=500)
    return jsonify({"items": rows, "count": len(rows)})


# ─── CHARTS TAB ───────────────────────────────────────────────────────────────
# Reuses the correlation engine's Finviz quote_export 1-min fetch (same endpoint,
# token, and headers) but also keeps Volume, which _fetch_price_data discards.
# Single ticker per request, never bulk; 60s cache so window toggles don't refetch.

_chart_cache: dict = {}          # (ticker, date) -> {"ts": epoch, "bars": [...]}
_CHART_CACHE_TTL = 60


def _fetch_intraday_bars(ticker: str, date_str: str):
    """1-min close+volume bars for one ticker/day. Returns list of bars,
    or a dict {"error": ...} on auth/transport failure."""
    key = (ticker, date_str)
    hit = _chart_cache.get(key)
    if hit and time.time() - hit["ts"] < _CHART_CACHE_TTL:
        return hit["bars"]

    try:
        dt_obj = datetime.strptime(date_str, "%Y-%m-%d")
        fdate = f"{dt_obj.month}/{dt_obj.day}/{dt_obj.year}"
    except ValueError:
        fdate = date_str
    url = (
        f"https://elite.finviz.com/quote_export"
        f"?t={ticker}&p=i1&s={fdate}&e={fdate}&auth={config.get_finviz_token()}"
    )
    try:
        session = cffi_requests.Session()
        # Retry on rate-limit responses: when a background poll (e.g. multicap) is
        # mid-burst, Finviz Elite can answer this on-demand call with 429 — or
        # escalate to a transient 401/403 — even though the token is valid. A short
        # backoff lets the burst clear so the chart still loads. A genuinely dead
        # token stays 401 across all retries and surfaces the auth error below.
        resp = None
        for attempt in range(3):
            resp = session.get(url, headers=correlation_engine.CURL_HEADERS,
                               impersonate="chrome124", timeout=25)
            if resp.status_code in (429, 401, 403) and attempt < 2:
                time.sleep(1.5 * (attempt + 1))
                continue
            break
        if resp.status_code in (401, 403):
            return {"error": f"Finviz auth failed (HTTP {resp.status_code}) — token may be expired"}
        if resp.status_code == 429:
            return {"error": "Finviz rate-limited (HTTP 429) — try again in a moment."}
        if resp.status_code in (400, 404):
            return {"error": f"No data for {ticker} — check the ticker symbol."}
        resp.raise_for_status()
        body = resp.text
        if body.lstrip().startswith("<"):
            return {"error": "Finviz returned non-CSV response — token may be expired"}
        # quote_export?p=i1 ignores s/e and returns ~11 days of bars; times are
        # 24-hour with a decorative AM/PM suffix ("19:55 PM"), so strip-and-%H:%M
        # is correct. Group by day and cache every day returned — the walk-back
        # over previous days then costs zero extra requests.
        by_day: dict = {}
        for row in csv.DictReader(io.StringIO(body)):
            raw = (row.get("Date") or row.get("date") or "").strip()
            raw = re.sub(r"\s*(AM|PM)$", "", raw, flags=re.IGNORECASE).strip()
            close = num(row.get("Close") or row.get("close"))
            o  = num(row.get("Open")  or row.get("open"))
            hi = num(row.get("High")  or row.get("high"))
            lo = num(row.get("Low")   or row.get("low"))
            vol   = num(row.get("Volume") or row.get("volume"))
            if not raw or close is None:
                continue
            try:
                ts = datetime.strptime(raw, "%m/%d/%Y %H:%M")
            except ValueError:
                continue
            # Keep true O/H/L (lightweight-charts candles need them); fall back to
            # close for any missing field. build_chart only reads close/volume/ts,
            # so these extra keys are additive and don't affect the legacy chart.
            by_day.setdefault(ts.strftime("%Y-%m-%d"), []).append(
                {"ts": ts,
                 "open":  o  if o  is not None else close,
                 "high":  hi if hi is not None else close,
                 "low":   lo if lo is not None else close,
                 "close": close, "volume": int(vol or 0)})
        now = time.time()
        for day, day_bars in by_day.items():
            day_bars.sort(key=lambda b: b["ts"])
            _chart_cache[(ticker, day)] = {"ts": now, "bars": day_bars}
        if date_str not in by_day:   # cache the miss so walk-back doesn't refetch
            _chart_cache[key] = {"ts": now, "bars": []}
        return _chart_cache[key]["bars"]
    except Exception as exc:
        return {"error": f"Intraday fetch failed: {exc}"}


def _latest_session_bars(ticker: str):
    """Most recent session with data: try today (ET), walk back up to 4 days.
    Returns (bars, date_str). On auth/transport/no-data error, bars is an
    {"error": ...} dict and date_str is None. Shared by build_chart (legacy
    /api/chart) and the React OHLC adapter so the walk logic stays single-source."""
    now_et = datetime.now(correlation_engine.EDT)
    for back in range(5):
        d = (now_et - timedelta(days=back)).strftime("%Y-%m-%d")
        result = _fetch_intraday_bars(ticker, d)
        if isinstance(result, dict):          # auth/transport error — stop immediately
            return result, None
        if result:
            return result, d
    return {"error": f"No intraday data for {ticker} in the last 5 days."}, None


def build_chart(ticker: str, window: str) -> dict:
    if window not in ("full", "2h", "1h"):
        window = "full"

    bars, date_used = _latest_session_bars(ticker)
    if date_used is None:
        return {**bars, "ticker": ticker}

    if window in ("2h", "1h"):
        cutoff = bars[-1]["ts"] - timedelta(hours=2 if window == "2h" else 1)
        bars = [b for b in bars if b["ts"] >= cutoff]

    return {
        "ticker": ticker,
        "date": date_used,
        "window": window,
        "n": len(bars),
        "labels":  [b["ts"].strftime("%H:%M") for b in bars],
        "prices":  [b["close"] for b in bars],
        "volumes": [b["volume"] for b in bars],
        "open": bars[0]["close"],
        "last": bars[-1]["close"],
    }


@app.route("/api/chart")
def api_chart():
    ticker = request.args.get("ticker", "").upper().strip()
    window = request.args.get("window", "full").lower().strip()
    if not ticker:
        return jsonify({"error": "ticker required"})
    return jsonify(build_chart(ticker, window))


# ─── CHARTS TAB: SOCIAL OVERLAYS ──────────────────────────────────────────────
# Message density and sentiment score for the Charts price chart, computed with
# the exact rolling-window math from the Research-main scripts:
#   density   = messages per minute over 04:00–20:00 ET, empty minutes = 0,
#               15-min rolling average (np.convolve mode='same' equivalent)
#   sentiment = (bullish − bearish) / total tagged per 5-min window sliding
#               1 min, 0.0 when no tagged messages, 15-min smoothing
# Source order: stored ticker_insights snapshots when they actually cover the
# day; otherwise one on-demand StockTwits stream walk for the single ticker.

def _smooth_same(values: list, k: int = 15) -> list:
    """Pure-python np.convolve(values, ones(k)/k, mode='same'): centered
    k-wide mean with zero padding at the edges. Matches the research scripts,
    which skip smoothing entirely when len < k."""
    n = len(values)
    if n < k:
        return list(values)
    lead = (k - 1) // 2
    out = []
    for i in range(n):
        s = 0.0
        for j in range(i - lead, i - lead + k):
            if 0 <= j < n:
                s += values[j]
        out.append(s / k)
    return out


def _stored_social_messages(ticker: str, date_str: str) -> list:
    """Every stored stocktwits post for ticker that falls on date_str (ET),
    deduped across snapshot rows. Returns [(naive_et_dt, sentiment|None)].
    Wired into social_store as its seed_fn (used when a live walk finds
    nothing) — kept here because it reads the dashboard's sqlite snapshots."""
    rows = query(
        "SELECT stocktwits_posts FROM ticker_insights "
        "WHERE ticker=? AND stocktwits_posts IS NOT NULL AND stocktwits_posts != ''",
        (ticker,))
    win_start, win_end = social_store.social_window(date_str)
    seen, msgs = set(), []
    for r in rows:
        try:
            posts = json.loads(r["stocktwits_posts"] or "[]")
        except Exception:
            continue
        for p in posts:
            ts = p.get("timestamp") or ""
            key = (ts, p.get("username", ""), (p.get("text") or "")[:80])
            if not ts or key in seen:
                continue
            seen.add(key)
            try:
                dt_utc = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            except ValueError:
                continue
            dt_et = dt_utc.astimezone(social_store.EDT).replace(tzinfo=None)
            if win_start <= dt_et <= win_end:
                msgs.append((dt_et, p.get("sentiment")))
    return msgs


# The Charts research views and the correlation engine share one resting store
# (social_store.py): walk StockTwits once per (ticker, day), persist the
# per-message (timestamp, Bullish/Bearish tag) to MongoDB, then serve instantly.
# Wire this module's sqlite snapshots in as the seed fallback for empty walks.
social_store.seed_fn = _stored_social_messages


def _build_social_series(msgs: list, date_str: str) -> dict:
    """The research scripts' bucketing, verbatim in spirit:
    per-minute counts → full zero-filled timeline → 15-min rolling average;
    5-min sentiment windows sliding 1 min keyed by window start."""
    win_start, win_end = social_store.social_window(date_str)

    minute_total = Counter()
    minute_bull  = Counter()
    minute_bear  = Counter()
    for dt_et, sent in msgs:
        b = dt_et.replace(second=0, microsecond=0)
        minute_total[b] += 1
        if sent == "Bullish":
            minute_bull[b] += 1
        elif sent == "Bearish":
            minute_bear[b] += 1

    all_minutes, t = [], win_start
    while t <= win_end:
        all_minutes.append(t)
        t += timedelta(minutes=1)
    density = [minute_total.get(m, 0) for m in all_minutes]

    sent_labels, scores, win_density = [], [], []
    t = win_start
    while t + timedelta(minutes=5) <= win_end:
        bull = bear = total = 0
        m = t
        while m < t + timedelta(minutes=5):
            bull += minute_bull.get(m, 0)
            bear += minute_bear.get(m, 0)
            total += minute_total.get(m, 0)
            m += timedelta(minutes=1)
        tagged = bull + bear
        scores.append(round((bull - bear) / tagged, 4) if tagged else 0.0)
        win_density.append(total)        # script graph 2: messages per 5-min window
        sent_labels.append(t.strftime("%H:%M"))
        t += timedelta(minutes=1)

    return {
        "labels":         [m.strftime("%H:%M") for m in all_minutes],
        "density":        density,
        "density_smooth": [round(v, 3) for v in _smooth_same(density, 15)],
        "sent_labels":    sent_labels,
        "scores":         scores,
        "scores_smooth":  [round(v, 4) for v in _smooth_same(scores, 15)],
        "win_density":        win_density,
        "win_density_smooth": [round(v, 3) for v in _smooth_same(win_density, 15)],
        "messages":       len(msgs),
        "bullish":        int(sum(minute_bull.values())),
        "bearish":        int(sum(minute_bear.values())),
        "tagged":         int(sum(minute_bull.values()) + sum(minute_bear.values())),
    }


def _social_ready_payload(ticker, date_str, doc, is_today):
    """Build the chart series from a resting-store doc, topping up today's
    messages incrementally first."""
    added = 0
    if is_today:
        try:
            added = social_store.incremental_update(ticker, date_str, doc)
        except Exception as exc:
            print(f"  [social] incremental error {ticker}|{date_str}: {exc}")
    msgs = social_store.docs_to_msgs(doc.get("messages"))
    payload = _build_social_series(msgs, date_str)
    payload.update({
        "ticker": ticker, "date": date_str, "status": "ready",
        "source": "store" + ("+live" if (is_today and added) else ""),
        "complete": bool(doc.get("complete")),
        "stored": len(doc.get("messages") or []),
        "added": added,
    })
    if msgs and not payload["complete"]:
        payload["coverage_start"] = min(d for d, _ in msgs).strftime("%H:%M")
    return payload


@app.route("/api/chart/social")
def api_chart_social():
    ticker = request.args.get("ticker", "").upper().strip()
    date_str = request.args.get("date", "").strip()
    if not ticker or not re.match(r"^\d{4}-\d{2}-\d{2}$", date_str):
        return jsonify({"error": "ticker and date=YYYY-MM-DD required"})

    key = f"{ticker}|{date_str}"
    today = datetime.now(correlation_engine.EDT).strftime("%Y-%m-%d")
    is_today = (date_str == today)

    # 1. Resting-store hit → serve instantly (today gets a cheap incremental top-up)
    doc = social_store.read_doc(key)
    if doc is not None:
        return jsonify(_social_ready_payload(ticker, date_str, doc, is_today))

    # 2. First time for this ticker/day → walk in the background, report progress
    job = social_store.ensure_job(ticker, date_str, key)
    if job["done"]:
        if job.get("error"):
            social_store.clear_job(key)           # clear so a re-select retries
            return jsonify({"error": f"StockTwits walk failed: {job['error']}",
                            "ticker": ticker, "date": date_str})
        doc = social_store.read_doc(key)          # walk just finished — adopt result
        if doc is not None:
            return jsonify(_social_ready_payload(ticker, date_str, doc, is_today))
    return jsonify({"status": "walking", "count": job["count"],
                    "ticker": ticker, "date": date_str})


# ─── MOMENTUM TAB ─────────────────────────────────────────────────────────────

def build_momentum() -> dict:
    """Leaderboard derived purely from data already in the DB — no external calls.
    Score = change_pct + (rel_vol − 1)×10 + (bulls − bears)."""
    insights = get_insights_latest()
    multicap = multicap_screener.get_latest_multicap(limit=500)

    items = []
    for r in insights:
        chg   = num(r.get("change_pct")) or 0.0
        rel   = num(r.get("rel_volume"))
        bulls = r.get("stocktwits_bull_count") or 0
        bears = r.get("stocktwits_bear_count") or 0
        comp_rel = ((rel - 1) * 10) if rel is not None else 0.0
        comp_soc = bulls - bears
        items.append({
            "ticker": r["ticker"], "company": r.get("company") or "",
            "price": r.get("price"), "change_pct": chg,
            "rel_vol": rel, "rsi": num(r.get("rsi")),
            "bulls": bulls, "bears": bears,
            "direction": r.get("direction"), "conviction": r.get("conviction"),
            "score": round(chg + comp_rel + comp_soc, 2),
            "components": {"change": round(chg, 2), "rel_vol": round(comp_rel, 2),
                           "social": comp_soc},
        })
    items.sort(key=lambda x: x["score"], reverse=True)

    # Merged universe for gainers/losers/relvol/RSI: screener rows win over multicap
    merged = {}
    for m in multicap:
        if m.get("status") == "dropped":
            continue
        t = m["ticker"]
        merged[t] = {"ticker": t, "company": m.get("company") or "",
                     "price": m.get("price"), "change_pct": num(m.get("change_pct")),
                     "rel_vol": num(m.get("rel_volume")), "rsi": num(m.get("rsi")),
                     "tier": m.get("market_cap_tier"), "src": "multicap"}
    for it in items:
        merged[it["ticker"]] = {"ticker": it["ticker"], "company": it["company"],
                                "price": it["price"], "change_pct": it["change_pct"],
                                "rel_vol": it["rel_vol"], "rsi": it["rsi"],
                                "tier": None, "src": "screener"}
    universe = [u for u in merged.values() if u["change_pct"] is not None]
    by_chg = sorted(universe, key=lambda x: x["change_pct"], reverse=True)
    gainers = [u for u in by_chg if u["change_pct"] > 0][:5]
    losers  = [u for u in by_chg[::-1] if u["change_pct"] < 0][:5]

    with_rel = sorted([u for u in merged.values() if u["rel_vol"] is not None],
                      key=lambda x: x["rel_vol"], reverse=True)
    unusual = [u for u in with_rel if u["rel_vol"] >= 1.5][:8]

    with_rsi   = [u for u in merged.values() if u["rsi"] is not None]
    overbought = sorted([u for u in with_rsi if u["rsi"] >= 70],
                        key=lambda x: x["rsi"], reverse=True)[:5]
    oversold   = sorted([u for u in with_rsi if u["rsi"] <= 30],
                        key=lambda x: x["rsi"])[:5]

    social = [i for i in items if (i["bulls"] + i["bears"]) > 0]
    most_bullish = sorted(social, key=lambda x: x["bulls"], reverse=True)[:5]
    most_bearish = sorted(social, key=lambda x: x["bears"], reverse=True)[:5]
    highest_density = sorted(social, key=lambda x: x["bulls"] + x["bears"], reverse=True)[:5]

    added   = [{"ticker": m["ticker"], "company": m.get("company") or "",
                "tier": m.get("market_cap_tier")}
               for m in multicap if m.get("status") == "added"]
    dropped = [{"ticker": m["ticker"], "company": m.get("company") or "",
                "tier": m.get("market_cap_tier")}
               for m in multicap if m.get("status") == "dropped"]

    return {
        "formula": "score = change_pct + (rel_vol − 1)×10 + (bulls − bears)",
        "items": items,
        "gainers": gainers, "losers": losers,
        "unusual_volume": unusual,
        "rsi_overbought": overbought, "rsi_oversold": oversold,
        "social_bullish": most_bullish, "social_bearish": most_bearish,
        "social_density": highest_density,
        "added": added, "dropped": dropped,
        "multicap_run": multicap[0]["run_timestamp"] if multicap else None,
    }


@app.route("/api/momentum")
def api_momentum():
    mom = build_momentum()                  # legacy keys preserved; `tickers` added for React
    return jsonify({**mom, "tickers": _momentum_rows_react(mom)})


@app.route("/api/news/structured")
def api_news_structured():
    """Structured news = the recognized wire-service / regulatory publishers only
    (PR Newswire, Business Wire, Global Newswire, ACCESS Wire, Benzinga, SEC, FDA,
    Dow Jones Newswires) — NOT aggregators (Yahoo/GuruFocus/etc.) or the legacy
    flat "Finviz" label, which are unstructured secondary coverage. Buckets each
    article by its extracted publisher (priyanshu_adapter.canonical_source) and
    honors the Settings → News Sources selection so the toggles actually filter
    this feed. Pass ?all=1 to include the "Other" bucket too (debug/back-compat).

    Pure DB read — no model call. Additive: same {items, count} shape, plus a
    `sources` breakdown and the active `enabled` selection."""
    limit = int(request.args.get("limit", 50))
    include_other = request.args.get("all", "") in ("1", "true", "yes")

    enabled = set(priyanshu_adapter.load_selected_sources())
    recognized = set(priyanshu_adapter.RECOGNIZED_SOURCES)

    # Pull a generous pool, then keep only the structured publishers that are both
    # recognized and enabled in Settings; cap at `limit`. TradingView is merged in
    # as its own recognized source (canonical_source("TradingView")), so it flows
    # through the identical recognized∩enabled filter and the same toggle.
    pool = priyanshu_adapter.fetch_priyanshu_articles(limit=max(2000, limit * 20))
    pool += tradingview_adapter.fetch_tradingview_articles(limit=max(200, limit * 4))
    pool.sort(key=lambda a: a.get("timestamp") or a.get("publish_date") or "", reverse=True)
    items, by_source = [], {}
    for a in pool:
        canon = priyanshu_adapter.canonical_source(a.get("source"))
        is_structured = canon in recognized or (include_other and canon == priyanshu_adapter.OTHER_SOURCE)
        if not is_structured:
            continue
        if canon not in enabled:                # respect the Settings toggles
            continue
        by_source[canon] = by_source.get(canon, 0) + 1
        if len(items) < limit:
            items.append(a)
    return jsonify({
        "items": items,
        "count": len(items),
        "sources": [{"source": s, "count": n} for s, n in
                    sorted(by_source.items(), key=lambda kv: -kv[1])],
        "enabled": sorted(enabled),
        "structured_only": not include_other,
    })


@app.route("/api/social/yosef")
def api_social_yosef():
    ticker = request.args.get("ticker", None)
    limit  = int(request.args.get("limit", 50))
    posts  = yosef_adapter.fetch_yosef_social(ticker=ticker, limit=limit)
    return jsonify({"posts": posts, "count": len(posts)})


@app.route("/api/broker")
def api_broker():
    scanners = jeff_adapter.fetch_jeff_scanner_data()
    return jsonify({"scanners": scanners, "count": len(scanners)})


# ─── REACT FRONTEND ADAPTERS (Otis-branch UI in ./frontend) ──────────────────
# Thin shape-adapters that re-project data the helpers above already produce into
# the JSON the React/Vite frontend expects (matches frontend/src/lib/types.ts and
# each page's `data?.<key>` reads). Design rules:
#   • Additive only — the legacy inline dashboard's /api/* shapes are preserved.
#     The three paths the React app shares with the legacy UI (/api/screener,
#     /api/momentum, /api/correlation) gain an extra key (`tickers`/`entries`);
#     their existing keys are untouched, so both frontends work off one backend.
#   • No storage details are hardcoded — everything flows through query()/the
#     module helpers, so moving ticker_insights/rss/social to Redis/Mongo later
#     needs no change here.

def _iso_to_epoch(s):
    """ISO-8601 (UTC) string -> unix seconds (int), or None. The React news rows
    do `new Date(ts * 1000)`, so they want seconds."""
    if not s:
        return None
    try:
        return int(datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp())
    except Exception:
        return None


def _signed_conviction(direction, conviction):
    """AI conviction (0–10) signed by direction, scaled to [-1, 1] for the React
    sentiment columns (>=0.2 bullish, <=-0.2 bearish)."""
    if conviction is None:
        return 0.0
    d = (direction or "neutral").lower()
    if d == "long":
        return round(conviction / 10.0, 4)
    if d == "short":
        return round(-conviction / 10.0, 4)
    return 0.0


def _social_sentiment(bulls, bears):
    """(bull − bear) / total tagged, in [-1, 1]; 0 when no posts."""
    tot = (bulls or 0) + (bears or 0)
    return round(((bulls or 0) - (bears or 0)) / tot, 4) if tot else 0.0


def _stocktwits_sentiment_num(s):
    return 1.0 if s == "Bullish" else -1.0 if s == "Bearish" else 0.0


def _multicap_volume_map():
    """ticker -> latest multicap volume (float). ticker_insights stores no volume
    column, so the React volume/avg-vol columns borrow it from the multicap run
    when the ticker appears there."""
    out = {}
    for m in multicap_screener.get_latest_multicap(limit=500):
        v = num(m.get("volume"))
        if v is not None:
            out[m["ticker"]] = v
    return out


def _insight_ai_block(ins):
    """AI + social fields from an insight row (ticker_insights), or empties for a
    multicap-only ticker. These are the fields the Overview / AI Top Picks page
    reads (direction, conviction, news_catalyst) plus the sentiment columns."""
    if not ins:
        return {"direction": None, "conviction": None, "news_catalyst": None,
                "avg_sentiment": 0.0, "social_sentiment": 0.0, "structured_sentiment": 0.0,
                "message_count": 0, "bullish_count": 0, "bearish_count": 0,
                "neutral_count": 0, "news_article_count": 0, "sources": [],
                "sector": None, "company": None}
    bulls = ins.get("stocktwits_bull_count") or 0
    bears = ins.get("stocktwits_bear_count") or 0
    social = _social_sentiment(bulls, bears)
    news   = _signed_conviction(ins.get("direction"), ins.get("conviction"))
    return {
        "direction": ins.get("direction"), "conviction": ins.get("conviction"),
        "news_catalyst": ins.get("news_catalyst"),
        "avg_sentiment": round((social + news) / 2, 4),
        "social_sentiment": social, "structured_sentiment": news,
        "message_count": bulls + bears, "bullish_count": bulls, "bearish_count": bears,
        "neutral_count": 0, "news_article_count": len(ins.get("news_sources") or []),
        "sources": ins.get("news_sources") or [],
        "sector": ins.get("sector"), "company": ins.get("company"),
    }


def _screener_rows_react():
    """React Screener payload (frontend/src/lib/types.ts ScreenerRow + extras).

    Sourced from the full multicap screener results so every row carries the REAL
    numeric columns the legacy Screener tab works over — price, % change, volume,
    relative volume, RSI, cap tier, add/drop status and the extended-hours session
    fields — with the AI insight fields (direction, conviction, news_catalyst,
    sentiments) merged in for tickers that have an insight. Insight-only tickers
    (AI-analysed but not in the latest multicap run) are still appended so the
    Overview / AI Top Picks ranking keeps every pick. Pure DB read — no model call.

    Additive: the legacy /api/screener `items` key is untouched; this only builds
    the `tickers` key both the React Screener and Overview consume."""
    insights = {r["ticker"]: r for r in get_insights_latest()}
    rows, seen = [], set()

    # Computed columns sourced from the team's stored scores — one DB read each,
    # no model call. News: per-ticker FinBERT/VADER mean over the FeedFlash store
    # (last 3 days). Social: Stocktwits sentiment + message density over a rolling
    # 72h window. Both fail soft to {} so the screener never blocks on a dead
    # source; a ticker absent from a map renders/sorts/filters as null, not zero.
    try:
        news_map = priyanshu_adapter.news_sentiment_by_ticker(days=3)
    except Exception as exc:
        print(f"  [screener] news agg failed: {exc}")
        news_map = {}
    try:
        social_map = yosef_adapter.social_metrics_by_ticker(window_hours=72)
    except Exception as exc:
        print(f"  [screener] social agg failed: {exc}")
        social_map = {}

    def _computed(t):
        """The three computed screener columns for ticker `t`, null where the
        source has no data for it."""
        nm = news_map.get((t or "").upper())
        sm = social_map.get((t or "").upper())
        return {
            "news_sentiment":      nm["score"] if nm else None,
            "news_article_count_3d": nm["count"] if nm else None,
            "stocktwits_sentiment": sm["sentiment"] if sm else None,
            "stocktwits_density":   sm["density"] if sm else None,
        }

    def _ext(m, ins, key):
        """Prefer the multicap value, fall back to the insight's."""
        v = num(m.get(key)) if m else None
        if v is None and ins is not None:
            v = num(ins.get(key))
        return v

    # 1. Base rows: the full multicap results (real numerics), AI merged where present.
    for m in multicap_screener.get_latest_multicap(limit=500):
        if m.get("status") == "dropped":
            continue
        t = m.get("ticker")
        if not t or t in seen:
            continue
        seen.add(t)
        ins = insights.get(t)
        ai  = _insight_ai_block(ins)
        mc_num = num(ins.get("market_cap")) if ins else None
        rows.append({
            "ticker":          t,
            "company":         ai["company"] or m.get("company") or "",
            "price":           m.get("price") if m.get("price") is not None else (ins.get("price") if ins else None),
            "change_pct":      _ext(m, ins, "change_pct"),
            "volume":          num(m.get("volume")),
            "avg_volume":      num(m.get("avg_volume")),
            "rel_volume":      num(m.get("rel_volume")),
            "rsi":             num(m.get("rsi")),
            "market_cap":      (mc_num * 1e6) if mc_num is not None else None,
            "sector":          ai["sector"],
            "industry":        None,
            "cap_tier":        m.get("market_cap_tier") or (ins.get("cap_tier") if ins else None),
            "capture_session": m.get("capture_session") or (ins.get("capture_session") if ins else None),
            "status":          m.get("status"),
            "ah_close":        _ext(m, ins, "ah_close"),
            "ah_change":       _ext(m, ins, "ah_change"),
            "prev_close":      _ext(m, ins, "prev_close"),
            "open_price":      _ext(m, ins, "open_price"),
            **{k: ai[k] for k in ("avg_sentiment", "social_sentiment", "structured_sentiment",
                                  "message_count", "bullish_count", "bearish_count", "neutral_count",
                                  "news_article_count", "sources", "direction", "conviction", "news_catalyst")},
            **_computed(t),
        })

    # 2. Insight-only tickers (analysed but not in the latest multicap run) — keep
    #    them so Overview / AI Top Picks never drops a ranked pick.
    for t, ins in insights.items():
        if t in seen:
            continue
        seen.add(t)
        ai = _insight_ai_block(ins)
        mc_num = num(ins.get("market_cap"))
        rows.append({
            "ticker":          t,
            "company":         ins.get("company") or "",
            "price":           ins.get("price"),
            "change_pct":      num(ins.get("change_pct")),
            "volume":          None,
            "avg_volume":      None,
            "rel_volume":      num(ins.get("rel_volume")),
            "rsi":             num(ins.get("rsi")),
            "market_cap":      (mc_num * 1e6) if mc_num is not None else None,
            "sector":          ins.get("sector"),
            "industry":        None,
            "cap_tier":        ins.get("cap_tier"),
            "capture_session": ins.get("capture_session"),
            "status":          None,
            "ah_close":        num(ins.get("ah_close")),
            "ah_change":       num(ins.get("ah_change")),
            "prev_close":      num(ins.get("prev_close")),
            "open_price":      num(ins.get("open_price")),
            **{k: ai[k] for k in ("avg_sentiment", "social_sentiment", "structured_sentiment",
                                  "message_count", "bullish_count", "bearish_count", "neutral_count",
                                  "news_article_count", "sources", "direction", "conviction", "news_catalyst")},
            **_computed(t),
        })
    return rows


def _momentum_rows_react(mom):
    """build_momentum()['items'] projected into the React MomentumRow shape and
    filtered by the page's query params. Unknown rel_vol/volume (sparse in the
    data — see NOTES.md) are treated as pass-through, not filtered out."""
    args = request.args
    min_vol  = num(args.get("min_volume"))
    min_rel  = num(args.get("min_rel_vol"))
    max_pr   = num(args.get("max_price"))
    sent_f   = (args.get("sentiment") or "").lower()
    try:
        limit = int(float(args.get("limit", 50)))
    except Exception:
        limit = 50
    vol_map = _multicap_volume_map()
    out = []
    for it in mom["items"]:
        social = _social_sentiment(it.get("bulls"), it.get("bears"))
        news   = _signed_conviction(it.get("direction"), it.get("conviction"))
        sent   = round((social + news) / 2, 4)
        vol    = vol_map.get(it["ticker"])
        rel    = it.get("rel_vol")
        price  = it.get("price")
        if min_vol and vol is not None and vol < min_vol:
            continue
        if min_rel and rel is not None and rel < min_rel:
            continue
        if max_pr is not None and price is not None and price > max_pr:
            continue
        if sent_f == "bullish" and sent < 0.2:
            continue
        if sent_f == "bearish" and sent > -0.2:
            continue
        out.append({
            "ticker":        it["ticker"],
            "company":       it.get("company") or "",
            "price":         price,
            "change_pct":    it.get("change_pct"),
            "volume":        vol,
            "sentiment":     sent,
            "article_count": 0,
            "score":         it.get("score"),
            "rel_vol":       rel,
            "rsi":           it.get("rsi"),
        })
    return out[:limit]


def _correlation_entries():
    """Per-ticker price×sentiment r from the cached /api/correlation/rank run,
    projected into the React CorrelationEntry shape. Reads only the cache — never
    triggers live Finviz calls (the Run button / legacy tab warm it)."""
    data  = _corr_rank_cache.get("data") or {}
    out = []
    for it in data.get("items", []):
        r = it.get("r_price_sentiment")
        if r is None:
            continue
        out.append({
            "ticker":      it["ticker"],
            "correlation": r,
            "p_value":     0.0,                 # significance not computed by the engine
            "sample_size": it.get("n") or 0,
        })
    return out


@app.route("/api/status")
def api_status():
    """TopBar health pill."""
    s = get_db_stats()
    # Report the FeedFlash scored-article count the News page reads, not the legacy
    # rss_items count, so the pill and the News header match. Falls back to rss.
    articles = priyanshu_adapter.feedflash_article_count() or s.get("total_rss", 0)
    return jsonify({"ok": True, "database": {
        "articles":  articles,
        "insights":  s.get("total_insights", 0),
        "runs":      s.get("total_runs", 0),
    }})


@app.route("/api/market/status")
def api_market_status():
    """TopBar / Momentum market-open pill. ET regular session = Mon–Fri 09:30–16:00."""
    now_et = datetime.now(correlation_engine.EDT)
    weekday = now_et.weekday() < 5
    hm = now_et.strftime("%H:%M")
    is_open = weekday and "09:30" <= hm < "16:00"
    return jsonify({
        "open":    is_open,
        "session": multicap_screener.capture_session(now_et) if weekday else "closed",
        "time":    now_et.strftime("%H:%M ET"),
    })


@app.route("/api/fetch", methods=["POST"])
def api_fetch():
    """TopBar Fetch button: pull the RSS feeds once, persist new items, report the
    delta. Reuses rss_poller + database.save_rss_items (no new storage logic)."""
    import rss_poller
    t0 = time.time()
    before = query("SELECT COUNT(*) AS n FROM rss_items")[0]["n"]
    try:
        articles = rss_poller.fetch_all_feeds()
        database.save_rss_items(articles, set())
    except Exception as exc:
        return jsonify({"new_articles": 0, "ms": int((time.time() - t0) * 1000),
                        "error": str(exc)})
    after = query("SELECT COUNT(*) AS n FROM rss_items")[0]["n"]
    return jsonify({"new_articles": after - before, "total": after,
                    "ms": int((time.time() - t0) * 1000)})


@app.route("/api/watch")
def api_watch():
    """TopBar auto-watch SSE: a start event, then a `line` per fetch cycle, capped
    so a forgotten stream can't run forever."""
    try:
        interval = max(10, int(request.args.get("interval", 60)))
    except (TypeError, ValueError):
        interval = 60

    def _sse(event, payload):
        return f"event: {event}\ndata: {json.dumps(payload)}\n\n"

    def gen():
        import rss_poller
        yield _sse("start", {"message": f"Watching — fetching every {interval}s"})
        for cycle in range(1, 121):
            t0 = time.time()
            before = query("SELECT COUNT(*) AS n FROM rss_items")[0]["n"]
            try:
                database.save_rss_items(rss_poller.fetch_all_feeds(), set())
                after = query("SELECT COUNT(*) AS n FROM rss_items")[0]["n"]
                new = after - before
            except Exception as exc:
                yield _sse("error", {"message": str(exc)})
                new = 0
            yield _sse("line", {"text": f"Cycle #{cycle}: {new} new articles ({time.time() - t0:.1f}s)"})
            time.sleep(interval)
        yield _sse("end", {"message": "Watch ended (cycle cap reached)."})

    return app.response_class(gen(), mimetype="text/event-stream",
                              headers={"Cache-Control": "no-cache",
                                       "X-Accel-Buffering": "no"})


def _rss_to_article(d):
    tickers = d.get("extracted_tickers") or []
    return {
        "id":            str(d.get("id")),
        "article_id":    str(d.get("id")),
        "title":         d.get("title") or "",
        "source":        d.get("source") or "",
        "category":      None,
        "publish_date":  _iso_to_epoch(d.get("published_at")) or _iso_to_epoch(d.get("fetched_at")),
        "fetched_date":  _iso_to_epoch(d.get("fetched_at")),
        "ticker":        tickers[0] if tickers else None,
        "company":       None,
        "sentiment":     None,             # RSS items aren't sentiment-classified
        "ml_confidence": None,
        "url":           d.get("link"),
        "content":       d.get("description") or "",
        "matched_keyword": d.get("matched_keyword"),
        "tickers":       tickers,
    }


def _scored_to_article(a):
    """A FinBERT/VADER-scored FeedFlash article (priyanshu_adapter.fetch_priyanshu_
    articles) → frontend/src/lib/types.ts Article. Carries the bull/bear/neutral
    label so the News-row sentiment dot renders, plus the FinBERT + VADER scores."""
    label = a.get("sentiment_label") or a.get("sentiment")
    if label not in ("bullish", "bearish", "neutral"):
        label = None
    conf = a.get("ml_confidence")
    if conf is None and isinstance(a.get("finbert_score"), (int, float)):
        conf = round(abs(a["finbert_score"]), 4)   # |FinBERT| as a confidence proxy
    ticker = a.get("ticker")
    return {
        "id":            str(a.get("id")),
        "article_id":    str(a.get("id")),
        "title":         a.get("title") or a.get("headline") or "",
        "source":        a.get("source") or "FeedFlash",
        "category":      a.get("category"),
        "publish_date":  _iso_to_epoch(a.get("publish_date") or a.get("timestamp")),
        "fetched_date":  _iso_to_epoch(a.get("fetched_date")),
        "ticker":        ticker,
        "company":       a.get("company"),
        "sentiment":     label,                     # 'bullish' | 'bearish' | 'neutral' | None
        "sentiment_score": a.get("finbert_score") if a.get("finbert_score") is not None else a.get("sentiment_combined"),
        "ml_confidence": conf,
        "finbert_score": a.get("finbert_score"),
        "vader_score":   a.get("vader_score"),
        "url":           a.get("url") or a.get("article_url"),
        "content":       "",
        "tickers":       [ticker] if ticker else [],
    }


@app.route("/api/articles")
def api_articles():
    """News page feed → {articles, total}. Sourced from the sentiment-scored
    FinBERT/VADER article store (priyanshu_adapter / feedflash.db) so each article
    carries its bull/bear/neutral label + scores and the React News dot renders.
    Falls back to raw rss_items (no sentiment) only if that store is unavailable.
    Pure DB read — no model call.

    Ordering: articles that carry a sentiment label are surfaced first (newest-
    first within), then the rest, so the sentiment feed leads with scored items.
    (In this environment the newest ~120 articles are still unscored because the
    FeedFlash FinBERT scorer is down — ModuleNotFoundError; once it runs, the
    newest articles score and this ordering is naturally chronological.)"""
    try:    limit = int(request.args.get("limit", 30))
    except ValueError: limit = 30
    try:    offset = int(request.args.get("offset", 0))
    except ValueError: offset = 0
    source   = (request.args.get("source", "") or "").strip()
    category = (request.args.get("category", "") or "").strip()
    kw_only  = request.args.get("keywords_only", "") in ("1", "true", "yes")

    # Settings → News Sources allowlist (canonical). Default is the full catalog,
    # so this is a no-op until the user narrows the selection in Settings.
    enabled = set(priyanshu_adapter.load_selected_sources())
    src_filter_active = enabled != set(priyanshu_adapter.SOURCE_CATALOG)

    scored = priyanshu_adapter.fetch_priyanshu_articles(limit=max(2000, offset + limit))
    scored += tradingview_adapter.fetch_tradingview_articles(limit=max(200, offset + limit))
    if scored:
        arts = [_scored_to_article(a) for a in scored]
        if src_filter_active:
            arts = [a for a in arts
                    if priyanshu_adapter.canonical_source(a.get("source")) in enabled]
        if source and source.lower() != "all":
            arts = [a for a in arts if (a.get("source") or "").lower() == source.lower()]
        if category and category.lower() != "all":
            arts = [a for a in arts if (a.get("category") or "").lower() == category.lower()]
        if kw_only:                                  # keyword/ticker-tagged only
            arts = [a for a in arts if a.get("ticker")]
        labeled   = [a for a in arts if a["sentiment"] in ("bullish", "bearish", "neutral")]
        unlabeled = [a for a in arts if a["sentiment"] not in ("bullish", "bearish", "neutral")]
        ordered = labeled + unlabeled
        page = ordered[offset:offset + limit]
        return jsonify({"articles": page, "total": len(ordered), "count": len(page),
                        "scored": len(labeled), "source_kind": "feedflash",
                        "source_filter_active": src_filter_active,
                        "enabled_sources": sorted(enabled)})

    # Fallback: raw rss_items (no sentiment) when the scored store is unavailable.
    conds, params = [], []
    if source and source.lower() not in ("all", ""):
        conds.append("source = ?"); params.append(source)
    if kw_only:
        conds.append("(finviz_match = 1 OR (matched_keyword IS NOT NULL AND matched_keyword != ''))")
    where = (" WHERE " + " AND ".join(conds)) if conds else ""
    total = query(f"SELECT COUNT(*) AS n FROM rss_items{where}", tuple(params))[0]["n"]
    rows = query(f"SELECT * FROM rss_items{where} ORDER BY id DESC LIMIT ? OFFSET ?",
                 tuple(params) + (limit, offset))
    articles = []
    for r in rows:
        d = dict(r)
        try:    d["extracted_tickers"] = json.loads(d.get("extracted_tickers") or "[]")
        except Exception: d["extracted_tickers"] = []
        articles.append(_rss_to_article(d))
    return jsonify({"articles": articles, "total": total, "count": len(articles),
                    "source_kind": "rss"})


@app.route("/api/stats")
def api_stats():
    """News sidebar facets → {sources:[{source,count}], categories:[]}."""
    rows = query("SELECT source, COUNT(*) AS n FROM rss_items GROUP BY source ORDER BY n DESC")
    sources = [{"source": r["source"], "count": r["n"]} for r in rows]
    return jsonify({"sources": sources, "categories": [],
                    "total_articles": sum(s["count"] for s in sources)})


@app.route("/api/keywords")
def api_keywords():
    """News page keyword highlighting list (shares keyword_filter with the pipeline)."""
    import keyword_filter
    return jsonify({"keywords": keyword_filter.load_user_keywords()})


@app.route("/api/prices/<ticker>")
def api_prices(ticker):
    """NewsRow inline quote → {price, change_pct}. Reads the resting screener/
    multicap snapshots (no live Finviz call — this fires once per visible row)."""
    ticker = ticker.upper().strip()
    rows = query("SELECT price, change_pct FROM ticker_insights "
                 "WHERE ticker=? ORDER BY id DESC LIMIT 1", (ticker,))
    if rows:
        return jsonify({"ticker": ticker, "price": rows[0]["price"],
                        "change_pct": num(rows[0]["change_pct"])})
    for m in multicap_screener.get_latest_multicap(limit=500):
        if m["ticker"] == ticker:
            return jsonify({"ticker": ticker, "price": m.get("price"),
                            "change_pct": num(m.get("change_pct"))})
    return jsonify({"ticker": ticker, "price": None, "change_pct": None})


def _label_sentiment_num(label):
    """A Bullish/Bearish/Neutral label → the SocialPost numeric sentiment
    (+1/-1/0), matching the Stocktwits mapping. Shared by Bluesky and Reddit."""
    s = (label or "").lower()
    return 1 if s == "bullish" else -1 if s == "bearish" else 0


@app.route("/api/social/posts")
def api_social_posts():
    """Social feed posts → {posts:[SocialPost]}. Stocktwits and (when configured)
    Bluesky are real; reddit/twitter filters still yield an empty list. The
    platform tab filters which source(s) are returned."""
    ticker = (request.args.get("ticker") or "").upper().strip()
    platform = (request.args.get("platform") or "all").lower()
    posts = []
    if platform in ("all", "stocktwits", ""):
        for i, p in enumerate(get_stocktwits_posts()):
            if ticker and p["ticker"] != ticker:
                continue
            posts.append({
                "id":         f'{p["ticker"]}-{i}',
                "platform":   "stocktwits",
                "author":     "stocktwits",
                "content":    p.get("text") or "",
                "created_at": p.get("timestamp") or "",
                "ticker":     p.get("ticker"),
                "sentiment":  _stocktwits_sentiment_num(p.get("sentiment")),
                "url":        None,
            })
    if platform in ("all", "bluesky"):
        for i, p in enumerate(bluesky_adapter.fetch_bluesky_posts(
                ticker=ticker or None, limit=100)):
            posts.append({
                "id":         f'bsky-{p.get("ticker")}-{i}',
                "platform":   "bluesky",
                "author":     p.get("author") or "bluesky",
                "content":    p.get("text") or "",
                "created_at": p.get("timestamp") or "",
                "ticker":     p.get("ticker"),
                "sentiment":  _label_sentiment_num(p.get("sentiment")),
                "url":        p.get("url"),
            })
    if platform in ("all", "reddit"):
        for i, p in enumerate(reddit_adapter.fetch_reddit_posts(
                ticker=ticker or None, limit=100)):
            posts.append({
                "id":         f'reddit-{p.get("ticker")}-{i}',
                "platform":   "reddit",
                "author":     p.get("author") or "reddit",
                "content":    p.get("text") or "",
                "created_at": p.get("timestamp") or "",
                "ticker":     p.get("ticker"),
                "sentiment":  _label_sentiment_num(p.get("sentiment")),
                "url":        p.get("url"),
            })
    return jsonify({"posts": posts, "count": len(posts)})


@app.route("/api/social/phrases")
def api_social_phrases():
    """Social trending phrases → {phrases:[{phrase,count}]}."""
    return jsonify({"phrases": extract_trending_phrases(get_stocktwits_posts(), top_n=20)})


@app.route("/api/social/tickers")
def api_social_tickers():
    """Social ticker sidebar → {tickers:[{ticker,count,sentiment}]}."""
    out = []
    for r in get_insights_latest():
        b = r.get("stocktwits_bull_count") or 0
        e = r.get("stocktwits_bear_count") or 0
        if b + e > 0:
            out.append({"ticker": r["ticker"], "count": b + e,
                        "sentiment": _social_sentiment(b, e)})
    out.sort(key=lambda x: x["count"], reverse=True)
    return jsonify({"tickers": out})


@app.route("/api/social/health")
def api_social_health():
    """Social 'subreddit health' panel. No Reddit source — report Stocktwits
    coverage so the panel renders meaningfully instead of empty."""
    posts = get_stocktwits_posts()
    bsky_configured = bluesky_adapter.is_configured()
    bsky_posts = len(bluesky_adapter.fetch_bluesky_posts(limit=500)) if bsky_configured else 0
    reddit_configured = reddit_adapter.is_configured()
    reddit_posts = len(reddit_adapter.fetch_reddit_posts(limit=500)) if reddit_configured else 0
    return jsonify({"subreddits": [],
                    "platforms": [
                        {"name": "Stocktwits", "posts": len(posts),
                         "status": "ok" if posts else "idle"},
                        {"name": "Bluesky", "posts": bsky_posts,
                         "status": ("ok" if bsky_posts else "idle") if bsky_configured
                                   else "not configured"},
                        {"name": "Reddit", "posts": reddit_posts,
                         "status": ("ok" if reddit_posts else "idle") if reddit_configured
                                   else "not configured"},
                    ]})


# ── Technical indicators (pure-python, computed from the 1-min close series) ──
# lightweight-charts line/histogram series take [{time, value}] aligned to the
# candle timestamps. Each indicator starts at its first valid point and shares
# the candle time axis.

def _ema_list(values, period):
    """Exponential moving average over the full series (seeded with values[0])."""
    if not values:
        return []
    k = 2.0 / (period + 1)
    out, ema = [], None
    for v in values:
        ema = v if ema is None else (v - ema) * k + ema
        out.append(ema)
    return out


def _rsi_series(times, closes, period=14):
    """Wilder's RSI(period). First value at close index `period`."""
    n = len(closes)
    if n < period + 1:
        return []
    ch = [closes[i] - closes[i - 1] for i in range(1, n)]   # ch[i] ↔ close index i+1
    gains = [c if c > 0 else 0.0 for c in ch]
    losses = [-c if c < 0 else 0.0 for c in ch]
    ag = sum(gains[:period]) / period
    al = sum(losses[:period]) / period

    def _val(ag, al):
        if al == 0:
            return 100.0
        rs = ag / al
        return 100.0 - 100.0 / (1.0 + rs)

    out = [{"time": times[period], "value": round(_val(ag, al), 2)}]
    for i in range(period, len(ch)):
        ag = (ag * (period - 1) + gains[i]) / period
        al = (al * (period - 1) + losses[i]) / period
        out.append({"time": times[i + 1], "value": round(_val(ag, al), 2)})
    return out


def _macd_series(times, closes, fast=12, slow=26, signal=9):
    """MACD(fast,slow,signal): line = EMAfast − EMAslow, signal = EMAsignal(line),
    histogram = line − signal. Emitted from index slow-1 to skip EMA warmup."""
    n = len(closes)
    if n < slow:
        return {"macd": [], "signal": [], "histogram": []}
    ef, es = _ema_list(closes, fast), _ema_list(closes, slow)
    line = [ef[i] - es[i] for i in range(n)]
    sig = _ema_list(line, signal)
    m, s, h = [], [], []
    for i in range(slow - 1, n):
        m.append({"time": times[i], "value": round(line[i], 4)})
        s.append({"time": times[i], "value": round(sig[i], 4)})
        h.append({"time": times[i], "value": round(line[i] - sig[i], 4)})
    return {"macd": m, "signal": s, "histogram": h}


def _bollinger_series(times, closes, period=20, mult=2.0):
    """Bollinger(period, mult): basis = SMA, upper/lower = basis ± mult·stddev."""
    n = len(closes)
    if n < period:
        return {"upper": [], "lower": [], "basis": []}
    up, lo, ba = [], [], []
    for i in range(period - 1, n):
        win = closes[i - period + 1:i + 1]
        m = sum(win) / period
        sd = (sum((x - m) ** 2 for x in win) / period) ** 0.5
        up.append({"time": times[i], "value": round(m + mult * sd, 4)})
        lo.append({"time": times[i], "value": round(m - mult * sd, 4)})
        ba.append({"time": times[i], "value": round(m, 4)})
    return {"upper": up, "lower": lo, "basis": ba}


# ─── FINVIZ CHART-IMAGE GRID (screener-mirroring charts view) ────────────────
# The React Charts Grid renders one Finviz chart image per screener ticker — the
# Finviz v=321 mirror. Images come from charts-node.finviz.com, which serves real
# intraday + daily candlestick PNGs WITHOUT the Elite token, so the grid puts ZERO
# load on the shared quote_export token we already hit 429s on. Each image is
# cached server-side (TTL) and only the visible page requests them, so a 12-up
# grid refreshing every 10s still re-fetches a given ticker from Finviz at most
# once per TTL.
_FINVIZ_TF = {            # frontend timeframe -> charts-node `tf` param
    "1m": "i1", "3m": "i3", "5m": "i5", "15m": "i15",
    "30m": "i30", "1h": "i60", "d": "d", "w": "w",
}
_chart_img_cache: dict = {}      # (ticker, tf) -> {"ts": epoch, "body": bytes, "ct": str}
_CHART_IMG_TTL = 45


def _finviz_chart_image(ticker: str, tf_param: str):
    """Fetch one Finviz candlestick PNG for `ticker` at the charts-node `tf_param`.
    Cached `_CHART_IMG_TTL`s per (ticker, tf). Returns (body, content_type) or
    (None, None) on failure. No Elite token — charts-node is unauthenticated, so
    this never touches the rate-limited quote_export token."""
    key = (ticker, tf_param)
    hit = _chart_img_cache.get(key)
    if hit and time.time() - hit["ts"] < _CHART_IMG_TTL:
        return hit["body"], hit["ct"]
    url = (f"https://charts-node.finviz.com/chart.ashx"
           f"?cs=l&t={ticker}&tf={tf_param}&ct=candle_stick")
    try:
        resp = cffi_requests.Session().get(
            url, headers=correlation_engine.CURL_HEADERS,
            impersonate="chrome124", timeout=20, max_redirects=5)
        if resp.status_code == 200 and resp.content[:4] == b"\x89PNG":
            ct = resp.headers.get("content-type") or "image/png"
            _chart_img_cache[key] = {"ts": time.time(), "body": resp.content, "ct": ct}
            return resp.content, ct
        print(f"  [charts-grid] {ticker}/{tf_param}: HTTP {resp.status_code} "
              f"(not a PNG) — skipping")
    except Exception as exc:
        print(f"  [charts-grid] image fetch failed {ticker}/{tf_param}: {exc}")
    return None, None


@app.route("/api/charts/grid-image/<ticker>")
def api_chart_grid_image(ticker):
    """Screener-mirror grid: one cached Finviz candlestick PNG per ticker. The
    `tf` query (1m/3m/5m/15m/30m/1h/d/w) maps to charts-node's timeframe param;
    unknown values fall back to daily. The client cache-busts on refresh, which
    re-requests this route, but the server still serves from its TTL cache so
    Finviz is hit at most once per TTL per (ticker, tf)."""
    ticker = re.sub(r"[^A-Za-z0-9.\-]", "", ticker.upper().strip())[:12]
    tf = (request.args.get("tf", "d") or "d").lower().strip()
    tf_param = _FINVIZ_TF.get(tf, "d")
    body, ct = _finviz_chart_image(ticker, tf_param)
    if body is None:
        return jsonify({"error": f"chart image unavailable for {ticker}"}), 502
    return app.response_class(body, mimetype=ct,
                              headers={"Cache-Control": "public, max-age=30"})


@app.route("/api/charts/<ticker>")
def api_charts(ticker):
    """Charts page candlestick view → real 1-min OHLC candles + RSI(14)/MACD/
    Bollinger from the Finviz quote_export bars. Honesty: the data is 1-min
    EXTENDED-HOURS intraday only (no daily history, no fundamentals), so `window`
    is intraday (full | 2h | 1h) and there is no daily/weekly range. Times are
    unix seconds with the naive ET wall-clock encoded as UTC, so lightweight-
    charts' UTC axis shows ET session time (04:00–20:00)."""
    ticker = ticker.upper().strip()
    window = (request.args.get("window", "full") or "full").lower().strip()
    if window not in ("full", "2h", "1h"):
        window = "full"
    bars, date_used = _latest_session_bars(ticker)
    if date_used is None:
        return jsonify({"ticker": ticker, "error": bars.get("error"), "candles": []})
    if window in ("2h", "1h"):
        cutoff = bars[-1]["ts"] - timedelta(hours=2 if window == "2h" else 1)
        bars = [b for b in bars if b["ts"] >= cutoff]

    def _epoch(ts):
        return int(ts.replace(tzinfo=timezone.utc).timestamp())

    times  = [_epoch(b["ts"]) for b in bars]
    closes = [b["close"] for b in bars]
    candles = [{"time": t, "open": b["open"], "high": b["high"],
                "low": b["low"], "close": b["close"], "volume": b["volume"]}
               for t, b in zip(times, bars)]
    return jsonify({
        "ticker": ticker, "date": date_used, "window": window, "n": len(bars),
        "candles":   candles,
        "rsi":       _rsi_series(times, closes, 14),
        "macd":      _macd_series(times, closes, 12, 26, 9),
        "bollinger": _bollinger_series(times, closes, 20, 2),
        "open": closes[0] if closes else None,
        "last": closes[-1] if closes else None,
    })


@app.route("/api/ticker/<ticker>/enrich")
def api_ticker_enrich(ticker):
    """Per-ticker enrichments for the Charts detail view (the professor's layout):
      • news_alert  — structured news present in the recent window (FeedFlash)
      • news        — the ticker's last-3-day scored articles (today/yesterday/
                      day-before), each with its sentiment score + source
      • social      — Stocktwits sentiment + message density + any detected rumor;
                      X / Reddit / Bluesky are surfaced as future (un-ingested) sources

    Pure DB read — no model call. Every block fails soft so a dead source (Mongo
    down, FeedFlash empty) degrades to empty rather than erroring the view."""
    ticker = re.sub(r"[^A-Za-z0-9.\-]", "", (ticker or "").upper().strip())[:12]
    if not ticker:
        return jsonify({"error": "no ticker"}), 400

    # ── News (FeedFlash + TradingView, last 3 days) ──
    try:
        articles = priyanshu_adapter.ticker_articles(ticker, days=3)
    except Exception as exc:
        print(f"  [enrich] news failed {ticker}: {exc}")
        articles = []
    try:
        articles += tradingview_adapter.ticker_articles(ticker, days=3)
    except Exception as exc:
        print(f"  [enrich] tradingview news failed {ticker}: {exc}")
    # Honor the Settings → News Sources selection (default = all sources on).
    enabled = set(priyanshu_adapter.load_selected_sources())
    src_filter_active = enabled != set(priyanshu_adapter.SOURCE_CATALOG)
    if src_filter_active:
        articles = [a for a in articles
                    if priyanshu_adapter.canonical_source(a.get("source")) in enabled]
    news_rows = [{
        "id":            a["id"],
        "headline":      a["headline"],
        "source":        a["source"],
        "url":           a["url"],
        "published_at":  _iso_to_epoch(a.get("timestamp")),
        "sentiment":     a.get("sentiment_label"),
        "sentiment_score": a.get("sentiment_score"),
        "finbert_score": a.get("finbert_score"),
        "vader_score":   a.get("vader_score"),
    } for a in articles]
    sources = sorted({a["source"] for a in articles if a.get("source")})

    # ── AI ranking news (ticker_insights) ──
    # The news that DROVE the AI pick lives here — the catalyst + the headlines the
    # ranking scored at run time — not in FeedFlash. Surfacing it keeps the detail
    # view consistent with Overview: a top pick can never show "no news" while its
    # own card cites a catalyst. This is the ticker's most recent insight (any run).
    ai_news = None
    try:
        irow = query("SELECT direction, conviction, news_catalyst, summary, "
                     "article_headlines, news_sources, created_at "
                     "FROM ticker_insights WHERE ticker=? ORDER BY run_id DESC LIMIT 1",
                     (ticker,))
        if irow:
            ins = dict(irow[0])
            try:    headlines = json.loads(ins.get("article_headlines") or "[]")
            except Exception: headlines = []
            try:    ai_sources = json.loads(ins.get("news_sources") or "[]")
            except Exception: ai_sources = []
            if ins.get("news_catalyst") or headlines:
                ai_news = {
                    "catalyst":    ins.get("news_catalyst"),
                    "summary":     ins.get("summary"),
                    "direction":   ins.get("direction"),
                    "conviction":  ins.get("conviction"),
                    "headlines":   [h for h in headlines if isinstance(h, str)],
                    "sources":     ai_sources,
                    "assessed_at": _iso_to_epoch(ins.get("created_at")),
                }
    except Exception as exc:
        print(f"  [enrich] ai news failed {ticker}: {exc}")

    # ── Social (Stocktwits) + rumor (Yosef) ──
    try:
        sm = yosef_adapter.social_metrics_by_ticker(window_hours=72).get(ticker)
    except Exception as exc:
        print(f"  [enrich] social failed {ticker}: {exc}")
        sm = None
    # ── Social (Bluesky — second real source, same metric shape) ──
    bsky_configured = bluesky_adapter.is_configured()
    bsm = None
    if bsky_configured:
        try:
            bsm = bluesky_adapter.social_metrics_by_ticker(window_hours=72).get(ticker)
        except Exception as exc:
            print(f"  [enrich] bluesky failed {ticker}: {exc}")
            bsm = None
    # ── Social (Reddit — third real source, same metric shape) ──
    reddit_configured = reddit_adapter.is_configured()
    rdm = None
    if reddit_configured:
        try:
            rdm = reddit_adapter.social_metrics_by_ticker(window_hours=72).get(ticker)
        except Exception as exc:
            print(f"  [enrich] reddit failed {ticker}: {exc}")
            rdm = None
    try:
        rumors = yosef_adapter.fetch_yosef_rumor_detection(
            tickers=[ticker], window_minutes=72 * 60)
        rumor = rumors[0] if rumors else None
        if rumor and not rumor.get("active_rumor"):
            rumor = None
    except Exception as exc:
        print(f"  [enrich] rumor failed {ticker}: {exc}")
        rumor = None

    # Alert fires when there's structured news OR an AI catalyst — so a top pick
    # is never shown as "no news". The empty state appears only when BOTH the
    # FeedFlash articles AND the AI insight are empty.
    ai_count = (len(ai_news["headlines"]) + (1 if ai_news.get("catalyst") else 0)) if ai_news else 0
    return jsonify({
        "ticker": ticker,
        "news_alert":       len(news_rows) > 0 or ai_news is not None,
        "news_alert_count": len(news_rows) + ai_count,
        "news": {
            "days": 3,
            "articles": news_rows,
            "ai": ai_news,
            "sources": sources,
            "source_filter_active": src_filter_active,
            "note": ("Filtered to your Settings → News Sources selection."
                     if src_filter_active else "Showing all sources."),
        },
        "social": {
            "stocktwits": ({
                "sentiment": sm.get("sentiment"),
                "density":   sm.get("density"),
                "bull":      sm.get("bull"),
                "bear":      sm.get("bear"),
                "window_hours": 72,
            } if sm else None),
            # Bluesky mirrors the Stocktwits block. `configured` distinguishes
            # "no creds set" (UI shows 'not configured') from "configured but no
            # mentions in the window" (metrics is None — a true null, never faked).
            "bluesky": {
                "configured": bsky_configured,
                "metrics": ({
                    "sentiment": bsm.get("sentiment"),
                    "density":   bsm.get("density"),
                    "bull":      bsm.get("bull"),
                    "bear":      bsm.get("bear"),
                    "window_hours": 72,
                } if bsm else None),
            },
            # Reddit mirrors the Bluesky block — same configured/metrics contract.
            "reddit": {
                "configured": reddit_configured,
                "metrics": ({
                    "sentiment": rdm.get("sentiment"),
                    "density":   rdm.get("density"),
                    "bull":      rdm.get("bull"),
                    "bear":      rdm.get("bear"),
                    "window_hours": 72,
                } if rdm else None),
            },
            "rumor": ({
                "text":      rumor.get("active_rumor"),
                "direction": rumor.get("rumor_direction"),
                "time":      _iso_to_epoch(rumor.get("rumor_time")),
                "author":    rumor.get("rumor_author"),
            } if rumor else None),
            # Sources we do not ingest yet — labeled so the UI shows them as future.
            # Bluesky and Reddit are now real, so only X remains future-only.
            "future_sources": ["X"],
        },
    })


@app.route("/api/momentum/trending")
def api_momentum_trending():
    """Momentum trending bar → {tickers:[...]} from the gainers leaderboard."""
    mom = build_momentum()
    return jsonify({"tickers": [{"ticker": g["ticker"], "change_pct": g.get("change_pct"),
                                 "price": g.get("price"), "company": g.get("company") or ""}
                                for g in mom.get("gainers", [])]})


@app.route("/api/momentum/<ticker>/details")
def api_momentum_details(ticker):
    """Momentum card expand → {headlines:[...], posts:[...]} for one ticker."""
    ticker = ticker.upper().strip()
    headlines = []
    for a in get_news_items(limit=300):
        if ticker in (a.get("extracted_tickers") or []):
            headlines.append({"title": a.get("title"), "source": a.get("source"),
                              "sentiment": None, "time": (a.get("published_at") or "")[11:16],
                              "catalyst": a.get("matched_keyword")})
            if len(headlines) >= 8:
                break
    posts = []
    rows = query("SELECT stocktwits_posts FROM ticker_insights "
                 "WHERE ticker=? AND stocktwits_posts IS NOT NULL "
                 "ORDER BY id DESC LIMIT 1", (ticker,))
    if rows:
        try:
            for p in (json.loads(rows[0]["stocktwits_posts"] or "[]"))[:6]:
                posts.append({"content": p.get("text") or "", "platform": "stocktwits",
                              "author": p.get("username") or "stocktwits",
                              "sentiment": _stocktwits_sentiment_num(p.get("sentiment"))})
        except Exception:
            pass
    return jsonify({"ticker": ticker, "headlines": headlines, "posts": posts})


@app.route("/api/correlation/run", methods=["POST"])
def api_correlation_run():
    """Correlation page Run button: warm the per-ticker rank cache (live Finviz +
    Stocktwits), which /api/correlation then exposes as `entries`."""
    with app.test_request_context("/api/correlation/rank?refresh=1"):
        resp = api_correlation_rank()
    data = resp.get_json() if hasattr(resp, "get_json") else {}
    return jsonify({"ok": True, "count": (data or {}).get("count", 0)})


@app.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    """React Settings page (generic UI prefs: theme/notifications/autoRefresh/
    refreshInterval). Persisted to a small JSON next to the DB; distinct from the
    legacy /api/settings/* (stats|logs|keywords|impersonate) routes, which stay."""
    path = Path(__file__).parent / "ui_settings.json"
    defaults = {"theme": "dark", "notifications": True,
                "autoRefresh": True, "refreshInterval": 60}
    if request.method == "POST":
        incoming = request.json or {}
        merged = {**defaults, **incoming}
        try:
            path.write_text(json.dumps(merged), encoding="utf-8")
        except Exception:
            pass
        return jsonify(merged)
    if path.exists():
        try:
            return jsonify({**defaults, **json.loads(path.read_text(encoding="utf-8"))})
        except Exception:
            pass
    return jsonify(defaults)


# ─── PUBLIC API v1 (token-authenticated; see API.md) ─────────────────────────
# The /api/* routes above stay internal/unauthenticated for the dashboard
# frontend. /api/v1/* is the versioned public surface for other systems.
# Envelope: {"ok": true, "data": ...} / {"ok": false, "error": {code, message}}.

def _api_keys() -> set:
    raw = os.environ.get("SENTIMENT_SCOUT_API_KEYS", "")
    return {k.strip() for k in raw.split(",") if k.strip()}


def v1_ok(data):
    return jsonify({"ok": True, "data": data})


def v1_error(status: int, code: str, message: str):
    return jsonify({"ok": False, "error": {"code": code, "message": message}}), status


def _api_key_error():
    """Validate the request's API key against SENTIMENT_SCOUT_API_KEYS.
    Returns a (response, status) error tuple if auth fails, else None. Shared by
    the require_api_key decorator and any handler that needs to gate a write."""
    keys = _api_keys()
    if not keys:
        return v1_error(503, "not_configured",
                        "No API keys configured on the server. Set the "
                        "SENTIMENT_SCOUT_API_KEYS environment variable.")
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        supplied = auth[7:].strip()
    else:
        supplied = request.headers.get("X-API-Key", "").strip()
    if not supplied:
        return v1_error(401, "unauthorized",
                        "Missing API key. Send 'Authorization: Bearer <key>' "
                        "or 'X-API-Key: <key>'.")
    if not any(hmac.compare_digest(supplied, k) for k in keys):
        return v1_error(401, "unauthorized", "Invalid API key.")
    return None


def require_api_key(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        err = _api_key_error()
        if err:
            return err
        return fn(*args, **kwargs)
    return wrapper


@app.route("/api/v1/health")
def api_v1_health():
    return v1_ok({"status": "ok", "version": "v1",
                  "time": datetime.now(timezone.utc).isoformat()})


@app.route("/api/v1/screener")
@require_api_key
def api_v1_screener():
    items = get_insights_latest()
    return v1_ok({"items": items, "count": len(items)})


@app.route("/api/v1/momentum")
@require_api_key
def api_v1_momentum():
    return v1_ok(build_momentum())


@app.route("/api/v1/social")
@require_api_key
def api_v1_social():
    posts = get_stocktwits_posts()
    return v1_ok({"posts": posts, "count": len(posts),
                  "trending": extract_trending_phrases(posts)})


@app.route("/api/v1/news")
@require_api_key
def api_v1_news():
    try:
        limit = int(request.args.get("limit", 200))
    except ValueError:
        return v1_error(400, "bad_request", "'limit' must be an integer.")
    items = get_news_items(
        limit=limit,
        source=request.args.get("source", ""),
        date_from=request.args.get("date_from", ""),
        date_to=request.args.get("date_to", ""),
        time_from=request.args.get("time_from", ""),
        time_to=request.args.get("time_to", ""),
    )
    return v1_ok({"items": items, "count": len(items)})


@app.route("/api/v1/multicap")
@require_api_key
def api_v1_multicap():
    rows = multicap_screener.get_latest_multicap(limit=500)
    return v1_ok({"items": rows, "count": len(rows)})


@app.route("/api/v1/correlation")
@require_api_key
def api_v1_correlation():
    return v1_ok(build_correlation(
        ticker=request.args.get("ticker", "").upper().strip(),
        date_val=request.args.get("date", "").strip(),
        t_from=request.args.get("time_from", "09:30").strip() or "09:30",
        t_to=request.args.get("time_to", "16:00").strip() or "16:00",
    ))


@app.route("/api/v1/chart")
@require_api_key
def api_v1_chart():
    ticker = request.args.get("ticker", "").upper().strip()
    if not ticker:
        return v1_error(400, "bad_request", "'ticker' query param is required.")
    window = request.args.get("window", "full").lower().strip()
    return v1_ok(build_chart(ticker, window))


# ─── MAIN TEMPLATE ────────────────────────────────────────────────────────────

TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Sentiment Scout</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
button{font:inherit;cursor:pointer;border:none;background:none}
a{color:inherit;text-decoration:none}
input,select,textarea{font:inherit}
:root{
  --bg-page:#0c0f14;
  --bg-panel:#111318;
  --bg-panel-alt:#16191f;
  --bg-hover:#1a1e27;
  --bg-row-alt:#13161c;
  --border:0.5px solid #252b38;
  --border-color:#252b38;
  --border-strong:#2e3444;
  --text-primary:#dde1ea;
  --text-secondary:#7a8290;
  --text-tertiary:#4e5567;
  --green:#1d9e75;
  --green-bg:rgba(29,158,117,.12);
  --green-border:rgba(29,158,117,.28);
  --red:#d85a30;
  --red-bg:rgba(216,90,48,.12);
  --red-border:rgba(216,90,48,.28);
  --amber:#c8922a;
  --amber-bg:rgba(200,146,42,.12);
  --amber-border:rgba(200,146,42,.28);
  --blue:#3b82f6;
  --blue-bg:rgba(59,130,246,.12);
  --blue-border:rgba(59,130,246,.28);
  --purple:#8b5cf6;
  --purple-bg:rgba(139,92,246,.12);
  --purple-border:rgba(139,92,246,.28);
  --pink:#ec4899;
  --pink-bg:rgba(236,72,153,.12);
  --pink-border:rgba(236,72,153,.28);
  --violet:#a78bfa;
  --violet-bg:rgba(167,139,250,.12);
  --violet-border:rgba(167,139,250,.28);
  --font:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  --mono:'SF Mono','Cascadia Code','Fira Code','Consolas',monospace;
  --radius:12px;--radius-sm:6px;--radius-xs:4px;
  --topbar-h:52px;
}
html{font-size:14px;height:100%}
body{font-family:var(--font);background:var(--bg-page);color:var(--text-primary);
  height:100vh;overflow:hidden;display:flex;flex-direction:column;line-height:1.5}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:var(--bg-page)}
::-webkit-scrollbar-thumb{background:var(--border-strong);border-radius:99px}

/* ── TOPBAR ─── */
#topbar{
  flex-shrink:0;height:var(--topbar-h);background:var(--bg-panel);
  border-bottom:var(--border);display:flex;align-items:center;
  padding:0 1.25rem;gap:0;z-index:100;
}
.topbar-logo{display:flex;align-items:baseline;gap:.3rem;
  font-family:var(--mono);font-size:.95rem;font-weight:700;
  letter-spacing:-.01em;white-space:nowrap;margin-right:1.25rem}
.logo-word{color:var(--text-primary)}
.logo-scout{color:var(--green)}
.logo-dot{width:6px;height:6px;border-radius:50%;background:var(--green);
  margin-left:.25rem;margin-bottom:.1rem;animation:pulse-dot 2s infinite;flex-shrink:0}
@keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:.35}}
.topbar-nav{display:flex;gap:0;flex:1;border-left:var(--border);margin-left:.5rem}
.nav-tab{padding:0 .9rem;height:var(--topbar-h);display:flex;align-items:center;
  font-size:.75rem;font-weight:500;letter-spacing:.02em;
  color:var(--text-tertiary);cursor:pointer;
  border-bottom:2px solid transparent;margin-bottom:-1px;
  transition:color .15s,border-color .15s;white-space:nowrap}
.nav-tab:hover{color:var(--text-secondary)}
.nav-tab.active{color:var(--text-primary);border-bottom-color:var(--green)}
.topbar-right{display:flex;align-items:center;gap:.6rem;margin-left:auto}
#et-clock{font-family:var(--mono);font-size:.72rem;color:var(--text-secondary);white-space:nowrap}
.iv-label{font-size:.66rem;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.07em}
.iv-select{font-family:var(--mono);font-size:.7rem;font-weight:600;
  color:var(--text-secondary);background:var(--bg-panel-alt);
  border:var(--border);border-radius:var(--radius-xs);
  padding:.28rem .5rem;cursor:pointer;outline:none;
  transition:border-color .15s,color .15s}
.iv-select:hover,.iv-select:focus{border-color:var(--green-border);color:var(--text-primary)}
#runBtn{display:inline-flex;align-items:center;gap:.4rem;
  font-family:var(--mono);font-size:.72rem;font-weight:700;letter-spacing:.04em;
  padding:.35rem .85rem;border-radius:var(--radius-sm);
  border:1px solid var(--green-border);background:var(--green-bg);color:var(--green);
  transition:background .15s,border-color .15s,opacity .15s}
#runBtn:hover:not(:disabled){background:rgba(29,158,117,.22);border-color:var(--green)}
#runBtn:disabled{opacity:.4;cursor:not-allowed}
#runBtn.running{border-color:var(--amber-border);background:var(--amber-bg);color:var(--amber)}
@keyframes spin{to{transform:rotate(360deg)}}
.spin{display:inline-block;animation:spin .8s linear infinite}

/* ── TAB CONTENT ─── */
#tab-content{flex:1;min-height:0;position:relative;overflow:hidden}
.tab-panel{position:absolute;inset:0;overflow-y:auto;display:none;flex-direction:column}
.tab-panel.active{display:flex}

/* ── COMMON PANEL HEADER ─── */
.page-header{
  flex-shrink:0;padding:.8rem 1.25rem;
  border-bottom:var(--border);background:var(--bg-panel);
  display:flex;align-items:center;gap:.75rem;
}
.page-title{font-size:.92rem;font-weight:700;color:var(--text-primary)}
.page-count{font-family:var(--mono);font-size:.72rem;color:var(--text-tertiary)}
.page-spacer{flex:1}

/* ── CONTROLS ROW ─── */
.controls-row{
  flex-shrink:0;padding:.55rem 1.25rem;border-bottom:var(--border);
  background:var(--bg-panel-alt);
  display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;
}
.ctrl-label{font-size:.66rem;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.07em;white-space:nowrap}
.ctrl-input{
  font-family:var(--mono);font-size:.72rem;color:var(--text-primary);
  background:var(--bg-page);border:var(--border);border-radius:var(--radius-xs);
  padding:.28rem .55rem;outline:none;transition:border-color .15s;
}
.ctrl-input:focus{border-color:var(--green-border)}
.ctrl-select{
  font-family:var(--mono);font-size:.72rem;color:var(--text-secondary);
  background:var(--bg-page);border:var(--border);border-radius:var(--radius-xs);
  padding:.28rem .5rem;outline:none;cursor:pointer;transition:border-color .15s,color .15s;
}
.ctrl-select:hover,.ctrl-select:focus{border-color:var(--green-border);color:var(--text-primary)}
.ctrl-sep{width:1px;height:18px;background:var(--border-color);flex-shrink:0}
.ctrl-btn{
  font-size:.7rem;font-weight:600;padding:.28rem .7rem;
  border-radius:var(--radius-xs);border:var(--border);
  background:var(--bg-hover);color:var(--text-secondary);cursor:pointer;
  transition:background .15s,color .15s,border-color .15s;white-space:nowrap;
}
.ctrl-btn:hover{background:var(--bg-panel-alt);color:var(--text-primary)}
.ctrl-btn.primary{background:var(--green-bg);color:var(--green);border-color:var(--green-border)}
.ctrl-btn.primary:hover{background:rgba(29,158,117,.22)}

/* toggle */
.toggle-wrap{display:flex;align-items:center;gap:.35rem;cursor:pointer;user-select:none}
.toggle-label{font-size:.7rem;color:var(--text-secondary)}
.toggle-track{width:28px;height:15px;border-radius:99px;background:var(--border-strong);
  position:relative;transition:background .2s;flex-shrink:0}
.toggle-thumb{position:absolute;top:2px;left:2px;width:11px;height:11px;
  border-radius:50%;background:var(--text-tertiary);transition:transform .2s,background .2s}
input.toggle-input:checked+.toggle-track{background:var(--green-bg);border:1px solid var(--green-border)}
input.toggle-input:checked+.toggle-track .toggle-thumb{transform:translateX(13px);background:var(--green)}
input.toggle-input{display:none}

/* ── SOURCE / FILTER CHIPS ─── */
.chips-row{
  flex-shrink:0;padding:.45rem 1.25rem;border-bottom:var(--border);
  display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;background:var(--bg-panel);
}
.chip{
  font-family:var(--mono);font-size:.65rem;font-weight:600;letter-spacing:.03em;
  padding:.22rem .6rem;border-radius:99px;
  border:1px solid var(--border-color);background:var(--bg-panel-alt);
  color:var(--text-tertiary);cursor:pointer;
  transition:background .15s,color .15s,border-color .15s;white-space:nowrap;
}
.chip:hover{color:var(--text-secondary);border-color:var(--border-strong)}
.chip.active{background:var(--green-bg);color:var(--green);border-color:var(--green-border)}
.chip.soon{opacity:.5;cursor:default}
.chip.soon::after{content:" ·coming soon";font-size:.58rem;color:var(--amber)}

/* ── BADGES ─── */
.badge{display:inline-flex;align-items:center;font-family:var(--mono);font-size:.6rem;
  font-weight:700;padding:.18rem .48rem;border-radius:var(--radius-xs);
  letter-spacing:.04em;white-space:nowrap;line-height:1.4}
.badge-long{background:var(--green-bg);color:var(--green);border:1px solid var(--green-border)}
.badge-short{background:var(--red-bg);color:var(--red);border:1px solid var(--red-border)}
.badge-neutral{background:var(--bg-hover);color:var(--text-tertiary);border:1px solid var(--border-color)}
.badge-hc{background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-border)}
.badge-same{background:var(--bg-hover);color:var(--text-tertiary);border:1px solid var(--border-color)}
.badge-added{background:var(--green-bg);color:var(--green);border:1px solid var(--green-border)}
.badge-dropped{background:var(--red-bg);color:var(--red);border:1px solid var(--red-border)}
.badge-mega{background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue-border)}
.badge-large{background:var(--green-bg);color:var(--green);border:1px solid var(--green-border)}
.badge-mid{background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-border)}
.badge-small{background:var(--red-bg);color:var(--red);border:1px solid var(--red-border)}
.badge-micro{background:var(--pink-bg);color:var(--pink);border:1px solid var(--pink-border)}
.badge-nano{background:var(--bg-hover);color:var(--text-secondary);border:1px solid var(--border-strong)}
.badge-both{background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-border)}
.badge-kw{background:var(--violet-bg);color:var(--violet);border:1px solid var(--violet-border)}
.badge-unknown{background:var(--bg-hover);color:var(--text-tertiary);border:1px solid var(--border-color)}
.badge-correct{background:var(--green-bg);color:var(--green);border:1px solid var(--green-border)}
.badge-wrong{background:var(--red-bg);color:var(--red);border:1px solid var(--red-border)}
.badge-pending{background:var(--bg-hover);color:var(--text-tertiary);border:1px solid var(--border-color)}
.badge-gnw{background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue-border)}
.badge-sec{background:var(--red-bg);color:var(--red);border:1px solid var(--red-border)}
.badge-prn{background:var(--green-bg);color:var(--green);border:1px solid var(--green-border)}
.badge-bw{background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-border)}
.badge-st{background:var(--purple-bg);color:var(--purple);border:1px solid var(--purple-border)}
.badge-ibkr{background:var(--violet-bg);color:var(--violet);border:1px solid var(--violet-border)}
.badge-fv{background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-border)}
.badge-reddit{background:var(--red-bg);color:var(--red);border:1px solid var(--red-border)}
.badge-x{background:var(--bg-hover);color:var(--text-secondary);border:1px solid var(--border-strong)}
.badge-bluesky{background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue-border)}

/* ── NEWS FEED ─── */
.news-feed{flex:1;display:flex;flex-direction:column}
.news-section-divider{
  padding:.4rem 1.25rem;background:var(--bg-page);border-bottom:var(--border);
  display:flex;align-items:center;gap:.6rem;
}
.nsd-label{font-size:.62rem;font-weight:700;text-transform:uppercase;
  letter-spacing:.1em;color:var(--text-tertiary)}
.nsd-team{font-size:.62rem;color:var(--text-tertiary);font-style:italic}
.nsd-pipe{color:var(--text-tertiary);font-family:var(--mono);font-size:.6rem}
.news-item{
  padding:.6rem 1.25rem;border-bottom:var(--border);
  display:grid;grid-template-columns:auto 1fr;
  gap:.4rem .7rem;align-items:start;
  transition:background .12s;cursor:default;
}
.news-item:hover{background:var(--bg-hover)}
.news-meta{display:flex;flex-direction:column;gap:.3rem;align-items:flex-start;min-width:72px}
.news-ts{font-family:var(--mono);font-size:.6rem;color:var(--text-tertiary);white-space:nowrap}
.news-body{display:flex;flex-direction:column;gap:.25rem}
.news-badges{display:flex;gap:.3rem;flex-wrap:wrap;align-items:center}
.news-headline{font-size:.78rem;color:var(--text-primary);line-height:1.45}
.news-headline a:hover{color:var(--green)}
.news-scores{font-family:var(--mono);font-size:.6rem;color:var(--text-tertiary)}
.news-soon{
  padding:.75rem 1.25rem;display:flex;align-items:center;gap:.6rem;
  border-bottom:var(--border);
}
.soon-bar{width:3px;height:26px;background:var(--border-color);border-radius:99px;flex-shrink:0}
.soon-label{font-size:.72rem;color:var(--text-tertiary)}
.soon-badge{margin-left:auto;font-family:var(--mono);font-size:.6rem;font-weight:700;
  padding:.14rem .4rem;border-radius:var(--radius-xs);
  background:var(--bg-hover);color:var(--text-tertiary);
  border:1px solid var(--border-color);letter-spacing:.04em}
.empty-state{padding:2.5rem;text-align:center;color:var(--text-tertiary);font-size:.8rem}

/* ── SCREENER TAB ─── */
.filter-panel{
  flex-shrink:0;overflow:hidden;max-height:0;
  transition:max-height .3s ease;border-bottom:var(--border);
}
.filter-panel.open{max-height:300px}
.filter-panel-inner{padding:.75rem 1.25rem;background:var(--bg-panel-alt)}
.filter-tabs{display:flex;gap:0;border-bottom:var(--border);margin-bottom:.65rem}
.ftab{font-size:.68rem;font-weight:600;letter-spacing:.04em;
  padding:.35rem .8rem;color:var(--text-tertiary);cursor:pointer;
  border-bottom:2px solid transparent;margin-bottom:-1px;
  transition:color .15s,border-color .15s}
.ftab:hover{color:var(--text-secondary)}
.ftab.active{color:var(--text-primary);border-bottom-color:var(--green)}
.ftab-panel{display:none}.ftab-panel.active{display:block}
.cap-checks{display:flex;gap:.5rem;flex-wrap:wrap}
.cap-check{display:flex;align-items:center;gap:.3rem;cursor:pointer;
  font-size:.72rem;color:var(--text-secondary)}
.cap-check input{accent-color:var(--green);cursor:pointer}
.range-row{display:flex;align-items:center;gap:.6rem;margin-bottom:.4rem}
.range-label{font-size:.68rem;color:var(--text-secondary);min-width:80px}
input[type=range]{accent-color:var(--green);flex:1}
.range-val{font-family:var(--mono);font-size:.68rem;color:var(--green);min-width:32px}
.table-wrap{flex:1;overflow:auto}
.screener-table{width:100%;border-collapse:collapse;font-size:.78rem}
.screener-table thead th{
  background:var(--bg-panel-alt);padding:.5rem .75rem;
  text-align:left;font-size:.63rem;font-weight:700;
  text-transform:uppercase;letter-spacing:.1em;color:var(--text-tertiary);
  border-bottom:var(--border);white-space:nowrap;
  user-select:none;
}
.screener-table thead th.sortable{cursor:pointer}
.screener-table thead th.sortable:hover{color:var(--text-secondary)}
.screener-table thead th.sort-asc::after{content:" ↑";color:var(--green)}
.screener-table thead th.sort-desc::after{content:" ↓";color:var(--green)}
.screener-table tbody tr{border-bottom:var(--border);border-left:2px solid transparent;transition:background .12s}
.screener-table tbody tr:hover{background:var(--bg-hover)}
.screener-table tbody tr:nth-child(even){background:var(--bg-row-alt)}
.screener-table tbody tr:nth-child(even):hover{background:var(--bg-hover)}
.screener-table tbody tr.dir-long{border-left-color:var(--green)}
.screener-table tbody tr.dir-short{border-left-color:var(--red)}
.screener-table td{padding:.55rem .75rem;vertical-align:middle;color:var(--text-primary);white-space:nowrap}
.ticker-sym{font-family:var(--mono);font-weight:700;font-size:.85rem;display:block}
.ticker-co{font-size:.66rem;color:var(--text-tertiary);display:block;margin-top:.1rem;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px}
.td-mono{font-family:var(--mono);font-size:.78rem}
.c-green{color:var(--green)}.c-red{color:var(--red)}.c-dim{color:var(--text-tertiary)}.c-amber{color:var(--amber)}
.sentiment-cell{display:flex;flex-direction:column;gap:.22rem}
.sentiment-score{font-family:var(--mono);font-size:.73rem;font-weight:700;line-height:1}
.sentiment-bar-track{width:48px;height:3px;background:var(--border-color);border-radius:99px;overflow:hidden}
.sentiment-bar-fill{height:100%;border-radius:99px;transition:width .3s}
.fill-green{background:var(--green)}.fill-red{background:var(--red)}.fill-gray{background:var(--text-tertiary)}
.signal-cell{display:flex;align-items:center;gap:.3rem;flex-wrap:wrap}
.ph-row{background:var(--bg-page);border-top:var(--border)}
.ph-row td{padding:.65rem .75rem;font-size:.68rem;color:var(--text-tertiary);font-style:italic}

/* ── SOCIAL TAB ─── */
.window-row{flex-shrink:0;padding:.45rem 1.25rem;border-bottom:var(--border);
  background:var(--bg-panel-alt);display:flex;align-items:center;gap:.4rem}
.wbtn{font-family:var(--mono);font-size:.68rem;font-weight:600;
  padding:.22rem .55rem;border-radius:var(--radius-xs);border:1px solid var(--border-color);
  background:var(--bg-page);color:var(--text-tertiary);cursor:pointer;
  transition:background .15s,color .15s,border-color .15s}
.wbtn.active{background:var(--green-bg);color:var(--green);border-color:var(--green-border)}
.social-item{padding:.6rem 1.25rem;border-bottom:var(--border);transition:background .12s}
.social-item:hover{background:var(--bg-hover)}
.social-header{display:flex;align-items:center;gap:.45rem;margin-bottom:.3rem;flex-wrap:wrap}
.social-ticker{font-family:var(--mono);font-weight:700;font-size:.82rem}
.social-text{font-size:.73rem;color:var(--text-secondary);line-height:1.45;margin-bottom:.3rem}
.social-stats{display:flex;gap:.65rem}
.social-stat{font-family:var(--mono);font-size:.63rem;color:var(--text-tertiary);
  display:flex;align-items:center;gap:.25rem}
.dot{width:5px;height:5px;border-radius:50%}
.dot-green{background:var(--green)}.dot-red{background:var(--red)}.dot-gray{background:var(--text-tertiary)}
.trending-section{flex-shrink:0;padding:.6rem 1.25rem;border-bottom:var(--border);
  background:var(--bg-panel-alt)}
.trending-title{font-size:.62rem;font-weight:700;text-transform:uppercase;
  letter-spacing:.1em;color:var(--text-tertiary);margin-bottom:.45rem}
.phrase-badges{display:flex;gap:.35rem;flex-wrap:wrap}
.phrase-badge{font-family:var(--mono);font-size:.65rem;
  padding:.18rem .48rem;border-radius:99px;
  background:var(--bg-hover);border:1px solid var(--border-color);color:var(--text-secondary)}
.phrase-badge span{color:var(--text-tertiary);font-size:.58rem;margin-left:.3rem}

/* ── PLACEHOLDER CARDS ─── */
.placeholder-section{padding:1.25rem}
.placeholder-card{
  border:1px dashed var(--border-strong);border-radius:var(--radius);
  background:var(--bg-panel);padding:1.5rem 1.25rem;
  display:flex;align-items:center;gap:.9rem;
  margin-bottom:.75rem;
}
.placeholder-card:last-child{margin-bottom:0}
.ph-lock{font-size:1.1rem;flex-shrink:0}
.ph-text{flex:1}
.ph-title{font-size:.78rem;font-weight:600;color:var(--text-secondary);margin-bottom:.2rem}
.ph-sub{font-size:.68rem;color:var(--text-tertiary)}
.ph-badge{font-family:var(--mono);font-size:.6rem;font-weight:700;
  padding:.15rem .42rem;border-radius:var(--radius-xs);
  background:var(--bg-hover);color:var(--text-tertiary);
  border:1px solid var(--border-color);letter-spacing:.04em;white-space:nowrap}
.ph-page{flex:1;display:flex;flex-direction:column;padding:1.25rem;gap:.75rem}
.ph-page-header{font-size:.78rem;font-weight:600;color:var(--text-secondary);
  margin-bottom:.25rem;display:flex;align-items:center;gap:.5rem}

/* ── CORRELATION TAB ─── */
.corr-form{flex-shrink:0;padding:.65rem 1.25rem;border-bottom:var(--border);
  background:var(--bg-panel-alt);display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}
.corr-stats{display:grid;grid-template-columns:repeat(3,1fr);border-bottom:var(--border)}
.corr-stat{padding:.65rem .75rem;border-right:var(--border);text-align:center}
.corr-stat:last-child{border-right:none}
.corr-val{font-family:var(--mono);font-size:1.1rem;font-weight:700;color:var(--text-primary)}
.corr-lbl{font-size:.6rem;color:var(--text-tertiary);margin-top:.2rem;
  text-transform:uppercase;letter-spacing:.06em;line-height:1.4}
.corr-chart-wrap{padding:.75rem 1.25rem;flex-shrink:0}
.corr-chart-title{font-size:.63rem;text-transform:uppercase;letter-spacing:.08em;
  color:var(--text-tertiary);margin-bottom:.5rem}
.corr-chart-container{position:relative;height:100px}

/* ── CHARTS TAB ─── */
/* .cwbtn mirrors .wbtn — distinct class so the Social tab's global
   document.querySelectorAll('.wbtn') listener doesn't catch these buttons */
.cwbtn{font-family:var(--mono);font-size:.68rem;font-weight:600;
  padding:.22rem .55rem;border-radius:var(--radius-xs);border:1px solid var(--border-color);
  background:var(--bg-page);color:var(--text-tertiary);cursor:pointer;
  transition:background .15s,color .15s,border-color .15s}
.cwbtn.active{background:var(--green-bg);color:var(--green);border-color:var(--green-border)}
.ch-stats-row{flex-shrink:0;display:grid;grid-template-columns:repeat(5,1fr);gap:.6rem;
  padding:.7rem 1.25rem;border-bottom:var(--border);background:var(--bg-panel)}
.ch-chart-wrap{flex:1;min-height:0;display:flex;flex-direction:column;padding:.75rem 1.25rem}
.ch-chart-container{position:relative;flex:1;min-height:300px}

/* ── MOMENTUM TAB ─── */
.mom-formula{font-family:var(--mono);font-size:.66rem;color:var(--text-secondary);
  border:1px solid var(--border-color);border-radius:var(--radius-xs);
  padding:.2rem .55rem;background:var(--bg-panel-alt);white-space:nowrap}
.mom-table-wrap{flex-shrink:0;max-height:38vh;overflow:auto;border-bottom:var(--border)}
.mom-table-wrap .screener-table thead th{position:sticky;top:0;z-index:5}
.mom-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));
  gap:.75rem;padding:1rem 1.25rem 1.5rem}
.mom-card{background:var(--bg-panel);border:var(--border);border-radius:var(--radius-sm);
  overflow:hidden;align-self:start}
.mom-card-title{font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.09em;
  color:var(--text-secondary);padding:.5rem .75rem;border-bottom:var(--border);
  background:var(--bg-panel-alt);display:flex;align-items:center;gap:.4rem}
.mom-row{display:flex;align-items:center;gap:.5rem;padding:.4rem .75rem;
  border-bottom:var(--border);cursor:pointer;transition:background .12s}
.mom-row:last-child{border-bottom:none}
.mom-row:hover{background:var(--bg-hover)}
.mom-row.uv-hot{background:var(--amber-bg)}
.mom-row.uv-hot:hover{background:rgba(200,146,42,.2)}
.mom-row .tk{font-family:var(--mono);font-weight:700;font-size:.78rem;color:var(--text-primary)}
.mom-row .co{font-size:.64rem;color:var(--text-tertiary);flex:1;min-width:0;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mom-row .val{font-family:var(--mono);font-size:.72rem;margin-left:auto;white-space:nowrap}
.mom-empty{padding:.6rem .75rem;font-size:.68rem;color:var(--text-tertiary);font-style:italic}
.tk-link{cursor:pointer}
.tk-link:hover{color:var(--green)}

/* ── SETTINGS TAB ─── */
.settings-tabs{flex-shrink:0;display:flex;gap:0;padding:0 1.25rem;
  border-bottom:var(--border);background:var(--bg-panel-alt)}
.stab{font-size:.72rem;font-weight:500;letter-spacing:.03em;
  padding:.5rem .85rem;color:var(--text-tertiary);cursor:pointer;
  border-bottom:2px solid transparent;margin-bottom:-1px;
  transition:color .15s,border-color .15s}
.stab:hover{color:var(--text-secondary)}
.stab.active{color:var(--text-primary);border-bottom-color:var(--green)}
.stab-panel{display:none;flex:1;overflow-y:auto;padding:1.25rem}
.stab-panel.active{display:block}
.settings-section{margin-bottom:1.5rem}
.settings-section-title{font-size:.7rem;font-weight:700;text-transform:uppercase;
  letter-spacing:.1em;color:var(--text-tertiary);margin-bottom:.65rem;
  padding-bottom:.35rem;border-bottom:var(--border)}
.source-row{display:flex;align-items:center;gap:.6rem;padding:.5rem 0;border-bottom:var(--border)}
.source-row:last-child{border-bottom:none}
.source-name{font-size:.78rem;font-weight:600;color:var(--text-primary);flex:1}
.source-url{font-family:var(--mono);font-size:.6rem;color:var(--text-tertiary)}
.toggle-row{display:flex;align-items:center;justify-content:space-between;
  padding:.5rem 0;border-bottom:var(--border)}
.toggle-row:last-child{border-bottom:none}
.toggle-row-label{font-size:.78rem;color:var(--text-secondary)}
.log-box{font-family:var(--mono);font-size:.68rem;color:var(--text-secondary);
  background:var(--bg-page);border:var(--border);border-radius:var(--radius-sm);
  padding:.65rem .75rem;height:280px;overflow-y:auto;line-height:1.6;white-space:pre-wrap;word-break:break-all}
.log-line-err{color:var(--red)}
.log-line-ok{color:var(--green)}
.data-stat{display:flex;justify-content:space-between;align-items:center;
  padding:.45rem 0;border-bottom:var(--border)}
.data-stat:last-child{border-bottom:none}
.data-stat-label{font-size:.75rem;color:var(--text-secondary)}
.data-stat-val{font-family:var(--mono);font-size:.85rem;font-weight:700;color:var(--text-primary)}
.kw-textarea{width:100%;background:var(--bg-page);border:var(--border);
  border-radius:var(--radius-sm);color:var(--text-primary);
  font-family:var(--mono);font-size:.72rem;padding:.65rem .75rem;
  resize:vertical;min-height:180px;outline:none;transition:border-color .15s;line-height:1.6}
.kw-textarea:focus{border-color:var(--green-border)}

/* ── OVERVIEW TAB ─── */
#tab-overview{overflow:hidden}
/* AI Top Picks — first thing on Overview; cached sentiment-based AI ranking */
.ov-toppicks{flex-shrink:0;background:var(--bg-panel-alt);border-bottom:var(--border);
  padding:.6rem 1.25rem .65rem}
.ov-tp-head{display:flex;align-items:baseline;gap:.55rem;margin-bottom:.45rem;flex-wrap:wrap}
.ov-tp-title{font-size:.82rem;font-weight:700;color:var(--text-primary);letter-spacing:.02em}
.ov-tp-title::before{content:"✦ ";color:var(--blue)}
.ov-tp-sub{font-size:.62rem;color:var(--text-tertiary)}
.ov-tp-list{display:flex;flex-direction:column;gap:.15rem}
.ov-tp-row{display:grid;grid-template-columns:1.3rem 3.4rem 5.1rem 2.8rem 1fr;align-items:center;
  gap:.55rem;padding:.16rem .35rem;border-radius:var(--radius-xs)}
.ov-tp-row:nth-child(odd){background:rgba(255,255,255,.018)}
.ov-tp-rank{font-family:var(--mono);font-size:.62rem;color:var(--text-tertiary);text-align:center}
.ov-tp-sym{font-family:var(--mono);font-weight:700;font-size:.74rem;color:var(--text-primary)}
.ov-tp-dir{justify-self:start}
.ov-tp-conv{font-family:var(--mono);font-size:.72rem;font-weight:700;color:var(--text-primary)}
.ov-tp-conv-max{font-size:.56rem;color:var(--text-tertiary);font-weight:400}
.ov-tp-reason{font-size:.66rem;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ov-tp-empty{font-size:.7rem;color:var(--text-tertiary);padding:.3rem .2rem}
.ov-stats-row{flex-shrink:0;display:grid;grid-template-columns:repeat(6,1fr);gap:.6rem;
  padding:.7rem 1.25rem;border-bottom:var(--border);background:var(--bg-panel)}
.ov-stat-card{background:var(--bg-panel-alt);border:var(--border);border-radius:var(--radius-sm);
  padding:.5rem .7rem;display:flex;flex-direction:column;gap:.15rem;min-width:0}
.ov-stat-val{font-family:var(--mono);font-size:1.05rem;font-weight:700;color:var(--text-primary);line-height:1.2}
.ov-stat-lbl{font-size:.6rem;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.07em;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ov-columns{flex:1;min-height:0;display:grid;grid-template-columns:2fr 1fr 1fr}
.ov-col{min-height:0;overflow-y:auto;border-right:var(--border);background:var(--bg-page);
  display:flex;flex-direction:column}
.ov-col:last-child{border-right:none}
.ov-col > *{flex-shrink:0}
.ov-col-header{position:sticky;top:0;z-index:20;background:var(--bg-panel);
  padding:.5rem 1rem;border-bottom:var(--border);
  font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.09em;
  color:var(--text-secondary);display:flex;align-items:center;gap:.5rem}
.ov-section-count{font-family:var(--mono);font-size:.62rem;color:var(--text-tertiary);
  margin-left:auto;text-transform:none;letter-spacing:0;font-weight:400}
.ov-scroll{max-height:42vh;overflow-y:auto}
.ov-scroll .screener-table thead th{position:sticky;top:0;z-index:5}
.ov-chips{padding:.4rem 1rem;border-bottom:var(--border);display:flex;gap:.35rem;flex-wrap:wrap;
  background:var(--bg-panel-alt)}
.ov-news-item{padding:.5rem 1rem;border-bottom:var(--border);display:flex;flex-direction:column;gap:.25rem}
.ov-news-item:hover{background:var(--bg-hover)}
.ov-social-card{padding:.6rem 1rem;border-bottom:var(--border)}
.ov-social-card:hover{background:var(--bg-hover)}
.ov-ph-card{margin:.6rem 1rem 0;border:1px dashed var(--border-strong);border-radius:var(--radius-sm);
  background:var(--bg-panel);padding:.8rem .9rem;display:flex;align-items:center;gap:.7rem}
.ov-ph-card:last-of-type{margin-bottom:.6rem}
.badge-schwab{background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue-border)}
.ov-corr-stats{display:grid;grid-template-columns:repeat(3,1fr);border-bottom:var(--border)}
.ov-corr-stats .corr-stat{padding:.5rem .4rem}
.ov-corr-stats .corr-val{font-size:.92rem}
.ov-chart-container{position:relative;height:110px;margin:.5rem .75rem}
.ov-data-stats{padding:.3rem 1rem .8rem}
</style>
</head>
<body>

<!-- ── TOPBAR ── -->
<header id="topbar">
  <div class="topbar-logo">
    <span class="logo-word">Sentiment</span><span class="logo-scout">Scout</span>
    <span class="logo-dot"></span>
  </div>

  <nav class="topbar-nav">
    <div class="nav-tab active" data-tab="overview">Overview</div>
    <div class="nav-tab" data-tab="news">News</div>
    <div class="nav-tab" data-tab="screener">Screener</div>
    <div class="nav-tab" data-tab="social">Social</div>
    <div class="nav-tab" data-tab="charts">Charts</div>
    <div class="nav-tab" data-tab="momentum">Momentum</div>
    <div class="nav-tab" data-tab="correlation">Correlation</div>
    <div class="nav-tab" data-tab="settings">Settings</div>
  </nav>

  <div class="topbar-right">
    <span id="et-clock">--:--:-- ET</span>
    <span class="iv-label">Fetch</span>
    <select class="iv-select" id="fetchSelect" onchange="onFetchChange(this.value)">
      <option value="30">30s</option>
      <option value="60">1m</option>
      <option value="120">2m</option>
      <option value="300" selected>5m</option>
      <option value="600">10m</option>
      <option value="1800">30m</option>
      <option value="auto">Auto</option>
    </select>
    <button id="runBtn" onclick="triggerRun()">
      <span id="runIcon">&#9654;</span>
      <span id="runLabel">Run Now</span>
    </button>
  </div>
</header>

<!-- ── TAB CONTENT ── -->
<div id="tab-content">

  <!-- ══ OVERVIEW ═══════════════════════════════════════════════════════ -->
  <div class="tab-panel active" id="tab-overview">

    <!-- AI Top Picks — sentiment-based AI ranking (reads cached ranking; no live model call) -->
    <div class="ov-toppicks">
      <div class="ov-tp-head">
        <span class="ov-tp-title">AI Top Picks</span>
        <span class="ov-tp-sub">Sentiment-based AI ranking from news&nbsp;+&nbsp;social — the model's view, ranked by conviction. Not a guarantee.</span>
      </div>
      {% if top_picks %}
      <div class="ov-tp-list">
        {% for i in top_picks %}
        {% set d = (i.direction or 'neutral')|lower %}
        <div class="ov-tp-row">
          <span class="ov-tp-rank">{{ loop.index }}</span>
          <span class="ov-tp-sym">{{ i.ticker }}</span>
          <span class="badge badge-{{ 'long' if d=='long' else 'short' if d=='short' else 'neutral' }} ov-tp-dir">{{ '▲' if d=='long' else '▼' if d=='short' else '●' }} {{ d|upper }}</span>
          <span class="ov-tp-conv">{{ i.conviction }}<span class="ov-tp-conv-max">/10</span></span>
          <span class="ov-tp-reason" title="{{ i.reason or i.news_catalyst or i.summary or '' }}">{{ i.reason or i.news_catalyst or i.summary or '—' }}</span>
        </div>
        {% endfor %}
      </div>
      {% else %}
      <div class="ov-tp-empty">No AI ranking yet — run the screener to score tickers from news &amp; social.</div>
      {% endif %}
    </div>

    <!-- Stats row — 6 metric cards -->
    <div class="ov-stats-row">
      <div class="ov-stat-card"><span class="ov-stat-val">{{ stats.tickers_screened }}</span><span class="ov-stat-lbl">Tickers Screened</span></div>
      <div class="ov-stat-card"><span class="ov-stat-val c-green">{{ stats.new_adds }}</span><span class="ov-stat-lbl">New Adds</span></div>
      <div class="ov-stat-card"><span class="ov-stat-val c-red">{{ stats.dropped }}</span><span class="ov-stat-lbl">Dropped</span></div>
      <div class="ov-stat-card"><span class="ov-stat-val">{{ stats.news_items }}</span><span class="ov-stat-lbl">News Items</span></div>
      <div class="ov-stat-card"><span class="ov-stat-val">{{ stats.social_signals }}</span><span class="ov-stat-lbl">Social Signals</span></div>
      <div class="ov-stat-card"><span class="ov-stat-val c-amber">{% if stats.accuracy is not none %}{{ stats.accuracy }}%{% else %}—{% endif %}</span><span class="ov-stat-lbl">Accuracy</span></div>
    </div>

    <!-- 3-column body -->
    <div class="ov-columns">

      <!-- LEFT (~50%): screener table + news feed -->
      <div class="ov-col">
        <div class="ov-col-header">Multi-Cap Screener<span class="ov-section-count" id="ovScreenerCount"></span></div>
        <div class="ov-scroll">
          <table class="screener-table" id="ovScreenerTable">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Cap</th>
                <th>Status</th>
                <th>Price</th>
                <th data-col="change_pct" class="sortable" onclick="ovSort(this)">Change %</th>
                <th data-col="rel_volume" class="sortable" onclick="ovSort(this)">Rel. Vol</th>
                <th>RSI</th>
                <th data-col="conviction" class="sortable sort-desc" onclick="ovSort(this)">Sentiment</th>
                <th>AI Signal</th>
              </tr>
            </thead>
            <tbody id="ovScreenerBody"></tbody>
          </table>
        </div>

        <div class="ov-col-header">News Feed<span class="ov-section-count" id="ovNewsCount"></span></div>
        <div class="ov-chips" id="ovNewsChips">
          <div class="chip active" data-cls="all" onclick="ovNewsChip(this)">All</div>
          <div class="chip" data-cls="rss" onclick="ovNewsChip(this)">RSS Feeds</div>
          <div class="chip" data-cls="structured" onclick="ovNewsChip(this)">Structured News</div>
          <span style="width:1px;height:14px;background:var(--border-color);margin:0 .2rem"></span>
          <div class="chip active" data-sort="published" onclick="ovNewsSortChip(this)">By Published</div>
          <div class="chip" data-sort="detected" onclick="ovNewsSortChip(this)">By Detected</div>
        </div>
        <div class="ov-scroll" id="ovNewsList"></div>
      </div>

      <!-- MIDDLE (~25%): unstructured social news + trending phrases -->
      <div class="ov-col">
        <div class="ov-col-header">Social (Unstructured)<span class="ov-section-count" id="ovSocialCount"></span></div>
        <div class="ov-scroll" id="ovSocialNewsList">
          <div class="empty-state">Loading social posts…</div>
        </div>
        <div class="ov-col-header">Trending Phrases</div>
        <div class="phrase-badges" id="ovTrending" style="padding:.65rem 1rem">
          <span style="font-size:.7rem;color:var(--text-tertiary)">Loading…</span>
        </div>
      </div>

      <!-- RIGHT (~25%): broker signals + correlation mini + stats -->
      <div class="ov-col">
        <div class="ov-col-header">Broker Signals
          <span class="badge badge-ibkr">IBKR</span>
          <span class="badge badge-schwab">SCHWAB</span>
        </div>
        <div class="ov-ph-card">
          <span class="badge badge-ibkr">IBKR</span>
          <div class="ph-text">
            <div class="ph-title">Awaiting IBKR scanner data</div>
            <div class="ph-sub">MongoDB not running — scanner configs unavailable</div>
          </div>
        </div>
        <div class="ov-ph-card">
          <span class="badge badge-schwab">SCHWAB</span>
          <div class="ph-text">
            <div class="ph-title">Awaiting Schwab feed</div>
            <div class="ph-sub">Integration pending</div>
          </div>
        </div>

        <div class="ov-col-header">Correlation<span class="ov-section-count" id="ovCorrTicker"></span></div>
        <div class="ov-corr-stats">
          <div class="corr-stat"><div class="corr-val c-dim" id="ovR1">—</div><div class="corr-lbl">Price ×<br>Sentiment</div></div>
          <div class="corr-stat"><div class="corr-val c-dim" id="ovR2">—</div><div class="corr-lbl">Price ×<br>Density</div></div>
          <div class="corr-stat"><div class="corr-val c-dim" id="ovR3">—</div><div class="corr-lbl">Sentiment ×<br>Density</div></div>
        </div>
        <div class="ov-chart-container"><canvas id="ovCorrChart"></canvas></div>

        <div class="ov-col-header">Stats</div>
        <div class="ov-data-stats">
          <div class="data-stat"><span class="data-stat-label">Total Runs</span><span class="data-stat-val" id="ovStatRuns">—</span></div>
          <div class="data-stat"><span class="data-stat-label">Total Insights</span><span class="data-stat-val" id="ovStatInsights">—</span></div>
          <div class="data-stat"><span class="data-stat-label">Accuracy</span><span class="data-stat-val" id="ovStatAcc">—</span></div>
        </div>
      </div>

    </div>
  </div><!-- /tab-overview -->

  <!-- ══ NEWS ══════════════════════════════════════════════════════════ -->
  <div class="tab-panel" id="tab-news">
    <div class="page-header">
      <span class="page-title">News Feed</span>
      <span class="page-count" id="news-count">— <span id="newsCountNum">{{ rss_feed | length }}</span> articles</span>
      <span class="page-spacer"></span>
    </div>

    <!-- Controls row -->
    <div class="controls-row">
      <span class="ctrl-label">Date</span>
      <input type="date" class="ctrl-input" id="newsDateFrom" style="width:130px">
      <input type="time" class="ctrl-input" id="newsTimeFrom" style="width:90px" value="09:30">
      <span style="font-size:.65rem;color:var(--text-tertiary)">—</span>
      <input type="date" class="ctrl-input" id="newsDateTo" style="width:130px">
      <input type="time" class="ctrl-input" id="newsTimeTo" style="width:90px" value="16:00">
      <button class="ctrl-btn primary" onclick="applyNewsFilters()">Apply</button>
      <div class="ctrl-sep"></div>
      <span class="ctrl-label">Sort</span>
      <select class="ctrl-select" id="newsSortSel" onchange="sortNewsItems()">
        <option value="fetched">Detected (newest)</option>
        <option value="ts">Published (newest)</option>
      </select>
      <div class="ctrl-sep"></div>
      <label class="toggle-wrap" title="Show only articles matching Finviz tickers">
        <input type="checkbox" class="toggle-input" id="kwOnly" onchange="filterNews()">
        <div class="toggle-track"><div class="toggle-thumb"></div></div>
        <span class="toggle-label">Keywords Only</span>
      </label>
      <button class="ctrl-btn" onclick="addNewsFilter()">+ Add Filter</button>
    </div>

    <!-- Source chips -->
    <div class="chips-row" id="newsSourceChips">
      <div class="chip active" data-src="all" onclick="newsChipClick(this)">All</div>
      <div class="chip" data-src="GlobeNewswire" onclick="newsChipClick(this)">GlobeNewswire</div>
      <div class="chip" data-src="PRNewswire" onclick="newsChipClick(this)">PRNewswire</div>
      <div class="chip" data-src="BusinessWire" onclick="newsChipClick(this)">BusinessWire</div>
      <div class="chip" data-src="SEC 8-K" onclick="newsChipClick(this)">SEC 8-K</div>
      <div class="chip" data-src="Stocktwits" onclick="newsChipClick(this)">Stocktwits</div>
      <div class="chip soon" title="Jeff pipeline — integration pending">Broker</div>
    </div>

    <!-- Feed -->
    <div class="news-feed" id="newsFeed">
      <!-- Active RSS section -->
      <div class="news-section-divider">
        <span class="nsd-label">Live Feed</span>
        <span class="nsd-pipe">|</span>
        <span class="nsd-team">RSS + Stocktwits — active</span>
      </div>
      <div id="newsItems">
        {% for item in rss_feed %}
        {% set src = item.source %}
        {% if src == 'GlobeNewswire' %}{% set src_cls = 'badge-gnw' %}{% set src_short = 'GlobeNW' %}
        {% elif src == 'PRNewswire' %}{% set src_cls = 'badge-prn' %}{% set src_short = 'PRNwire' %}
        {% elif src == 'BusinessWire' %}{% set src_cls = 'badge-bw' %}{% set src_short = 'BizWire' %}
        {% elif src == 'SEC 8-K' %}{% set src_cls = 'badge-sec' %}{% set src_short = 'SEC 8-K' %}
        {% elif src == 'Stocktwits' %}{% set src_cls = 'badge-st' %}{% set src_short = 'ST' %}
        {% else %}{% set src_cls = 'badge-fv' %}{% set src_short = src[:7] %}{% endif %}
        <div class="news-item" data-source="{{ src }}" data-kw="{{ 1 if item.finviz_match else 0 }}" data-ts="{{ item.published_at or '' }}" data-fetched="{{ item.fetched_at or '' }}">
          <div class="news-meta">
            <span class="badge {{ src_cls }}">{{ src_short }}</span>
            <span class="news-ts">{{ item.published_at[:16].replace('T',' ') if item.published_at else '—' }}</span>
          </div>
          <div class="news-body">
            <div class="news-badges">
              {% for t in item.extracted_tickers[:5] %}
                <span class="badge badge-same">{{ t }}</span>
              {% endfor %}
              {% if item.finviz_match %}<span class="badge badge-hc">HC</span>{% endif %}
              {% if item.matched_keyword %}<span class="badge badge-kw" title="Keyword that matched the screener filter">⚡ {{ item.matched_keyword }}</span>{% endif %}
            </div>
            <div class="news-headline">
              {% if item.link %}
                <a href="{{ item.link }}" target="_blank" rel="noopener">{{ item.title[:150] }}{% if item.title|length > 150 %}…{% endif %}</a>
              {% else %}
                {{ item.title[:150] }}{% if item.title|length > 150 %}…{% endif %}
              {% endif %}
            </div>
            {% if item.finviz_match %}
            <div class="news-scores">Sentiment: — &nbsp;|&nbsp; FinBERT: —</div>
            {% endif %}
          </div>
        </div>
        {% else %}
        <div class="empty-state">No RSS items yet — click Run Now to fetch.</div>
        {% endfor %}
      </div>

      <!-- Structured News / Priyanshu -->
      <div class="news-section-divider" style="margin-top:.5rem">
        <span class="nsd-label">Structured News</span>
        <span class="nsd-pipe">|</span>
        <span class="nsd-team">Priyanshu FeedFlash pipeline</span>
        <span class="page-count" id="structuredCount" style="margin-left:auto"></span>
      </div>
      <div id="structuredFeed">
        <div class="empty-state" id="structuredEmpty">Loading…</div>
      </div>

      <!-- Broker / Jeff -->
      <div class="news-section-divider">
        <span class="nsd-label">IBKR Scanners</span>
        <span class="nsd-pipe">|</span>
        <span class="nsd-team">Jeff IBKR pipeline</span>
        <span class="page-count" id="brokerCount" style="margin-left:auto"></span>
      </div>
      <div id="brokerFeed">
        <div class="empty-state" id="brokerEmpty">Loading…</div>
      </div>
    </div>
  </div><!-- /tab-news -->

  <!-- ══ SCREENER ═══════════════════════════════════════════════════════ -->
  <div class="tab-panel" id="tab-screener">
    <div class="page-header">
      <span class="page-title">Market Screener</span>
      <span class="page-count">— <span id="screenerCountNum">{{ insights | length }}</span> tickers</span>
      <span class="page-spacer"></span>
    </div>

    <!-- Controls -->
    <div class="controls-row">
      <span class="ctrl-label">Signal</span>
      <select class="ctrl-select" id="signalFilter" onchange="onSignalChange(this.value)">
        <option value="">All</option>
        <option value="bullish">Social Bullish</option>
        <option value="bearish">Social Bearish</option>
        <option value="volume">Unusual Volume</option>
        <option value="hc">HC Only</option>
      </select>
      <div class="ctrl-sep"></div>
      <span class="ctrl-label">Order by</span>
      <select class="ctrl-select" id="orderBy" onchange="onOrderByChange()">
        <option value="ticker">Ticker</option>
        <option value="price">Price</option>
        <option value="change_pct">Change %</option>
        <option value="rel_volume">Rel. Vol</option>
        <option value="sentiment_signed">Sentiment</option>
        <option value="conviction">AI Conviction</option>
      </select>
      <button class="ctrl-btn" id="sortDirBtn" onclick="toggleSortDir()" title="Toggle sort direction">↓ Desc</button>
      <button class="ctrl-btn" onclick="reloadScreener()">↺ Refresh</button>
      <button class="ctrl-btn" id="filterPanelBtn" onclick="toggleFilterPanel()">⊞ Filters</button>
    </div>

    <!-- Filter panel -->
    <div class="filter-panel" id="filterPanel">
      <div class="filter-panel-inner">
        <div class="filter-tabs">
          <div class="ftab active" data-ftab="overview" onclick="switchFtab(this)">Overview</div>
          <div class="ftab" data-ftab="valuation" onclick="switchFtab(this)">Valuation</div>
          <div class="ftab" data-ftab="technical" onclick="switchFtab(this)">Technical</div>
          <div class="ftab" data-ftab="sentiment" onclick="switchFtab(this)">Sentiment</div>
        </div>
        <div class="ftab-panel active" id="ftab-overview">
          <div class="cap-checks">
            <label class="cap-check"><input type="checkbox" value="mega" onchange="applyScreenerFilters()" checked> Mega</label>
            <label class="cap-check"><input type="checkbox" value="large" onchange="applyScreenerFilters()" checked> Large</label>
            <label class="cap-check"><input type="checkbox" value="mid" onchange="applyScreenerFilters()" checked> Mid</label>
            <label class="cap-check"><input type="checkbox" value="small" onchange="applyScreenerFilters()" checked> Small</label>
            <label class="cap-check"><input type="checkbox" value="micro" onchange="applyScreenerFilters()" checked> Micro</label>
            <label class="cap-check"><input type="checkbox" value="nano" onchange="applyScreenerFilters()" checked> Nano</label>
            <label class="cap-check"><input type="checkbox" value="unknown" onchange="applyScreenerFilters()" checked> Unknown</label>
          </div>
        </div>
        <div class="ftab-panel" id="ftab-valuation">
          <span style="font-size:.72rem;color:var(--text-tertiary)">Valuation filters — placeholder</span>
        </div>
        <div class="ftab-panel" id="ftab-technical">
          <div class="range-row">
            <span class="range-label">RSI min</span>
            <input type="range" id="rsiMin" min="0" max="100" value="0" oninput="document.getElementById('rsiMinVal').textContent=this.value;applyScreenerFilters()">
            <span class="range-val" id="rsiMinVal">0</span>
            <span class="range-label">max</span>
            <input type="range" id="rsiMax" min="0" max="100" value="100" oninput="document.getElementById('rsiMaxVal').textContent=this.value;applyScreenerFilters()">
            <span class="range-val" id="rsiMaxVal">100</span>
          </div>
          <div class="range-row">
            <span class="range-label">Min Rel Vol</span>
            <input type="number" class="ctrl-input" id="minRelVol" min="0" step="0.1" placeholder="0" style="width:80px" oninput="applyScreenerFilters()">
          </div>
        </div>
        <div class="ftab-panel" id="ftab-sentiment">
          <div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.5rem">
            <span class="range-label">AI Signal</span>
            <select class="ctrl-select" id="aiSignalFilter" onchange="applyScreenerFilters()">
              <option value="">All</option>
              <option value="long">Long</option>
              <option value="short">Short</option>
              <option value="neutral">Neutral</option>
            </select>
          </div>
          <div class="range-row">
            <span class="range-label">Min Conviction</span>
            <input type="range" id="minConv" min="0" max="10" value="0" oninput="document.getElementById('minConvVal').textContent=this.value;applyScreenerFilters()">
            <span class="range-val" id="minConvVal">0</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Quick filter chips (single-select, synced with Signal dropdown) -->
    <div class="chips-row" id="screenerChips">
      <div class="chip active" data-signal="" onclick="screenerChipClick(this)">All</div>
      <div class="chip" data-signal="bullish" onclick="screenerChipClick(this)">Social Bullish</div>
      <div class="chip" data-signal="bearish" onclick="screenerChipClick(this)">Social Bearish</div>
      <div class="chip" data-signal="volume" onclick="screenerChipClick(this)">Unusual Volume</div>
      <div class="chip" data-signal="hc" onclick="screenerChipClick(this)">HC Only</div>
    </div>

    <div class="table-wrap">
      <table class="screener-table" id="screenerTable">
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Cap</th>
            <th>Status</th>
            <th data-col="price" class="sortable" onclick="colSort(this)">Price</th>
            <th data-col="change_pct" class="sortable" onclick="colSort(this)">Change %</th>
            <th title="Extended-hours change (After-Hours from Finviz, or pre-market gap = Open vs Prev Close)">Ext-Hours Δ</th>
            <th data-col="rel_volume" class="sortable" onclick="colSort(this)">Rel. Vol</th>
            <th>RSI</th>
            <th data-col="sentiment_signed" class="sortable" onclick="colSort(this)">Sentiment</th>
            <th>AI Signal</th>
          </tr>
        </thead>
        <tbody id="screenerBody">
          <!-- rendered by JS -->
        </tbody>
      </table>
    </div>

    <!-- Multicap scanner section -->
    <div style="flex-shrink:0;border-top:var(--border)">
      <div class="page-header" style="border-top:none">
        <span class="page-title">Live Market Caps</span>
        <span class="page-count">— <span id="multicapCountNum">0</span> tickers</span>
        <span class="page-spacer"></span>
        <button class="ctrl-btn" onclick="loadMulticap()">↺ Refresh</button>
      </div>
      <div class="chips-row" id="multicapChips">
        <div class="chip active" data-tier="all" onclick="multicapChipClick(this)">All</div>
        <div class="chip" data-tier="mega"  onclick="multicapChipClick(this)">Mega</div>
        <div class="chip" data-tier="large" onclick="multicapChipClick(this)">Large</div>
        <div class="chip" data-tier="mid"   onclick="multicapChipClick(this)">Mid</div>
        <div class="chip" data-tier="small" onclick="multicapChipClick(this)">Small</div>
        <div class="chip" data-tier="micro" onclick="multicapChipClick(this)">Micro</div>
        <div class="chip" data-tier="nano"  onclick="multicapChipClick(this)">Nano</div>
        <div class="chip" data-status="added"   onclick="multicapStatusClick(this)" style="margin-left:.75rem">Added</div>
        <div class="chip" data-status="dropped" onclick="multicapStatusClick(this)">Dropped</div>
      </div>
      <div style="max-height:260px;overflow-y:auto">
        <table class="screener-table" id="multicapTable">
          <thead>
            <tr>
              <th>Ticker</th><th>Company</th><th>Tier</th><th>Status</th>
              <th>Price</th><th>Change</th><th title="Extended-hours change (After-Hours from Finviz, or pre-market gap = Open vs Prev Close)">Ext-Hours Δ</th><th>Rel Vol</th><th>RSI</th>
            </tr>
          </thead>
          <tbody id="multicapBody">
            <tr><td colspan="9" style="text-align:center;color:var(--text-tertiary);padding:1rem">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div><!-- /tab-screener -->

  <!-- ══ SOCIAL ═════════════════════════════════════════════════════════ -->
  <div class="tab-panel" id="tab-social">
    <div class="page-header">
      <span class="page-title">Social Feed</span>
      <span class="page-count">— <span id="socialCountNum">0</span> posts</span>
      <span class="page-spacer"></span>
    </div>

    <!-- Window selector -->
    <div class="window-row">
      <span class="ctrl-label" style="margin-right:.2rem">Window</span>
      <button class="wbtn active" data-w="1">1m</button>
      <button class="wbtn" data-w="3">3m</button>
      <button class="wbtn" data-w="5">5m</button>
      <button class="wbtn" data-w="15">15m</button>
      <button class="wbtn" data-w="60">60m</button>
    </div>

    <!-- Platform chips -->
    <div class="chips-row" id="socialChips">
      <div class="chip active" data-platform="all" onclick="socialChipClick(this)">All</div>
      <div class="chip" data-platform="Stocktwits" onclick="socialChipClick(this)">Stocktwits</div>
      <div class="chip soon" title="Reddit — coming soon">Reddit</div>
      <div class="chip soon" title="X / Twitter — coming soon">X</div>
      <div class="chip soon" title="Bluesky — coming soon">Bluesky</div>
    </div>

    <!-- Trending phrases -->
    <div class="trending-section">
      <div class="trending-title">Trending Phrases</div>
      <div class="phrase-badges" id="trendingPhrases">
        <span style="font-size:.7rem;color:var(--text-tertiary)">Loading…</span>
      </div>
    </div>

    <!-- Posts -->
    <div style="flex:1;overflow-y:auto" id="socialFeed">
      <div class="empty-state" id="socialEmpty">Loading social data…</div>
    </div>

    <!-- Yosef pipeline -->
    <div class="news-section-divider">
      <span class="nsd-label">MongoDB Live Feed</span>
      <span class="nsd-pipe">|</span>
      <span class="nsd-team">Yosef Stocktwits pipeline</span>
      <span class="page-count" id="yosefCount" style="margin-left:auto"></span>
    </div>
    <div id="yosefFeed" style="flex:1;overflow-y:auto">
      <div class="empty-state" id="yosefEmpty">Loading…</div>
    </div>
  </div><!-- /tab-social -->

  <!-- ══ CHARTS ══════════════════════════════════════════════════════════ -->
  <div class="tab-panel" id="tab-charts">
    <div class="page-header">
      <span class="page-title">Charts</span>
      <span class="page-count" id="chartMeta"></span>
      <span class="page-spacer"></span>
    </div>

    <!-- Ticker + window controls -->
    <div class="controls-row">
      <span class="ctrl-label">Ticker</span>
      <select class="ctrl-select" id="chartTickerSel" onchange="onChartTickerChange()"></select>
      <input class="ctrl-input" id="chartTickerInput" placeholder="any ticker…"
             style="width:96px;text-transform:uppercase"
             onkeydown="if(event.key==='Enter')chartTickerGo()">
      <button class="cwbtn" onclick="chartTickerGo()">Go</button>
      <span class="ctrl-sep"></span>
      <span class="ctrl-label">Window</span>
      <button class="cwbtn active" data-cw="full" onclick="chartWindowClick(this)">Full Day</button>
      <button class="cwbtn" data-cw="2h" onclick="chartWindowClick(this)">2h</button>
      <button class="cwbtn" data-cw="1h" onclick="chartWindowClick(this)">1h</button>
      <span class="ctrl-sep"></span>
      <span class="ctrl-label">Chart</span>
      <button class="cwbtn active" data-cm="pv" onclick="chartModeClick(this)">Price+Vol</button>
      <button class="cwbtn" data-cm="pd" onclick="chartModeClick(this)">Price+Density</button>
      <button class="cwbtn" data-cm="sent" onclick="chartModeClick(this)">Sentiment</button>
      <button class="cwbtn" data-cm="ds" onclick="chartModeClick(this)">Density vs Sent</button>
      <span class="ctrl-sep"></span>
      <span class="ctrl-label">Overlays</span>
      <button class="cwbtn active" id="ovlDensityBtn" onclick="toggleOverlay('density', this)">Density</button>
      <button class="cwbtn active" id="ovlSentimentBtn" onclick="toggleOverlay('sentiment', this)">Sentiment</button>
      <span id="chartStatus" style="font-size:.7rem;color:var(--text-tertiary);margin-left:.25rem"></span>
    </div>

    <!-- Stat cards (from /api/screener data) -->
    <div class="ch-stats-row">
      <div class="ov-stat-card"><span class="ov-stat-val" id="chStatPrice">—</span><span class="ov-stat-lbl">Price</span></div>
      <div class="ov-stat-card"><span class="ov-stat-val" id="chStatChange">—</span><span class="ov-stat-lbl">Change %</span></div>
      <div class="ov-stat-card"><span class="ov-stat-val" id="chStatRelVol">—</span><span class="ov-stat-lbl">Rel Vol</span></div>
      <div class="ov-stat-card"><span class="ov-stat-val" id="chStatRsi">—</span><span class="ov-stat-lbl">RSI</span></div>
      <div class="ov-stat-card"><span class="ov-stat-val" id="chStatSent">—</span><span class="ov-stat-lbl">Sentiment</span></div>
    </div>

    <!-- Intraday price + volume chart -->
    <div class="ch-chart-wrap">
      <div class="corr-chart-title" id="chartTitle">Intraday Price + Volume — 1-min bars</div>
      <div id="chartSessions" style="font-family:var(--mono);font-size:.66rem;color:var(--text-tertiary);margin:-.2rem 0 .4rem"></div>
      <div class="ch-chart-container"><canvas id="priceVolChart"></canvas></div>
    </div>
  </div><!-- /tab-charts -->

  <!-- ══ MOMENTUM ════════════════════════════════════════════════════════ -->
  <div class="tab-panel" id="tab-momentum">
    <div class="page-header">
      <span class="page-title">Momentum</span>
      <span class="page-count" id="momCount"></span>
      <span class="page-spacer"></span>
      <span class="mom-formula" title="Transparent momentum score — every component is shown per ticker below">Score = Change% + (RelVol − 1)×10 + (Bulls − Bears)</span>
    </div>

    <!-- Momentum Score leaderboard -->
    <div class="mom-table-wrap">
      <table class="screener-table">
        <thead><tr>
          <th>#</th><th>Ticker</th><th>Score</th><th>Change %</th>
          <th>Rel Vol</th><th>Social B/B</th><th>Score Breakdown</th><th>Signal</th>
        </tr></thead>
        <tbody id="momBody">
          <tr><td colspan="8" style="text-align:center;color:var(--text-tertiary);padding:1rem">Loading…</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Leaderboard cards -->
    <div class="mom-grid" id="momGrid">
      <div class="mom-empty">Loading momentum data…</div>
    </div>
  </div><!-- /tab-momentum -->

  <!-- ══ CORRELATION ════════════════════════════════════════════════════ -->
  <div class="tab-panel" id="tab-correlation">
    <div class="page-header">
      <span class="page-title">Correlation</span>
      <span class="page-spacer"></span>
    </div>

    <!-- Form -->
    <div class="corr-form">
      <span class="ctrl-label">Ticker</span>
      <input type="text" class="ctrl-input" id="corrTicker" placeholder="e.g. AAPL" style="width:90px;text-transform:uppercase">
      <span class="ctrl-label">Date</span>
      <input type="date" class="ctrl-input" id="corrDate" style="width:130px">
      <input type="time" class="ctrl-input" id="corrTimeFrom" style="width:90px" value="09:30">
      <span style="font-size:.65rem;color:var(--text-tertiary)">—</span>
      <input type="time" class="ctrl-input" id="corrTimeTo" style="width:90px" value="16:00">
      <button class="ctrl-btn primary" onclick="runCorrelation()">Analyze</button>
      <span id="corrStatus" style="font-size:.7rem;color:var(--text-tertiary);margin-left:.25rem"></span>
    </div>

    <!-- Stat cards -->
    <div class="corr-stats">
      <div class="corr-stat">
        <div class="corr-val c-dim" id="corrR1">—</div>
        <div class="corr-lbl">Price ×<br>Sentiment</div>
      </div>
      <div class="corr-stat">
        <div class="corr-val c-dim" id="corrR2">—</div>
        <div class="corr-lbl">Price ×<br>Density</div>
      </div>
      <div class="corr-stat">
        <div class="corr-val c-dim" id="corrR3">—</div>
        <div class="corr-lbl">Sentiment ×<br>Density</div>
      </div>
    </div>

    <!-- Sparkline -->
    <div class="corr-chart-wrap">
      <div class="corr-chart-title">Price vs Sentiment — last 20 data points</div>
      <div class="corr-chart-container">
        <canvas id="corrChart"></canvas>
      </div>
    </div>

    <!-- Rolling 30-min r over time (research script Graph 2) -->
    <div class="corr-chart-wrap" id="corrRollWrap" style="display:none">
      <div class="corr-chart-title" id="corrRollTitle">Rolling 30-min r — Price vs Normalized Sentiment</div>
      <div class="corr-chart-container" style="height:150px">
        <canvas id="corrRollChart"></canvas>
      </div>
    </div>

    <!-- Active-ticker correlation ranking -->
    <div style="padding:.9rem 1.25rem;flex:1">
      <div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.55rem;flex-wrap:wrap">
        <span class="corr-chart-title" style="margin:0">Active Tickers — ranked by correlation (today 09:30–16:00)</span>
        <button class="ctrl-btn primary" id="corrRankBtn" onclick="loadCorrRank()">Rank Active Tickers</button>
        <span id="corrRankStatus" style="font-size:.7rem;color:var(--text-tertiary)"></span>
      </div>
      <table class="screener-table" id="corrRankTable" style="display:none">
        <thead><tr>
          <th>Ticker</th><th>n</th>
          <th class="sortable sort-desc" data-rcol="r_price_sentiment" onclick="corrRankSort(this)">r Price×Sentiment</th>
          <th class="sortable" data-rcol="r_price_density" onclick="corrRankSort(this)">r Price×Density</th>
          <th class="sortable" data-rcol="r_sentiment_density" onclick="corrRankSort(this)">r Sentiment×Density</th>
        </tr></thead>
        <tbody id="corrRankBody"></tbody>
      </table>
    </div>
  </div><!-- /tab-correlation -->

  <!-- ══ SETTINGS ═══════════════════════════════════════════════════════ -->
  <div class="tab-panel" id="tab-settings">
    <div class="page-header">
      <span class="page-title">Settings</span>
      <span class="page-spacer"></span>
    </div>

    <div class="settings-tabs">
      <div class="stab active" data-stab="sources" onclick="switchStab(this)">Sources</div>
      <div class="stab" data-stab="keywords" onclick="switchStab(this)">Keywords</div>
      <div class="stab" data-stab="config" onclick="switchStab(this)">Config</div>
      <div class="stab" data-stab="data" onclick="switchStab(this)">Data</div>
      <div class="stab" data-stab="logs" onclick="switchStab(this)">Logs</div>
      <div class="stab" data-stab="impersonate" onclick="switchStab(this)">Impersonate</div>
    </div>

    <div style="flex:1;overflow:hidden;display:flex;flex-direction:column">
      <!-- Sources -->
      <div class="stab-panel active" id="stab-sources">
        <div class="settings-section">
          <div class="settings-section-title">Active RSS Feeds</div>
          <div class="source-row">
            <div><div class="source-name">GlobeNewswire</div>
            <div class="source-url">globenewswire.com/RssFeed/…/Earnings</div></div>
            <label class="toggle-wrap">
              <input type="checkbox" class="toggle-input" checked onchange="saveSources()">
              <div class="toggle-track"><div class="toggle-thumb"></div></div>
            </label>
          </div>
          <div class="source-row">
            <div><div class="source-name">PRNewswire</div>
            <div class="source-url">prnewswire.com/rss/news-releases-list.rss</div></div>
            <label class="toggle-wrap">
              <input type="checkbox" class="toggle-input" checked onchange="saveSources()">
              <div class="toggle-track"><div class="toggle-thumb"></div></div>
            </label>
          </div>
          <div class="source-row">
            <div><div class="source-name">BusinessWire</div>
            <div class="source-url">feed.businesswire.com/rss/home/…</div></div>
            <label class="toggle-wrap">
              <input type="checkbox" class="toggle-input" checked onchange="saveSources()">
              <div class="toggle-track"><div class="toggle-thumb"></div></div>
            </label>
          </div>
          <div class="source-row">
            <div><div class="source-name">SEC 8-K</div>
            <div class="source-url">sec.gov/cgi-bin/browse-edgar?type=8-K</div></div>
            <label class="toggle-wrap">
              <input type="checkbox" class="toggle-input" checked onchange="saveSources()">
              <div class="toggle-track"><div class="toggle-thumb"></div></div>
            </label>
          </div>
        </div>
      </div>

      <!-- Keywords -->
      <div class="stab-panel" id="stab-keywords">
        <div class="settings-section">
          <div class="settings-section-title">Active Keyword List</div>
          <p style="font-size:.72rem;color:var(--text-tertiary);margin-bottom:.65rem">
            One keyword or ticker per line. Articles matching any entry pass the keyword filter.
          </p>
          <textarea class="kw-textarea" id="kwTextarea" placeholder="AAPL&#10;earnings&#10;guidance&#10;…"></textarea>
          <div style="display:flex;justify-content:flex-end;margin-top:.65rem">
            <button class="ctrl-btn primary" onclick="saveKeywords()">Save Keywords</button>
          </div>
        </div>
      </div>

      <!-- Config -->
      <div class="stab-panel" id="stab-config">
        <div class="settings-section">
          <div class="settings-section-title">Scheduler Config</div>
          <div class="toggle-row">
            <span class="toggle-row-label">Refresh Interval</span>
            <select class="ctrl-select" id="cfgInterval" onchange="saveConfig()">
              <option value="30">30s</option>
              <option value="60">1m</option>
              <option value="300" selected>5m</option>
              <option value="900">15m</option>
              <option value="1800">30m</option>
            </select>
          </div>
          <div class="toggle-row">
            <span class="toggle-row-label">Market Hours Mode</span>
            <label class="toggle-wrap">
              <input type="checkbox" class="toggle-input" id="cfgMarketHours" checked onchange="saveConfig()">
              <div class="toggle-track"><div class="toggle-thumb"></div></div>
            </label>
          </div>
          <div class="toggle-row">
            <span class="toggle-row-label">Off-Hours Mode</span>
            <label class="toggle-wrap">
              <input type="checkbox" class="toggle-input" id="cfgOffHours" checked onchange="saveConfig()">
              <div class="toggle-track"><div class="toggle-thumb"></div></div>
            </label>
          </div>
        </div>
      </div>

      <!-- Data -->
      <div class="stab-panel" id="stab-data">
        <div class="settings-section">
          <div class="settings-section-title">Database Stats</div>
          <div class="data-stat">
            <span class="data-stat-label">Total Screener Runs</span>
            <span class="data-stat-val" id="dbRuns">—</span>
          </div>
          <div class="data-stat">
            <span class="data-stat-label">Total Ticker Insights</span>
            <span class="data-stat-val" id="dbInsights">—</span>
          </div>
          <div class="data-stat">
            <span class="data-stat-label">Total RSS Items</span>
            <span class="data-stat-val" id="dbRss">—</span>
          </div>
        </div>
        <button class="ctrl-btn" onclick="loadDbStats()" style="margin-top:.5rem">↺ Refresh Stats</button>
      </div>

      <!-- Logs -->
      <div class="stab-panel" id="stab-logs">
        <div class="settings-section" style="height:100%">
          <div class="settings-section-title" style="display:flex;align-items:center;gap:.6rem">
            Scheduler Log
            <button class="ctrl-btn" onclick="loadLogs()" style="margin-left:auto">↺ Refresh</button>
          </div>
          <div class="log-box" id="logBox">Loading…</div>
        </div>
      </div>

      <!-- Impersonate -->
      <div class="stab-panel" id="stab-impersonate">
        <div class="settings-section">
          <div class="settings-section-title">curl_cffi Browser Profile</div>
          <div class="toggle-row">
            <span class="toggle-row-label">Current Profile</span>
            <select class="ctrl-select" id="impersonateSelect" onchange="saveImpersonate()">
              <option value="chrome124" selected>chrome124</option>
              <option value="chrome131">chrome131</option>
              <option value="chrome120">chrome120</option>
              <option value="chrome119">chrome119</option>
              <option value="chrome116">chrome116</option>
              <option value="chrome110">chrome110</option>
              <option value="chrome107">chrome107</option>
              <option value="chrome104">chrome104</option>
              <option value="chrome100">chrome100</option>
              <option value="chrome99">chrome99</option>
              <option value="firefox109">firefox109</option>
              <option value="safari15_5">safari15_5</option>
              <option value="safari17_0">safari17_0</option>
            </select>
          </div>
          <p style="font-size:.7rem;color:var(--text-tertiary);margin-top:.65rem">
            Profile is stored in localStorage. Full hot-swap wiring is a future sprint.
          </p>
        </div>
      </div>
    </div>
  </div><!-- /tab-settings -->

</div><!-- /tab-content -->

<script>
// ── DATA from server ───────────────────────────────────────────────────────────
const INSIGHTS = {{ insights | tojson }};
const SPARKLINE = {{ sparkline | tojson }};
const RSS_FEED = {{ rss_feed | tojson }};
const SOCIAL = {{ social | tojson }};
const TOP_TICKER = {{ top_ticker | tojson }};
const STATS = {{ stats | tojson }};

// ── Overview state (declared early — initTab may render Overview first) ───────
let _ovSortCol = 'conviction', _ovSortDir = 'desc', _ovChart = null;
// Overview news classification: all | rss | structured | social
let _ovNewsClass = 'all';
let _ovNewsSort = 'published';   // published | detected (declared early — TDZ)
let _ovStructured = [];   // Priyanshu FeedFlash articles (FinBERT/VADER scored)
let _ovSocialNews = [];   // Yosef Stocktwits messages (unstructured social)
const _OV_STRUCT_BADGE = '<span class="badge" style="background:rgba(20,184,166,.12);color:#14b8a6;border:1px solid rgba(20,184,166,.28)">STRUCTURED</span>';
const _OV_RSS_BADGE    = '<span class="badge badge-fv">RSS</span>';
const _OV_SOCIAL_BADGE = '<span class="badge badge-st">SOCIAL</span>';

// ── Screener + multicap state (declared early — initTab may render Screener
//    synchronously before the later sections of this script are reached) ──────
let _screenerData = [];
let _sortDir = 'desc';
let _colSort = null;
let _multicapData = [];
let _mcTier = 'all';
let _mcStatus = null;
const _dirByTicker = {};
INSIGHTS.forEach(i => { _dirByTicker[i.ticker] = (i.direction || 'neutral').toLowerCase(); });

// ── Charts + Momentum state (declared early — initTab may activate either tab
//    synchronously before the later sections of this script are reached) ──────
let _chartsChart = null;          // Chart.js instance on the Charts tab
let _chartTicker = null;          // currently charted ticker
let _chartWindow = 'full';        // full | 2h | 1h
let _lastChartData = null;        // last /api/chart payload (for overlay re-render)
let _chartMode = 'pv';            // pv | pd | sent | ds  (research chart views)
let _ovlDensity = true;           // Density overlay toggle
let _ovlSentiment = true;         // Sentiment overlay toggle
let _socialData = null;           // last /api/chart/social payload
let _socialKey = '';              // "TICKER|DATE" the social payload belongs to
let _socialPollTimer = null;      // setTimeout handle for the walk-progress poll
let _socialPollKey = '';          // "TICKER|DATE" the active poll belongs to (cross-ticker guard)
let _pendingChartTicker = null;   // set by Momentum cross-link before switchTab('charts')
let _chartSelInit = false;        // ticker selector populated once
let _momentumLoaded = false;
// Correlation ranking table state (declared early — TDZ)
let _corrRank = [];
let _corrRankCol = 'r_price_sentiment';
let _corrRankDir = 'desc';
let _userKeywords = [];   // Settings keyword dictionary (server-persisted)

// ── ET clock ──────────────────────────────────────────────────────────────────
function updateClock(){
  try{
    const s = new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:false,
      hour:'2-digit',minute:'2-digit',second:'2-digit'});
    document.getElementById('et-clock').textContent = s+' ET';
  }catch(e){}
}
updateClock(); setInterval(updateClock,1000);

// ── Fetch interval / auto-refresh ─────────────────────────────────────────────
let _refreshTimer = null;
function onFetchChange(v){
  clearTimeout(_refreshTimer);
  localStorage.setItem('scoutFetch', v);
  if(v !== 'auto' && parseInt(v) > 0){
    _refreshTimer = setTimeout(()=>location.reload(), parseInt(v)*1000);
  }
}
(function initFetch(){
  const saved = localStorage.getItem('scoutFetch') || '300';
  const sel = document.getElementById('fetchSelect');
  const opts = Array.from(sel.options).map(o=>o.value);
  sel.value = opts.includes(saved) ? saved : '300';
  onFetchChange(sel.value);
})();

// ── Tab switching ──────────────────────────────────────────────────────────────
function switchTab(name){
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===name));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active', p.id==='tab-'+name));
  localStorage.setItem('scoutTab', name);
  onTabActivated(name);
}
document.querySelectorAll('.nav-tab').forEach(t=>t.addEventListener('click',()=>switchTab(t.dataset.tab)));
(function initTab(){
  const saved = localStorage.getItem('scoutTab') || 'overview';
  switchTab(saved);
})();

function onTabActivated(name){
  if(name==='overview'){ renderOverview(); }
  if(name==='screener'){ renderScreener(INSIGHTS); loadMulticap(); }
  if(name==='social'){ loadSocial(); loadYosefSocial(); }
  if(name==='news'){ loadStructuredNews(); loadBrokerFeed(); loadUserKeywords(); }
  if(name==='charts'){ initChartsTab(); }
  if(name==='momentum'){ loadMomentum(); }
  if(name==='correlation'){}
  if(name==='settings'){
    loadDbStats();
    loadLogs();
    initSettingsFromStorage();
  }
}

// ── Run Now button ─────────────────────────────────────────────────────────────
let _pollTimer = null;
function setRunning(on, elapsed){
  const btn=document.getElementById('runBtn');
  const icon=document.getElementById('runIcon');
  const lbl=document.getElementById('runLabel');
  if(on){
    btn.disabled=true; btn.classList.add('running');
    icon.className='spin'; icon.textContent='↻';
    lbl.textContent=elapsed?'Running… '+elapsed+'s':'Running…';
  }else{
    btn.disabled=false; btn.classList.remove('running');
    icon.className=''; icon.textContent='►';
    lbl.textContent='Run Now';
  }
}
function pollStatus(){
  fetch('/run/status').then(r=>r.json()).then(d=>{
    if(d.running){ setRunning(true,d.elapsed_s); _pollTimer=setTimeout(pollStatus,3000); }
    else{
      setRunning(false); clearTimeout(_pollTimer);
      if(d.just_finished){ clearTimeout(_refreshTimer); setTimeout(()=>location.reload(),800); }
    }
  }).catch(()=>setRunning(false));
}
function triggerRun(){
  fetch('/run',{method:'POST'}).then(r=>r.json()).then(d=>{
    if(d.status==='started'||d.status==='already_running'){
      setRunning(true,d.elapsed_s||0); _pollTimer=setTimeout(pollStatus,3000);
    }
  }).catch(()=>alert('Could not reach server.'));
}
pollStatus();

// ── NEWS TAB ──────────────────────────────────────────────────────────────────
function sortNewsItems(){
  const key = document.getElementById('newsSortSel').value;   // 'fetched' | 'ts'
  const wrap = document.getElementById('newsItems');
  [...wrap.querySelectorAll('.news-item')]
    .sort((a,b)=>(b.dataset[key]||'').localeCompare(a.dataset[key]||''))
    .forEach(el=>wrap.appendChild(el));
}

function newsChipClick(el){
  document.querySelectorAll('#newsSourceChips .chip:not(.soon)').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');
  filterNews();
}
function filterNews(){
  const activeChip = document.querySelector('#newsSourceChips .chip.active');
  const src = activeChip ? activeChip.dataset.src : 'all';
  const kwOnly = document.getElementById('kwOnly').checked;
  let visible = 0;
  document.querySelectorAll('#newsItems .news-item').forEach(item=>{
    let show = true;
    if(src && src !== 'all') show = show && (item.dataset.source === src);
    if(kwOnly) show = show && (item.dataset.kw === '1');
    item.style.display = show ? '' : 'none';
    if(show) visible++;
  });
  document.getElementById('newsCountNum').textContent = visible;
}
function applyNewsFilters(){
  const df = document.getElementById('newsDateFrom').value;
  const dt = document.getElementById('newsDateTo').value;
  const tf = document.getElementById('newsTimeFrom').value || '00:00';
  const tt = document.getElementById('newsTimeTo').value || '23:59';
  if(!df && !dt){ filterNews(); return; }
  const from = df ? new Date(df+'T'+tf+':00') : null;
  const to   = dt ? new Date(dt+'T'+tt+':59') : null;
  document.querySelectorAll('#newsItems .news-item').forEach(item=>{
    const ts = item.dataset.ts;
    if(!ts){ item.style.display=''; return; }
    const d = new Date(ts);
    let show = true;
    if(from && d < from) show = false;
    if(to && d > to) show = false;
    item.style.display = show ? '' : 'none';
  });
  filterNews();
}
function addNewsFilter(){
  alert('Custom filter builder — wiring in a future sprint.');
}

// ── SCREENER TAB ──────────────────────────────────────────────────────────────
// (state vars are declared near the top of this script to avoid TDZ on init)

// Extended-hours cell: Finviz's After-Hours Change when present (pre-market
// before the open / after-hours after the close, per capture_session), else
// the pre-market gap derived from Open vs Prev Close.
function extHoursCell(r){
  const raw = String(r.ah_change==null?'':r.ah_change).trim();
  const ah = parseFloat(raw);
  if(raw !== '' && !isNaN(ah)){
    const cls = ah<0?'c-red':ah>0?'c-green':'c-dim';
    const lbl = r.capture_session==='post'?'AH':'PM';
    return `<td class="td-mono ${cls}" title="Finviz extended-hours change (captured: ${r.capture_session||'?'} session)">${lbl} ${ah>0?'+':''}${ah.toFixed(2)}%</td>`;
  }
  const o = parseFloat(r.open_price), pc = parseFloat(r.prev_close);
  if(!isNaN(o) && !isNaN(pc) && pc !== 0){
    const gap = (o-pc)/pc*100;
    const cls = gap<0?'c-red':gap>0?'c-green':'c-dim';
    return `<td class="td-mono ${cls}" title="Pre-market gap: open ${o} vs prev close ${pc} (captured: ${r.capture_session||'?'} session)">GAP ${gap>0?'+':''}${gap.toFixed(2)}%</td>`;
  }
  return '<td class="td-mono c-dim">—</td>';
}

function reloadScreener(){
  fetch('/api/screener').then(r=>r.json()).then(d=>{
    _screenerData = d.items;
    renderScreener(_screenerData);
  });
}
function renderScreener(data){
  _screenerData = data;
  applyScreenerFilters();
}

// Signed sentiment: +conviction for long, -conviction for short, 0 neutral
function _signedSent(r){
  const d = (r.direction||'neutral').toLowerCase();
  const c = r.conviction||0;
  return d==='long' ? c : d==='short' ? -c : 0;
}

// Build ticker -> tier / status maps from the latest multicap run.
// A ticker that was both added and dropped in the run maps to "both".
function _multicapMaps(){
  const tier = {}, statusSets = {};
  (_multicapData||[]).forEach(m=>{
    const t = m.ticker;
    if(!t) return;
    if(m.market_cap_tier && !(t in tier)) tier[t] = m.market_cap_tier;
    const s = (m.status||'').toLowerCase();
    (statusSets[t] = statusSets[t] || new Set()).add(s==='first' ? 'same' : s);
  });
  const status = {};
  Object.entries(statusSets).forEach(([t, set])=>{
    if(set.has('added') && set.has('dropped')) status[t] = 'both';
    else if(set.has('added'))   status[t] = 'added';
    else if(set.has('dropped')) status[t] = 'dropped';
    else status[t] = 'same';
  });
  return { tier, status };
}

function applyScreenerFilters(){
  const signal = document.getElementById('signalFilter').value;
  const orderBy = document.getElementById('orderBy').value;
  const aiSig = document.getElementById('aiSignalFilter').value;
  const minConv = parseInt(document.getElementById('minConv').value)||0;
  const rsiMin = parseFloat(document.getElementById('rsiMin').value)||0;
  const rsiMax = parseFloat(document.getElementById('rsiMax').value)||100;
  const minRv = parseFloat(document.getElementById('minRelVol').value)||0;
  const capChecked = new Set(
    Array.from(document.querySelectorAll('#ftab-overview input:checked')).map(i=>i.value)
  );
  const mc = _multicapMaps();

  let rows = [..._screenerData];

  // cap filter — tier comes from multicap data matched by ticker
  rows = rows.filter(r=>{
    const ct = mc.tier[r.ticker] || 'unknown';
    return capChecked.has(ct);
  });
  // signal quick filter
  if(signal==='bullish')      rows = rows.filter(r=>(r.stocktwits_bull_count||0) > (r.stocktwits_bear_count||0));
  else if(signal==='bearish') rows = rows.filter(r=>(r.stocktwits_bear_count||0) > (r.stocktwits_bull_count||0));
  else if(signal==='volume')  rows = rows.filter(r=>(parseFloat(r.rel_volume)||0) > 3);
  else if(signal==='hc')      rows = rows.filter(r=>r.high_conviction);
  // ai signal
  if(aiSig) rows = rows.filter(r=>(r.direction||'neutral').toLowerCase()===aiSig);
  // conviction
  if(minConv>0) rows = rows.filter(r=>(r.conviction||0)>=minConv);
  // RSI
  rows = rows.filter(r=>{
    if(!r.rsi) return true;
    const v = parseFloat(r.rsi);
    return !isNaN(v) && v>=rsiMin && v<=rsiMax;
  });
  // rel vol
  if(minRv>0) rows = rows.filter(r=>{
    if(!r.rel_volume) return false;
    return parseFloat(r.rel_volume)>=minRv;
  });

  // sort
  const col = _colSort || orderBy;
  rows.sort((a,b)=>{
    let av, bv;
    if(col==='ticker'){
      av = a.ticker||''; bv = b.ticker||'';
      return _sortDir==='asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    if(col==='sentiment_signed'){ av = _signedSent(a); bv = _signedSent(b); }
    else if(col==='change_pct'||col==='rel_volume'){ av = parseFloat(a[col])||0; bv = parseFloat(b[col])||0; }
    else { av = a[col]||0; bv = b[col]||0; }
    return _sortDir==='asc' ? av-bv : bv-av;
  });

  const tbody = document.getElementById('screenerBody');
  tbody.innerHTML = '';

  if(!_screenerData.length){
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--text-tertiary);padding:1.5rem">
      No screener data — Finviz token may need updating</td></tr>`;
  } else if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--text-tertiary);padding:1.5rem">
      No rows match the current filters.</td></tr>`;
  }

  rows.forEach(r=>{
    const dir = (r.direction||'neutral').toLowerCase();
    const conv = r.conviction||0;
    const capTier = mc.tier[r.ticker] || 'unknown';
    const capLabel = {mega:'Mega',large:'Large',mid:'Mid',small:'Small',micro:'Micro',nano:'Nano'}[capTier]||'—';
    const mcStatus = mc.status[r.ticker] || 'same';
    const statusLabel = {added:'Added',dropped:'Dropped',both:'Both',same:'Same'}[mcStatus]||'Same';
    const chgRaw = String(r.change_pct||'');
    const chgClass = chgRaw.includes('+')?'c-green':chgRaw.includes('-')?'c-red':'';
    const sentColor = dir==='long'?'fill-green':dir==='short'?'fill-red':'fill-gray';
    const sentScore = dir==='long'?'+'+conv:dir==='short'?'-'+conv:'0';
    const sentClass = dir==='long'?'c-green':dir==='short'?'c-red':'c-dim';
    const sigLabel = dir==='long'?'▲ LONG':dir==='short'?'▼ SHORT':'● NEUT';
    const hcBadge = r.high_conviction?'<span class="badge badge-hc">HC</span>':'';
    const tr = document.createElement('tr');
    tr.className = 'dir-'+dir;
    tr.title = r.news_catalyst||'';
    tr.innerHTML = `
      <td><span class="ticker-sym">${r.ticker}</span><span class="ticker-co">${r.company||''}</span></td>
      <td><span class="badge badge-${capTier}">${capLabel}</span></td>
      <td><span class="badge badge-${mcStatus==='both'?'both':mcStatus}">${statusLabel}</span></td>
      <td class="td-mono">${r.price?'$'+parseFloat(r.price).toFixed(2):'—'}</td>
      <td class="td-mono ${chgClass}">${r.change_pct||'—'}</td>
      ${extHoursCell(r)}
      <td class="td-mono">${r.rel_volume?r.rel_volume+'x':'—'}</td>
      <td class="td-mono">${r.rsi||'—'}</td>
      <td>
        <div class="sentiment-cell">
          <span class="sentiment-score ${sentClass}">${sentScore}</span>
          <div class="sentiment-bar-track">
            <div class="sentiment-bar-fill ${sentColor}" style="width:${Math.min(conv/10*100,100)}%"></div>
          </div>
        </div>
      </td>
      <td><div class="signal-cell"><span class="badge badge-${dir}">${sigLabel}</span><span class="td-mono c-dim" style="font-size:.68rem">${conv}/10</span>${hcBadge}</div></td>
    `;
    tbody.appendChild(tr);
  });

  // placeholder row
  const phTr = document.createElement('tr');
  phTr.className = 'ph-row';
  phTr.innerHTML = `<td colspan="10">🔒 Multi-cap screener with real-time add/drop detection — high school student script — integration pending for live data</td>`;
  tbody.appendChild(phTr);

  document.getElementById('screenerCountNum').textContent = rows.length;
}

// Quick chips <-> Signal dropdown sync (single select)
function screenerChipClick(el){
  document.getElementById('signalFilter').value = el.dataset.signal;
  onSignalChange(el.dataset.signal);
}
function onSignalChange(v){
  document.querySelectorAll('#screenerChips .chip').forEach(c=>
    c.classList.toggle('active', c.dataset.signal===v));
  applyScreenerFilters();
}
// Changing Order-by must release any header-click sort override
function onOrderByChange(){
  _colSort = null;
  document.querySelectorAll('#screenerTable th').forEach(h=>h.classList.remove('sort-asc','sort-desc'));
  applyScreenerFilters();
}

function toggleSortDir(){
  _sortDir = _sortDir==='desc' ? 'asc' : 'desc';
  document.getElementById('sortDirBtn').textContent = _sortDir==='asc' ? '↑ Asc' : '↓ Desc';
  applyScreenerFilters();
}
function colSort(th){
  const col = th.dataset.col;
  if(_colSort===col){
    _sortDir = _sortDir==='desc'?'asc':'desc';
  } else {
    _colSort = col; _sortDir = 'desc';
  }
  document.querySelectorAll('#screenerTable th').forEach(h=>{
    h.classList.remove('sort-asc','sort-desc');
  });
  th.classList.add(_sortDir==='asc'?'sort-asc':'sort-desc');
  document.getElementById('sortDirBtn').textContent = _sortDir==='asc'?'↑ Asc':'↓ Desc';
  applyScreenerFilters();
}
function toggleFilterPanel(){
  const panel = document.getElementById('filterPanel');
  panel.classList.toggle('open');
  document.getElementById('filterPanelBtn').textContent = panel.classList.contains('open')?'⊟ Filters':'⊞ Filters';
}
function switchFtab(el){
  const name = el.dataset.ftab;
  document.querySelectorAll('.ftab').forEach(t=>t.classList.toggle('active',t.dataset.ftab===name));
  document.querySelectorAll('.ftab-panel').forEach(p=>p.classList.toggle('active',p.id==='ftab-'+name));
}

// ── SOCIAL TAB ────────────────────────────────────────────────────────────────
let _socialPosts = [];
let _socialPlatform = 'all';

function loadSocial(){
  fetch('/api/social').then(r=>r.json()).then(d=>{
    _socialPosts = d.posts||[];
    document.getElementById('socialCountNum').textContent = _socialPosts.length;
    renderTrending(d.trending||[]);
    renderSocialPosts();
  }).catch(()=>{
    document.getElementById('socialEmpty').textContent = 'No social data available.';
  });
}
function renderTrending(phrases){
  const el = document.getElementById('trendingPhrases');
  if(!phrases.length){ el.innerHTML='<span style="font-size:.7rem;color:var(--text-tertiary)">No trending phrases yet.</span>'; return; }
  el.innerHTML = phrases.map(p=>`<span class="phrase-badge">${p.phrase}<span>${p.count}</span></span>`).join('');
}
function renderSocialPosts(){
  const feed = document.getElementById('socialFeed');
  const empty = document.getElementById('socialEmpty');
  const posts = _socialPosts.filter(p=>_socialPlatform==='all'||p.platform===_socialPlatform);
  if(!posts.length){
    feed.innerHTML='';
    empty.style.display='';
    empty.textContent='No posts for this filter.';
    return;
  }
  empty.style.display='none';
  feed.innerHTML = posts.map(p=>{
    const sentBadge = p.sentiment==='Bullish'?'badge-long':p.sentiment==='Bearish'?'badge-short':'badge-neutral';
    const sentLabel = p.sentiment==='Bullish'?'▲ Bullish':p.sentiment==='Bearish'?'▼ Bearish':'● Neutral';
    const platBadge = p.platform==='Stocktwits'?'badge-st':'badge-same';
    const platLabel = p.platform==='Stocktwits'?'ST':p.platform;
    const total = (p.bull_count||0)+(p.bear_count||0);
    const ts = p.timestamp ? p.timestamp.replace('T',' ').slice(0,16) : '—';
    const text = (p.text||'').slice(0,200)+(p.text&&p.text.length>200?'…':'');
    return `
    <div class="social-item">
      <div class="social-header">
        <span class="social-ticker">${p.ticker}</span>
        <span class="badge ${platBadge}">${platLabel}</span>
        ${p.sentiment?`<span class="badge ${sentBadge}">${sentLabel}</span>`:''}
        <span style="margin-left:auto;font-family:var(--mono);font-size:.6rem;color:var(--text-tertiary)">${ts}</span>
      </div>
      <div class="social-text">${text}</div>
      <div class="social-stats">
        <span class="social-stat"><span class="dot dot-green"></span>${p.bull_count||0} bull</span>
        <span class="social-stat"><span class="dot dot-red"></span>${p.bear_count||0} bear</span>
        <span class="social-stat"><span class="dot dot-gray"></span>${total} total</span>
      </div>
    </div>`;
  }).join('');
}
function socialChipClick(el){
  document.querySelectorAll('#socialChips .chip:not(.soon)').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');
  _socialPlatform = el.dataset.platform;
  renderSocialPosts();
}
document.querySelectorAll('.wbtn').forEach(b=>{
  b.addEventListener('click',()=>{
    document.querySelectorAll('.wbtn').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    loadSocial();
  });
});

// ── CORRELATION TAB ───────────────────────────────────────────────────────────
let _corrChart = null;

function rColor(v){
  if(v===null||v==='—') return 'var(--text-tertiary)';
  const n = parseFloat(v);
  if(n>0.5) return 'var(--green)';
  if(n<-0.5) return 'var(--red)';
  return 'var(--amber)';
}

function runCorrelation(){
  const ticker = document.getElementById('corrTicker').value.trim().toUpperCase();
  const date = document.getElementById('corrDate').value;
  const tf = document.getElementById('corrTimeFrom').value;
  const tt = document.getElementById('corrTimeTo').value;
  const status = document.getElementById('corrStatus');
  status.textContent = 'Analyzing…';
  const params = new URLSearchParams({ticker,date,time_from:tf,time_to:tt});
  fetch('/api/correlation?'+params).then(r=>r.json()).then(d=>{
    if(d.error){
      status.textContent = d.error;
      ['corrR1','corrR2','corrR3'].forEach(id=>{
        const el = document.getElementById(id);
        el.textContent = '—'; el.style.color = 'var(--text-tertiary)';
      });
      buildCorrRollChart(null);   // destroy + hide the rolling-r chart
      return;
    }
    const r1 = d.r_price_sentiment;
    const r2 = d.r_price_density;
    const r3 = d.r_sentiment_density;
    document.getElementById('corrR1').textContent = r1;
    document.getElementById('corrR1').style.color = rColor(r1);
    document.getElementById('corrR2').textContent = r2;
    document.getElementById('corrR2').style.color = rColor(r2);
    document.getElementById('corrR3').textContent = r3;
    document.getElementById('corrR3').style.color = rColor(r3);
    status.textContent = `n=${d.n} data points`;
    buildCorrChart(d.chart);
    buildCorrRollChart(d.rolling);
  }).catch(()=>{ status.textContent='Error'; });
}

// Rolling 30-min Pearson r over the session (research script Graph 2):
// r line with green shading above zero / red below, zero baseline, and
// the ±0.5 dotted guide lines.
let _corrRollChart = null;

const _corrGuideLinesPlugin = {
  id: 'corrGuides',
  afterDatasetsDraw(chart){
    const sc = chart.scales.y, area = chart.chartArea, ctx = chart.ctx;
    if(!sc || !area) return;
    const line = (v, dash, col, w)=>{
      const y = sc.getPixelForValue(v);
      if(y < area.top || y > area.bottom) return;
      ctx.save();
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(area.left, y); ctx.lineTo(area.right, y); ctx.stroke();
      ctx.restore();
    };
    line(0,    [],     'rgba(200,200,200,.5)', 1);    // zero baseline
    line(0.5,  [2,3],  'rgba(150,150,150,.5)', .8);   // r = ±0.5 guides
    line(-0.5, [2,3],  'rgba(150,150,150,.5)', .8);
  }
};

function buildCorrRollChart(rolling){
  const wrap = document.getElementById('corrRollWrap');
  if(_corrRollChart){ _corrRollChart.destroy(); _corrRollChart = null; }
  if(!rolling || !rolling.values || !rolling.values.length){
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  document.getElementById('corrRollTitle').textContent =
    `Rolling ${rolling.window||30}-min r — Price vs Normalized Sentiment`;
  Chart.defaults.color = '#4e5567';
  // overall r is computed on the same smoothed series as the rolling values
  const overallR = rolling.overall;
  _corrRollChart = new Chart(document.getElementById('corrRollChart'),{
    type:'line',
    data:{ labels: rolling.labels, datasets:[
      {label:`r(price vs sentiment)  overall=${overallR>=0?'+':''}${overallR}`,
        data: rolling.values, borderColor:'#2E7D32', borderWidth:2,
        tension:.1, pointRadius:0,
        fill:{target:'origin',
              above:'rgba(46,160,67,.25)', below:'rgba(229,83,75,.25)'}},
    ]},
    plugins:[_corrGuideLinesPlugin],
    options:{
      responsive:true,maintainAspectRatio:false,animation:false,
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:true,labels:{font:{size:9},boxWidth:12}}},
      scales:{
        x:{grid:{color:'#1e2330'},ticks:{font:{size:8},maxTicksLimit:16}},
        y:{min:-1.1,max:1.1,grid:{color:'#1e2330'},ticks:{font:{size:8}},
           title:{display:true,text:'Pearson r',font:{size:10}}},
      },
    },
  });
}

function buildCorrChart(data){
  const ctx = document.getElementById('corrChart');
  if(_corrChart){ _corrChart.destroy(); }
  Chart.defaults.color = '#4e5567';
  const sentData = data.sentiment || data.sentiments || [];
  const datasets = [
    {label:'Price',data:data.prices,borderColor:'#3b82f6',backgroundColor:'transparent',
      yAxisID:'y1',tension:.3,pointRadius:2,borderWidth:1.5},
    {label:'Sentiment',data:sentData,borderColor:'#1d9e75',backgroundColor:'transparent',
      yAxisID:'y2',tension:.3,pointRadius:2,borderWidth:1.5},
  ];
  if(data.density && data.density.length){
    datasets.push({label:'Density',data:data.density,borderColor:'#c8922a',backgroundColor:'transparent',
      yAxisID:'y2',tension:.3,pointRadius:1,borderWidth:1,borderDash:[3,3]});
  }
  _corrChart = new Chart(ctx,{
    type:'line',
    data:{ labels: data.labels, datasets },
    options:{
      responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:true,labels:{font:{size:9},boxWidth:12}}},
      scales:{
        x:{grid:{color:'#1e2330'},ticks:{font:{size:8},maxTicksLimit:20}},
        y1:{position:'left',grid:{color:'#1e2330'},ticks:{font:{size:8}}},
        y2:{position:'right',grid:{display:false},ticks:{font:{size:8}}},
      }
    }
  });
}

// ── CORRELATION RANKING ───────────────────────────────────────────────────────
function loadCorrRank(){
  const btn = document.getElementById('corrRankBtn');
  const status = document.getElementById('corrRankStatus');
  btn.disabled = true;
  status.textContent = 'Computing live correlations — one Finviz + Stocktwits pass per ticker, ~1 min…';
  fetch('/api/correlation/rank').then(r=>r.json()).then(d=>{
    btn.disabled = false;
    _corrRank = d.items||[];
    status.textContent = `${_corrRank.length} tickers · ${d.date}${d.cached?' · cached':''}`;
    document.getElementById('corrRankTable').style.display = '';
    renderCorrRank();
  }).catch(()=>{ btn.disabled=false; status.textContent='Error computing ranking.'; });
}

function corrRankSort(th){
  const col = th.dataset.rcol;
  if(_corrRankCol===col){ _corrRankDir = _corrRankDir==='desc' ? 'asc' : 'desc'; }
  else { _corrRankCol = col; _corrRankDir = 'desc'; }
  document.querySelectorAll('#corrRankTable th').forEach(h=>h.classList.remove('sort-asc','sort-desc'));
  th.classList.add(_corrRankDir==='asc' ? 'sort-asc' : 'sort-desc');
  renderCorrRank();
}

function renderCorrRank(){
  const rows = [..._corrRank].sort((a,b)=>{
    const an = a[_corrRankCol]==null ? -Infinity : a[_corrRankCol];
    const bn = b[_corrRankCol]==null ? -Infinity : b[_corrRankCol];
    return _corrRankDir==='asc' ? an-bn : bn-an;
  });
  const rCell = v => `<td class="td-mono" style="color:${rColor(v==null?null:v)}">${v==null?'—':v}</td>`;
  document.getElementById('corrRankBody').innerHTML = rows.map(r=>`
    <tr ${r.error?`title="${String(r.error).replace(/"/g,'&quot;')}"`:''}>
      <td><span class="ticker-sym tk-link" onclick="openInCharts('${r.ticker}')">${r.ticker}</span></td>
      <td class="td-mono c-dim">${r.n!=null?r.n:'—'}</td>
      ${rCell(r.r_price_sentiment)}${rCell(r.r_price_density)}${rCell(r.r_sentiment_density)}
    </tr>`).join('');
}

// ── CHARTS TAB ────────────────────────────────────────────────────────────────
// (state vars are declared near the top of this script to avoid TDZ on init)

function initChartsTab(){
  const sel = document.getElementById('chartTickerSel');
  if(!_chartSelInit){
    _chartSelInit = true;
    const tickers = [...new Set(INSIGHTS.map(i=>i.ticker))].sort();
    sel.innerHTML = tickers.map(t=>`<option value="${t}">${t}</option>`).join('');
  }
  if(_pendingChartTicker){
    const t = _pendingChartTicker; _pendingChartTicker = null;
    selectChartTicker(t);
  } else if(!_chartTicker){
    if(sel.value){ loadChart(sel.value); }
    else { document.getElementById('chartStatus').textContent = 'No screener tickers yet — type any ticker above, or click Run Now.'; }
  }
}

// Chart any ticker the dropdown doesn't list: add it as an option, select it,
// and load it. Backend /api/chart fetches Finviz for any symbol, so the
// dropdown is just a quick-pick of screener tickers, not a hard limit.
function selectChartTicker(t){
  const sel = document.getElementById('chartTickerSel');
  if(![...sel.options].some(o=>o.value===t)){
    sel.insertAdjacentHTML('afterbegin', `<option value="${t}">${t}</option>`);
  }
  sel.value = t;
  loadChart(t);
}

function chartTickerGo(){
  const inp = document.getElementById('chartTickerInput');
  const t = (inp.value || '').trim().toUpperCase();
  if(!t) return;
  if(!/^[A-Z][A-Z.\-]{0,7}$/.test(t)){
    document.getElementById('chartStatus').textContent = 'Enter a valid ticker symbol (e.g. AAPL, BRK.B).';
    return;
  }
  inp.value = '';
  selectChartTicker(t);
}

function onChartTickerChange(){
  const t = document.getElementById('chartTickerSel').value;
  if(t) loadChart(t);
}

function chartWindowClick(btn){
  document.querySelectorAll('#tab-charts .cwbtn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  _chartWindow = btn.dataset.cw;
  if(_chartTicker) loadChart(_chartTicker);  // server caches the day's bars — no refetch
}

function updateChartStats(ticker){
  const ins = INSIGHTS.find(i=>i.ticker===ticker);
  const mc  = (_multicapData||[]).find(m=>m.ticker===ticker && m.status!=='dropped');
  const src = ins || mc || {};
  const set = (id,val,color)=>{
    const el = document.getElementById(id);
    el.textContent = (val===null||val===undefined||val==='') ? '—' : val;
    el.style.color = color || '';
  };
  const price = src.price!=null ? '$'+parseFloat(src.price).toFixed(2) : null;
  const chgRaw = String(src.change_pct||'');
  const chgColor = chgRaw.includes('-') ? 'var(--red)' : chgRaw ? 'var(--green)' : '';
  set('chStatPrice', price);
  set('chStatChange', src.change_pct||null, chgColor);
  set('chStatRelVol', src.rel_volume ? src.rel_volume+'x' : null);
  set('chStatRsi', src.rsi||null);
  if(ins){
    const dir = (ins.direction||'neutral').toLowerCase();
    const arrow = dir==='long'?'▲':dir==='short'?'▼':'●';
    const col = dir==='long'?'var(--green)':dir==='short'?'var(--red)':'var(--text-tertiary)';
    const bb = `${ins.stocktwits_bull_count||0}B/${ins.stocktwits_bear_count||0}B`;
    set('chStatSent', `${arrow} ${ins.conviction!=null?ins.conviction+'/10':''} · ${bb}`, col);
  } else {
    set('chStatSent', null);
  }
}

function loadChart(ticker){
  _chartTicker = ticker;
  if(_socialPollTimer){ clearTimeout(_socialPollTimer); _socialPollTimer = null; }  // cancel any in-flight poll for a prior ticker
  const status = document.getElementById('chartStatus');
  status.textContent = 'Loading…';
  updateChartStats(ticker);
  document.getElementById('chartTitle').textContent =
    `${ticker} — Intraday Price + Volume (1-min bars)`;
  const params = new URLSearchParams({ticker, window:_chartWindow});
  fetch('/api/chart?'+params).then(r=>r.json()).then(d=>{
    if(d.error){
      status.textContent = d.error;
      if(_chartsChart){ _chartsChart.destroy(); _chartsChart = null; }
      document.getElementById('chartMeta').textContent = '';
      document.getElementById('chartSessions').innerHTML = '';
      return;
    }
    status.textContent = '';
    document.getElementById('chartMeta').textContent = `— ${d.ticker} · ${d.date} · ${d.n} bars`;
    _lastChartData = d;
    renderChart();
    loadSocialOverlays(d);
  }).catch(()=>{ status.textContent = 'Error loading chart data.'; });
}

function toggleOverlay(which, btn){
  if(which==='density') _ovlDensity = !_ovlDensity;
  else _ovlSentiment = !_ovlSentiment;
  btn.classList.toggle('active');
  if(_lastChartData) renderChart();
}

function chartModeClick(btn){
  document.querySelectorAll('#tab-charts .cwbtn[data-cm]').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  _chartMode = btn.dataset.cm;
  if(_lastChartData) renderChart();   // presentation only — no refetch
}

// Dispatch the active chart mode. All builders destroy the previous Chart.js
// instance before creating a new one, so mode switches never leak. The status
// line is owned by loadSocialOverlays (walk progress / no-data note / summary),
// so this function never touches it — it only decides what to draw. Research
// modes fall back to the price chart until usable social data arrives, so the
// chart area is never blank.
function renderChart(){
  const d = _lastChartData;
  if(!d) return;
  const social = (_socialKey===`${d.ticker}|${d.date}`) ? _socialData : null;
  const haveSocial = social && social.messages;
  if(_chartMode==='pd' && haveSocial)        buildPriceDensityChart(d, social);
  else if(_chartMode==='sent' && haveSocial) buildSentimentChart(d, social);
  else if(_chartMode==='ds' && haveSocial)   buildDensitySentimentChart(d, social);
  else                                       buildPriceVolChart(d);
}

// Research-chart x-axis: the scripts plot the full 04:00–20:00 session, so
// Full Day uses the complete social minute timeline; 2h/1h follow the price
// window so the zoom buttons keep working.
function _researchLabels(d, social){
  if(_chartWindow==='full') return social.labels;
  const lo = d.labels[0], hi = d.labels[d.labels.length-1];
  return social.labels.filter(l=>l>=lo && l<=hi);
}

// Density + sentiment series for the charted ticker/day. Served instantly from
// the MongoDB resting store after the first walk; a first-time request streams
// a progress count ("Loading social history, N messages") while a background
// walk runs, then renders. Result is held client-side per ticker|date so
// window/overlay/mode toggles never refetch.
function loadSocialOverlays(d){
  const key = `${d.ticker}|${d.date}`;
  if(_socialKey===key && _socialData) return;   // already loaded for this ticker/day

  const poll = ()=>{
    fetch('/api/chart/social?'+new URLSearchParams({ticker:d.ticker, date:d.date}))
      .then(r=>r.json()).then(s=>{
        // cross-ticker guard: ignore a response for a ticker/day we've moved off
        if(_chartTicker!==d.ticker || !_lastChartData || _lastChartData.date!==d.date) return;
        const status = document.getElementById('chartStatus');

        if(s.error){
          status.textContent = 'Social data: '+s.error;
          renderChart();                          // research modes show "no data" note
          return;
        }
        if(s.status==='walking'){
          // the price chart is already drawn (loadChart rendered it before this
          // poll began), so just update the live count — no chart rebuild/flicker
          status.textContent = `Loading social history, ${s.count||0} messages…`;
          _socialPollTimer = setTimeout(poll, 1500);
          return;
        }
        // ready
        _socialData = s; _socialKey = key; _socialPollTimer = null;
        if(!s.messages){
          status.textContent = 'Not enough social data for this day — price chart only.';
        } else {
          let txt = `Social: ${s.source} · ${s.messages} msgs (${s.bullish}B/${s.bearish}B tagged)`;
          if(!s.complete && s.coverage_start) txt += ` · partial, from ${s.coverage_start}`;
          status.textContent = txt;
        }
        renderChart();
      }).catch(()=>{
        if(_chartTicker!==d.ticker) return;
        document.getElementById('chartStatus').textContent = 'Social data failed to load.';
      });
  };
  _socialPollKey = key;
  poll();
}

// Market sessions (ET): [start, end, label, shade-rgb or null for regular]
const _SESSIONS = [
  ['04:00','09:30','PRE',  [59,130,246]],
  ['09:30','16:00','REG',  null],
  ['16:00','20:00','POST', [139,92,246]],
];

// Background bands over the intraday series — bars already span 04:00–20:00,
// so this needs no new data, only the HH:MM labels.
const _sessionBandsPlugin = {
  id: 'sessionBands',
  beforeDraw(chart){
    const {ctx, chartArea, scales:{x}} = chart;
    if(!chartArea) return;
    const labels = chart.data.labels || [];
    _SESSIONS.forEach(([s,e,name,rgb])=>{
      if(!rgb) return;                       // regular session stays unshaded
      let i0=-1, i1=-1;
      labels.forEach((l,i)=>{ if(l>=s && l<e){ if(i0<0) i0=i; i1=i; } });
      if(i0<0) return;
      const x0 = x.getPixelForValue(i0), x1 = x.getPixelForValue(i1);
      ctx.save();
      ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.07)`;
      ctx.fillRect(x0, chartArea.top, x1-x0, chartArea.bottom-chartArea.top);
      ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.55)`;
      ctx.font = '8px monospace'; ctx.textAlign = 'left';
      ctx.fillText(name, x0+4, chartArea.top+10);
      ctx.restore();
    });
  }
};

function _renderSessionStats(d){
  const seg = (s,e)=>{
    const idx = [];
    d.labels.forEach((l,i)=>{ if(l>=s && l<e) idx.push(i); });
    if(idx.length < 2) return null;
    const a = d.prices[idx[0]], b = d.prices[idx[idx.length-1]];
    return a ? (b-a)/a*100 : null;
  };
  const html = _SESSIONS.map(([s,e,name])=>{
    const v = seg(s,e);
    const label = {PRE:'Pre 04:00–09:30', REG:'Regular 09:30–16:00', POST:'Post 16:00–20:00'}[name];
    if(v===null) return `${label}: <span style="color:var(--text-tertiary)">—</span>`;
    const col = v<0?'var(--red)':v>0?'var(--green)':'var(--text-tertiary)';
    return `${label}: <span style="color:${col}">${v>0?'+':''}${v.toFixed(2)}%</span>`;
  }).join(' · ');
  document.getElementById('chartSessions').innerHTML = html;
}

// Market open/close reference lines (research scripts' axvline cues):
// red dashed at 09:30, purple dashed at 16:00.
const _marketLinesPlugin = {
  id: 'marketLines',
  afterDatasetsDraw(chart){
    const {ctx, chartArea, scales:{x}} = chart;
    if(!chartArea) return;
    const labels = chart.data.labels || [];
    [['09:30','rgba(239,68,68,.75)'],['16:00','rgba(139,92,246,.85)']].forEach(([t,col])=>{
      let i = labels.indexOf(t);
      if(i<0) i = labels.findIndex(l=>l>=t);    // minute missing — first bar after it
      if(i<0 || labels[0]>t) return;            // line falls outside this window
      const px = x.getPixelForValue(i);
      ctx.save();
      ctx.strokeStyle = col; ctx.setLineDash([4,3]); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(px, chartArea.top); ctx.lineTo(px, chartArea.bottom); ctx.stroke();
      ctx.restore();
    });
  }
};

function buildPriceVolChart(d){
  const ctx = document.getElementById('priceVolChart');
  if(_chartsChart){ _chartsChart.destroy(); _chartsChart = null; }
  Chart.defaults.color = '#4e5567';
  const up = d.last >= d.open;
  const maxVol = Math.max(...d.volumes, 1);
  _renderSessionStats(d);

  const datasets = [
    {label:'Price',data:d.prices,borderColor:up?'#1d9e75':'#d85a30',
      backgroundColor:'transparent',yAxisID:'y1',tension:.15,pointRadius:0,borderWidth:1.5},
    {label:'Volume',type:'bar',data:d.volumes,yAxisID:'y2',
      backgroundColor:'rgba(59,130,246,.28)',borderWidth:0,
      barPercentage:1,categoryPercentage:1},
  ];
  const scales = {
    x:{grid:{color:'#1e2330'},ticks:{font:{size:8},maxTicksLimit:16}},
    y1:{position:'left',grid:{color:'#1e2330'},ticks:{font:{size:8}}},
    y2:{position:'right',grid:{display:false},beginAtZero:true,
        max:maxVol*4,ticks:{display:false}},  // volume bars sit in the bottom quarter
  };

  // Social overlays — align the 04:00–20:00 per-minute series to whatever
  // price labels this window shows, by HH:MM lookup (null where undefined).
  const social = (_socialKey===`${d.ticker}|${d.date}`) ? _socialData : null;
  if(social && social.messages){
    const dMap={}, dsMap={}, sMap={}, ssMap={};
    social.labels.forEach((l,i)=>{ dMap[l]=social.density[i]; dsMap[l]=social.density_smooth[i]; });
    social.sent_labels.forEach((l,i)=>{ sMap[l]=social.scores[i]; ssMap[l]=social.scores_smooth[i]; });
    const at = m => l => (l in m ? m[l] : null);
    if(_ovlDensity){
      const maxDen = Math.max(...social.density, 1);
      datasets.push(
        {label:'Msgs/min',type:'bar',data:d.labels.map(at(dMap)),yAxisID:'y3',
          backgroundColor:'rgba(255,152,0,.18)',borderWidth:0,grouped:false,
          barPercentage:1,categoryPercentage:1},
        {label:'Density (15-min avg)',data:d.labels.map(at(dsMap)),yAxisID:'y3',
          borderColor:'#ff9800',backgroundColor:'transparent',
          tension:.15,pointRadius:0,borderWidth:1.6});
      // research combined graphs cap density low so bars don't dominate price
      scales.y3 = {position:'right',display:false,beginAtZero:true,max:maxDen*2.5};
    }
    if(_ovlSentiment){
      datasets.push(
        {label:'Sentiment (raw)',data:d.labels.map(at(sMap)),yAxisID:'y4',
          borderColor:'rgba(160,160,160,.35)',backgroundColor:'transparent',
          tension:0,pointRadius:0,borderWidth:.8},
        {label:'Sentiment (15-min)',data:d.labels.map(at(ssMap)),yAxisID:'y4',
          borderColor:'#2e9e4f',tension:.15,pointRadius:0,borderWidth:1.8,
          fill:{target:'origin',                       // bull/bear shading around 0
                above:'rgba(46,160,67,.14)', below:'rgba(239,68,68,.14)'}});
      scales.y4 = {position:'right',display:false,min:-1.5,max:1.5};
    }
  }

  document.getElementById('chartTitle').textContent =
    `${d.ticker} — Intraday Price + Volume (1-min bars)`;
  _chartsChart = new Chart(ctx,{
    type:'line',
    data:{ labels: d.labels, datasets },
    plugins:[_sessionBandsPlugin,_marketLinesPlugin],
    options:{
      responsive:true,maintainAspectRatio:false,animation:false,
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:true,labels:{font:{size:9},boxWidth:12}}},
      scales,
    },
  });
}

// ── Research chart views (Research-main script reproductions) ────────────────

// Zero baseline for sentiment axes (the scripts' axhline(0)).
const _zeroLinePlugin = {
  id: 'zeroLine',
  afterDatasetsDraw(chart, _a, opts){
    if(!opts || !opts.scale) return;
    const sc = chart.scales[opts.scale], area = chart.chartArea;
    if(!sc || !area) return;
    const y = sc.getPixelForValue(0);
    if(y < area.top || y > area.bottom) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(200,200,200,.45)'; ctx.lineWidth = .8;
    ctx.beginPath(); ctx.moveTo(area.left, y); ctx.lineTo(area.right, y); ctx.stroke();
    ctx.restore();
  }
};

// High/Low peak markers on the price series (Combined script's scatter +
// annotate). Reads dataset 0 of the chart it is attached to.
const _hiLoPlugin = {
  id: 'hiLo',
  afterDatasetsDraw(chart, _a, opts){
    if(!opts || !opts.enabled) return;
    const data = chart.data.datasets[0].data, labels = chart.data.labels;
    let hi=-1, lo=-1;
    data.forEach((v,i)=>{
      if(v==null) return;
      if(hi<0 || v>data[hi]) hi=i;
      if(lo<0 || v<data[lo]) lo=i;
    });
    if(hi<0) return;
    const meta = chart.getDatasetMeta(0), ctx = chart.ctx;
    const draw = (i, col, txt, dy)=>{
      const el = meta.data[i]; if(!el) return;
      ctx.save();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(el.x, el.y, 4, 0, Math.PI*2); ctx.fill();
      ctx.font = '9px monospace'; ctx.textAlign = 'left';
      const tx = Math.min(el.x+8, chart.chartArea.right-90);
      ctx.fillText(txt, tx, el.y+dy);
      ctx.fillText(labels[i], tx, el.y+dy+10);
      ctx.restore();
    };
    draw(hi, '#2ea043', `High: $${data[hi].toFixed(2)}`, -14);
    draw(lo, '#e5534b', `Low: $${data[lo].toFixed(2)}`,  16);
  }
};

function _mapBy(labels, values){
  const m = {};
  labels.forEach((l,i)=>{ m[l] = values[i]; });
  return m;
}
const _atMap = m => l => (l in m ? m[l] : null);

// Combined Message Density and Price Graph — dual axis: close price (left,
// blue, area fill, Hi/Lo markers) vs msgs/min bars + 15-min avg (right).
function buildPriceDensityChart(d, social){
  const ctx = document.getElementById('priceVolChart');
  if(_chartsChart){ _chartsChart.destroy(); _chartsChart = null; }
  Chart.defaults.color = '#4e5567';
  _renderSessionStats(d);
  document.getElementById('chartTitle').textContent =
    `${d.ticker} — Close Price vs Message Density | ${d.date}`;
  const labels = _researchLabels(d, social);
  const prices = labels.map(_atMap(_mapBy(d.labels, d.prices)));
  const dens   = labels.map(_atMap(_mapBy(social.labels, social.density)));
  const densSm = labels.map(_atMap(_mapBy(social.labels, social.density_smooth)));
  const pVals = prices.filter(v=>v!=null);
  const pMin = Math.min(...pVals), pMax = Math.max(...pVals);
  const maxDen = Math.max(...social.density, 1);
  _chartsChart = new Chart(ctx,{
    type:'line',
    data:{ labels, datasets:[
      {label:'Close price',data:prices,yAxisID:'y1',spanGaps:true,
        borderColor:'#2196F3',borderWidth:1.4,tension:.1,pointRadius:0,
        fill:{target:{value:pMin}},backgroundColor:'rgba(33,150,243,.08)'},
      {label:'Messages/min',type:'bar',data:dens,yAxisID:'y2',grouped:false,
        backgroundColor:'rgba(144,202,249,.5)',borderWidth:0,
        barPercentage:1,categoryPercentage:1},
      {label:'15-min avg density',data:densSm,yAxisID:'y2',spanGaps:true,
        borderColor:'#FF9800',borderWidth:2,tension:.1,pointRadius:0},
    ]},
    plugins:[_marketLinesPlugin,_hiLoPlugin],
    options:{
      responsive:true,maintainAspectRatio:false,animation:false,
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:true,labels:{font:{size:9},boxWidth:12}},
               hiLo:{enabled:true}},
      scales:{
        x:{grid:{color:'#1e2330'},ticks:{font:{size:8},maxTicksLimit:16}},
        y1:{position:'left',min:pMin*0.97,max:pMax*1.08,
            grid:{color:'#1e2330'},ticks:{font:{size:8},color:'#2196F3'},
            title:{display:true,text:'Close Price ($)',color:'#2196F3',font:{size:10}}},
        y2:{position:'right',beginAtZero:true,max:maxDen*2.5,
            grid:{display:false},ticks:{font:{size:8},color:'#FF9800'},
            title:{display:true,text:'Messages per minute',color:'#FF9800',font:{size:10}}},
      },
    },
  });
}

// Sentiment Score Graph (figure 1) — raw score faint with green/red zone
// shading around zero, 15-min smoothed line on top, zero baseline.
function buildSentimentChart(d, social){
  const ctx = document.getElementById('priceVolChart');
  if(_chartsChart){ _chartsChart.destroy(); _chartsChart = null; }
  Chart.defaults.color = '#4e5567';
  _renderSessionStats(d);
  document.getElementById('chartTitle').textContent =
    `${d.ticker} Sentiment Score | ${d.date} — (Bullish − Bearish) / Tagged · 5-min window, slides 1 min`;
  const labels = _researchLabels(d, social);
  const raw    = labels.map(_atMap(_mapBy(social.sent_labels, social.scores)));
  const smooth = labels.map(_atMap(_mapBy(social.sent_labels, social.scores_smooth)));
  _chartsChart = new Chart(ctx,{
    type:'line',
    data:{ labels, datasets:[
      {label:'Raw score',data:raw,yAxisID:'ys',spanGaps:true,
        borderColor:'rgba(160,160,160,.4)',borderWidth:.6,tension:0,pointRadius:0,
        fill:{target:'origin',                       // script shades the raw series
              above:'rgba(76,175,80,.2)', below:'rgba(244,67,54,.2)'}},
      {label:'15-min smoothed score',data:smooth,yAxisID:'ys',spanGaps:true,
        borderColor:'#4CAF50',borderWidth:2,tension:.1,pointRadius:0},
    ]},
    plugins:[_marketLinesPlugin,_zeroLinePlugin],
    options:{
      responsive:true,maintainAspectRatio:false,animation:false,
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:true,labels:{font:{size:9},boxWidth:12}},
               zeroLine:{scale:'ys'}},
      scales:{
        x:{grid:{color:'#1e2330'},ticks:{font:{size:8},maxTicksLimit:16}},
        ys:{position:'left',min:-1.1,max:1.1,
            grid:{color:'#1e2330'},ticks:{font:{size:8}},
            title:{display:true,text:'Sentiment Score  (−1 = Bearish | +1 = Bullish)',font:{size:10}}},
      },
    },
  });
}

// Sentiment Score Graph (figure 2) — message density per 5-min window (left)
// vs smoothed sentiment with zone shading (right).
function buildDensitySentimentChart(d, social){
  const ctx = document.getElementById('priceVolChart');
  if(_chartsChart){ _chartsChart.destroy(); _chartsChart = null; }
  Chart.defaults.color = '#4e5567';
  _renderSessionStats(d);
  document.getElementById('chartTitle').textContent =
    `${d.ticker} — Message Density vs Sentiment Score | ${d.date}`;
  const labels = _researchLabels(d, social);
  const dens   = labels.map(_atMap(_mapBy(social.sent_labels, social.win_density)));
  const densSm = labels.map(_atMap(_mapBy(social.sent_labels, social.win_density_smooth)));
  const smooth = labels.map(_atMap(_mapBy(social.sent_labels, social.scores_smooth)));
  const maxDen = Math.max(...social.win_density, 1);
  _chartsChart = new Chart(ctx,{
    type:'line',
    data:{ labels, datasets:[
      {label:'Messages/window',type:'bar',data:dens,yAxisID:'y1',grouped:false,
        backgroundColor:'rgba(33,150,243,.3)',borderWidth:0,
        barPercentage:1,categoryPercentage:1},
      {label:'15-min avg density',data:densSm,yAxisID:'y1',spanGaps:true,
        borderColor:'#2196F3',borderWidth:1.8,tension:.1,pointRadius:0},
      {label:'Sentiment score (smoothed)',data:smooth,yAxisID:'ys',spanGaps:true,
        borderColor:'#FF5722',borderWidth:2,tension:.1,pointRadius:0,
        fill:{target:'origin',                       // script shades the smoothed series here
              above:'rgba(76,175,80,.12)', below:'rgba(244,67,54,.12)'}},
    ]},
    plugins:[_marketLinesPlugin,_zeroLinePlugin],
    options:{
      responsive:true,maintainAspectRatio:false,animation:false,
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:true,labels:{font:{size:9},boxWidth:12}},
               zeroLine:{scale:'ys'}},
      scales:{
        x:{grid:{color:'#1e2330'},ticks:{font:{size:8},maxTicksLimit:16}},
        y1:{position:'left',beginAtZero:true,max:maxDen*2.2,
            grid:{color:'#1e2330'},ticks:{font:{size:8},color:'#2196F3'},
            title:{display:true,text:'Messages per 5-min window',color:'#2196F3',font:{size:10}}},
        ys:{position:'right',min:-1.5,max:1.5,
            grid:{display:false},ticks:{font:{size:8},color:'#FF5722'},
            title:{display:true,text:'Sentiment Score  (−1 to +1)',color:'#FF5722',font:{size:10}}},
      },
    },
  });
}

// ── MOMENTUM TAB ──────────────────────────────────────────────────────────────

function openInCharts(t){
  _pendingChartTicker = t;
  switchTab('charts');
}

function loadMomentum(){
  fetch('/api/momentum').then(r=>r.json()).then(d=>{
    _momentumLoaded = true;
    renderMomentum(d);
  }).catch(()=>{
    document.getElementById('momGrid').innerHTML =
      '<div class="mom-empty">Error loading momentum data.</div>';
  });
}

function _momRow(t, valHtml, co, extraCls){
  return `<div class="mom-row ${extraCls||''}" onclick="openInCharts('${t}')" title="Open ${t} in Charts">
    <span class="tk">${t}</span><span class="co">${co||''}</span><span class="val">${valHtml}</span>
  </div>`;
}
function _chgHtml(v){
  if(v===null||v===undefined) return '—';
  const cls = v<0?'c-red':v>0?'c-green':'c-dim';
  return `<span class="${cls}">${v>0?'+':''}${Number(v).toFixed(2)}%</span>`;
}
function _momCard(title, rows, emptyMsg){
  return `<div class="mom-card"><div class="mom-card-title">${title}</div>
    ${rows.length ? rows.join('') : `<div class="mom-empty">${emptyMsg}</div>`}
  </div>`;
}

function renderMomentum(d){
  // Leaderboard table
  const body = document.getElementById('momBody');
  const items = d.items||[];
  document.getElementById('momCount').textContent = `— ${items.length} tickers scored`;
  if(!items.length){
    body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-tertiary);padding:1rem">No screener data yet — click Run Now.</td></tr>';
  } else {
    body.innerHTML = items.map((r,i)=>{
      const dir = (r.direction||'neutral').toLowerCase();
      const sigLabel = dir==='long'?'▲ LONG':dir==='short'?'▼ SHORT':'● NEUT';
      const scoreCls = r.score>0?'c-green':r.score<0?'c-red':'c-dim';
      const c = r.components;
      const breakdown = `Δ ${c.change>=0?'+':''}${c.change} · RV ${c.rel_vol>=0?'+':''}${c.rel_vol} · Soc ${c.social>=0?'+':''}${c.social}`;
      return `<tr class="dir-${dir}" onclick="openInCharts('${r.ticker}')" style="cursor:pointer" title="Open ${r.ticker} in Charts">
        <td class="td-mono c-dim">${i+1}</td>
        <td><span class="ticker-sym tk-link">${r.ticker}</span><span class="ticker-co">${r.company||''}</span></td>
        <td class="td-mono ${scoreCls}" style="font-weight:700">${r.score>0?'+':''}${r.score}</td>
        <td class="td-mono">${_chgHtml(r.change_pct)}</td>
        <td class="td-mono">${r.rel_vol!=null?r.rel_vol+'x':'—'}</td>
        <td class="td-mono"><span class="c-green">${r.bulls}</span>/<span class="c-red">${r.bears}</span></td>
        <td class="td-mono" style="font-size:.66rem;color:var(--text-tertiary)">${breakdown}</td>
        <td><span class="badge badge-${dir}">${sigLabel}</span></td>
      </tr>`;
    }).join('');
  }

  // Leaderboard cards
  const tierBadge = u => u.tier ? ` <span class="badge badge-${u.tier}">${u.tier.toUpperCase()}</span>` : '';
  const cards = [
    _momCard('▲ Top Gainers',
      (d.gainers||[]).map(u=>_momRow(u.ticker,_chgHtml(u.change_pct),u.company)),
      'No gainers in latest cycle.'),
    _momCard('▼ Top Losers',
      (d.losers||[]).map(u=>_momRow(u.ticker,_chgHtml(u.change_pct),u.company)),
      'No losers in latest cycle.'),
    _momCard('⚡ Unusual Volume',
      (d.unusual_volume||[]).map(u=>_momRow(u.ticker,
        `${u.rel_vol}x${u.rel_vol>3?' <span class="badge badge-hc">&gt;3x</span>':''}`,
        u.company, u.rel_vol>3?'uv-hot':'')),
      'No rel-volume data in latest cycle.'),
    _momCard('RSI Overbought (≥70)',
      (d.rsi_overbought||[]).map(u=>_momRow(u.ticker,`<span class="c-red">${u.rsi}</span>`,u.company)),
      'No RSI data ≥70 in latest cycle.'),
    _momCard('RSI Oversold (≤30)',
      (d.rsi_oversold||[]).map(u=>_momRow(u.ticker,`<span class="c-green">${u.rsi}</span>`,u.company)),
      'No RSI data ≤30 in latest cycle.'),
    _momCard('🐂 Most Bullish (Stocktwits)',
      (d.social_bullish||[]).map(u=>_momRow(u.ticker,`<span class="c-green">${u.bulls} bull</span>`,u.company)),
      'No tagged social posts yet.'),
    _momCard('🐻 Most Bearish (Stocktwits)',
      (d.social_bearish||[]).map(u=>_momRow(u.ticker,`<span class="c-red">${u.bears} bear</span>`,u.company)),
      'No tagged social posts yet.'),
    _momCard('💬 Highest Social Density',
      (d.social_density||[]).map(u=>_momRow(u.ticker,`${u.bulls+u.bears} msgs`,u.company)),
      'No tagged social posts yet.'),
    _momCard('Added — latest multicap cycle',
      (d.added||[]).map(u=>_momRow(u.ticker,`<span class="badge badge-added">ADDED</span>${tierBadge(u)}`,u.company)),
      'No tickers added in latest cycle.'),
    _momCard('Dropped — latest multicap cycle',
      (d.dropped||[]).map(u=>_momRow(u.ticker,`<span class="badge badge-dropped">DROPPED</span>${tierBadge(u)}`,u.company)),
      'No tickers dropped in latest cycle.'),
  ];
  document.getElementById('momGrid').innerHTML = cards.join('');
}

// ── SETTINGS ─────────────────────────────────────────────────────────────────
function switchStab(el){
  const name = el.dataset.stab;
  document.querySelectorAll('.stab').forEach(t=>t.classList.toggle('active',t.dataset.stab===name));
  document.querySelectorAll('.stab-panel').forEach(p=>p.classList.toggle('active',p.id==='stab-'+name));
  if(name==='data') loadDbStats();
  if(name==='logs') loadLogs();
}
function loadDbStats(){
  fetch('/api/settings/stats').then(r=>r.json()).then(d=>{
    document.getElementById('dbRuns').textContent = d.total_runs;
    document.getElementById('dbInsights').textContent = d.total_insights;
    document.getElementById('dbRss').textContent = d.total_rss;
  });
}
function loadLogs(){
  fetch('/api/settings/logs').then(r=>r.json()).then(d=>{
    const box = document.getElementById('logBox');
    if(!d.lines||!d.lines.length){ box.textContent='No log entries yet.'; return; }
    box.innerHTML = d.lines.map(l=>{
      let cls = '';
      try{ const o=JSON.parse(l); cls=o.success?'log-line-ok':'log-line-err'; }catch(e){}
      return `<span class="${cls}">${l}</span>`;
    }).join('\n');
    box.scrollTop = box.scrollHeight;
  });
}
function saveSources(){ /* localStorage persistence for source toggles */ }
function saveKeywords(){
  const kw = document.getElementById('kwTextarea').value;
  localStorage.setItem('scoutKeywords', kw);   // offline fallback for the textarea
  fetch('/api/settings/keywords', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({keywords: kw}),
  }).then(r=>r.json()).then(d=>{
    _userKeywords = d.keywords || [];
    applyUserKwBadges();
    alert(`Saved ${d.count} keyword(s) — the pipeline matches them on incoming news, and matching items are highlighted now.`);
  }).catch(()=>alert('Could not reach server — keywords saved to localStorage only.'));
}

function loadUserKeywords(){
  fetch('/api/settings/keywords').then(r=>r.json()).then(d=>{
    _userKeywords = d.keywords || [];
    const ta = document.getElementById('kwTextarea');
    if(d.raw && !ta.value) ta.value = d.raw;
    applyUserKwBadges();
  }).catch(()=>{});
}

// Highlight user-keyword matches on the rendered news items (the pipeline
// also matches them on ingest via keyword_filter — this makes saved keywords
// visible immediately on items already in the feed).
function applyUserKwBadges(){
  if(!_userKeywords.length) return;
  document.querySelectorAll('#newsItems .news-item').forEach(item=>{
    if(item.querySelector('.badge-ukw')) return;
    const text = (item.querySelector('.news-headline')?.innerText)||'';
    const kw = _userKeywords.find(k=>new RegExp(`(?<!\\w)${k.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&')}(?!\\w)`,'i').test(text));
    if(kw){
      item.querySelector('.news-badges')?.insertAdjacentHTML('beforeend',
        `<span class="badge badge-kw badge-ukw" title="Matches your Settings keyword">⚡ ${kw}</span>`);
    }
  });
}
function saveConfig(){
  localStorage.setItem('scoutConfig', JSON.stringify({
    interval: document.getElementById('cfgInterval').value,
    marketHours: document.getElementById('cfgMarketHours').checked,
    offHours: document.getElementById('cfgOffHours').checked,
  }));
}
function saveImpersonate(){
  const p = document.getElementById('impersonateSelect').value;
  localStorage.setItem('scoutImpersonate', p);
}
function initSettingsFromStorage(){
  const kw = localStorage.getItem('scoutKeywords');
  if(kw) document.getElementById('kwTextarea').value = kw;
  const cfg = JSON.parse(localStorage.getItem('scoutConfig')||'{}');
  if(cfg.interval) document.getElementById('cfgInterval').value = cfg.interval;
  const imp = localStorage.getItem('scoutImpersonate');
  if(imp) document.getElementById('impersonateSelect').value = imp;
}

// ── MULTICAP ─────────────────────────────────────────────────────────────────
// (state vars are declared near the top of this script to avoid TDZ on init)

function loadMulticap(){
  fetch('/api/multicap').then(r=>r.json()).then(d=>{
    _multicapData = d.items || [];
    document.getElementById('multicapCountNum').textContent = _multicapData.length;
    renderMulticap();
    // Cap/Status columns in the screener table derive from multicap data
    applyScreenerFilters();
  }).catch(()=>{});
}

function multicapChipClick(el){
  document.querySelectorAll('#multicapChips .chip[data-tier]').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');
  _mcTier = el.dataset.tier;
  renderMulticap();
}

function multicapStatusClick(el){
  const wasActive = el.classList.contains('active');
  document.querySelectorAll('#multicapChips .chip[data-status]').forEach(c=>c.classList.remove('active'));
  if(!wasActive){ el.classList.add('active'); _mcStatus = el.dataset.status; }
  else { _mcStatus = null; }
  renderMulticap();
}

function mcStatusBadge(s){
  const map = {added:'badge-added',dropped:'badge-dropped',same:'badge-same',first:'badge-neutral'};
  return `<span class="badge ${map[s]||'badge-neutral'}">${(s||'').toUpperCase()}</span>`;
}

function renderMulticap(){
  let rows = _multicapData;
  if(_mcTier !== 'all') rows = rows.filter(r=>r.market_cap_tier===_mcTier);
  if(_mcStatus) rows = rows.filter(r=>r.status===_mcStatus);
  const body = document.getElementById('multicapBody');
  if(!rows.length){
    body.innerHTML='<tr><td colspan="9" style="text-align:center;color:var(--text-tertiary);padding:1rem">No data</td></tr>';
    return;
  }
  body.innerHTML = rows.map(r=>`
    <tr style="border-bottom:var(--border)">
      <td style="padding:.4rem .75rem;font-family:var(--mono);font-weight:700;color:var(--text-primary)">${r.ticker}</td>
      <td style="padding:.4rem .75rem;color:var(--text-secondary);font-size:.75rem">${r.company||''}</td>
      <td style="padding:.4rem .75rem"><span class="badge badge-${r.market_cap_tier||'unknown'}">${(r.market_cap_tier||'').toUpperCase()}</span></td>
      <td style="padding:.4rem .75rem">${mcStatusBadge(r.status)}</td>
      <td style="padding:.4rem .75rem;font-family:var(--mono);color:var(--text-primary)">${r.price!=null?'$'+Number(r.price).toFixed(2):'—'}</td>
      <td style="padding:.4rem .75rem;font-family:var(--mono);color:${(r.change_pct||'').startsWith('-')?'var(--red)':'var(--green)'}">${r.change_pct||'—'}</td>
      ${extHoursCell(r)}
      <td style="padding:.4rem .75rem;font-family:var(--mono);color:var(--text-secondary)">${r.rel_volume||'—'}</td>
      <td style="padding:.4rem .75rem;font-family:var(--mono);color:var(--text-secondary)">${r.rsi||'—'}</td>
    </tr>`).join('');
}

// ── STRUCTURED NEWS (Priyanshu) ───────────────────────────────────────────────
function loadStructuredNews(){
  fetch('/api/news/structured?limit=50').then(r=>r.json()).then(d=>{
    const items = d.items || [];
    const cnt = document.getElementById('structuredCount');
    if(cnt) cnt.textContent = items.length ? `${items.length} articles` : '';
    const feed = document.getElementById('structuredFeed');
    const empty = document.getElementById('structuredEmpty');
    if(!items.length){
      if(empty) empty.textContent = 'feedflash.db not connected';
      return;
    }
    if(empty) empty.style.display='none';
    feed.innerHTML = items.map(a=>{
      const sent = (a.sentiment||'').toLowerCase();
      const sentBadge = sent==='bullish'?'badge-long':sent==='bearish'?'badge-short':'badge-neutral';
      const conf = a.ml_confidence!=null ? ` · ML ${(a.ml_confidence*100).toFixed(0)}%` : '';
      const ticker = a.ticker ? `<span class="badge badge-gnw" style="margin-right:.3rem">${a.ticker}</span>` : '';
      const ts = a.publish_date ? new Date(a.publish_date).toLocaleDateString() : '';
      return `<div class="news-item">
        <div class="news-meta">
          <span class="news-ts">${ts}</span>
        </div>
        <div class="news-body">
          <div class="news-badges">
            <span class="badge" style="background:rgba(20,184,166,.12);color:#14b8a6;border:1px solid rgba(20,184,166,.28)">STRUCTURED</span>
            ${ticker}
            <span class="badge ${sentBadge}">${(a.sentiment||'neutral').toUpperCase()}</span>
            ${a.source?`<span class="badge badge-neutral">${a.source}</span>`:''}
          </div>
          <div class="news-headline">${a.url?`<a href="${a.url}" target="_blank" rel="noopener">${a.title||'(no title)'}</a>`:a.title||'(no title)'}</div>
          ${conf?`<div class="news-scores">${conf}</div>`:''}
        </div>
      </div>`;
    }).join('');
  }).catch(()=>{ document.getElementById('structuredEmpty').textContent='Error loading structured news'; });
}

// ── BROKER / JEFF ────────────────────────────────────────────────────────────
function loadBrokerFeed(){
  fetch('/api/broker').then(r=>r.json()).then(d=>{
    const scanners = d.scanners || [];
    const cnt = document.getElementById('brokerCount');
    if(cnt) cnt.textContent = scanners.length ? `${scanners.length} scanners` : '';
    const feed = document.getElementById('brokerFeed');
    const empty = document.getElementById('brokerEmpty');
    if(!scanners.length){
      if(empty) empty.textContent = 'IBKR_DB not connected — awaiting scanner data';
      return;
    }
    if(empty) empty.style.display='none';
    feed.innerHTML = scanners.map(s=>{
      const tags = (s.tags||[]).map(t=>`<span class="badge badge-neutral">${t.tag}: ${t.value}</span>`).join(' ');
      return `<div class="news-item">
        <div class="news-meta">
          <span class="badge badge-ibkr">IBKR</span>
        </div>
        <div class="news-body">
          <div class="news-badges">
            <span class="badge badge-violet" style="background:var(--violet-bg);color:var(--violet);border:1px solid var(--violet-border)">${s.scan_code||'SCANNER'}</span>
            ${tags}
          </div>
          <div class="news-headline">${s.display_name||'Unnamed Scanner'}</div>
          <div class="news-scores">Req ID: ${s.req_id||'—'} · ${s.instrument||'STK'} / ${s.location_code||'STK.US.MAJOR'}</div>
        </div>
      </div>`;
    }).join('');
  }).catch(()=>{ document.getElementById('brokerEmpty').textContent='Error loading IBKR data'; });
}

// ── YOSEF SOCIAL ─────────────────────────────────────────────────────────────
function loadYosefSocial(){
  fetch('/api/social/yosef?limit=50').then(r=>r.json()).then(d=>{
    const posts = d.posts || [];
    const cnt = document.getElementById('yosefCount');
    if(cnt) cnt.textContent = posts.length ? `${posts.length} messages` : '';
    const feed = document.getElementById('yosefFeed');
    const empty = document.getElementById('yosefEmpty');
    if(!posts.length){
      if(empty) empty.textContent = 'MongoDB not connected — no Yosef data';
      return;
    }
    if(empty) empty.style.display='none';
    feed.innerHTML = posts.map(p=>{
      const sent = (p.sentiment||'').toLowerCase();
      const sentBadge = sent==='bullish'?'badge-long':sent==='bearish'?'badge-short':'badge-neutral';
      const ts = p.timestamp ? new Date(p.timestamp).toLocaleTimeString() : '';
      const rw = (p.rolling_window_score!==null && p.rolling_window_score!==undefined)
        ? `<span class="badge ${p.rolling_window_score>0?'badge-long':p.rolling_window_score<0?'badge-short':'badge-neutral'}"
              title="Rolling ${p.window_minutes||60}m window: ${p.bull_count||0} bull / ${p.bear_count||0} bear of ${p.total_messages||0} msgs">
             RW ${p.rolling_window_score>0?'+':''}${p.rolling_window_score}</span>` : '';
      const counts = (p.total_messages!==null && p.total_messages!==undefined)
        ? `<span class="news-ts">🟢${p.bull_count||0} 🔴${p.bear_count||0} · ${p.total_messages} msgs/${p.window_minutes||60}m</span>` : '';
      const rumor = p.rumor_direction
        ? `<span class="badge ${p.rumor_direction==='Buy-In'?'badge-added':'badge-dropped'}"
              title="Cue-based rumor classification (buy-in vs leave language)">RUMOR: ${p.rumor_direction.toUpperCase()}</span>` : '';
      return `<div class="news-item">
        <div class="news-meta">
          <span class="news-ts">${ts}</span>
          ${p.ticker?`<span class="badge badge-gnw">${p.ticker}</span>`:''}
        </div>
        <div class="news-body">
          <div class="news-badges">
            <span class="badge badge-st">ST</span>
            ${sent?`<span class="badge ${sentBadge}">${sent.toUpperCase()}</span>`:''}
            ${rumor}
            ${rw}
            ${counts}
            ${p.source_type?`<span class="badge badge-neutral">${p.source_type}</span>`:''}
          </div>
          <div class="news-headline" style="color:var(--text-secondary)">${p.text||''}</div>
          ${p.author?`<div class="news-scores">@${p.author}</div>`:''}
        </div>
      </div>`;
    }).join('');
  }).catch(()=>{ document.getElementById('yosefEmpty').textContent='Error loading Yosef data'; });
}

// ── OVERVIEW TAB ─────────────────────────────────────────────────────────────
function ovSort(th){
  const col = th.dataset.col;
  if(_ovSortCol===col){ _ovSortDir = _ovSortDir==='desc' ? 'asc' : 'desc'; }
  else { _ovSortCol = col; _ovSortDir = 'desc'; }
  document.querySelectorAll('#ovScreenerTable th').forEach(h=>h.classList.remove('sort-asc','sort-desc'));
  th.classList.add(_ovSortDir==='asc' ? 'sort-asc' : 'sort-desc');
  renderOvScreener();
}

function renderOvScreener(){
  const rows = [...INSIGHTS];
  rows.sort((a,b)=>{
    let av = a[_ovSortCol], bv = b[_ovSortCol];
    if(_ovSortCol==='change_pct'||_ovSortCol==='rel_volume'){
      av = parseFloat(av)||0; bv = parseFloat(bv)||0;
    } else { av = av||0; bv = bv||0; }
    return _ovSortDir==='asc' ? av-bv : bv-av;
  });
  const tbody = document.getElementById('ovScreenerBody');
  if(!rows.length){
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-tertiary);padding:1rem">No screener data yet — click Run Now.</td></tr>';
  } else {
    tbody.innerHTML = rows.map(r=>{
      const dir = (r.direction||'neutral').toLowerCase();
      const conv = r.conviction||0;
      const capTier = r.cap_tier||'unknown';
      const capLabel = {mega:'Mega',large:'Large',mid:'Mid',small:'Small',micro:'Micro',nano:'Nano',unknown:'—'}[capTier]||'—';
      const chgRaw = String(r.change_pct||'');
      const chgClass = chgRaw.includes('+')?'c-green':chgRaw.includes('-')?'c-red':'';
      const sentColor = dir==='long'?'fill-green':dir==='short'?'fill-red':'fill-gray';
      const sentScore = dir==='long'?'+'+conv:dir==='short'?'-'+conv:'0';
      const sentClass = dir==='long'?'c-green':dir==='short'?'c-red':'c-dim';
      const sigLabel = dir==='long'?'▲ LONG':dir==='short'?'▼ SHORT':'● NEUT';
      const hcBadge = r.high_conviction?'<span class="badge badge-hc">HC</span>':'';
      return `<tr class="dir-${dir}" title="${(r.news_catalyst||'').replace(/"/g,'&quot;')}">
        <td><span class="ticker-sym">${r.ticker}</span><span class="ticker-co">${r.company||''}</span></td>
        <td><span class="badge badge-${capTier}">${capLabel}</span></td>
        <td><span class="badge badge-same">Same</span></td>
        <td class="td-mono">${r.price?'$'+parseFloat(r.price).toFixed(2):'—'}</td>
        <td class="td-mono ${chgClass}">${r.change_pct||'—'}</td>
        <td class="td-mono">${r.rel_volume?r.rel_volume+'x':'—'}</td>
        <td class="td-mono">${r.rsi||'—'}</td>
        <td>
          <div class="sentiment-cell">
            <span class="sentiment-score ${sentClass}">${sentScore}</span>
            <div class="sentiment-bar-track">
              <div class="sentiment-bar-fill ${sentColor}" style="width:${Math.min(conv/10*100,100)}%"></div>
            </div>
          </div>
        </td>
        <td><div class="signal-cell"><span class="badge badge-${dir}">${sigLabel}</span>${hcBadge}</div></td>
      </tr>`;
    }).join('');
  }
  document.getElementById('ovScreenerCount').textContent = rows.length + ' tickers';
}

function ovSrcBadge(src){
  const map = {
    'GlobeNewswire':['badge-gnw','GlobeNW'],
    'PRNewswire':['badge-prn','PRNwire'],
    'BusinessWire':['badge-bw','BizWire'],
    'SEC 8-K':['badge-sec','SEC 8-K'],
    'Stocktwits':['badge-st','ST'],
  };
  const [cls,label] = map[src] || ['badge-fv',(src||'').slice(0,7)];
  return `<span class="badge ${cls}">${label}</span>`;
}

function ovNewsChip(el){
  document.querySelectorAll('#ovNewsChips .chip[data-cls]').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');
  _ovNewsClass = el.dataset.cls;
  renderOvNews();
}
function ovNewsSortChip(el){
  document.querySelectorAll('#ovNewsChips .chip[data-sort]').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');
  _ovNewsSort = el.dataset.sort;
  renderOvNews();
}

function _ovParseTs(s){
  if(!s) return 0;
  let str = String(s).replace(' ','T');
  // Pipeline timestamps without a timezone are naive UTC — pin them so the
  // three classes sort correctly against each other in the All view.
  if(!/Z$|[+-][0-9]{2}:?[0-9]{2}$/.test(str)) str = str.slice(0,23) + 'Z';
  const d = new Date(str);
  return isNaN(d) ? 0 : d.getTime();
}
function _ovTsLabel(s){
  return s ? String(s).slice(0,16).replace('T',' ') : '\u2014';
}

function ovRssItemHtml(i){
  const tickers = (i.extracted_tickers||[]).slice(0,3)
    .map(t=>`<span class="badge badge-same">${t}</span>`).join('');
  const hc = i.finviz_match ? '<span class="badge badge-hc">HC</span>' : '';
  const kw = i.matched_keyword ? `<span class="badge badge-kw" title="Keyword that matched the screener filter">\u26a1 ${i.matched_keyword}</span>` : '';
  const matched = (i.extracted_tickers||[]).find(t=>_dirByTicker[t]);
  const dir = matched ? _dirByTicker[matched] : null;
  const dirBadge = dir
    ? `<span class="badge badge-${dir}">${dir==='long'?'\u25b2 LONG':dir==='short'?'\u25bc SHORT':'\u25cf NEUT'}</span>` : '';
  const headline = (i.title||'').slice(0,120) + ((i.title||'').length>120?'\u2026':'');
  return `<div class="ov-news-item">
    <div class="news-badges">${_OV_RSS_BADGE}${ovSrcBadge(i.source)}<span class="news-ts">${_ovTsLabel(i.published_at)}</span>${tickers}${hc}${kw}${dirBadge}</div>
    <div class="news-headline">${i.link?`<a href="${i.link}" target="_blank" rel="noopener">${headline}</a>`:headline}</div>
  </div>`;
}

function ovStructuredItemHtml(a){
  const sent = (a.sentiment_label||'').toLowerCase();
  const sentBadge = sent==='bullish'?'badge-long':sent==='bearish'?'badge-short':'badge-neutral';
  const ticker = a.ticker ? `<span class="badge badge-gnw">${a.ticker}</span>` : '';
  const conf = a.ml_confidence!=null ? ` \u00b7 ML ${(a.ml_confidence*100).toFixed(0)}%` : '';
  const fb = a.finbert_score!=null ? `FinBERT ${a.finbert_score>=0?'+':''}${Number(a.finbert_score).toFixed(2)}` : '';
  const headline = (a.headline||'').slice(0,120) + ((a.headline||'').length>120?'\u2026':'');
  return `<div class="ov-news-item">
    <div class="news-badges">${_OV_STRUCT_BADGE}<span class="news-ts">${_ovTsLabel(a.timestamp)}</span>${ticker}${sent?`<span class="badge ${sentBadge}">${sent.toUpperCase()}</span>`:''}</div>
    <div class="news-headline">${a.article_url?`<a href="${a.article_url}" target="_blank" rel="noopener">${headline}</a>`:headline}</div>
    ${(fb||conf)?`<div class="news-scores">${fb}${conf}</div>`:''}
  </div>`;
}

function ovSocialItemHtml(p){
  const sent = (p.sentiment||'').toLowerCase();
  const sentBadge = sent==='bullish'?'badge-long':sent==='bearish'?'badge-short':'badge-neutral';
  const ticker = p.ticker ? `<span class="badge badge-gnw">${p.ticker}</span>` : '';
  const rw = (p.rolling_window_score!==null && p.rolling_window_score!==undefined)
    ? `<span class="badge ${p.rolling_window_score>0?'badge-long':p.rolling_window_score<0?'badge-short':'badge-neutral'}">RW ${p.rolling_window_score>0?'+':''}${p.rolling_window_score}</span>` : '';
  const raw = p.message_text || p.text || '';
  const text = raw.slice(0,140) + (raw.length>140?'\u2026':'');
  return `<div class="ov-news-item">
    <div class="news-badges">${_OV_SOCIAL_BADGE}<span class="news-ts">${_ovTsLabel(p.timestamp)}</span>${ticker}${sent?`<span class="badge ${sentBadge}">${sent.toUpperCase()}</span>`:''}${rw}</div>
    <div class="news-headline" style="color:var(--text-secondary)">${text}</div>
    ${p.author?`<div class="news-scores">@${p.author}</div>`:''}
  </div>`;
}

function renderOvNews(){
  // Social (unstructured) posts live in their own Overview column now —
  // this feed only merges RSS and structured news.
  const items = [];
  // ts = publication time; dts = detection time (fetched_at when the poller
  // stored it; structured articles only have their pipeline timestamp)
  RSS_FEED.forEach(i=>items.push({cls:'rss', ts:_ovParseTs(i.published_at),
    dts:_ovParseTs(i.fetched_at||i.published_at), it:i}));
  _ovStructured.forEach(a=>items.push({cls:'structured', ts:_ovParseTs(a.timestamp||a.publish_date),
    dts:_ovParseTs(a.timestamp||a.publish_date), it:a}));
  const k = _ovNewsSort==='detected' ? 'dts' : 'ts';

  let list;
  if(_ovNewsClass==='all'){
    // Balanced view: newest 8 of each class, merged newest-first.
    list = ['rss','structured'].flatMap(cls =>
      items.filter(x=>x.cls===cls).sort((a,b)=>b[k]-a[k]).slice(0,8)
    );
  } else {
    list = items.filter(x=>x.cls===_ovNewsClass);
  }
  list.sort((a,b)=>b[k]-a[k]);
  list = list.slice(0,15);

  const el = document.getElementById('ovNewsList');
  if(!list.length){
    el.innerHTML = '<div class="empty-state">No items in this class yet.</div>';
  } else {
    el.innerHTML = list.map(x=>
      x.cls==='rss' ? ovRssItemHtml(x.it) : ovStructuredItemHtml(x.it)
    ).join('');
  }
  document.getElementById('ovNewsCount').textContent = list.length + ' items';
}

function loadOvNewsSources(){
  fetch('/api/news/structured?limit=20').then(r=>r.json()).then(d=>{
    _ovStructured = d.items||[]; renderOvNews();
  }).catch(()=>{});
  fetch('/api/social/yosef?limit=20').then(r=>r.json()).then(d=>{
    _ovSocialNews = d.posts||[]; renderOvSocialNews();
  }).catch(()=>{});
}

function renderOvSocialNews(){
  const wrap = document.getElementById('ovSocialNewsList');
  const posts = [..._ovSocialNews]
    .sort((a,b)=>_ovParseTs(b.timestamp)-_ovParseTs(a.timestamp))
    .slice(0,20);
  wrap.innerHTML = posts.length
    ? posts.map(ovSocialItemHtml).join('')
    : '<div class="empty-state">No unstructured social posts yet.</div>';
  document.getElementById('ovSocialCount').textContent = posts.length + ' posts';
}

function loadOvTrending(){
  fetch('/api/social').then(r=>r.json()).then(d=>{
    const el = document.getElementById('ovTrending');
    const phrases = (d.trending||[]).slice(0,5);
    el.innerHTML = phrases.length
      ? phrases.map(p=>`<span class="phrase-badge">${p.phrase}<span>${p.count}</span></span>`).join('')
      : '<span style="font-size:.7rem;color:var(--text-tertiary)">No trending phrases yet.</span>';
  }).catch(()=>{});
}

function loadOvCorrelation(){
  const lbl = document.getElementById('ovCorrTicker');
  if(!TOP_TICKER || !TOP_TICKER.ticker){ lbl.textContent = 'no data'; return; }
  lbl.textContent = TOP_TICKER.ticker;
  fetch('/api/correlation?ticker='+encodeURIComponent(TOP_TICKER.ticker))
    .then(r=>r.json()).then(d=>{
      [['ovR1',d.r_price_sentiment],['ovR2',d.r_price_density],['ovR3',d.r_sentiment_density]]
        .forEach(([id,v])=>{
          const el = document.getElementById(id);
          el.textContent = (v===undefined||v===null) ? '—' : v;
          el.style.color = rColor(v);
        });
      if(d.chart) buildOvChart(d.chart);
    }).catch(()=>{});
}

function buildOvChart(data){
  const ctx = document.getElementById('ovCorrChart');
  if(_ovChart){ _ovChart.destroy(); }
  Chart.defaults.color = '#4e5567';
  const sent = data.sentiment || data.sentiments || [];
  _ovChart = new Chart(ctx,{
    type:'line',
    data:{
      labels: data.labels,
      datasets:[
        {label:'Price',data:data.prices,borderColor:'#3b82f6',backgroundColor:'transparent',
          yAxisID:'y1',tension:.3,pointRadius:0,borderWidth:1.5},
        {label:'Sentiment',data:sent,borderColor:'#1d9e75',backgroundColor:'transparent',
          yAxisID:'y2',tension:.3,pointRadius:0,borderWidth:1.5},
      ],
    },
    options:{
      responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:true,labels:{font:{size:8},boxWidth:10}}},
      scales:{
        x:{grid:{color:'#1e2330'},ticks:{font:{size:7},maxTicksLimit:8}},
        y1:{position:'left',grid:{color:'#1e2330'},ticks:{font:{size:7}}},
        y2:{position:'right',grid:{display:false},ticks:{font:{size:7}}},
      },
    },
  });
}

function loadOvStats(){
  document.getElementById('ovStatRuns').textContent = STATS.total_runs!=null ? STATS.total_runs : '—';
  document.getElementById('ovStatAcc').textContent = STATS.accuracy!=null ? STATS.accuracy+'%' : '—';
  fetch('/api/settings/stats').then(r=>r.json()).then(d=>{
    document.getElementById('ovStatInsights').textContent = d.total_insights;
  }).catch(()=>{});
}

function renderOverview(){
  renderOvScreener();
  renderOvNews();
  loadOvNewsSources();
  renderOvSocialNews();
  loadOvTrending();
  loadOvCorrelation();
  loadOvStats();
}

// ── Init ─────────────────────────────────────────────────────────────────────
// Render screener if already on that tab
if(localStorage.getItem('scoutTab')==='screener') renderScreener(INSIGHTS);
// Load multicap data on startup
loadMulticap();
setInterval(loadMulticap, 60000);
</script>
</body>
</html>"""


# ─── MAIN ROUTES ──────────────────────────────────────────────────────────────

@app.route("/")
def index():
    stats     = get_stats()
    insights  = get_insights_latest()
    rss_feed  = get_rss_feed(limit=200)
    social    = get_social_panel()
    top_ticker = get_top_ticker()
    sparkline = get_conviction_sparkline()
    # AI Top Picks: reuse the cached, conviction-sorted ranking (no live model
    # call) — top scored tickers for the at-a-glance Overview panel.
    top_picks = [i for i in insights if i.get("conviction") is not None][:7]
    return render_template_string(
        TEMPLATE,
        stats=stats,
        insights=insights,
        rss_feed=rss_feed,
        social=social,
        top_ticker=top_ticker,
        sparkline=sparkline,
        top_picks=top_picks,
    )


def _run_pipeline_thread():
    import sentiment_screener
    _run_state["started_at"] = datetime.now(timezone.utc)
    try:
        result = sentiment_screener.run_pipeline()
        _run_state["last_result"] = result
    except Exception as e:
        _run_state["last_result"] = {"success": False, "error": str(e)}
    finally:
        _run_state["running"] = False


@app.route("/run", methods=["POST"])
def trigger_run():
    with _run_lock:
        if _run_state["running"]:
            elapsed = int((datetime.now(timezone.utc) - _run_state["started_at"]).total_seconds())
            return jsonify({"status": "already_running", "elapsed_s": elapsed})
        _run_state["running"] = True
        _run_state["last_result"] = None
        threading.Thread(target=_run_pipeline_thread, daemon=True).start()
    return jsonify({"status": "started"})


@app.route("/run/status")
def run_status():
    running = _run_state["running"]
    elapsed = 0
    if _run_state["started_at"]:
        elapsed = int((datetime.now(timezone.utc) - _run_state["started_at"]).total_seconds())
    last = _run_state["last_result"]
    just_finished = (not running) and (last is not None)
    if just_finished:
        _run_state["last_result"] = None
    return jsonify({"running": running, "elapsed_s": elapsed,
                    "just_finished": just_finished, "last_result": last})


if __name__ == "__main__":
    if not DB_PATH.exists():
        print(f"[WARN] Database not found at {DB_PATH}")
        print("       Run sentiment_screener.py first.")

    # Start background multicap screener (every 60 s)
    try:
        from apscheduler.schedulers.background import BackgroundScheduler
        from apscheduler.triggers.interval import IntervalTrigger
        _aps = BackgroundScheduler(daemon=True)
        # 300s, not 60s: six concurrent Finviz Elite requests every 60s saturate
        # the per-token rate limit (429s that escalate to a hard 401), which then
        # breaks on-demand calls sharing the token — notably /api/chart's
        # quote_export fetch. 5 min matches the other jobs and keeps charts alive.
        # Tunable via MULTICAP_INTERVAL_SEC.
        _aps.add_job(
            multicap_screener.run_multicap_screener,
            trigger=IntervalTrigger(seconds=int(os.environ.get("MULTICAP_INTERVAL_SEC", "300"))),
            id="multicap",
            name="Multicap Screener",
            max_instances=1,
            misfire_grace_time=30,
        )
        _aps.add_job(
            priyanshu_adapter.run_priyanshu_pipeline,
            trigger=IntervalTrigger(minutes=5),
            id="priyanshu",
            name="Priyanshu FeedFlash Pipeline",
            max_instances=1,            # never overlap a slow FinBERT run
            misfire_grace_time=120,
        )
        # SEC EDGAR 8-K ingest — free, no key, ticker-mapped. Brings the SEC
        # structured source into the same store the wire services land in. Every
        # 30 min (EDGAR is rate-limited; filings change slowly).
        _aps.add_job(
            priyanshu_adapter.run_sec_edgar_ingest,
            trigger=IntervalTrigger(minutes=30),
            id="sec_edgar",
            name="SEC EDGAR 8-K Ingest",
            max_instances=1,
            misfire_grace_time=300,
        )
        _aps.add_job(
            yosef_adapter.run_yosef_scrapers,
            trigger=IntervalTrigger(minutes=5),
            id="yosef",
            name="Yosef Stocktwits Scraper",
            max_instances=1,
            misfire_grace_time=120,
        )
        # Bluesky social ingestion — only meaningful when creds are set; the job
        # itself no-ops cleanly otherwise. Runs every 10 min (vs 5) to respect
        # Bluesky's search rate limits.
        _aps.add_job(
            bluesky_adapter.run_bluesky_scraper,
            trigger=IntervalTrigger(minutes=10),
            id="bluesky",
            name="Bluesky Social Scraper",
            max_instances=1,
            misfire_grace_time=120,
        )
        # Reddit social ingestion — only meaningful when creds are set; no-ops
        # cleanly otherwise. Runs every 10 min to respect Reddit's rate limits.
        _aps.add_job(
            reddit_adapter.run_reddit_scraper,
            trigger=IntervalTrigger(minutes=10),
            id="reddit",
            name="Reddit Social Scraper",
            max_instances=1,
            misfire_grace_time=120,
        )
        # TradingView news ingestion — FinBERT/VADER-scored, fails soft (block /
        # rate-limit → no-op). Every 10 min; never overlaps a slow FinBERT run.
        _aps.add_job(
            tradingview_adapter.run_tradingview_pipeline,
            trigger=IntervalTrigger(minutes=10),
            id="tradingview",
            name="TradingView News",
            max_instances=1,
            misfire_grace_time=120,
        )
        _aps.start()
        _multicap_interval = int(os.environ.get("MULTICAP_INTERVAL_SEC", "300"))
        print(f"[multicap] Background screener started ({_multicap_interval}s interval)")
        print("[priyanshu] FeedFlash pipeline scheduled (5min interval)")
        print("[yosef] Stocktwits scraper scheduled (5min interval, 120s timeout)")
        print(f"[bluesky] Social scraper scheduled (10min interval) — "
              f"{'configured' if bluesky_adapter.is_configured() else 'NOT configured (idle)'}")
        print(f"[reddit] Social scraper scheduled (10min interval) — "
              f"{'configured' if reddit_adapter.is_configured() else 'NOT configured (idle)'}")
        print("[tradingview] News pipeline scheduled (10min interval)")
    except Exception as _aps_err:
        print(f"[WARN] Could not start multicap scheduler: {_aps_err}")

    print("Sentiment Scout running at http://localhost:5050")
    app.run(host="0.0.0.0", port=5050, debug=False)
