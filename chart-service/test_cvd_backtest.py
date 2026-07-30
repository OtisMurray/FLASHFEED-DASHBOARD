import unittest
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from cvd_backtest import (
    Feature,
    build_sessions,
    chronological_split,
    event_returns,
    normalize_bar,
    paired_session_incremental,
)
from cvd_engine import DEFAULT_SIGNAL_POLICY


ET = ZoneInfo("America/New_York")


def epoch(date, hour, minute):
    local = datetime.fromisoformat(f"{date}T{hour:02d}:{minute:02d}:00").replace(tzinfo=ET)
    return int(local.astimezone(timezone.utc).timestamp())


class CvdBacktestTests(unittest.TestCase):
    def test_normalize_bar_uses_real_epoch_and_close_fallback(self):
        row = normalize_bar({"minute": 100, "open": 2, "high": 3, "low": 1, "price": 2.5, "volume": 9})
        self.assertEqual(row["time"], 100)
        self.assertEqual(row["close"], 2.5)

    def test_sessions_are_market_day_ticker_groups(self):
        docs = []
        for day in ("2026-07-23", "2026-07-24"):
            for index in range(3):
                docs.append({
                    "ticker": "ABC", "minute": epoch(day, 9, 30 + index * 5),
                    "open": 10, "high": 11, "low": 9, "close": 10.5, "volume": 100,
                })
        sessions = build_sessions(docs, min_bars=3)
        self.assertEqual([row["date"] for row in sessions], ["2026-07-23", "2026-07-24"])

    def test_chronological_split_never_mixes_later_dates_into_train(self):
        sessions = [{"ticker": "ABC", "date": f"2026-07-{day:02d}", "candles": []} for day in range(20, 26)]
        train, holdout, train_dates, holdout_dates = chronological_split(sessions, 0.67)
        self.assertLess(max(train_dates), min(holdout_dates))
        self.assertTrue(all(row["date"] in train_dates for row in train))
        self.assertTrue(all(row["date"] in holdout_dates for row in holdout))

    def test_forward_return_requires_the_full_future_horizon(self):
        rows = []
        start = epoch("2026-07-24", 10, 0)
        for index in range(7):
            rows.append(Feature(
                start + index * 300, 100 + index, "regular", 10, 100_000,
                1, 20, 0.9, 0.6, "estimated_bvc",
            ))
        session = {"analysis": {30: rows}}
        policy = {**DEFAULT_SIGNAL_POLICY, "window_minutes": 30}
        returns = event_returns([session], policy, horizon_minutes=30)
        self.assertEqual(len(returns), 1)
        self.assertAlmostEqual(returns[0], 6.0)

    def test_paired_session_comparison_uses_matching_sessions(self):
        start = epoch("2026-07-24", 10, 0)
        rows = [Feature(
            start + index * 300, 100 + index, "regular", 10, 100_000,
            1, 20 if index < 5 else 0, 0.9, 0.6, "estimated_bvc",
        ) for index in range(7)]
        policy = {**DEFAULT_SIGNAL_POLICY, "window_minutes": 30}
        paired = paired_session_incremental([{"analysis": {30: rows}}], policy, 30)
        self.assertEqual(paired["n"], 1)
        self.assertIn("mean_lift_95pct_cluster_bootstrap_ci", paired)


if __name__ == "__main__":
    unittest.main()
