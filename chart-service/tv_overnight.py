"""Overnight (20:00-04:00 ET) 1-min prices via TradingView — Blue Ocean ATS data.

TradingView integrated the Blue Ocean overnight session into its main US-stock
symbols, so a logged-in datafeed pull with the extended session returns real
overnight trades for supported (liquid) tickers. This module fills ONLY the
20:00->04:00 gap on the 24-h price+density chart; Finviz stays authoritative
for the 04:00-20:00 session.

Data path is the unofficial `tvDatafeed` package (TradingView has no official
data API). Treat as best-effort and fragile by design:
  * lazy import — the service runs fine if the package isn't installed
  * any failure returns [] and the chart falls back to the dashed
    prev-close carry
  * TV_USERNAME / TV_PASSWORD come from chart-service/.env (gitignored,
    never logged) — overnight coverage needs the owner's paid TV account
  * thin tape: overnight minutes without trades simply have no bar

Timezone note: tvDatafeed returns bars indexed in the exchange's local time
for US equities (ET) as naive datetimes; if a tz-aware index ever appears we
convert to ET. The first live run should sanity-check alignment by comparing
the 04:00-20:00 overlap against Finviz bars (see /api/sentchart/chart).
"""
import os
import threading
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

EDT = ZoneInfo("America/New_York")

_lock = threading.Lock()
_tv = None                       # singleton TvDatafeed (one login per process)
_exchange_cache: dict = {}       # ticker -> resolved exchange
_cache: dict = {}                # (ticker, date) -> {"ts": epoch, "bars": [...]}
_TTL = 300

_EXCHANGES = ("NASDAQ", "NYSE", "AMEX")   # tried in order per ticker


def available() -> bool:
    """True if the tvDatafeed package is importable (installed)."""
    try:
        import tvDatafeed  # noqa: F401
        return True
    except Exception:
        return False


def _client():
    """One logged-in TvDatafeed per process. Anonymous fallback works but
    almost certainly lacks the overnight session."""
    global _tv
    with _lock:
        if _tv is not None:
            return _tv
        from tvDatafeed import TvDatafeed
        user = os.environ.get("TV_USERNAME")
        pw = os.environ.get("TV_PASSWORD")
        _tv = TvDatafeed(user, pw) if user and pw else TvDatafeed()
        return _tv


def _to_et_naive(idx_val):
    """Normalize a bar timestamp to naive ET wall-clock."""
    dt = idx_val.to_pydatetime() if hasattr(idx_val, "to_pydatetime") else idx_val
    if dt.tzinfo is not None:
        dt = dt.astimezone(EDT).replace(tzinfo=None)
    return dt


def _fetch_df(ticker: str):
    """1-min extended-session bars, resolving the exchange on first use."""
    from tvDatafeed import Interval
    tv = _client()
    tried = ([_exchange_cache[ticker]] if ticker in _exchange_cache
             else list(_EXCHANGES))
    for exch in tried:
        try:
            df = tv.get_hist(symbol=ticker, exchange=exch,
                             interval=Interval.in_1_minute,
                             n_bars=3000, extended_session=True)
        except Exception:
            df = None
        if df is not None and len(df):
            _exchange_cache[ticker] = exch
            return df
    return None


def overnight_bars(ticker: str, date_str: str) -> list:
    """Real overnight bars for the 24-h window of date_str: naive-ET closes in
    [date-1 20:00, date 04:00). Returns [{"ts": dt, "close": f, "volume": f}]
    sorted by time; [] on any failure (caller falls back to prev-close carry)."""
    key = (ticker, date_str)
    hit = _cache.get(key)
    if hit and time.time() - hit["ts"] < _TTL:
        return hit["bars"]

    try:
        d0 = datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return []
    start = d0 - timedelta(hours=4)              # date-1 20:00
    end = d0 + timedelta(hours=4)                # date   04:00

    try:
        df = _fetch_df(ticker)
    except Exception:
        df = None
    if df is None or not len(df):
        return []

    bars = []
    for idx, row in df.iterrows():
        dt = _to_et_naive(idx)
        if start <= dt < end:
            try:
                bars.append({"ts": dt, "close": float(row["close"]),
                             "volume": float(row.get("volume") or 0)})
            except Exception:
                continue
    bars.sort(key=lambda b: b["ts"])
    _cache[key] = {"ts": time.time(), "bars": bars}
    return bars
