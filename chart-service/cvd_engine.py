"""CVD calculations used by the native FlashFeed CVD view.

Bar-only feeds cannot reveal the true aggressor side of each trade.  This
module therefore keeps two estimates separate:

* BVC: probabilistic split from standardized close-to-close movement.
* Wick: directional OHLC split, retained as a transparent comparison.

When measured IBKR tick deltas are available, callers can pass them through
``merge_measured_minutes``.  The response always carries provenance so an
estimate is never presented as measured order flow.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from math import erf, isfinite, sqrt
from statistics import median, stdev
from zoneinfo import ZoneInfo


SIGMA_WINDOW = 50
SIGMA_MIN_PERIODS = 10
ET = ZoneInfo("America/New_York")

DEFAULT_SIGNAL_POLICY = {
    "window_minutes": 30,
    "flow_threshold_pct": 8.0,
    "price_threshold_pct": 0.15,
    "divergence_price_threshold_pct": 0.25,
    "agreement_threshold": 0.55,
    "reliability_threshold": 0.42,
    "opening_no_entry_minutes": 15,
    "opening_caution_minutes": 30,
    "opening_caution_multiplier": 1.35,
    "event_cooldown_minutes": 15,
}


def _number(value, default=0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if isfinite(result) else default


def _minute_epoch(value) -> int | None:
    """Normalize an epoch/datetime/string to a minute epoch."""
    if isinstance(value, (int, float)):
        return int(value) // 60 * 60
    if isinstance(value, datetime):
        dt = value
    else:
        try:
            dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp()) // 60 * 60


def _rolling_sample_std(values: list[float | None], index: int) -> float | None:
    start = max(0, index - SIGMA_WINDOW + 1)
    window = [v for v in values[start:index + 1] if v is not None and isfinite(v)]
    if len(window) >= SIGMA_MIN_PERIODS:
        return stdev(window)
    expanding = [v for v in values[:index + 1] if v is not None and isfinite(v)]
    if len(expanding) >= 2:
        return stdev(expanding)
    return None


def _auction_minutes(candles: list[dict]) -> set[int]:
    """Conservatively flag oversized closing-cross bars.

    FinViz bars do not include exchange condition codes, so this is only a
    fallback heuristic.  Measured tick documents can explicitly set
    ``is_auction`` and bypass it.
    """
    volumes = [_number(row.get("volume")) for row in candles]
    positive = [v for v in volumes if v > 0]
    baseline = median(positive) if positive else 0.0
    if baseline <= 0:
        return set()

    flagged: set[int] = set()
    for row, volume in zip(candles, volumes):
        epoch = _minute_epoch(row.get("time"))
        if epoch is None:
            continue
        wall_clock = datetime.fromtimestamp(epoch, tz=timezone.utc)
        near_close = (wall_clock.hour == 15 and wall_clock.minute >= 58) or (
            wall_clock.hour == 16 and wall_clock.minute <= 1
        )
        if near_close and volume >= baseline * 6.0:
            flagged.add(epoch)
    return flagged


def compute_bar_cvd(candles: list[dict]) -> dict:
    """Compute BVC and wick CVD estimates for sorted one-minute candles."""
    rows = sorted(candles or [], key=lambda row: _number(row.get("time")))
    closes = [_number(row.get("close")) for row in rows]
    changes: list[float | None] = [None]
    changes.extend(closes[i] - closes[i - 1] for i in range(1, len(closes)))
    auctions = _auction_minutes(rows)

    cvd_bvc = 0.0
    cvd_wick = 0.0
    output = []
    for index, row in enumerate(rows):
        epoch = _minute_epoch(row.get("time"))
        if epoch is None:
            continue
        volume = max(0.0, _number(row.get("volume")))
        price_range = _number(row.get("high")) - _number(row.get("low"))
        direction = _number(row.get("close")) - _number(row.get("open"))
        wick_delta = volume * direction / price_range if price_range > 0 else 0.0

        # Expanding/rolling volatility is intentionally causal.  A completed-
        # session fallback would leak later returns into the opening bars.
        sigma = _rolling_sample_std(changes, index)
        change = changes[index]
        if change is None or sigma is None or sigma <= 0:
            buy_fraction = 0.5
        else:
            buy_fraction = 0.5 * (1.0 + erf((change / sigma) / sqrt(2.0)))
            buy_fraction = min(1.0, max(0.0, buy_fraction))
        buy_bvc = volume * buy_fraction
        bvc_delta = buy_bvc - (volume - buy_bvc)

        is_auction = epoch in auctions
        if is_auction:
            wick_delta = 0.0
            bvc_delta = 0.0
        cvd_bvc += bvc_delta
        cvd_wick += wick_delta

        output.append({
            "time": epoch,
            "volume": volume,
            "delta_bvc": round(bvc_delta, 6),
            "delta_wick": round(wick_delta, 6),
            "cvd_bvc": round(cvd_bvc, 6),
            "cvd_wick": round(cvd_wick, 6),
            "is_auction": is_auction,
        })

    return {"rows": output, "auction_minutes": sorted(auctions)}


def aggregate_measured_ticks(ticks: list[dict]) -> dict[int, dict]:
    """Aggregate already classified trade ticks into one-minute CVD inputs."""
    buckets: dict[int, dict] = defaultdict(
        lambda: {"buy": 0.0, "sell": 0.0, "delta": 0.0, "trades": 0, "auction": False}
    )
    for tick in sorted(ticks or [], key=lambda row: str(row.get("date", row.get("time", "")))):
        epoch = _minute_epoch(tick.get("time", tick.get("date")))
        if epoch is None:
            continue
        size = max(0.0, _number(tick.get("size", tick.get("volume"))))
        if size <= 0:
            continue
        delta = max(-size, min(size, _number(tick.get("delta"))))
        bucket = buckets[epoch]
        bucket["trades"] += max(1, int(_number(tick.get("trades"), 1)))
        conditions = str(tick.get("cond", tick.get("special_conditions", "")) or "")
        condition_tokens = {
            token.strip()
            for comma_group in conditions.split(",")
            for token in comma_group.split()
            if token.strip()
        }
        bucket["auction"] = (
            bucket["auction"]
            or bool(tick.get("is_auction"))
            or bool(condition_tokens & {"6", "M"})
        )
        if delta > 0:
            bucket["buy"] += size
        elif delta < 0:
            bucket["sell"] += size
        else:
            bucket["buy"] += size / 2.0
            bucket["sell"] += size / 2.0
        bucket["delta"] += delta
    return dict(buckets)


def merge_measured_minutes(estimated_rows: list[dict], ticks: list[dict]) -> dict:
    """Overlay measured minute deltas and return a provenance-aware best line."""
    measured = aggregate_measured_ticks(ticks)
    best_cvd = 0.0
    output = []
    measured_minutes = 0
    for row in estimated_rows:
        epoch = row["time"]
        bucket = measured.get(epoch)
        if bucket and bucket["trades"] > 0:
            delta = 0.0 if bucket["auction"] else bucket["delta"]
            measured_minutes += 1
            quality = "measured"
            delta_best = delta
        else:
            quality = "estimated_bvc"
            delta_best = row["delta_bvc"]
        best_cvd += delta_best
        output.append({
            **row,
            "delta_best": round(delta_best, 6),
            "cvd_best": round(best_cvd, 6),
            "quality": quality,
            "measured_trades": int(bucket["trades"]) if bucket else 0,
        })
    return {"rows": output, "measured_minutes": measured_minutes}


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return min(high, max(low, value))


def _market_clock(epoch: int, timestamp_mode: str) -> datetime:
    """Return exchange wall-clock time for either supported timestamp contract."""
    dt = datetime.fromtimestamp(epoch, tz=timezone.utc)
    if timestamp_mode == "utc":
        return dt.astimezone(ET)
    if timestamp_mode != "et_wall_clock":
        raise ValueError("timestamp_mode must be 'utc' or 'et_wall_clock'")
    return dt


def market_session_phase(epoch: int, timestamp_mode: str = "utc") -> str:
    clock = _market_clock(epoch, timestamp_mode)
    minute = clock.hour * 60 + clock.minute
    if minute < 9 * 60 + 30:
        return "premarket"
    if minute < 9 * 60 + 45:
        return "opening_noise"
    if minute < 10 * 60:
        return "opening_caution"
    if minute < 16 * 60:
        return "regular"
    return "afterhours"


def _point_method_agreement(row: dict) -> float:
    """Volume-bounded agreement between the two independent bar estimators."""
    volume = max(0.0, _number(row.get("volume")))
    if volume <= 0:
        return 0.0
    bvc = _number(row.get("delta_bvc"))
    wick = _number(row.get("delta_wick"))
    magnitude_similarity = _clamp(1.0 - abs(bvc - wick) / (2.0 * volume))
    quiet = max(abs(bvc), abs(wick)) <= volume * 0.02
    direction_match = 1.0 if quiet or bvc == 0 or wick == 0 or (bvc > 0) == (wick > 0) else 0.0
    return 0.65 * magnitude_similarity + 0.35 * direction_match


def compute_cvd_features(
    candles: list[dict],
    rows: list[dict],
    window_minutes: int = 30,
    timestamp_mode: str = "utc",
) -> list[dict]:
    """Add causal, volume-normalized CVD features without assigning signals."""
    candle_by_time = {
        _minute_epoch(candle.get("time")): candle
        for candle in candles or []
        if _minute_epoch(candle.get("time")) is not None
    }
    ordered = sorted((dict(row) for row in rows or []), key=lambda row: _number(row.get("time")))
    if not ordered:
        return []

    volumes = [max(0.0, _number(row.get("volume"))) for row in ordered]
    deltas = [_number(row.get("delta_best")) for row in ordered]
    agreements = [_point_method_agreement(row) for row in ordered]
    measured = [1 if row.get("quality") == "measured" else 0 for row in ordered]
    closes = [_number(candle_by_time.get(int(row["time"]), {}).get("close")) for row in ordered]

    def prefix(values):
        result = [0.0]
        for value in values:
            result.append(result[-1] + value)
        return result

    volume_prefix = prefix(volumes)
    delta_prefix = prefix(deltas)
    agreement_prefix = prefix([agreement * volume for agreement, volume in zip(agreements, volumes)])
    measured_prefix = prefix(measured)
    cumulative_volume = 0.0
    start = 0
    output = []
    window_seconds = max(1, int(window_minutes)) * 60

    for index, row in enumerate(ordered):
        epoch = int(row["time"])
        while start < index and int(ordered[start]["time"]) < epoch - window_seconds:
            start += 1
        cumulative_volume += volumes[index]
        window_volume = volume_prefix[index + 1] - volume_prefix[start]
        window_delta = delta_prefix[index + 1] - delta_prefix[start]
        weighted_agreement = agreement_prefix[index + 1] - agreement_prefix[start]
        sample_count = index - start + 1
        measured_count = int(measured_prefix[index + 1] - measured_prefix[start])
        measured_coverage = measured_count / sample_count if sample_count else 0.0
        agreement = weighted_agreement / window_volume if window_volume > 0 else 0.0
        flow_imbalance = 100.0 * window_delta / window_volume if window_volume > 0 else 0.0
        normalized_cvd = (
            100.0 * _number(row.get("cvd_best")) / cumulative_volume
            if cumulative_volume > 0 else 0.0
        )
        start_close = closes[start]
        end_close = closes[index]
        price_return = (
            100.0 * (end_close / start_close - 1.0)
            if start_close > 0 and end_close > 0 else 0.0
        )
        source_factor = 0.65 + 0.33 * measured_coverage
        sample_factor = _clamp(sample_count / 6.0)
        reliability = source_factor * (0.55 + 0.45 * agreement) * sample_factor
        output.append({
            **row,
            "close": round(end_close, 6) if end_close > 0 else None,
            "cumulative_volume": round(cumulative_volume, 6),
            "normalized_cvd_pct": round(normalized_cvd, 4),
            "flow_imbalance_pct": round(flow_imbalance, 4),
            "window_price_return_pct": round(price_return, 4),
            "method_agreement": round(agreement, 4),
            "reliability": round(_clamp(reliability), 4),
            "window_measured_coverage": round(measured_coverage, 4),
            "window_samples": sample_count,
            "window_minutes": int(window_minutes),
            "session_phase": market_session_phase(epoch, timestamp_mode),
        })
    return output


def classify_cvd_feature(row: dict, policy: dict | None = None) -> dict:
    """Classify one already-computed feature row with conservative gates."""
    config = {**DEFAULT_SIGNAL_POLICY, **(policy or {})}
    phase = row.get("session_phase", "regular")
    multiplier = config["opening_caution_multiplier"] if phase == "opening_caution" else 1.0
    flow_gate = float(config["flow_threshold_pct"]) * multiplier
    price_gate = float(config["price_threshold_pct"]) * multiplier
    divergence_price_gate = float(config["divergence_price_threshold_pct"]) * multiplier
    flow = _number(row.get("flow_imbalance_pct"))
    price = _number(row.get("window_price_return_pct"))
    agreement = _number(row.get("method_agreement"))
    reliability = _number(row.get("reliability"))
    enough_data = int(row.get("window_samples") or 0) >= 6 and _number(row.get("cumulative_volume")) > 0
    quality_ok = (
        agreement >= float(config["agreement_threshold"])
        and reliability >= float(config["reliability_threshold"])
    )
    phase_ok = phase in {"regular", "opening_caution"}

    signal = "neutral"
    direction = 0
    reason = "No confirmed order-flow edge."
    if not enough_data:
        reason = "Waiting for enough session bars."
    elif phase in {"premarket", "afterhours"}:
        signal = "observe_only"
        reason = "Extended-hours flow is displayed but not used for entry confirmation."
    elif phase == "opening_noise":
        signal = "opening_noise_guard"
        reason = "Opening auction and spread noise block entry confirmation for the first 15 minutes."
    elif not quality_ok:
        signal = "low_confidence"
        reason = "The independent CVD estimates do not agree strongly enough."
    elif price >= price_gate and flow >= flow_gate:
        signal, direction = "buying_confirmation", 1
        reason = "Price and estimated aggressive-buying pressure are aligned; predictive value is not validated."
    elif price <= -price_gate and flow <= -flow_gate:
        signal, direction = "selling_confirmation", -1
        reason = "Price and estimated aggressive-selling pressure are aligned; predictive value is not validated."
    elif price <= -divergence_price_gate and flow >= flow_gate:
        signal, direction = "bullish_divergence", 1
        reason = "Price is falling while estimated buying pressure improves."
    elif price >= divergence_price_gate and flow <= -flow_gate:
        signal, direction = "bearish_divergence", -1
        reason = "Price is rising while estimated selling pressure strengthens."

    strength = min(1.0, abs(flow) / max(1.0, flow_gate * 2.0))
    signal_confidence = reliability * (0.55 + 0.45 * strength) if direction else reliability * 0.5
    if row.get("quality") != "measured":
        signal_confidence = min(signal_confidence, 0.70)
    return {
        **row,
        "signal": signal,
        "signal_direction": direction,
        "entry_confirmation": False,
        "exit_warning": signal in {"selling_confirmation", "bearish_divergence"},
        "signal_confidence": round(_clamp(signal_confidence), 4),
        "signal_reason": reason,
        "signal_eligible": bool(enough_data and quality_ok and phase_ok),
        "ranking_eligible": False,
        "flow_gate_pct": round(flow_gate, 4),
        "price_gate_pct": round(price_gate, 4),
    }


def analyze_cvd_rows(
    candles: list[dict],
    rows: list[dict],
    window_minutes: int = 30,
    timestamp_mode: str = "utc",
    policy: dict | None = None,
) -> list[dict]:
    config = {**DEFAULT_SIGNAL_POLICY, **(policy or {}), "window_minutes": int(window_minutes)}
    features = compute_cvd_features(candles, rows, window_minutes, timestamp_mode)
    return [classify_cvd_feature(row, config) for row in features]


def cvd_signal_events(rows: list[dict], cooldown_minutes: int = 15) -> list[dict]:
    """Deduplicate research signals so adjacent bars do not look like new calls."""
    events = []
    last_by_signal: dict[str, int] = {}
    allowed = {
        "buying_confirmation", "selling_confirmation",
        "bullish_divergence", "bearish_divergence",
    }
    cooldown = max(1, int(cooldown_minutes)) * 60
    for row in rows or []:
        signal = row.get("signal")
        if signal not in allowed:
            continue
        epoch = int(row.get("time") or 0)
        if epoch - last_by_signal.get(signal, -10**18) < cooldown:
            continue
        last_by_signal[signal] = epoch
        events.append({
            key: row.get(key)
            for key in (
                "time", "signal", "signal_direction", "signal_confidence", "signal_reason",
                "flow_imbalance_pct", "window_price_return_pct", "normalized_cvd_pct",
                "method_agreement", "reliability", "session_phase", "quality", "close",
            )
        })
    return events


def summarize_cvd(rows: list[dict], events: list[dict]) -> dict:
    latest = rows[-1] if rows else {}
    counts = defaultdict(int)
    for event in events or []:
        counts[event.get("signal", "unknown")] += 1
    return {
        "latest_signal": latest.get("signal", "neutral"),
        "latest_reason": latest.get("signal_reason", "No CVD data."),
        "latest_confidence": latest.get("signal_confidence", 0.0),
        "normalized_cvd_pct": latest.get("normalized_cvd_pct", 0.0),
        "flow_imbalance_pct": latest.get("flow_imbalance_pct", 0.0),
        "method_agreement": latest.get("method_agreement", 0.0),
        "reliability": latest.get("reliability", 0.0),
        "session_phase": latest.get("session_phase"),
        "event_counts": dict(counts),
        "research_only": True,
    }


def merge_liquidity_walls(levels: list[dict], adjacency: float) -> list[dict]:
    """Merge nearby L2 levels without ever combining opposite book sides."""
    result = []
    for side in ("support", "resistance"):
        side_levels = sorted(
            (row for row in levels if row.get("side") == side),
            key=lambda row: _number(row.get("price")),
        )
        run = []
        for level in side_levels:
            if run and _number(level.get("price")) - _number(run[-1].get("price")) > adjacency:
                result.append(max(run, key=lambda row: _number(row.get("score"))))
                run = []
            run.append(level)
        if run:
            result.append(max(run, key=lambda row: _number(row.get("score"))))
    return result
