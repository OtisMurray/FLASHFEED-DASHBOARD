"""Causal historical validation for FlashFeed's estimated CVD signals.

This is a research harness, not a production trading engine.  It tunes only on
chronologically earlier sessions and reports final metrics on later, untouched
sessions.  Estimated bar CVD is compared with price-only momentum and session
buy-and-hold baselines so a visually convincing CVD line is never mistaken for
incremental predictive value.
"""

from __future__ import annotations

import argparse
import json
import os
import random
from collections import defaultdict, namedtuple
from datetime import datetime, timezone
from itertools import product
from statistics import mean, median
from zoneinfo import ZoneInfo

from cvd_engine import (
    DEFAULT_SIGNAL_POLICY,
    compute_bar_cvd,
    compute_cvd_features,
    merge_measured_minutes,
)


ET = ZoneInfo("America/New_York")
ROUND_TRIP_COST_BPS = 10.0
Feature = namedtuple(
    "Feature",
    "time close phase samples cumulative_volume price_return flow agreement reliability quality",
)


def _number(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _clock(epoch):
    return datetime.fromtimestamp(int(epoch), tz=timezone.utc).astimezone(ET)


def _session_key(epoch):
    return _clock(epoch).date().isoformat()


def normalize_bar(document):
    epoch = int(document.get("minute") or 0)
    return {
        "time": epoch,
        "open": _number(document.get("open")),
        "high": _number(document.get("high")),
        "low": _number(document.get("low")),
        "close": _number(document.get("close", document.get("price"))),
        "volume": max(0.0, _number(document.get("volume"))),
    }


def build_sessions(documents, min_bars=40):
    grouped = defaultdict(list)
    for document in documents:
        ticker = str(document.get("ticker") or "").upper()
        bar = normalize_bar(document)
        clock = _clock(bar["time"])
        if not ticker or not bar["time"] or bar["close"] <= 0:
            continue
        minute = clock.hour * 60 + clock.minute
        if clock.weekday() >= 5 or not (9 * 60 + 30 <= minute <= 16 * 60):
            continue
        grouped[(ticker, clock.date().isoformat())].append(bar)
    sessions = []
    for (ticker, date), bars in grouped.items():
        ordered = sorted({bar["time"]: bar for bar in bars}.values(), key=lambda row: row["time"])
        if len(ordered) < min_bars:
            continue
        sessions.append({"ticker": ticker, "date": date, "candles": ordered})
    return sorted(sessions, key=lambda row: (row["date"], row["ticker"]))


def enrich_sessions(sessions, windows=(15, 30, 60)):
    enriched = []
    for session in sessions:
        estimates = compute_bar_cvd(session["candles"])["rows"]
        merged = merge_measured_minutes(estimates, [])["rows"]
        analyses = {}
        for window in windows:
            features = compute_cvd_features(
                session["candles"], merged, int(window), timestamp_mode="utc"
            )
            analyses[int(window)] = [Feature(
                int(row.get("time") or 0), _number(row.get("close")),
                row.get("session_phase"), int(row.get("window_samples") or 0),
                _number(row.get("cumulative_volume")),
                _number(row.get("window_price_return_pct")),
                _number(row.get("flow_imbalance_pct")),
                _number(row.get("method_agreement")), _number(row.get("reliability")),
                row.get("quality"),
            ) for row in features]
        candles = session["candles"]
        buy_hold = (
            100.0 * (candles[-1]["close"] / candles[0]["open"] - 1.0)
            if len(candles) >= 2 and candles[0]["open"] > 0 else None
        )
        enriched.append({
            "ticker": session["ticker"], "date": session["date"],
            "analysis": analyses, "buy_hold_return": buy_hold,
        })
    return enriched


def _future_return(rows, index, horizon_minutes):
    start = rows[index]
    start_price = start.close
    target_time = start.time + int(horizon_minutes) * 60
    if start_price <= 0:
        return None
    target = None
    for row in rows[index + 1:]:
        target = row
        if row.time >= target_time:
            break
    if not target or target.time < target_time:
        return None
    end_price = target.close
    return 100.0 * (end_price / start_price - 1.0) if end_price > 0 else None


def _metric(returns, cost_bps=ROUND_TRIP_COST_BPS):
    clean = [float(value) for value in returns if value is not None]
    cost = float(cost_bps) / 100.0
    net = [value - cost for value in clean]
    if not clean:
        return {
            "n": 0, "gross_mean_pct": None, "net_mean_pct": None,
            "median_pct": None, "hit_rate_pct": None,
            "total_equal_weighted_net_pct": None,
        }
    return {
        "n": len(clean),
        "gross_mean_pct": round(mean(clean), 4),
        "net_mean_pct": round(mean(net), 4),
        "median_pct": round(median(net), 4),
        "hit_rate_pct": round(100.0 * sum(value > 0 for value in net) / len(net), 2),
        "total_equal_weighted_net_pct": round(sum(net), 4),
    }


def _bootstrap_mean_ci(values, iterations=1000, seed=495):
    clean = [float(value) for value in values if value is not None]
    if len(clean) < 2:
        return [None, None]
    rng = random.Random(seed)
    size = len(clean)
    samples = sorted(
        mean(clean[rng.randrange(size)] for _ in range(size))
        for _ in range(iterations)
    )
    return [round(samples[int(iterations * 0.025)], 4), round(samples[int(iterations * 0.975)], 4)]


def _eligible(row, policy, side="cvd"):
    phase = row.phase
    if phase not in {"opening_caution", "regular"}:
        return False
    multiplier = policy["opening_caution_multiplier"] if phase == "opening_caution" else 1.0
    price_gate = policy["price_threshold_pct"] * multiplier
    if row.samples < 6 or row.cumulative_volume <= 0:
        return False
    if row.price_return < price_gate:
        return False
    if side == "price":
        return True
    return (
        row.flow >= policy["flow_threshold_pct"] * multiplier
        and row.agreement >= policy["agreement_threshold"]
        and row.reliability >= policy["reliability_threshold"]
    )


def _session_event_returns(session, policy, horizon_minutes=30, side="cvd"):
    results = []
    cooldown = int(policy.get("event_cooldown_minutes", 15)) * 60
    window = int(policy["window_minutes"])
    rows = session["analysis"][window]
    last_event = -10**18
    for index, row in enumerate(rows):
        epoch = row.time
        if epoch - last_event < cooldown or not _eligible(row, policy, side):
            continue
        future = _future_return(rows, index, horizon_minutes)
        if future is None:
            continue
        last_event = epoch
        results.append(future)
    return results


def event_returns(sessions, policy, horizon_minutes=30, side="cvd"):
    return [
        value
        for session in sessions
        for value in _session_event_returns(session, policy, horizon_minutes, side)
    ]


def paired_session_incremental(sessions, policy, horizon_minutes=30, bootstrap=True):
    """Compare methods within the same ticker-session to avoid pseudo-replication."""
    differences = []
    cvd_session_means = []
    price_session_means = []
    for session in sessions:
        cvd = _session_event_returns(session, policy, horizon_minutes, "cvd")
        price = _session_event_returns(session, policy, horizon_minutes, "price")
        if not cvd or not price:
            continue
        cvd_mean, price_mean = mean(cvd), mean(price)
        cvd_session_means.append(cvd_mean)
        price_session_means.append(price_mean)
        differences.append(cvd_mean - price_mean)
    metric = _metric(differences, cost_bps=0)
    metric["mean_lift_95pct_cluster_bootstrap_ci"] = (
        _bootstrap_mean_ci(differences) if bootstrap else [None, None]
    )
    metric["sessions_with_positive_lift_pct"] = (
        round(100.0 * sum(value > 0 for value in differences) / len(differences), 2)
        if differences else None
    )
    metric["cvd_session_mean"] = _metric(cvd_session_means)
    metric["price_session_mean"] = _metric(price_session_means)
    return metric


def divergence_returns(sessions, policy, horizon_minutes=30, direction=1):
    results = []
    cooldown = int(policy.get("event_cooldown_minutes", 15)) * 60
    window = int(policy["window_minutes"])
    for session in sessions:
        rows = session["analysis"][window]
        last_event = -10**18
        for index, row in enumerate(rows):
            epoch = row.time
            phase = row.phase
            multiplier = policy["opening_caution_multiplier"] if phase == "opening_caution" else 1.0
            quality_ok = (
                row.samples >= 6 and row.cumulative_volume > 0
                and row.agreement >= policy["agreement_threshold"]
                and row.reliability >= policy["reliability_threshold"]
            )
            flow_gate = policy["flow_threshold_pct"] * multiplier
            price_gate = policy["divergence_price_threshold_pct"] * multiplier
            is_divergence = (
                phase in {"opening_caution", "regular"} and quality_ok
                and (
                    (direction > 0 and row.price_return <= -price_gate and row.flow >= flow_gate)
                    or (direction < 0 and row.price_return >= price_gate and row.flow <= -flow_gate)
                )
            )
            if not is_divergence or epoch - last_event < cooldown:
                continue
            future = _future_return(rows, index, horizon_minutes)
            if future is None:
                continue
            last_event = epoch
            results.append(future * direction)
    return results


def session_buy_hold_returns(sessions):
    return [row["buy_hold_return"] for row in sessions if row.get("buy_hold_return") is not None]


def evaluate_policy(sessions, policy, horizons=(15, 30, 60)):
    forward = {}
    for horizon in horizons:
        cvd = _metric(event_returns(sessions, policy, horizon, "cvd"))
        price = _metric(event_returns(sessions, policy, horizon, "price"))
        if cvd["net_mean_pct"] is not None and price["net_mean_pct"] is not None:
            lift = round(cvd["net_mean_pct"] - price["net_mean_pct"], 4)
            hit_lift = round(cvd["hit_rate_pct"] - price["hit_rate_pct"], 2)
        else:
            lift = hit_lift = None
        forward[str(horizon)] = {
            "cvd_confirmation": cvd,
            "price_only_momentum": price,
            "incremental_net_mean_pct": lift,
            "incremental_hit_rate_points": hit_lift,
            "paired_session_incremental": paired_session_incremental(sessions, policy, horizon),
        }
    return {
        "forward_returns": forward,
        "bullish_divergence_30m": _metric(divergence_returns(sessions, policy, 30, 1)),
        "bearish_divergence_30m": _metric(divergence_returns(sessions, policy, 30, -1)),
        "session_buy_and_hold": _metric(session_buy_hold_returns(sessions)),
    }


def candidate_policies():
    for window, flow, price, agreement, reliability in product(
        (15, 30, 60), (6.0, 8.0, 10.0, 12.0), (0.10, 0.15, 0.25),
        (0.45, 0.55, 0.65), (0.38, 0.42),
    ):
        yield {
            **DEFAULT_SIGNAL_POLICY,
            "window_minutes": window,
            "flow_threshold_pct": flow,
            "price_threshold_pct": price,
            "agreement_threshold": agreement,
            "reliability_threshold": reliability,
        }


def select_policy(train_sessions, minimum_events=40):
    ranked = []
    for policy in candidate_policies():
        cvd = _metric(event_returns(train_sessions, policy, 30, "cvd"))
        if cvd["n"] < minimum_events:
            continue
        price = _metric(event_returns(train_sessions, policy, 30, "price"))
        if price["net_mean_pct"] is None:
            continue
        paired = paired_session_incremental(train_sessions, policy, 30, bootstrap=False)
        if paired["n"] < max(20, minimum_events // 2):
            continue
        lift = paired["net_mean_pct"]
        positive_sessions = paired["sessions_with_positive_lift_pct"]
        score = lift + (positive_sessions - 50.0) * 0.002 + min(paired["n"], 300) * 0.0001
        ranked.append((score, lift, positive_sessions, cvd["n"], paired["n"], policy))
    if not ranked:
        return dict(DEFAULT_SIGNAL_POLICY), []
    ranked.sort(key=lambda row: (row[0], row[4], row[3]), reverse=True)
    leaderboard = [
        {
            "selection_score": round(row[0], 4),
            "train_incremental_net_mean_pct": round(row[1], 4),
            "train_sessions_with_positive_lift_pct": round(row[2], 2),
            "train_cvd_events": row[3],
            "train_paired_sessions": row[4],
            "policy": row[5],
        }
        for row in ranked[:10]
    ]
    return ranked[0][5], leaderboard


def chronological_split(sessions, train_fraction=0.70):
    dates = sorted({session["date"] for session in sessions})
    if len(dates) < 4:
        raise ValueError("At least four trading dates are required for chronological validation")
    split = min(len(dates) - 1, max(1, int(len(dates) * train_fraction)))
    train_dates, holdout_dates = set(dates[:split]), set(dates[split:])
    return (
        [row for row in sessions if row["date"] in train_dates],
        [row for row in sessions if row["date"] in holdout_dates],
        dates[:split], dates[split:],
    )


def build_report(sessions, minimum_events=40, train_fraction=0.70):
    enriched = enrich_sessions(sessions)
    train, holdout, train_dates, holdout_dates = chronological_split(enriched, train_fraction)
    selected, leaderboard = select_policy(train, minimum_events)
    train_results = evaluate_policy(train, selected)
    holdout_results = evaluate_policy(holdout, selected)
    holdout_30 = holdout_results["forward_returns"]["30"]
    cvd_30 = holdout_30["cvd_confirmation"]
    price_30 = holdout_30["price_only_momentum"]
    paired_30 = holdout_30["paired_session_incremental"]
    paired_ci = paired_30["mean_lift_95pct_cluster_bootstrap_ci"]
    validated = bool(
        cvd_30["n"] >= minimum_events
        and holdout_30["incremental_net_mean_pct"] is not None
        and holdout_30["incremental_net_mean_pct"] > 0
        and holdout_30["incremental_hit_rate_points"] > 0
        and cvd_30["net_mean_pct"] > 0
        and paired_30["n"] >= max(20, minimum_events // 2)
        and paired_30["net_mean_pct"] > 0
        and paired_ci[0] is not None and paired_ci[0] > 0
    )
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": "holdout_incremental_value_confirmed" if validated else "research_only_not_validated",
        "ai_ranking_integration_allowed": validated,
        "data_contract": {
            "cvd_source": "estimated_from_ohlcv_bars",
            "bar_interval_seconds": 300,
            "signal_features_are_causal": True,
            "transaction_cost_bps_round_trip": ROUND_TRIP_COST_BPS,
            "limitations": [
                "Bar CVD estimates aggressor direction; it is not measured trade-side flow.",
                "Stored ticker coverage is availability-biased and is not a point-in-time full-market universe.",
                "The policy is selected on early dates only; later dates are untouched holdout data.",
            ],
        },
        "coverage": {
            "sessions": len(enriched),
            "tickers": len({row["ticker"] for row in enriched}),
            "trading_dates": len({row["date"] for row in enriched}),
            "train_dates": train_dates,
            "holdout_dates": holdout_dates,
            "train_sessions": len(train),
            "holdout_sessions": len(holdout),
            "train_fraction": train_fraction,
        },
        "selected_policy": selected,
        "train_leaderboard": leaderboard,
        "train_results": train_results,
        "untouched_holdout_results": holdout_results,
    }


def load_mongo_documents(uri, days=75, ticker_limit=150):
    from pymongo import MongoClient

    client = MongoClient(uri, serverSelectionTimeoutMS=5000)
    database = client.get_default_database() if client.get_default_database() is not None else client["feedflash"]
    collection = database["ohlcv_bars"]
    latest = collection.find_one(
        {"source": "yahoo_chart_ohlcv", "providerIntervalSec": 300},
        {"minute": 1}, sort=[("minute", -1)],
    )
    if not latest:
        raise RuntimeError("No five-minute yahoo_chart_ohlcv documents found")
    cutoff = int(latest["minute"]) - int(days) * 86400
    ticker_counts = collection.aggregate([
        {"$match": {
            "source": "yahoo_chart_ohlcv", "providerIntervalSec": 300,
            "minute": {"$gte": cutoff}, "volume": {"$gt": 0},
        }},
        {"$group": {"_id": "$ticker", "bars": {"$sum": 1}}},
        {"$sort": {"bars": -1, "_id": 1}},
        {"$limit": int(ticker_limit)},
    ], allowDiskUse=True)
    tickers = [row["_id"] for row in ticker_counts if row.get("_id")]
    documents = []
    projection = {
        "_id": 0, "ticker": 1, "minute": 1, "open": 1, "high": 1,
        "low": 1, "close": 1, "price": 1, "volume": 1,
    }
    for ticker in tickers:
        documents.extend(collection.find({
            "ticker": ticker,
            "source": "yahoo_chart_ohlcv",
            "providerIntervalSec": 300,
            "minute": {"$gte": cutoff},
        }, projection).sort("minute", 1))
    client.close()
    return documents


def load_mongo_sessions(uri, days=75, ticker_limit=150, min_bars=40):
    """Load and group one ticker at a time to keep broad replays memory-safe."""
    from pymongo import MongoClient

    client = MongoClient(uri, serverSelectionTimeoutMS=5000)
    database = client.get_default_database() if client.get_default_database() is not None else client["feedflash"]
    collection = database["ohlcv_bars"]
    latest = collection.find_one(
        {"source": "yahoo_chart_ohlcv", "providerIntervalSec": 300},
        {"minute": 1}, sort=[("minute", -1)],
    )
    if not latest:
        raise RuntimeError("No five-minute yahoo_chart_ohlcv documents found")
    cutoff = int(latest["minute"]) - int(days) * 86400
    ticker_counts = collection.aggregate([
        {"$match": {
            "source": "yahoo_chart_ohlcv", "providerIntervalSec": 300,
            "minute": {"$gte": cutoff}, "volume": {"$gt": 0},
        }},
        {"$group": {"_id": "$ticker", "bars": {"$sum": 1}}},
        {"$sort": {"bars": -1, "_id": 1}},
        {"$limit": int(ticker_limit)},
    ], allowDiskUse=True)
    tickers = [row["_id"] for row in ticker_counts if row.get("_id")]
    projection = {
        "_id": 0, "ticker": 1, "minute": 1, "open": 1, "high": 1,
        "low": 1, "close": 1, "price": 1, "volume": 1,
    }
    sessions = []
    for ticker in tickers:
        documents = list(collection.find({
            "ticker": ticker, "source": "yahoo_chart_ohlcv",
            "providerIntervalSec": 300, "minute": {"$gte": cutoff},
        }, projection).sort("minute", 1))
        sessions.extend(build_sessions(documents, min_bars))
    client.close()
    return sessions


def main():
    parser = argparse.ArgumentParser(description="Causal estimated-CVD backtest")
    parser.add_argument("--mongo-uri", default=os.getenv("MONGODB_URI", "mongodb://mongo:27017/feedflash"))
    parser.add_argument("--days", type=int, default=75)
    parser.add_argument("--tickers", type=int, default=150)
    parser.add_argument("--min-bars", type=int, default=40)
    parser.add_argument("--min-events", type=int, default=40)
    parser.add_argument("--train-fraction", type=float, default=0.70)
    parser.add_argument("--output", default="/tmp/cvd_backtest_report.json")
    args = parser.parse_args()
    sessions = load_mongo_sessions(args.mongo_uri, args.days, args.tickers, args.min_bars)
    if not 0.5 <= args.train_fraction <= 0.85:
        parser.error("--train-fraction must be between 0.5 and 0.85")
    report = build_report(sessions, args.min_events, args.train_fraction)
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(json.dumps({
        "output": args.output,
        "status": report["status"],
        "coverage": report["coverage"],
        "selected_policy": report["selected_policy"],
        "holdout_30m": report["untouched_holdout_results"]["forward_returns"]["30"],
    }, indent=2))


if __name__ == "__main__":
    main()
