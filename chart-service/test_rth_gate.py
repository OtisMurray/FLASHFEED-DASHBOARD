"""The regular-hours trading restriction.

The strategy may only ACT between 09:30 and 16:00 ET unless the ticker is on
RTH_EXEMPT_TICKERS. Three separate behaviours, tested separately:

  entry   a correlation crossing outside regular hours is DESTROYED, not
          deferred — crossed_up is a transition, so a cross that never re-crosses
          inside regular hours simply never becomes a trade
  peak    the trailing-stop ratchet freezes outside regular hours, so the stop
          can never be set against a high the strategy could not have worked
  exit    a non-exempt position is FLATTENED at 16:00 rather than carried into
          hours it cannot be managed in — a real fill, not a frozen mark

Every restricted expectation below is paired with its unrestricted control on the
SAME tape, so each test shows the gate doing something rather than asserting into
a vacuum. The unrestricted control is the pre-change behaviour exactly:
restrict_rth=False is the ungated function.

WARM-UP IS UNTOUCHED. The 360-minute correlation still computes across the whole
session grid; this gates the action, not the indicator. test_warmup_is_untouched
pins that.
"""
import math
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

import chart_service

DATE = "2026-07-24"
SESSION_START = datetime(2026, 7, 24, 4, 0)


def _bar(ts, close):
    return {"ts": ts, "open": close, "high": close + 0.05,
            "low": close - 0.05, "close": close, "volume": 100}


def tape(end_h=19, end_m=59, flip_idx=400, amp=3.0, per=97.0, after_hours_bump=0.0):
    """Density anti-correlated with price early and correlated late, so the
    rolling correlation climbs through 0.10 at a predictable minute. flip_idx
    moves that minute; after_hours_bump lifts price only after 16:00."""
    end = datetime(2026, 7, 24, end_h, end_m)
    bars, msgs, ts, i = [], [], SESSION_START, 0
    while ts <= end:
        close = 100 + amp * math.sin(i / per)
        if after_hours_bump and ts.hour >= 16:
            close += after_hours_bump * ((ts.hour * 60 + ts.minute) - 960) / 60.0
        close = round(close, 4)
        bars.append(_bar(ts, close))
        level = close - 97.0
        count = int(round(level * 2)) if i >= flip_idx else int(round((6.0 - level) * 2))
        msgs.extend((ts, "Bullish") for _ in range(max(0, count)))
        ts += timedelta(minutes=1)
        i += 1
    return bars, msgs


def run(bars, msgs, restrict, ticker="TEST"):
    markers, stats = chart_service._compute_strategy_signals(
        ticker, bars, DATE, 0.10, 5.0, msgs=msgs, restrict_rth=restrict)
    trades = [{"entry": chart_service._marker_hhmm(e["time"]),
               "exit": chart_service._marker_hhmm(x["time"]),
               "reason": x["reason"], "peak": x["peak"]}
              for e, x in zip(markers[::2], markers[1::2])]
    return trades, stats


class BoundaryTests(unittest.TestCase):
    def test_entry_window_is_half_open_at_the_close(self):
        allowed = chart_service._rth_entry_allowed
        self.assertFalse(allowed(datetime(2026, 7, 24, 9, 29)))
        self.assertTrue(allowed(datetime(2026, 7, 24, 9, 30)))
        self.assertTrue(allowed(datetime(2026, 7, 24, 15, 59)))
        # an entry AT 16:00 would be flattened the same minute — a zero-length
        # trade the gate should not manufacture
        self.assertFalse(allowed(datetime(2026, 7, 24, 16, 0)))

    def test_exit_window_includes_the_close(self):
        allowed = chart_service._rth_exit_allowed
        self.assertFalse(allowed(datetime(2026, 7, 24, 9, 29)))
        self.assertTrue(allowed(datetime(2026, 7, 24, 9, 30)))
        self.assertTrue(allowed(datetime(2026, 7, 24, 16, 0)))   # the flatten itself
        self.assertFalse(allowed(datetime(2026, 7, 24, 16, 1)))

    def test_exempt_list_parsing_normalises(self):
        got = chart_service._parse_exempt_tickers(" aapl, TSLA ,,nvda;msft ")
        self.assertEqual(got, frozenset({"AAPL", "TSLA", "NVDA", "MSFT"}))
        self.assertEqual(chart_service._parse_exempt_tickers(None), frozenset())
        self.assertEqual(chart_service._parse_exempt_tickers(""), frozenset())


class EntryGateTests(unittest.TestCase):
    """flip_idx=700 puts the only crossing at 18:17 — after hours."""

    def setUp(self):
        self.bars, self.msgs = tape(flip_idx=700)

    def test_after_hours_crossing_is_destroyed(self):
        restricted, _ = run(self.bars, self.msgs, True)
        self.assertEqual(restricted, [])

    def test_control_the_same_tape_does_trade_ungated(self):
        """Guards the fixture: without the gate this tape takes a trade, so the
        assertion above is the gate working, not an empty tape."""
        ungated, _ = run(self.bars, self.msgs, False)
        self.assertEqual(len(ungated), 1)
        self.assertEqual(ungated[0]["entry"], "18:17")

    def test_an_exempt_ticker_still_takes_it(self):
        with patch.object(chart_service, "RTH_EXEMPT_TICKERS", frozenset({"TEST"})):
            trades, stats = run(self.bars, self.msgs, True, ticker="TEST")
        self.assertEqual(len(trades), 1)
        self.assertEqual(trades[0]["entry"], "18:17")
        self.assertFalse(stats["rth_applied"])

    def test_exemption_is_per_ticker_not_global(self):
        with patch.object(chart_service, "RTH_EXEMPT_TICKERS", frozenset({"OTHER"})):
            trades, stats = run(self.bars, self.msgs, True, ticker="TEST")
        self.assertEqual(trades, [])
        self.assertTrue(stats["rth_applied"])

    def test_exemption_match_is_case_insensitive(self):
        with patch.object(chart_service, "RTH_EXEMPT_TICKERS", frozenset({"TEST"})):
            trades, _ = run(self.bars, self.msgs, True, ticker="test")
        self.assertEqual(len(trades), 1)


class FlattenAndPeakTests(unittest.TestCase):
    """flip_idx=400 enters at 13:19 and is still open at 16:00."""

    def test_non_exempt_position_flattens_at_the_close(self):
        bars, msgs = tape()
        trades, _ = run(bars, msgs, True)
        self.assertEqual(len(trades), 1)
        self.assertEqual(trades[0]["entry"], "13:19")
        self.assertEqual(trades[0]["exit"], "16:00")
        self.assertEqual(trades[0]["reason"], "rth_close")

    def test_exempt_position_runs_to_session_end(self):
        bars, msgs = tape()
        ungated, _ = run(bars, msgs, False)
        self.assertEqual(ungated[0]["exit"], "19:59")
        self.assertEqual(ungated[0]["reason"], "session_end")

    def test_peak_does_not_move_on_an_after_hours_print(self):
        """The ratchet is frozen outside regular hours: three tapes identical
        through 16:00 and diverging sharply after it must produce ONE peak."""
        peaks = set()
        for bump in (0.0, 1.5, 3.0):
            bars, msgs = tape(after_hours_bump=bump)
            trades, _ = run(bars, msgs, True)
            peaks.add(trades[0]["peak"])
        self.assertEqual(len(peaks), 1, f"peak moved with after-hours price: {peaks}")

    def test_control_ungated_peak_does_track_the_after_hours_print(self):
        """Guards the test above: the after-hours bump is real and would move an
        unfrozen peak."""
        peaks = []
        for bump in (0.0, 1.5, 3.0):
            bars, msgs = tape(after_hours_bump=bump)
            ungated, _ = run(bars, msgs, False)
            peaks.append(ungated[0]["peak"])
        self.assertEqual(len(set(peaks)), 3)
        self.assertEqual(peaks, sorted(peaks))

    def test_entry_already_inside_regular_hours_is_untouched(self):
        bars, msgs = tape()
        restricted, _ = run(bars, msgs, True)
        ungated, _ = run(bars, msgs, False)
        self.assertEqual(restricted[0]["entry"], ungated[0]["entry"])

    def test_mid_session_frontier_stays_open_rather_than_flattening(self):
        """Before 16:00 there is nothing to flatten — the position is genuinely
        open and must still report session_end at the frontier."""
        bars, msgs = tape(end_h=14, end_m=30)
        trades, _ = run(bars, msgs, True)
        self.assertEqual(len(trades), 1)
        self.assertEqual(trades[0]["exit"], "14:30")
        self.assertEqual(trades[0]["reason"], "session_end")


class IndicatorUntouchedTests(unittest.TestCase):
    def test_warmup_is_untouched(self):
        """Requirement: the gate must not change the correlation itself. Same
        tape, gated and ungated, must warm up over the identical minutes."""
        bars, msgs = tape()
        _, gated = run(bars, msgs, True)
        _, ungated = run(bars, msgs, False)
        self.assertEqual(gated["corr_defined"], ungated["corr_defined"])
        self.assertEqual(gated["messages"], ungated["messages"])
        # and it really is the whole session, not a regular-hours slice
        self.assertEqual(gated["corr_defined"], 960 - (chart_service.STRAT_ROLL_WINDOW - 1))

    def test_pre_market_entries_were_already_impossible(self):
        """Worth pinning: the 360-minute warm-up means the earliest defined
        correlation is 09:59, so the gate's morning half can never bind. Its
        entire practical effect is on 16:00-20:00."""
        grid = chart_service._session_minute_grid(DATE)
        first_possible = grid[chart_service.STRAT_ROLL_WINDOW - 1]
        self.assertEqual(first_possible.strftime("%H:%M"), "09:59")
        self.assertTrue(chart_service._rth_entry_allowed(first_possible))


class StampTests(unittest.TestCase):
    def test_stats_record_whether_the_gate_bound_this_ticker(self):
        bars, msgs = tape()
        _, gated = run(bars, msgs, True)
        self.assertTrue(gated["rth_applied"])
        self.assertEqual(gated["rth_rule_version"], chart_service.RTH_RULE_VERSION)

    def test_an_unbound_ticker_records_no_rule_version(self):
        bars, msgs = tape()
        _, ungated = run(bars, msgs, False)
        self.assertFalse(ungated["rth_applied"])
        self.assertIsNone(ungated["rth_rule_version"])

    def test_policy_snapshot_states_the_exemption_list(self):
        with patch.object(chart_service, "RTH_EXEMPT_TICKERS", frozenset({"TSLA", "AAPL"})):
            snap = chart_service.rth_policy_snapshot()
        self.assertEqual(snap["exempt_tickers"], ["AAPL", "TSLA"])   # sorted
        self.assertEqual(snap["exempt_count"], 2)
        self.assertEqual(snap["open_et"], "09:30")
        self.assertEqual(snap["close_et"], "16:00")
        self.assertEqual(snap["rule_version"], chart_service.RTH_RULE_VERSION)


if __name__ == "__main__":
    unittest.main()


class RthApiTests(unittest.TestCase):
    """The gate has to be VISIBLE, not just active: a restriction a reader cannot
    see is a restriction they cannot check."""

    def setUp(self):
        bars, msgs = tape()
        self.bars, self.msgs = bars, msgs
        self.client = chart_service.app.test_client()
        chart_service._positions_batch_cache.clear()
        chart_service._corr_batch_cache.clear()
        self.patchers = [
            patch.object(chart_service, "_latest_session_bars", return_value=(bars, DATE)),
            patch.object(chart_service.social_store, "read_doc",
                         side_effect=lambda *_a, **_k: {"messages": [], "win": None}),
            patch.object(chart_service.social_store, "docs_to_msgs", return_value=msgs),
            patch.object(chart_service, "_try_claim_topup", return_value=False),
            patch.object(chart_service, "RTH_EXEMPT_TICKERS", frozenset({"AAPL"})),
        ]
        for p in self.patchers:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in self.patchers])

    def test_positions_batch_echoes_the_policy(self):
        r = self.client.get(
            "/api/sentchart/positions/batch?tickers=TEST&threshold=0.1&stop_pct=5").get_json()
        self.assertEqual(r["rth"]["restricted"], True)
        self.assertEqual(r["rth"]["open_et"], "09:30")
        self.assertEqual(r["rth"]["close_et"], "16:00")
        self.assertEqual(r["rth"]["exempt_tickers"], ["AAPL"])
        self.assertEqual(r["rth"]["rule_version"], chart_service.RTH_RULE_VERSION)

    def test_positions_batch_row_reports_whether_the_gate_bound_it(self):
        r = self.client.get(
            "/api/sentchart/positions/batch?tickers=TEST&threshold=0.1&stop_pct=5").get_json()
        row = r["results"]["TEST"]
        self.assertTrue(row["rth_applied"])
        self.assertEqual(row["rth_rule_version"], chart_service.RTH_RULE_VERSION)
        trade = row["trades"][0]
        self.assertEqual(trade["exit_reason"], "rth_close")
        self.assertEqual(trade["exit_time"], "16:00")
        # a flatten is a fill, and must not claim to be a stop-out
        self.assertEqual(trade["status"], "Flattened at close")

    def test_an_exempt_ticker_reports_itself_unbound(self):
        chart_service._positions_batch_cache.clear()
        r = self.client.get(
            "/api/sentchart/positions/batch?tickers=AAPL&threshold=0.1&stop_pct=5").get_json()
        row = r["results"]["AAPL"]
        self.assertFalse(row["rth_applied"])
        self.assertIsNone(row["rth_rule_version"])
        self.assertEqual(row["trades"][0]["exit_reason"], "session_end")

    def test_signals_endpoint_shows_the_same_restricted_markers(self):
        """The research chart must draw the trades the live strategy takes."""
        r = self.client.get("/api/sentchart/signals/TEST?threshold=0.1&stop_pct=5").get_json()
        self.assertTrue(r["rth_applied"])
        self.assertEqual(r["rth"]["rule_version"], chart_service.RTH_RULE_VERSION)
        exits = [m for m in r["markers"] if m["type"] == "exit"]
        self.assertTrue(exits)
        self.assertEqual(exits[-1]["reason"], "rth_close")
        batch = self.client.get(
            "/api/sentchart/positions/batch?tickers=TEST&threshold=0.1&stop_pct=5").get_json()
        self.assertEqual(exits[-1]["reason"],
                         batch["results"]["TEST"]["trades"][-1]["exit_reason"])
