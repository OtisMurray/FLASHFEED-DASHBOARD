import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import chart_service


def sample_bars(count=20):
    start = datetime(2026, 7, 24, 9, 30)
    bars = []
    for index in range(count):
        open_price = 100 + index * 0.05
        close_price = open_price + (0.06 if index % 3 else -0.02)
        bars.append({
            "ts": start + timedelta(minutes=index),
            "open": open_price,
            "high": max(open_price, close_price) + 0.08,
            "low": min(open_price, close_price) - 0.08,
            "close": close_price,
            "volume": 1_000 + index * 25,
        })
    return bars


class CvdApiTests(unittest.TestCase):
    def setUp(self):
        self.client = chart_service.app.test_client()

    @patch.object(chart_service, "_load_cvd_ticks", return_value=[])
    @patch.object(chart_service, "_latest_session_bars", return_value=(sample_bars(), "2026-07-24"))
    def test_estimated_response_contract(self, _bars, _ticks):
        response = self.client.get("/api/sentchart/cvd/META")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["ticker"], "META")
        self.assertEqual(payload["provenance"], "estimated")
        self.assertEqual(len(payload["candles"]), 20)
        self.assertEqual(len(payload["rows"]), 20)
        self.assertTrue(all(row["quality"] == "estimated_bvc" for row in payload["rows"]))
        self.assertTrue(all("normalized_cvd_pct" in row for row in payload["rows"]))
        self.assertTrue(all("method_agreement" in row for row in payload["rows"]))
        self.assertIn("latest_signal", payload["analysis"])
        self.assertTrue(payload["analysis"]["research_only"])
        self.assertEqual(payload["signal_policy"]["status"], "research_only_holdout_not_confirmed")
        self.assertEqual(payload["measured_source"]["status"], "disabled")

    @patch.object(chart_service, "_load_cvd_ticks", return_value=[])
    @patch.object(chart_service, "_latest_session_bars", return_value=(sample_bars(), "2026-07-24"))
    def test_analysis_window_is_validated_and_reported(self, _bars, _ticks):
        selected = self.client.get("/api/sentchart/cvd/META?analysis_window=60").get_json()
        clamped = self.client.get("/api/sentchart/cvd/META?analysis_window=999").get_json()
        invalid = self.client.get("/api/sentchart/cvd/META?analysis_window=nope").get_json()
        self.assertEqual(selected["signal_policy"]["window_minutes"], 60)
        self.assertEqual(clamped["signal_policy"]["window_minutes"], 120)
        self.assertEqual(invalid["signal_policy"]["window_minutes"], 30)

    @patch.object(chart_service, "_load_cvd_ticks")
    @patch.object(chart_service, "_latest_session_bars", return_value=(sample_bars(), "2026-07-24"))
    def test_measured_ticks_are_reported(self, _bars, ticks):
        first = int(sample_bars()[0]["ts"].replace(tzinfo=timezone.utc).timestamp())
        ticks.return_value = [{"time": first, "size": 50, "delta": 50}]
        response = self.client.get("/api/sentchart/cvd/META")
        payload = response.get_json()
        self.assertEqual(payload["provenance"], "mixed")
        self.assertEqual(payload["measured_minutes"], 1)
        self.assertEqual(payload["rows"][0]["quality"], "measured")

    @patch.object(chart_service, "_latest_session_bars", return_value=([], None))
    def test_missing_ticker_data_is_safe(self, _bars):
        response = self.client.get("/api/sentchart/cvd/NOPE")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["rows"], [])
        self.assertIn("No intraday data", payload["error"])

    def test_pressure_overlay_keeps_only_strongest_outlier_per_display_bucket(self):
        rows = []
        start = 1_722_000_000
        for index, delta in enumerate([1, 1, 1, 1, 1, 20, 40, 1, 1, 1, -30]):
            rows.append({
                "time": start + index * 60,
                "delta_best": delta,
                "quality": "estimated_bvc",
            })
        bubbles = chart_service._cvd_bubbles(rows, window=5, display_bucket_minutes=5)
        bucket_ids = [row["time"] // 300 for row in bubbles]
        self.assertEqual(len(bucket_ids), len(set(bucket_ids)))
        self.assertTrue(any(row["delta"] == 40 for row in bubbles))

    @patch.object(chart_service, "_load_cvd_ticks", return_value={
        "ticks": [], "status": "error", "error": "ServerSelectionTimeoutError",
    })
    @patch.object(chart_service, "_latest_session_bars", return_value=(sample_bars(), "2026-07-24"))
    def test_measured_source_failure_is_visible_without_connection_details(self, _bars, _ticks):
        payload = self.client.get("/api/sentchart/cvd/META").get_json()
        self.assertEqual(payload["measured_source"]["status"], "error")
        self.assertEqual(payload["measured_source"]["error"], "ServerSelectionTimeoutError")
        self.assertNotIn("uri", payload["measured_source"])


if __name__ == "__main__":
    unittest.main()
