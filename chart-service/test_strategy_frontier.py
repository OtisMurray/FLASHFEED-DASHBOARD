"""The data frontier bound on the shared strategy grid.

Regression cover for the phantom-entry bug. Mid-session the tape only reaches
"now", and the strategy used to keep walking the rest of the 04:00-20:00 grid on
forward-filled price, taking entries on minutes that had not happened and
snapping them back to the last real bar — entry == peak == current_price, so the
position rendered as a live 0.00%. Observed on 2026-07-30 at 16:16 ET with
entries at grid minutes 16:21, 17:31, 17:36 and 18:11.

_price_density_grid now stops at the last real bar, so every consumer of the
shared grid — signals, positions batch, corr batch — inherits the bound.

`old_price_density_grid` below is the pre-fix implementation, kept so the tests
can show the difference rather than assert the fix in a vacuum.
"""
import math
import unittest
from collections import Counter
from datetime import datetime, timedelta

import chart_service

DATE = "2026-07-24"
SESSION_START = datetime(2026, 7, 24, 4, 0)


def old_price_density_grid(msgs, bars, date_used):
    """The pre-fix grid: the full 960-minute session, price carried flat past the
    last real bar for as long as the grid runs."""
    minute_count = Counter()
    for dt_et, _sent in msgs:
        minute_count[dt_et.replace(second=0, microsecond=0)] += 1
    grid = chart_service._session_minute_grid(date_used)
    density = [float(minute_count.get(m, 0)) for m in grid]
    bar_by_min = {b["ts"].replace(second=0, microsecond=0): b for b in bars}
    price, eff_bar, last = [None] * len(grid), [None] * len(grid), None
    for idx, m in enumerate(grid):
        b = bar_by_min.get(m)
        if b is not None:
            last = b
        if last is not None:
            price[idx] = last["close"]
            eff_bar[idx] = last
    return grid, density, price, eff_bar


def _bar(ts, close):
    return {"ts": ts, "open": close, "high": close + 0.05,
            "low": close - 0.05, "close": close, "volume": 100}


def phase_flip_tape(end_h=16, end_m=16):
    """Density anti-correlated with price early, correlated late, so the rolling
    correlation climbs through 0.10 at a REAL minute (13:19) — a genuine entry."""
    end = datetime(2026, 7, 24, end_h, end_m)
    bars, msgs, ts, i = [], [], SESSION_START, 0
    while ts <= end:
        close = round(100 + 3 * math.sin(i / 97.0), 4)
        bars.append(_bar(ts, close))
        level = close - 97.0
        count = int(round(level * 2)) if i >= 400 else int(round((6.0 - level) * 2))
        msgs.extend((ts, "Bullish") for _ in range(max(0, count)))
        ts += timedelta(minutes=1)
        i += 1
    return bars, msgs


def fading_tape(end_h=16, end_m=16, drop=80):
    """Price fades hard into the frontier, leaving the last close well below the
    window mean. The carried tail then drags the correlation UP through 0.10 at a
    minute that has not happened — the phantom entry, reproduced."""
    end = datetime(2026, 7, 24, end_h, end_m)
    n = int((end - SESSION_START).total_seconds() // 60) + 1
    bars, msgs, ts, i = [], [], SESSION_START, 0
    while ts <= end:
        close = 100 + 2.0 * math.sin(i / 97.0)
        if i > n - drop:
            close -= (i - (n - drop)) * 0.02
        close = round(close, 4)
        bars.append(_bar(ts, close))
        count = int(round((close - 98.0) * 0.5))
        msgs.extend((ts, "Bullish") for _ in range(max(0, count)))
        ts += timedelta(minutes=1)
        i += 1
    return bars, msgs


def crossings(grid, corr, threshold=0.10):
    return [grid[i] for i in range(1, len(corr))
            if corr[i - 1] is not None and corr[i] is not None
            and corr[i - 1] <= threshold < corr[i]]


class PhantomEntryRegressionTests(unittest.TestCase):
    """The bug itself: an entry taken on a minute that has not happened."""

    def setUp(self):
        self.bars, self.msgs = fading_tape()
        self.last_bar_ts = max(b["ts"] for b in self.bars)

    def test_old_grid_did_take_an_entry_past_the_frontier(self):
        """Guards the fixture: if this stops reproducing the bug, the test below
        stops proving anything."""
        grid, density, price, _e = old_price_density_grid(self.msgs, self.bars, DATE)
        found = crossings(grid, chart_service._rolling_corr_pd(price, density))
        phantom = [m for m in found if m > self.last_bar_ts]
        self.assertEqual([m.strftime("%H:%M") for m in phantom], ["19:34"])
        self.assertGreater(phantom[0], self.last_bar_ts + timedelta(hours=3))

    def test_bounded_grid_takes_no_entry_past_the_frontier(self):
        grid, density, price, _e = chart_service._price_density_grid(
            self.msgs, self.bars, DATE)
        found = crossings(grid, chart_service._rolling_corr_pd(price, density))
        self.assertEqual([m for m in found if m > self.last_bar_ts], [])

    def test_no_zero_duration_trade_survives(self):
        """The observable fingerprint. Marker TIMES cannot catch a phantom —
        every marker is snapped to eff_bar, so a 19:34 entry reports the 16:16
        bar and looks in-range. What gives it away is that its entry and exit
        land on the SAME bar: a position opened and closed at one price, which is
        what rendered as entry == peak == current_price and 0.00%."""
        markers, _stats = chart_service._compute_strategy_signals(
            "TEST", self.bars, DATE, 0.10, 5.0, msgs=self.msgs)
        pairs = list(zip(markers[::2], markers[1::2]))
        for entry, exit_ in pairs:
            self.assertNotEqual(
                entry["time"], exit_["time"],
                "zero-duration trade: entry and exit snapped to the same bar")

    def test_the_phantom_position_is_gone_entirely(self):
        """Not relabelled, not zero-P&L — absent. The strategy never took it."""
        markers, stats = chart_service._compute_strategy_signals(
            "TEST", self.bars, DATE, 0.10, 5.0, msgs=self.msgs)
        self.assertEqual(stats["trades"], 0)
        self.assertEqual(markers, [])


class PriceDensityGridFrontierTests(unittest.TestCase):
    def test_grid_stops_at_the_last_real_bar(self):
        bars, msgs = phase_flip_tape(12, 0)
        grid, density, price, eff_bar = chart_service._price_density_grid(msgs, bars, DATE)
        self.assertEqual(len(grid), len(density))
        self.assertEqual(len(grid), len(price))
        self.assertEqual(len(grid), len(eff_bar))
        self.assertEqual(grid[-1], datetime(2026, 7, 24, 12, 0))
        self.assertEqual(len(grid), 8 * 60 + 1)          # 04:00..12:00 inclusive
        self.assertLess(len(grid), 960)
        self.assertEqual(eff_bar[-1]["ts"], max(b["ts"] for b in bars))

    def test_gaps_inside_the_tape_keep_their_forward_fill(self):
        """A hole in the middle really elapsed — the research definition counts
        it — so the bound must not shorten or hole the series there."""
        bars, msgs = phase_flip_tape(12, 0)
        kept = [b for b in bars
                if not (datetime(2026, 7, 24, 9, 0) < b["ts"] < datetime(2026, 7, 24, 10, 0))]
        grid, _d, price, _e = chart_service._price_density_grid(msgs, kept, DATE)
        self.assertEqual(grid[-1], datetime(2026, 7, 24, 12, 0))
        gap_idx = grid.index(datetime(2026, 7, 24, 9, 30))
        self.assertIsNotNone(price[gap_idx], "interior gap must stay forward-filled")
        self.assertTrue(all(p is not None for p in price))

    def test_no_in_window_bars_yields_empty_series(self):
        self.assertEqual(chart_service._price_density_grid([], [], DATE), ([], [], [], []))

    def test_corr_is_defined_over_real_minutes_not_the_whole_session(self):
        bars, msgs = phase_flip_tape()
        grid, density, price, _e = chart_service._price_density_grid(msgs, bars, DATE)
        corr = chart_service._rolling_corr_pd(price, density)
        defined = [i for i, c in enumerate(corr) if c is not None]
        self.assertTrue(defined)
        self.assertLessEqual(grid[defined[-1]], max(b["ts"] for b in bars))
        # 04:00..16:16 inclusive is 737 real minutes, less the 359-minute warm-up.
        self.assertEqual(len(corr), 737)
        self.assertEqual(defined[-1], 736)
        # The pre-fix signature was 601 defined minutes for ANY ticker, because
        # the tail always ran to 19:59 regardless of how much tape existed.
        old_grid, old_d, old_p, _ = old_price_density_grid(msgs, bars, DATE)
        old_corr = chart_service._rolling_corr_pd(old_p, old_d)
        self.assertEqual(sum(1 for c in old_corr if c is not None), 601)
        self.assertEqual(old_grid[-1], datetime(2026, 7, 24, 19, 59))


class RealEntriesUnaffectedTests(unittest.TestCase):
    """corr at minute i reads only the window ENDING at i, so truncating the tail
    cannot move a crossing that already happened. These pin that."""

    def test_real_entry_timing_is_identical_before_and_after_the_bound(self):
        bars, msgs = phase_flip_tape()
        new_grid, new_d, new_p, _ = chart_service._price_density_grid(msgs, bars, DATE)
        old_grid, old_d, old_p, _ = old_price_density_grid(msgs, bars, DATE)
        frontier = max(b["ts"] for b in bars)
        new_hits = crossings(new_grid, chart_service._rolling_corr_pd(new_p, new_d))
        old_hits = [m for m in crossings(old_grid, chart_service._rolling_corr_pd(old_p, old_d))
                    if m <= frontier]
        self.assertEqual(new_hits, old_hits)
        self.assertEqual([m.strftime("%H:%M") for m in new_hits], ["13:19"])

    def test_corr_values_at_real_minutes_are_bit_identical(self):
        bars, msgs = phase_flip_tape()
        _g, new_d, new_p, _ = chart_service._price_density_grid(msgs, bars, DATE)
        _og, old_d, old_p, _ = old_price_density_grid(msgs, bars, DATE)
        new_corr = chart_service._rolling_corr_pd(new_p, new_d)
        old_corr = chart_service._rolling_corr_pd(old_p, old_d)
        self.assertEqual(new_corr, old_corr[:len(new_corr)])

    def test_a_growing_tape_does_not_move_an_entry_already_taken(self):
        """The churn check: re-simulating later in the day must reproduce the
        same entry minute, not walk it forward one cycle at a time."""
        short_bars, short_msgs = phase_flip_tape(14, 30)
        long_bars, long_msgs = phase_flip_tape(16, 16)
        short, short_stats = chart_service._compute_strategy_signals(
            "TEST", short_bars, DATE, 0.10, 5.0, msgs=short_msgs)
        long, _ = chart_service._compute_strategy_signals(
            "TEST", long_bars, DATE, 0.10, 5.0, msgs=long_msgs)
        self.assertEqual(short_stats["trades"], 1, "fixture must hold a real trade")
        frontier = chart_service._epoch_utc(max(b["ts"] for b in short_bars))
        self.assertEqual(
            [m["time"] for m in short if m["type"] == "entry"],
            [m["time"] for m in long if m["type"] == "entry" and m["time"] <= frontier],
        )

    def test_session_end_exit_marks_the_frontier_bar(self):
        bars, msgs = phase_flip_tape()
        last_bar = max(bars, key=lambda b: b["ts"])
        markers, _s = chart_service._compute_strategy_signals(
            "TEST", bars, DATE, 0.10, 5.0, msgs=msgs)
        holds = [m for m in markers
                 if m["type"] == "exit" and m.get("reason") == "session_end"]
        self.assertTrue(holds, "fixture must leave a position open at the frontier")
        for m in holds:
            self.assertEqual(m["time"], chart_service._epoch_utc(last_bar["ts"]))
            self.assertEqual(m["price"], round(last_bar["close"], 4))


class BarsSinceEntryTests(unittest.TestCase):
    """The honest label for a genuine entry on the newest bar (the NUWE case)."""

    def test_zero_exactly_when_the_entry_is_the_frontier_bar(self):
        bars, msgs = phase_flip_tape()
        frontier = chart_service._epoch_utc(max(b["ts"] for b in bars))
        markers, _s = chart_service._compute_strategy_signals(
            "TEST", bars, DATE, 0.10, 5.0, msgs=msgs)
        entries = [m for m in markers if m["type"] == "entry"]
        self.assertTrue(entries)
        for m in entries:
            since = sum(1 for b in bars if chart_service._epoch_utc(b["ts"]) > m["time"])
            self.assertEqual(since == 0, m["time"] == frontier)

    def test_an_established_position_reports_real_elapsed_bars(self):
        bars, msgs = phase_flip_tape()
        markers, _s = chart_service._compute_strategy_signals(
            "TEST", bars, DATE, 0.10, 5.0, msgs=msgs)
        entry = next(m for m in markers if m["type"] == "entry")
        since = sum(1 for b in bars if chart_service._epoch_utc(b["ts"]) > entry["time"])
        self.assertEqual(since, 177)          # 13:19 -> 16:16


if __name__ == "__main__":
    unittest.main()
