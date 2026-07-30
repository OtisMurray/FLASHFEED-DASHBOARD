import unittest

from cvd_engine import (
    aggregate_measured_ticks,
    analyze_cvd_rows,
    classify_cvd_feature,
    compute_bar_cvd,
    compute_cvd_features,
    cvd_signal_events,
    market_session_phase,
    merge_liquidity_walls,
    merge_measured_minutes,
    summarize_cvd,
)


class CvdEngineTests(unittest.TestCase):
    def setUp(self):
        self.candles = []
        for index in range(12):
            open_price = 100.0 + index * 0.1
            close_price = open_price + (0.08 if index % 2 == 0 else -0.03)
            self.candles.append({
                "time": 1_722_000_000 + index * 60,
                "open": open_price,
                "high": max(open_price, close_price) + 0.1,
                "low": min(open_price, close_price) - 0.1,
                "close": close_price,
                "volume": 1_000 + index * 10,
            })

    def test_bar_cvd_is_deterministic_and_conserves_shape(self):
        result = compute_bar_cvd(self.candles)
        self.assertEqual(len(result["rows"]), len(self.candles))
        self.assertEqual(result, compute_bar_cvd(self.candles))
        for source, row in zip(self.candles, result["rows"]):
            self.assertLessEqual(abs(row["delta_bvc"]), source["volume"])
            self.assertLessEqual(abs(row["delta_wick"]), source["volume"])

    def test_measured_ticks_replace_only_covered_minutes(self):
        estimates = compute_bar_cvd(self.candles)["rows"]
        ticks = [
            {"time": estimates[0]["time"], "size": 20, "delta": 20},
            {"time": estimates[0]["time"] + 2, "size": 5, "delta": -5},
        ]
        merged = merge_measured_minutes(estimates, ticks)
        self.assertEqual(merged["measured_minutes"], 1)
        self.assertEqual(merged["rows"][0]["delta_best"], 15)
        self.assertEqual(merged["rows"][0]["quality"], "measured")
        self.assertEqual(merged["rows"][1]["quality"], "estimated_bvc")
        self.assertEqual(
            merged["rows"][1]["cvd_best"],
            round(15 + merged["rows"][1]["delta_bvc"], 6),
        )

    def test_measured_closing_cross_is_neutralized(self):
        estimates = compute_bar_cvd(self.candles)["rows"]
        merged = merge_measured_minutes(estimates, [{
            "time": estimates[0]["time"],
            "size": 1_000,
            "delta": 1_000,
            "cond": "6 X,F",
        }])
        self.assertEqual(merged["rows"][0]["quality"], "measured")
        self.assertEqual(merged["rows"][0]["delta_best"], 0)
        self.assertEqual(merged["rows"][0]["cvd_best"], 0)

    def test_zero_delta_tick_splits_volume_neutrally(self):
        epoch = self.candles[0]["time"]
        bucket = aggregate_measured_ticks([{"time": epoch, "size": 10, "delta": 0}])[epoch]
        self.assertEqual(bucket["buy"], 5)
        self.assertEqual(bucket["sell"], 5)

    def test_malformed_measured_ticks_cannot_create_impossible_delta(self):
        epoch = self.candles[0]["time"]
        buckets = aggregate_measured_ticks([
            {"time": "not-a-time", "size": 10, "delta": 10},
            {"time": epoch, "size": 0, "delta": 1_000},
            {"time": epoch, "size": 10, "delta": 1_000, "trades": 4},
        ])
        self.assertEqual(buckets[epoch]["delta"], 10)
        self.assertEqual(buckets[epoch]["trades"], 4)

    def test_liquidity_walls_never_merge_across_sides(self):
        walls = merge_liquidity_walls([
            {"price": 99.99, "score": 100, "side": "support"},
            {"price": 100.01, "score": 120, "side": "resistance"},
        ], adjacency=0.05)
        self.assertEqual({row["side"] for row in walls}, {"support", "resistance"})

    def test_normalized_features_are_bounded_and_causal(self):
        estimates = compute_bar_cvd(self.candles)["rows"]
        merged = merge_measured_minutes(estimates, [])["rows"]
        features = compute_cvd_features(self.candles, merged, window_minutes=5)
        self.assertEqual(len(features), len(self.candles))
        for row in features:
            self.assertLessEqual(abs(row["normalized_cvd_pct"]), 100)
            self.assertLessEqual(abs(row["flow_imbalance_pct"]), 100)
            self.assertGreaterEqual(row["method_agreement"], 0)
            self.assertLessEqual(row["method_agreement"], 1)
            self.assertLessEqual(row["reliability"], 0.65)
        shortened = compute_cvd_features(self.candles[:-1], merged[:-1], window_minutes=5)
        self.assertEqual(features[:-1], shortened)

    def test_opening_noise_blocks_an_otherwise_valid_confirmation(self):
        row = {
            "time": 0,
            "session_phase": "opening_noise",
            "window_samples": 12,
            "cumulative_volume": 100_000,
            "flow_imbalance_pct": 30,
            "window_price_return_pct": 2,
            "method_agreement": 0.95,
            "reliability": 0.65,
            "quality": "estimated_bvc",
        }
        classified = classify_cvd_feature(row)
        self.assertEqual(classified["signal"], "opening_noise_guard")
        self.assertFalse(classified["entry_confirmation"])

    def test_confirmation_divergence_and_exit_warning_contract(self):
        base = {
            "time": 1_000_000,
            "session_phase": "regular",
            "window_samples": 12,
            "cumulative_volume": 100_000,
            "method_agreement": 0.9,
            "reliability": 0.62,
            "quality": "estimated_bvc",
        }
        buying = classify_cvd_feature({
            **base, "flow_imbalance_pct": 20, "window_price_return_pct": 1,
        })
        bearish_divergence = classify_cvd_feature({
            **base, "flow_imbalance_pct": -20, "window_price_return_pct": 1,
        })
        self.assertEqual(buying["signal"], "buying_confirmation")
        self.assertFalse(buying["entry_confirmation"])
        self.assertFalse(buying["ranking_eligible"])
        self.assertEqual(bearish_divergence["signal"], "bearish_divergence")
        self.assertTrue(bearish_divergence["exit_warning"])
        self.assertLessEqual(buying["signal_confidence"], 0.70)

    def test_signal_events_are_deduplicated(self):
        rows = []
        for minute in (0, 5, 16):
            rows.append({
                "time": 1_000_000 + minute * 60,
                "signal": "buying_confirmation",
                "signal_direction": 1,
            })
        events = cvd_signal_events(rows, cooldown_minutes=15)
        self.assertEqual(len(events), 2)
        summary = summarize_cvd(rows, events)
        self.assertEqual(summary["event_counts"]["buying_confirmation"], 2)
        self.assertTrue(summary["research_only"])

    def test_timestamp_modes_protect_the_opening_window(self):
        # 13:35 UTC is 09:35 ET in July, while chart timestamps encode 09:35
        # directly as UTC wall-clock.
        self.assertEqual(market_session_phase(1_722_000_900, "utc"), "opening_noise")
        self.assertEqual(market_session_phase(1_721_986_500, "et_wall_clock"), "opening_noise")

    def test_full_analysis_adds_signals_without_changing_raw_cvd(self):
        estimates = compute_bar_cvd(self.candles)["rows"]
        merged = merge_measured_minutes(estimates, [])["rows"]
        analyzed = analyze_cvd_rows(self.candles, merged, window_minutes=5)
        self.assertEqual([row["cvd_best"] for row in analyzed], [row["cvd_best"] for row in merged])
        self.assertTrue(all("signal" in row for row in analyzed))


if __name__ == "__main__":
    unittest.main()
