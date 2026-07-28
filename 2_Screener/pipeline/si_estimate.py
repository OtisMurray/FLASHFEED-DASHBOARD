#!/usr/bin/env python3
"""
Live short-interest estimate, recomputed between FINRA settlement figures.

FINRA publishes official short interest twice a month, and it lands about nine
business days stale. Between those points the only daily signal is FINRA's
consolidated short-VOLUME file. This layers that volume on top of the last
official number:

    SI_est = SI_official + delta_since_settlement + delta_today

    delta_since_settlement = k * sum_over_days[ (SVR_d - B) * V_d ] / Float * 100
    delta_today            = k * (SVR_latest - B) * V_today / Float * 100

    SVR_d   short-volume ratio on day d (FINRA daily file)
    B       the ticker's OWN baseline short-volume ratio -- its volume-weighted
            SVR over the four weeks BEFORE settlement, so a deviation measures a
            genuine shift rather than netting out against the market average.
            Falls back to 0.45 (market-typical) with too little history.
    V_d     that day's consolidated total volume
    V_today rel_volume * avg_volume, refreshed every screener cycle
    k       dampening. Most short volume is market-maker flow covered the same
            day and never becomes short interest. Calibrated per liquidity
            bucket when calibration data exists; otherwise UNCALIBRATED_K.
    Float   shares float

The result is clamped to a sanity band around the official figure, so an
estimate can refine the official number but never run away from it.

Deliberately NOT included (see the recon that scoped this port):
  * borrow-rate pressure -- that term needs IBKR, which is out of scope. The
    seam is kept at neutral (1.0) so it can be supplied later without a rewrite.
  * any scoring or classification. This module produces one number plus its
    provenance; the v11 evidence gate remains the sole squeeze-scoring logic.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

# Dampening used when no calibration data is available. Documented fallback --
# every estimate produced with it is stamped UNCALIBRATED so the output is
# never mistaken for a fitted result.
UNCALIBRATED_K = 0.25

MARKET_BASELINE_SVR = 0.45

# On a micro-float name, daily volume can be several times the entire float --
# the same shares changing hands repeatedly. Past this point extra volume is
# overwhelmingly repeat churn rather than new distinct short positions, so each
# day's contribution is capped at this many float-turnovers (ratio preserved,
# magnitude bounded). Without it one mega-volume day on a thin float pins the
# estimate to the sanity-band ceiling on its own.
MAX_DAILY_TURNOVER = 3.0

# The estimate may refine the official figure within this band, never beyond it.
SANITY_BAND_MIN_MULTIPLE = 0.3
SANITY_BAND_MAX_MULTIPLE = 2.5

# Minimum baseline observations before we trust a ticker's own SVR over the
# market-typical default.
MIN_BASELINE_DAYS = 5

CALIBRATION_STATUS_CALIBRATED = "calibrated"
CALIBRATION_STATUS_UNCALIBRATED = "uncalibrated_fallback"

DEFAULT_CALIBRATION_PATH = (
    Path(__file__).resolve().parents[2] / "config" / "si_calibration.json"
)


class CalibrationError(RuntimeError):
    """A calibration file exists but cannot be trusted.

    Raised rather than silently falling back: a corrupt calibration file is an
    operational fault, and quietly reverting to UNCALIBRATED_K would hide a
    fitted-looking deployment that is not actually fitted.
    """


@dataclass(frozen=True)
class Calibration:
    k_pooled: float
    buckets: tuple[tuple[float | None, float], ...]  # (max_adv, k), ascending
    fitted_at: str = ""
    n_obs: int = 0

    def k_for(self, avg_volume_shares) -> float:
        try:
            adv = float(avg_volume_shares or 0)
        except (TypeError, ValueError):
            return self.k_pooled
        for max_adv, k in self.buckets:
            if max_adv is None or adv < max_adv:
                return k
        return self.k_pooled


def _positive_number(value, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CalibrationError(f"{label} must be a number, got {value!r}")
    number = float(value)
    if not (number > 0) or number != number or number in (float("inf"), float("-inf")):
        raise CalibrationError(f"{label} must be a finite positive number, got {number!r}")
    return number


def load_calibration(path=None) -> tuple[Calibration | None, str]:
    """Load calibration data if present.

    Returns (calibration, status).
      * File absent  -> (None, 'uncalibrated_fallback'). Expected today; the
        caller must label every estimate accordingly.
      * File present but unreadable, malformed, or semantically invalid ->
        raises CalibrationError. Loud on purpose.

    Swapping in real calibration data later is a data change only: drop a valid
    si_calibration.json in place and the same code path picks it up.
    """
    target = Path(path or os.getenv("SI_CALIBRATION_PATH") or DEFAULT_CALIBRATION_PATH)
    if not target.exists():
        return None, CALIBRATION_STATUS_UNCALIBRATED

    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise CalibrationError(f"calibration file {target} is unreadable: {exc}") from exc

    if not isinstance(raw, dict):
        raise CalibrationError(f"calibration file {target} must contain a JSON object")

    k_pooled = _positive_number(raw.get("k_pooled"), f"{target}: k_pooled")

    buckets_raw = raw.get("buckets", [])
    if not isinstance(buckets_raw, list):
        raise CalibrationError(f"{target}: buckets must be a list")

    buckets: list[tuple[float | None, float]] = []
    for index, bucket in enumerate(buckets_raw):
        if not isinstance(bucket, dict):
            raise CalibrationError(f"{target}: buckets[{index}] must be an object")
        max_adv = bucket.get("max_adv")
        if max_adv is not None:
            max_adv = _positive_number(max_adv, f"{target}: buckets[{index}].max_adv")
        bucket_k = _positive_number(bucket.get("k"), f"{target}: buckets[{index}].k")
        buckets.append((max_adv, bucket_k))

    # Ascending by max_adv so the first matching bucket is the narrowest one;
    # an open-ended bucket (max_adv=None) always sorts last.
    buckets.sort(key=lambda item: (item[0] is None, item[0] or 0.0))

    calibration = Calibration(
        k_pooled=k_pooled,
        buckets=tuple(buckets),
        fitted_at=str(raw.get("fitted_at") or ""),
        n_obs=int(raw.get("n_obs") or 0),
    )
    return calibration, CALIBRATION_STATUS_CALIBRATED


def resolve_k(calibration: Calibration | None, avg_volume_shares) -> float:
    if calibration is None:
        return UNCALIBRATED_K
    return calibration.k_for(avg_volume_shares)


def cap_day_turnover(short_vol: float, total_vol: float, float_shares) -> tuple[float, float]:
    """Cap one day's volume at MAX_DAILY_TURNOVER x float, preserving its ratio.

    A missing or non-positive float leaves the day untouched rather than
    applying a cap we cannot justify.
    """
    try:
        float_shares = float(float_shares or 0)
    except (TypeError, ValueError):
        return short_vol, total_vol
    if float_shares <= 0 or total_vol <= 0:
        return short_vol, total_vol
    cap = MAX_DAILY_TURNOVER * float_shares
    if total_vol > cap:
        scale = cap / total_vol
        return short_vol * scale, cap
    return short_vol, total_vol


def baseline_svr(baseline_rows) -> tuple[float, bool]:
    """Volume-weighted short-volume ratio over the pre-settlement window.

    Returns (baseline, is_ticker_specific). Too little history falls back to the
    market-typical ratio, and says so.
    """
    rows = [(sv, tv) for _, sv, tv in baseline_rows if tv > 0]
    if len(rows) < MIN_BASELINE_DAYS:
        return MARKET_BASELINE_SVR, False
    total_volume = sum(tv for _, tv in rows)
    if total_volume <= 0:
        return MARKET_BASELINE_SVR, False
    return sum(sv for sv, _ in rows) / total_volume, True


def apply_sanity_band(estimate: float, official_pct: float) -> tuple[float, bool]:
    """Clamp the estimate to the band around the official figure."""
    low = SANITY_BAND_MIN_MULTIPLE * official_pct
    high = SANITY_BAND_MAX_MULTIPLE * official_pct
    clamped = max(0.0, max(low, min(high, estimate)))
    return clamped, clamped != estimate


@dataclass(frozen=True)
class SiEstimate:
    official_pct: float
    estimated_pct: float
    delta_pct: float
    k: float
    calibration_status: str
    baseline_svr: float
    baseline_is_ticker_specific: bool
    observed_days: int
    clamped: bool
    borrow_multiplier: float = 1.0


def estimate_si_pct(
    *,
    official_pct,
    float_shares,
    since_settlement_rows,
    baseline_rows,
    rel_volume=None,
    avg_volume_shares=None,
    calibration: Calibration | None = None,
    calibration_status: str = CALIBRATION_STATUS_UNCALIBRATED,
    borrow_multiplier: float = 1.0,
) -> SiEstimate | None:
    """Estimate current short interest as a percentage.

    Returns None when the official figure or the float is missing -- there is
    nothing to refine, and inventing a base would be worse than staying stale.
    """
    try:
        official = float(official_pct)
        float_count = float(float_shares or 0)
    except (TypeError, ValueError):
        return None
    if official != official or official <= 0 or float_count <= 0:
        return None

    k = resolve_k(calibration, avg_volume_shares)
    baseline, ticker_specific = baseline_svr(baseline_rows)

    rows = [(day, sv, tv) for day, sv, tv in since_settlement_rows if tv > 0]

    excess_shares = 0.0
    for _, short_vol, total_vol in rows:
        capped_short, capped_total = cap_day_turnover(short_vol, total_vol, float_count)
        excess_shares += capped_short - baseline * capped_total

    # Today, still in progress: assume shorting runs at the latest known ratio,
    # applied to the live volume estimate.
    try:
        today_volume = float(rel_volume) * float(avg_volume_shares)
    except (TypeError, ValueError):
        today_volume = 0.0
    if rows and today_volume > 0:
        _, last_short, last_total = rows[-1]
        latest_svr = last_short / last_total
        _, capped_today = cap_day_turnover(latest_svr * today_volume, today_volume, float_count)
        excess_shares += (latest_svr - baseline) * capped_today

    delta = k * excess_shares / float_count * 100.0
    delta *= borrow_multiplier

    estimated, clamped = apply_sanity_band(official + delta, official)

    return SiEstimate(
        official_pct=round(official, 4),
        estimated_pct=round(estimated, 4),
        delta_pct=round(estimated - official, 4),
        k=k,
        calibration_status=calibration_status,
        baseline_svr=round(baseline, 6),
        baseline_is_ticker_specific=ticker_specific,
        observed_days=len(rows),
        clamped=clamped,
        borrow_multiplier=borrow_multiplier,
    )
