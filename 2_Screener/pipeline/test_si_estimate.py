from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path


def _load(name: str):
    path = Path(__file__).resolve().with_name(f"{name}.py")
    module_name = f"{name}_tested"
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    # Registered before exec so dataclasses can resolve this module's own
    # annotations (PEP 604 unions) while the class bodies are being processed.
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


si = _load("si_estimate")
finra = _load("finra_short_volume")


class TurnoverCapTests(unittest.TestCase):
    """The per-day float-turnover cap (ported from the source screener)."""

    def test_no_cap_when_under_threshold(self):
        short_vol, total_vol = 40_000, 100_000  # 0.1x turnover
        self.assertEqual(
            si.cap_day_turnover(short_vol, total_vol, 1_000_000),
            (short_vol, total_vol),
        )

    def test_cap_preserves_ratio(self):
        short_vol, total_vol, float_shares = 4_492_690, 7_913_219, 490_000  # ~16x
        capped_short, capped_total = si.cap_day_turnover(short_vol, total_vol, float_shares)
        self.assertEqual(capped_total, si.MAX_DAILY_TURNOVER * float_shares)
        self.assertAlmostEqual(capped_short / capped_total, short_vol / total_vol, places=9)
        self.assertLess(capped_total, total_vol)
        self.assertLess(capped_short, short_vol)

    def test_missing_float_leaves_day_uncapped(self):
        short_vol, total_vol = 5_000_000, 8_000_000
        for bad_float in (None, 0, -1, "abc"):
            self.assertEqual(
                si.cap_day_turnover(short_vol, total_vol, bad_float),
                (short_vol, total_vol),
                msg=f"float={bad_float!r} must not produce a cap",
            )

    def test_extreme_microfloat_signal_is_damped(self):
        """A 30x-turnover day must contribute far less excess than uncapped.

        Asserted on raw excess shares rather than the final percentage: for a
        sufficiently extreme name both the capped and uncapped paths saturate
        the sanity band and collide on the same output, which would hide the
        cap's actual effect.
        """
        float_shares = 500_000
        short_vol, total_vol = 9_000_000, 15_000_000  # 30x float
        baseline = 0.45

        capped_short, capped_total = si.cap_day_turnover(short_vol, total_vol, float_shares)
        capped_excess = capped_short - baseline * capped_total
        uncapped_excess = short_vol - baseline * total_vol

        self.assertLess(capped_excess, uncapped_excess)
        reduction = (1 - capped_excess / uncapped_excess) * 100
        self.assertGreater(reduction, 50, f"expected >50% damping, got {reduction:.0f}%")


class SanityBandTests(unittest.TestCase):
    """The estimate may refine the official figure, never run away from it."""

    def test_clamps_above_upper_multiple(self):
        clamped, was_clamped = si.apply_sanity_band(999.0, 10.0)
        self.assertEqual(clamped, si.SANITY_BAND_MAX_MULTIPLE * 10.0)
        self.assertTrue(was_clamped)

    def test_clamps_below_lower_multiple(self):
        clamped, was_clamped = si.apply_sanity_band(0.1, 10.0)
        self.assertEqual(clamped, si.SANITY_BAND_MIN_MULTIPLE * 10.0)
        self.assertTrue(was_clamped)

    def test_leaves_in_band_value_untouched(self):
        clamped, was_clamped = si.apply_sanity_band(12.5, 10.0)
        self.assertEqual(clamped, 12.5)
        self.assertFalse(was_clamped)

    def test_never_returns_negative(self):
        clamped, _ = si.apply_sanity_band(-50.0, 10.0)
        self.assertGreaterEqual(clamped, 0.0)

    def test_end_to_end_estimate_stays_in_band_and_reports_clamp(self):
        """A sustained heavy-shorting run must not blow past the ceiling."""
        rows = [(f"2026070{d}", 950_000.0, 1_000_000.0) for d in range(1, 9)]
        baseline_rows = [(f"2026060{d}", 100_000.0, 1_000_000.0) for d in range(1, 9)]
        estimate = si.estimate_si_pct(
            official_pct=10.0,
            float_shares=1_000_000,
            since_settlement_rows=rows,
            baseline_rows=baseline_rows,
        )
        self.assertIsNotNone(estimate)
        self.assertLessEqual(estimate.estimated_pct, si.SANITY_BAND_MAX_MULTIPLE * 10.0)
        self.assertTrue(estimate.clamped)


class CalibrationFallbackTests(unittest.TestCase):
    """A missing calibration file must be loud; a corrupt one must be fatal."""

    def test_missing_file_reports_uncalibrated_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            calibration, status = si.load_calibration(Path(tmp) / "absent.json")
        self.assertIsNone(calibration)
        self.assertEqual(status, si.CALIBRATION_STATUS_UNCALIBRATED)

    def test_missing_file_falls_back_to_documented_k(self):
        self.assertEqual(si.resolve_k(None, 1_000_000), si.UNCALIBRATED_K)
        self.assertEqual(si.UNCALIBRATED_K, 0.25)

    def test_uncalibrated_status_propagates_onto_every_estimate(self):
        """The fallback must never be silent -- it rides along on the result."""
        rows = [("20260701", 600_000.0, 1_000_000.0)]
        estimate = si.estimate_si_pct(
            official_pct=12.0,
            float_shares=5_000_000,
            since_settlement_rows=rows,
            baseline_rows=[],
            calibration=None,
            calibration_status=si.CALIBRATION_STATUS_UNCALIBRATED,
        )
        self.assertIsNotNone(estimate)
        self.assertEqual(estimate.k, si.UNCALIBRATED_K)
        self.assertEqual(estimate.calibration_status, si.CALIBRATION_STATUS_UNCALIBRATED)

    def _expect_error(self, payload: str):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "si_calibration.json"
            path.write_text(payload, encoding="utf-8")
            with self.assertRaises(si.CalibrationError):
                si.load_calibration(path)

    def test_corrupt_json_raises_rather_than_falling_back(self):
        self._expect_error("{not valid json")

    def test_non_object_payload_raises(self):
        self._expect_error("[1, 2, 3]")

    def test_missing_k_pooled_raises(self):
        self._expect_error(json.dumps({"buckets": []}))

    def test_non_numeric_k_raises(self):
        self._expect_error(json.dumps({"k_pooled": "0.25"}))

    def test_non_positive_k_raises(self):
        self._expect_error(json.dumps({"k_pooled": 0}))

    def test_malformed_bucket_raises(self):
        self._expect_error(json.dumps({"k_pooled": 0.3, "buckets": [{"max_adv": 1e6}]}))

    def test_valid_file_loads_and_selects_bucket_by_liquidity(self):
        payload = {
            "k_pooled": 0.30,
            "fitted_at": "2026-07-27",
            "n_obs": 120,
            "buckets": [
                {"max_adv": 10_000_000, "k": 0.40},
                {"max_adv": 1_000_000, "k": 0.20},
                {"max_adv": None, "k": 0.50},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "si_calibration.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            calibration, status = si.load_calibration(path)

        self.assertEqual(status, si.CALIBRATION_STATUS_CALIBRATED)
        self.assertEqual(calibration.k_for(500_000), 0.20)      # narrowest bucket
        self.assertEqual(calibration.k_for(5_000_000), 0.40)
        self.assertEqual(calibration.k_for(50_000_000), 0.50)   # open-ended bucket
        self.assertEqual(si.resolve_k(calibration, 500_000), 0.20)

    def test_swapping_in_calibration_changes_k_without_logic_change(self):
        """Same inputs, same code path -- only the data file differs."""
        rows = [("20260701", 700_000.0, 1_000_000.0)]
        baseline_rows = [(f"2026060{d}", 400_000.0, 1_000_000.0) for d in range(1, 9)]
        kwargs = dict(
            official_pct=10.0,
            float_shares=20_000_000,
            since_settlement_rows=rows,
            baseline_rows=baseline_rows,
            avg_volume_shares=500_000,
        )
        uncalibrated = si.estimate_si_pct(**kwargs, calibration=None)
        calibrated = si.estimate_si_pct(
            **kwargs,
            calibration=si.Calibration(k_pooled=0.9, buckets=((None, 0.9),)),
            calibration_status=si.CALIBRATION_STATUS_CALIBRATED,
        )
        self.assertEqual(uncalibrated.k, si.UNCALIBRATED_K)
        self.assertEqual(calibrated.k, 0.9)
        self.assertNotEqual(uncalibrated.estimated_pct, calibrated.estimated_pct)


class BaselineTests(unittest.TestCase):
    def test_thin_history_falls_back_to_market_baseline(self):
        rows = [("20260701", 40_000.0, 100_000.0)]  # only one day
        baseline, ticker_specific = si.baseline_svr(rows)
        self.assertEqual(baseline, si.MARKET_BASELINE_SVR)
        self.assertFalse(ticker_specific)

    def test_sufficient_history_uses_volume_weighted_ticker_ratio(self):
        rows = [(f"2026060{d}", 300_000.0, 1_000_000.0) for d in range(1, 9)]
        baseline, ticker_specific = si.baseline_svr(rows)
        self.assertAlmostEqual(baseline, 0.3, places=9)
        self.assertTrue(ticker_specific)


class EstimateGuardTests(unittest.TestCase):
    def test_missing_official_figure_returns_none(self):
        self.assertIsNone(si.estimate_si_pct(
            official_pct=None, float_shares=1_000_000,
            since_settlement_rows=[], baseline_rows=[],
        ))

    def test_missing_float_returns_none(self):
        self.assertIsNone(si.estimate_si_pct(
            official_pct=12.0, float_shares=0,
            since_settlement_rows=[], baseline_rows=[],
        ))

    def test_borrow_term_defaults_to_neutral(self):
        """IBKR borrow pressure is out of scope; the seam must stay at 1.0."""
        estimate = si.estimate_si_pct(
            official_pct=10.0, float_shares=1_000_000,
            since_settlement_rows=[("20260701", 500_000.0, 1_000_000.0)],
            baseline_rows=[],
        )
        self.assertEqual(estimate.borrow_multiplier, 1.0)

    def test_no_finra_days_leaves_official_figure_untouched(self):
        estimate = si.estimate_si_pct(
            official_pct=14.0, float_shares=1_000_000,
            since_settlement_rows=[], baseline_rows=[],
        )
        self.assertEqual(estimate.estimated_pct, 14.0)
        self.assertEqual(estimate.delta_pct, 0.0)
        self.assertEqual(estimate.observed_days, 0)


class FinraParsingTests(unittest.TestCase):
    SAMPLE = (
        "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n"
        "20260724|A|375395.292812|25|597607.250587|B,Q,N\n"
        "20260724|AA|471727.177470|934|885109.951355|B,Q,N\n"
        "20260724|ZEROVOL|0.0|0|0.0|B,Q,N\n"
        "20260724|BAD|notanumber|0|123.0|B,Q,N\n"
        "truncated|row\n"
    )

    def test_parses_real_file_layout(self):
        parsed = finra.parse_daily_text(self.SAMPLE)
        self.assertEqual(parsed["A"], (375395.292812, 597607.250587))
        self.assertEqual(parsed["AA"], (471727.177470, 885109.951355))

    def test_drops_zero_volume_malformed_and_truncated_rows(self):
        parsed = finra.parse_daily_text(self.SAMPLE)
        self.assertNotIn("ZEROVOL", parsed)  # no ratio information
        self.assertNotIn("BAD", parsed)
        self.assertEqual(len(parsed), 2)

    def test_checksum_is_stable_and_content_sensitive(self):
        self.assertEqual(finra.checksum_of(self.SAMPLE), finra.checksum_of(self.SAMPLE))
        self.assertNotEqual(finra.checksum_of(self.SAMPLE), finra.checksum_of(self.SAMPLE + "x"))

    def test_settlement_calendar_picks_a_published_date(self):
        settlement = finra.latest_published_settlement(date(2026, 7, 27))
        self.assertLess(settlement, date(2026, 7, 27))
        self.assertIn(settlement.day, range(1, 32))
        # Must be far enough back that FINRA has actually published it.
        self.assertGreaterEqual((date(2026, 7, 27) - settlement).days, 9)

    def test_trading_days_between_excludes_weekends_and_endpoints(self):
        days = finra.trading_days_between(date(2026, 7, 17), date(2026, 7, 27))
        self.assertNotIn(date(2026, 7, 17), days)  # exclusive start
        self.assertNotIn(date(2026, 7, 27), days)  # exclusive end
        self.assertTrue(all(day.weekday() < 5 for day in days))
        self.assertIn(date(2026, 7, 24), days)

    def test_series_for_returns_oldest_first_and_skips_absent_days(self):
        days = {
            "20260722": finra.DayFile("20260722", {"AAA": (10.0, 100.0)}),
            "20260723": finra.DayFile("20260723", {"BBB": (10.0, 100.0)}),
            "20260724": finra.DayFile("20260724", {"AAA": (30.0, 100.0)}),
        }
        series = finra.series_for(days, "aaa")
        self.assertEqual([row[0] for row in series], ["20260722", "20260724"])

    def test_cache_doc_round_trips(self):
        original = finra.DayFile(
            trade_date="20260724",
            symbols={"AAA": (1.0, 2.0)},
            checksum="abc",
            source_url="https://example.invalid/f.txt",
            row_count=1,
        )
        restored = finra.DayFile.from_cache_doc(original.as_cache_doc())
        self.assertEqual(restored.symbols, {"AAA": (1.0, 2.0)})
        self.assertEqual(restored.checksum, "abc")
        self.assertEqual(restored.trade_date, "20260724")


if __name__ == "__main__":
    unittest.main()
