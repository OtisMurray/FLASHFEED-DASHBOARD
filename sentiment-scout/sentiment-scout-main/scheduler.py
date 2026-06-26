"""
Sentiment Scout Scheduler
─────────────────────────
Runs the full screener pipeline on a market-aware schedule:
  • Market hours  (Mon–Fri 9:30–16:00 ET) → every  5 minutes
  • Outside hours (evenings, weekends)     → every 15 minutes

Usage
  python scheduler.py            # normal daemon mode
  python scheduler.py --demo 2   # run N cycles immediately with short intervals, then exit
"""

import argparse
import json
import sys
import time
import threading
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

import sentiment_screener
import multicap_screener

# ─── CONFIG ───────────────────────────────────────────────────────────────────
LOG_FILE          = Path(__file__).parent / "scheduler_log.txt"
ET                = ZoneInfo("America/New_York")
MARKET_OPEN       = (9, 30)    # inclusive
MARKET_CLOSE      = (16, 0)    # exclusive
MARKET_DAYS       = {0, 1, 2, 3, 4}   # Mon=0 … Fri=4
INTERVAL_MARKET   = 5          # minutes during market hours
INTERVAL_OFF      = 15         # minutes outside market hours
POLL_SECONDS      = 5 * 60     # job fires every 5 min; off-hours skipped internally
STATUS_REFRESH    = 5          # seconds between status-line redraws
# ──────────────────────────────────────────────────────────────────────────────

# ─── SHARED STATE (written by job thread, read by status thread) ──────────────
_state: dict = {
    "last_run_local": None,      # datetime (ET) of last completed cycle
    "last_run_utc":   None,      # datetime (UTC) of last completed cycle
    "next_run_local": None,      # datetime (ET) — estimated
    "total_cycles":   0,
    "last_status":    "—",
    "last_tickers":   [],
    "last_duration":  None,
    "lock":           threading.Lock(),
}
_stop_status = threading.Event()


# ─── MARKET HOURS HELPERS ─────────────────────────────────────────────────────

def _now_et() -> datetime:
    return datetime.now(ET)


def is_market_hours(dt: datetime | None = None) -> bool:
    if dt is None:
        dt = _now_et()
    if dt.weekday() not in MARKET_DAYS:
        return False
    t = (dt.hour, dt.minute)
    return MARKET_OPEN <= t < MARKET_CLOSE


def _expected_interval_min(dt: datetime | None = None) -> int:
    return INTERVAL_MARKET if is_market_hours(dt) else INTERVAL_OFF


def _estimate_next_run(from_dt: datetime) -> datetime:
    from datetime import timedelta
    delta = _expected_interval_min(from_dt)
    return from_dt + timedelta(minutes=delta)


# ─── LOGGING ──────────────────────────────────────────────────────────────────

def _log(entry: dict):
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


# ─── THE JOB ──────────────────────────────────────────────────────────────────

def _screener_job(demo_mode: bool = False):
    """
    Called by APScheduler every POLL_SECONDS.
    During market hours: always runs.
    Outside market hours: skips if last run was < INTERVAL_OFF minutes ago.
    """
    now_et  = _now_et()
    now_utc = datetime.now(timezone.utc)

    # Off-hours throttle
    if not demo_mode and not is_market_hours(now_et):
        with _state["lock"]:
            last = _state["last_run_local"]
        if last is not None:
            elapsed_min = (now_et - last).total_seconds() / 60
            if elapsed_min < INTERVAL_OFF:
                # Update next-run estimate and silently skip
                with _state["lock"]:
                    _state["next_run_local"] = _estimate_next_run(last)
                return

    with _state["lock"]:
        _state["total_cycles"] += 1
        cycle = _state["total_cycles"]

    session_label = "MARKET" if is_market_hours(now_et) else "OFF-HRS"
    print(f"\n{'━'*60}")
    print(f"  CYCLE {cycle}  [{session_label}]  {now_et.strftime('%Y-%m-%d %H:%M:%S %Z')}")
    print(f"{'━'*60}\n")

    start_utc = datetime.now(timezone.utc)
    log_entry = {
        "cycle":        cycle,
        "start_time":   start_utc.isoformat(),
        "market_hours": is_market_hours(now_et),
        "tickers":      [],
        "count":        0,
        "run_id":       None,
        "success":      False,
        "error":        None,
        "duration_sec": 0,
    }

    try:
        result = sentiment_screener.run_pipeline()
        log_entry["tickers"]  = result.get("tickers", [])
        log_entry["count"]    = result.get("count", 0)
        log_entry["run_id"]   = result.get("run_id")
        log_entry["success"]  = result.get("success", False)
        if result.get("error"):
            log_entry["error"] = result["error"]
        status_str = (
            f"✓ {log_entry['count']} tickers: {', '.join(log_entry['tickers'])}"
            if log_entry["success"]
            else f"✗ {result.get('error', 'unknown error')}"
        )
    except Exception as exc:
        log_entry["error"] = str(exc)
        status_str = f"✗ EXCEPTION: {exc}"
        print(f"\n  [ERROR] Cycle {cycle} raised an exception: {exc}\n")

    end_utc = datetime.now(timezone.utc)
    duration = round((end_utc - start_utc).total_seconds(), 1)
    log_entry["duration_sec"] = duration

    _log(log_entry)

    next_et = _estimate_next_run(_now_et())
    with _state["lock"]:
        _state["last_run_local"]  = now_et
        _state["last_run_utc"]    = now_utc
        _state["next_run_local"]  = next_et
        _state["last_status"]     = status_str
        _state["last_tickers"]    = log_entry["tickers"]
        _state["last_duration"]   = duration

    print(f"\n  ↳ Cycle {cycle} complete in {duration}s  |  {status_str}")
    print(f"  ↳ Logged to {LOG_FILE.name}")
    print(f"  ↳ Next run ~{next_et.strftime('%H:%M:%S %Z')}\n")


# ─── STATUS LINE (background thread) ─────────────────────────────────────────

def _status_thread_fn():
    """Reprints a compact status block every STATUS_REFRESH seconds."""
    while not _stop_status.wait(STATUS_REFRESH):
        _print_status()


def _print_status():
    with _state["lock"]:
        last_local  = _state["last_run_local"]
        next_local  = _state["next_run_local"]
        total       = _state["total_cycles"]
        status      = _state["last_status"]
        duration    = _state["last_duration"]

    last_str  = last_local.strftime("%H:%M:%S %Z") if last_local  else "—"
    next_str  = next_local.strftime("%H:%M:%S %Z") if next_local  else "—"
    dur_str   = f"  ({duration}s)" if duration else ""
    session   = "MARKET HOURS" if is_market_hours() else "OFF-HOURS"
    interval  = _expected_interval_min()

    lines = [
        "",
        "┌─ Sentiment Scout Scheduler ─────────────────────────────┐",
        f"│  Session    : {session:<43}│",
        f"│  Interval   : every {interval} min{'':<38}│",
        f"│  Last run   : {last_str:<43}│",
        f"│  Last result: {status[:43]:<43}│",
        f"│  Next run   : {next_str}{dur_str:<34}│",
        f"│  Total cycles: {total:<42}│",
        "└─────────────────────────────────────────────────────────┘",
        "  Press Ctrl+C to stop",
        "",
    ]
    print("\n".join(lines), flush=True)


# ─── DEMO MODE ────────────────────────────────────────────────────────────────

def _run_demo(cycles: int):
    """Run N cycles back-to-back with a 10-second pause between them, then exit."""
    print(f"\n{'━'*60}")
    print(f"  DEMO MODE  —  running {cycles} cycle(s) then exiting")
    print(f"{'━'*60}")

    for i in range(cycles):
        _screener_job(demo_mode=True)
        if i < cycles - 1:
            print(f"\n  [demo] Waiting 10 seconds before cycle {i+2}…\n")
            time.sleep(10)

    print(f"\n  Demo complete.  Log → {LOG_FILE}")
    _print_status()


# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Sentiment Scout Scheduler")
    parser.add_argument(
        "--demo", type=int, metavar="N",
        help="Run N pipeline cycles immediately (no interval), then exit"
    )
    args = parser.parse_args()

    print(f"\n{'━'*60}")
    print("  SENTIMENT SCOUT  —  Scheduler starting")
    print(f"  Market hours : Mon–Fri {MARKET_OPEN[0]:02d}:{MARKET_OPEN[1]:02d}–"
          f"{MARKET_CLOSE[0]:02d}:{MARKET_CLOSE[1]:02d} ET  →  every {INTERVAL_MARKET} min")
    print(f"  Off-hours    : every {INTERVAL_OFF} min")
    print(f"  Log file     : {LOG_FILE}")
    print(f"{'━'*60}\n")

    if args.demo:
        _run_demo(args.demo)
        return

    # ── Normal daemon mode ────────────────────────────────────────────────────
    scheduler = BackgroundScheduler(timezone=str(ET))
    scheduler.add_job(
        _screener_job,
        trigger=IntervalTrigger(seconds=POLL_SECONDS),
        id="screener",
        name="Sentiment Screener",
        max_instances=1,           # never overlap
        misfire_grace_time=60,     # tolerate up to 1-min late fire
        next_run_time=datetime.now(ET),  # fire immediately on start
    )
    scheduler.add_job(
        multicap_screener.run_multicap_screener,
        trigger=IntervalTrigger(seconds=60),
        id="multicap",
        name="Multicap Screener",
        max_instances=1,
        misfire_grace_time=30,
        next_run_time=datetime.now(ET),
    )

    # Seed next-run estimate
    with _state["lock"]:
        _state["next_run_local"] = _estimate_next_run(_now_et())

    # Start status-line thread
    st = threading.Thread(target=_status_thread_fn, daemon=True)
    st.start()

    scheduler.start()
    print("  Scheduler running. First cycle fires immediately.\n")

    try:
        while True:
            time.sleep(1)
    except (KeyboardInterrupt, SystemExit):
        print("\n\n  Shutting down scheduler…")
        _stop_status.set()
        scheduler.shutdown(wait=False)
        print("  Done. Goodbye.\n")
        sys.exit(0)


if __name__ == "__main__":
    main()
