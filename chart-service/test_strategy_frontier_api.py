"""Endpoint-level cover for the frontier bound.

Two things to hold at once:
  - the STRATEGY endpoints (signals, positions/batch, corr/batch) must stop at
    the last real bar;
  - the DISPLAY endpoint (/api/sentchart/chart) must be untouched — it draws the
    carried line on purpose, with ResearchChart's `isReal` mask keeping the
    synthetic minutes visually distinct. Bounding what the strategy TREATS as
    real must not bound what the chart DRAWS.
"""
import sys
import types
import unittest
from unittest.mock import patch

import chart_service
from test_strategy_frontier import DATE, phase_flip_tape

# The chart endpoint's overnight pull is a best-effort TradingView call. Left
# live it reaches the network and times out, which made this file take 12s and
# depend on the internet; an empty pull is the documented fallback anyway.
_NO_OVERNIGHT = types.ModuleType("tv_overnight")
_NO_OVERNIGHT.overnight_bars = lambda *_a, **_k: []

# Frontier deliberately INSIDE regular hours (14:30). These tests are about the
# data-frontier bound, and a frontier past 16:00 would hand the position to the
# regular-hours gate, which flattens it at the close — a different behaviour,
# covered in test_rth_gate.py. Keeping the frontier at 14:30 leaves the position
# genuinely open at the last real bar, which is what these assertions are for.
BARS, MSGS = phase_flip_tape(14, 30)    # real entry at 13:19, frontier 14:30
FRONTIER_HHMM = "14:30"
REAL_MINUTES = 631                      # 04:00..14:30 inclusive


def fake_doc(*_a, **_k):
    return {"messages": [], "win": getattr(chart_service.social_store, "WINDOW_TAG", None)}


class FrontierApiTests(unittest.TestCase):
    def setUp(self):
        self.client = chart_service.app.test_client()
        # the batch endpoints memoize; a stale entry would mask the change
        chart_service._positions_batch_cache.clear()
        chart_service._corr_batch_cache.clear()
        self.patchers = [
            patch.object(chart_service, "_latest_session_bars", return_value=(BARS, DATE)),
            patch.object(chart_service.social_store, "read_doc", side_effect=fake_doc),
            patch.object(chart_service.social_store, "docs_to_msgs", return_value=MSGS),
            patch.object(chart_service, "_try_claim_topup", return_value=False),
            patch.object(chart_service, "_prev_session_close", return_value=(99.5, "2026-07-23")),
            patch.dict(sys.modules, {"tv_overnight": _NO_OVERNIGHT}),
        ]
        for p in self.patchers:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in self.patchers])

    # ---- strategy endpoints: bounded -------------------------------------
    def test_signals_corr_defined_counts_real_minutes_only(self):
        r = self.client.get("/api/sentchart/signals/TEST?threshold=0.1&stop_pct=5").get_json()
        self.assertEqual(r["n"], REAL_MINUTES)
        # pre-fix this was 601 for any ticker regardless of its bar count
        self.assertEqual(r["corr_defined"],
                         REAL_MINUTES - (chart_service.STRAT_ROLL_WINDOW - 1))
        self.assertNotEqual(r["corr_defined"], 601)

    def test_signals_places_no_marker_past_the_frontier(self):
        r = self.client.get("/api/sentchart/signals/TEST?threshold=0.1&stop_pct=5").get_json()
        self.assertTrue(r["markers"])
        frontier = chart_service._epoch_utc(max(b["ts"] for b in BARS))
        self.assertTrue(all(m["time"] <= frontier for m in r["markers"]))

    def test_corr_batch_serves_the_frontier_minute(self):
        r = self.client.get("/api/sentchart/corr/batch?tickers=TEST").get_json()
        row = r["results"]["TEST"]
        self.assertEqual(row["status"], "ok")
        # pre-fix this was always 19:59 — the end of the grid, not of the tape
        self.assertEqual(row["corr_minute"], FRONTIER_HHMM)

    def test_positions_batch_trade_carries_bars_since_entry(self):
        r = self.client.get(
            "/api/sentchart/positions/batch?tickers=TEST&threshold=0.1&stop_pct=5").get_json()
        row = r["results"]["TEST"]
        self.assertEqual(row["status"], "ok")
        self.assertTrue(row["trades"])
        trade = row["trades"][0]
        self.assertIn("bars_since_entry", trade)
        self.assertEqual(trade["entry_time"], "13:19")
        self.assertEqual(trade["bars_since_entry"], 71)       # 13:19 -> 14:30
        self.assertEqual(trade["status"], "Holding")

    def test_open_position_is_marked_to_the_frontier_bar(self):
        r = self.client.get(
            "/api/sentchart/positions/batch?tickers=TEST&threshold=0.1&stop_pct=5").get_json()
        row = r["results"]["TEST"]
        last_close = round(max(BARS, key=lambda b: b["ts"])["close"], 4)
        self.assertEqual(row["current_price"], last_close)
        self.assertEqual(row["trades"][0]["exit_time"], FRONTIER_HHMM)

    # ---- display endpoint: untouched -------------------------------------
    def test_chart_endpoint_still_returns_the_whole_tape(self):
        """The display series is built straight from bars, never from the
        strategy grid, so the bound cannot shorten it."""
        r = self.client.get("/api/sentchart/chart?ticker=TEST").get_json()
        self.assertEqual(r["n"], len(BARS))
        self.assertEqual(len(r["prices"]), len(BARS) + r["overnight_n"])
        self.assertEqual(len(r["labels"]), len(r["prices"]))
        self.assertEqual(r["labels"][-1], FRONTIER_HHMM)
        self.assertIn("prev_close", r)          # what the client carries flat
        self.assertIn("overnight_n", r)         # JEM overnight path intact

    def test_candles_endpoint_still_returns_every_bar(self):
        r = self.client.get("/api/sentchart/charts/TEST").get_json()
        self.assertEqual(r["n"], len(BARS))
        self.assertEqual(len(r["candles"]), len(BARS))


if __name__ == "__main__":
    unittest.main()
