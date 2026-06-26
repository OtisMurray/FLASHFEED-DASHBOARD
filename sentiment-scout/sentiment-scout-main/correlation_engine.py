"""
Correlation engine: Finviz 1-min price + Stocktwits rolling windows → Pearson r.
Ported from highschool scripts; no Selenium, no pandas, no scipy.
"""

import csv
import io
import math
import re
import time
from collections import defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from curl_cffi import requests as cffi_requests

import social_store
import config

EDT = ZoneInfo("America/New_York")

CURL_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://finviz.com/",
}


# ─── MATH ─────────────────────────────────────────────────────────────────────

def _smooth_same(values: list, k: int) -> list:
    """Centered k-wide moving average with zero-padded edges — the pure-python
    equivalent of np.convolve(values, ones(k)/k, mode='same'). Matches the
    research script's smooth() (and dashboard._smooth_same), including its
    skip-when-too-short behavior."""
    n = len(values)
    if n < k:
        return list(values)
    lead = k // 2          # numpy 'same' window start = i - k//2 (handles even k)
    out = []
    for i in range(n):
        s = 0.0
        for j in range(i - lead, i - lead + k):
            if 0 <= j < n:
                s += values[j]
        out.append(s / k)
    return out


def pearson_r(xs: list, ys: list) -> float:
    n = len(xs)
    if n < 2:
        return 0.0
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx  = sum((x - mx) ** 2 for x in xs) ** 0.5
    dy  = sum((y - my) ** 2 for y in ys) ** 0.5
    if dx * dy == 0:
        return 0.0
    return round(num / (dx * dy), 4)


# ─── PRICE DATA ───────────────────────────────────────────────────────────────

def _fetch_price_data(session, ticker: str, date: str) -> dict:
    """
    Fetch 1-min OHLCV from Finviz Elite quote_export.
    date: "YYYY-MM-DD"
    Returns {datetime_obj: close_price} (naive, no tz).
    """
    try:
        dt_obj = datetime.strptime(date, "%Y-%m-%d")
        fdate  = f"{dt_obj.month}/{dt_obj.day}/{dt_obj.year}"
    except ValueError:
        fdate = date

    url = (
        f"https://elite.finviz.com/quote_export"
        f"?t={ticker}&p=i1&s={fdate}&e={fdate}&auth={config.get_finviz_token()}"
    )
    try:
        resp = session.get(url, headers=CURL_HEADERS, impersonate="chrome124", timeout=25)
        resp.raise_for_status()
        prices: dict = {}
        reader = csv.DictReader(io.StringIO(resp.text))
        for row in reader:
            raw = (row.get("Date") or row.get("date") or "").strip()
            raw = re.sub(r"\s*(AM|PM)$", "", raw, flags=re.IGNORECASE).strip()
            close_str = (row.get("Close") or row.get("close") or "").strip()
            if not raw or not close_str:
                continue
            try:
                ts = datetime.strptime(raw, "%m/%d/%Y %H:%M")
                prices[ts] = float(close_str)
            except Exception:
                pass
        print(f"  [corr] {ticker}: {len(prices)} price bars loaded")
        return prices
    except Exception as exc:
        print(f"  [corr] price fetch error ({ticker}): {exc}")
        return {}


# ─── STOCKTWITS ───────────────────────────────────────────────────────────────
# Per-message social data now comes from the shared resting store
# (social_store.get_messages) instead of a walk local to this module, so the
# engine both benefits from and contributes to the same store as the Charts tab.


# ─── MAIN ENTRY ───────────────────────────────────────────────────────────────

def run_correlation(ticker: str, date: str,
                    start_time: str = "09:30",
                    end_time:   str = "16:00") -> dict:
    """
    Compute Pearson correlations between 1-min price, 5-min social density,
    and 5-min weighted sentiment score.

    Args:
        ticker:     e.g. "AAPL"
        date:       "YYYY-MM-DD"
        start_time: "HH:MM" (default 09:30)
        end_time:   "HH:MM" (default 16:00)

    Returns dict with r values + chart data (labels, prices, sentiment, density).
    """
    ticker = ticker.upper().strip()
    try:
        base = datetime.strptime(date, "%Y-%m-%d")
        sh, sm = map(int, start_time.split(":"))
        eh, em = map(int, end_time.split(":"))
        t_start = base.replace(hour=sh, minute=sm)
        t_end   = base.replace(hour=eh, minute=em)
    except Exception as exc:
        return {"error": f"Invalid date/time: {exc}", "ticker": ticker}

    session    = cffi_requests.Session()
    price_map  = _fetch_price_data(session, ticker, date)

    if not price_map:
        return {"error": "No price data returned from Finviz. Check date or ticker.",
                "ticker": ticker}

    # Per-message social data from the shared resting store (social_store):
    # walk-once-then-persist on a miss, incremental top-up for the current day.
    # Shared with the Charts tab, so a ticker charted there needs no second walk.
    today = datetime.now(EDT).strftime("%Y-%m-%d")
    social_msgs, _doc = social_store.get_messages(ticker, date, today=today)

    # ── Build 1-min message buckets ──────────────────────────────────────────
    # The store returns the full 04:00–20:00 ET day; the 5-min windows below
    # only reference keys within [t_start, t_end], so out-of-window minutes are
    # simply never summed (no behavior change vs the old in-range walk).
    minute_counts = defaultdict(int)
    minute_bull   = defaultdict(int)
    minute_bear   = defaultdict(int)
    for dt_et, sent in social_msgs:
        k = dt_et.replace(second=0, microsecond=0)
        minute_counts[k] += 1
        if sent == "Bullish":
            minute_bull[k] += 1
        elif sent == "Bearish":
            minute_bear[k] += 1

    # ── Build 5-min rolling windows (slide 1 min) ────────────────────────────
    windows = []
    t = t_start
    while t + timedelta(minutes=5) <= t_end:
        wend   = t + timedelta(minutes=5)
        keys   = [k for k in minute_counts if t <= k < wend]
        total  = sum(minute_counts[k] for k in keys)
        bull   = sum(minute_bull[k]   for k in keys)
        bear   = sum(minute_bear[k]   for k in keys)
        tagged = bull + bear
        raw_score = ((bull - bear) / tagged * math.log1p(total)) if tagged > 0 else 0.0
        windows.append({"t": t, "total": total, "score": raw_score})
        t += timedelta(minutes=1)

    if not windows:
        return {"error": "No rolling windows built — no messages in time range.",
                "ticker": ticker}

    max_w = max(abs(w["score"]) for w in windows) or 1.0
    for w in windows:
        w["norm_score"] = w["score"] / max_w

    # ── Align price to windows ───────────────────────────────────────────────
    prices_al    = []
    density_al   = []
    sentiment_al = []
    labels       = []

    for w in windows:
        price = price_map.get(w["t"])
        if price is None:
            continue
        prices_al.append(price)
        density_al.append(w["total"])
        sentiment_al.append(w["norm_score"])
        labels.append(w["t"].strftime("%H:%M"))

    n = len(prices_al)
    if n < 2:
        return {"error": f"Only {n} overlapping data points — need at least 2.",
                "ticker": ticker, "n": n}

    r_ps = pearson_r(prices_al, sentiment_al)
    r_pd = pearson_r(prices_al, density_al)
    r_sd = pearson_r(sentiment_al, density_al)

    # Rolling 30-min r of price vs normalized sentiment over the aligned
    # series — the highschool scripts' Graph 2 (window slides 1 min, value
    # plotted at the window's trailing edge). The script pre-smooths the full
    # series before correlating (price k=5, score k=10, np.convolve 'same'),
    # so both the rolling values and this chart's overall r run on the
    # smoothed series. Scoped to this chart only — the static r cards above
    # stay on the raw aligned series.
    win_r = 30
    price_sm = _smooth_same(prices_al, 5)
    sent_sm  = _smooth_same(sentiment_al, 10)
    rolling_labels, rolling_values = [], []
    for i in range(win_r, n):
        rolling_values.append(pearson_r(price_sm[i - win_r:i],
                                        sent_sm[i - win_r:i]))
        rolling_labels.append(labels[i])
    rolling_overall = pearson_r(price_sm, sent_sm)

    cap = 120  # max chart points
    return {
        "ticker": ticker,
        "date":   date,
        "n":      n,
        "r_price_sentiment":   r_ps,
        "r_price_density":     r_pd,
        "r_sentiment_density": r_sd,
        "chart": {
            "labels":    labels[:cap],
            "prices":    prices_al[:cap],
            "sentiment": sentiment_al[:cap],
            "density":   density_al[:cap],
        },
        "rolling": {
            "window":  win_r,
            "labels":  rolling_labels,
            "values":  rolling_values,
            "overall": rolling_overall,
        },
    }


if __name__ == "__main__":
    import sys
    tkr   = sys.argv[1] if len(sys.argv) > 1 else "AAPL"
    dt    = sys.argv[2] if len(sys.argv) > 2 else datetime.now(EDT).strftime("%Y-%m-%d")
    result = run_correlation(tkr, dt)
    import json
    print(json.dumps({k: v for k, v in result.items() if k != "chart"}, indent=2))
