import test from 'node:test'
import assert from 'node:assert/strict'
import {
  simulateSlotDay, clampSlotCapital, slotShortLabel, slotAssumptionLabel,
  SLOT_DEFAULT_CAPITAL_USD, SLOT_MIN_CAPITAL_USD, SLOT_MAX_CAPITAL_USD, SLOT_COUNT,
} from '../slotSim.ts'

// Real production rows, pulled from /api/position-screener and trimmed to the
// fields the simulation reads. Using real shapes keeps the proportionality
// claim honest — synthetic rows could accidentally avoid the skip path, which
// is exactly the behaviour that must NOT scale with the dollar amount.
// Captured from /api/position-screener on 2026-08-05: the 2026-08-03 session, the
// densest on record, with 22 entered signals against 5 slots — so the skip path is
// genuinely exercised rather than assumed. SLOT_ROWS/SLOT_DATE override it if
// you want to re-check against a live payload.
const FIXTURE_ROWS = [
  {
    "ticker": "XAIR",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "15:40",
    "exit_time": "16:00",
    "pnl_pct": 2.58,
    "entry_price": 6.171,
    "exit_price": 6.33
  },
  {
    "ticker": "AUTL",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "15:37",
    "exit_time": "16:00",
    "pnl_pct": -1.09,
    "entry_price": 1.84,
    "exit_price": 1.82
  },
  {
    "ticker": "PRZO",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "14:42",
    "exit_time": "16:00",
    "pnl_pct": 2.68,
    "entry_price": 0.522,
    "exit_price": 0.536
  },
  {
    "ticker": "SNDK",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "14:08",
    "pnl_pct": -1.52,
    "entry_price": 1311.315,
    "exit_price": 1291.405
  },
  {
    "ticker": "SGLY",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "13:51",
    "exit_time": "15:24",
    "pnl_pct": 0.63,
    "entry_price": 5.585,
    "exit_price": 5.62
  },
  {
    "ticker": "HAO",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "13:27",
    "exit_time": "14:51",
    "pnl_pct": -2.47,
    "entry_price": 0.162,
    "exit_price": 0.158
  },
  {
    "ticker": "SGLY",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "13:11",
    "exit_time": "13:45",
    "pnl_pct": -4.35,
    "entry_price": 5.75,
    "exit_price": 5.5
  },
  {
    "ticker": "YYAI",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "13:09",
    "exit_time": "13:45",
    "pnl_pct": -4.93,
    "entry_price": 0.142,
    "exit_price": 0.135
  },
  {
    "ticker": "FCUV",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "12:55",
    "exit_time": "13:23",
    "pnl_pct": -4.24,
    "entry_price": 12.96,
    "exit_price": 12.41
  },
  {
    "ticker": "FCUV",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "12:20",
    "exit_time": "12:29",
    "pnl_pct": -8.74,
    "entry_price": 15.105,
    "exit_price": 13.785
  },
  {
    "ticker": "UPC",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "11:53",
    "exit_time": "12:06",
    "pnl_pct": 6.41,
    "entry_price": 6.55,
    "exit_price": 6.97
  },
  {
    "ticker": "GIFT",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "11:39",
    "exit_time": "11:53",
    "pnl_pct": 0,
    "entry_price": 1.03,
    "exit_price": 1.03
  },
  {
    "ticker": "SGLY",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "11:34",
    "exit_time": "12:51",
    "pnl_pct": 2.38,
    "entry_price": 5.47,
    "exit_price": 5.6
  },
  {
    "ticker": "MGN",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "11:22",
    "exit_time": "11:25",
    "pnl_pct": 2.55,
    "entry_price": 0.196,
    "exit_price": 0.201
  },
  {
    "ticker": "GXAI",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "11:20",
    "exit_time": "15:53",
    "pnl_pct": -3.83,
    "entry_price": 0.835,
    "exit_price": 0.803
  },
  {
    "ticker": "SGLY",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "10:43",
    "exit_time": "11:10",
    "pnl_pct": -3.91,
    "entry_price": 5.495,
    "exit_price": 5.28
  },
  {
    "ticker": "SXTC",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "10:42",
    "exit_time": "11:50",
    "pnl_pct": 18.31,
    "entry_price": 0.071,
    "exit_price": 0.084
  },
  {
    "ticker": "WYFI",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "10:33",
    "exit_time": "16:00",
    "pnl_pct": -1.05,
    "entry_price": 26.225,
    "exit_price": 25.95
  },
  {
    "ticker": "LNAI",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "10:32",
    "exit_time": "10:58",
    "pnl_pct": 34.47,
    "entry_price": 2.35,
    "exit_price": 3.16
  },
  {
    "ticker": "NWL",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "10:14",
    "exit_time": "16:00",
    "pnl_pct": 0.87,
    "entry_price": 6.305,
    "exit_price": 6.36
  },
  {
    "ticker": "FCUV",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "10:08",
    "exit_time": "10:23",
    "pnl_pct": -5.43,
    "entry_price": 15.44,
    "exit_price": 14.601
  },
  {
    "ticker": "AXTI",
    "date": "2026-08-03",
    "group": "closed_earlier",
    "entry_time": "10:00",
    "exit_time": "16:00",
    "pnl_pct": 6.29,
    "entry_price": 64.485,
    "exit_price": 68.54
  }
] as unknown as Parameters<typeof simulateSlotDay>[0]

const rows = process.env.SLOT_ROWS ? JSON.parse(process.env.SLOT_ROWS) : FIXTURE_ROWS
const DATE = process.env.SLOT_DATE || "2026-08-03"

test('clamp: default when the field is empty or nonsense', () => {
  assert.equal(clampSlotCapital(''), SLOT_DEFAULT_CAPITAL_USD)
  assert.equal(clampSlotCapital('abc'), SLOT_DEFAULT_CAPITAL_USD)
  assert.equal(clampSlotCapital(null), SLOT_DEFAULT_CAPITAL_USD)
  assert.equal(clampSlotCapital(undefined), SLOT_DEFAULT_CAPITAL_USD)
  assert.equal(clampSlotCapital(NaN), SLOT_DEFAULT_CAPITAL_USD)
})

test('clamp: zero and negatives are refused, not passed through', () => {
  assert.equal(clampSlotCapital(0), SLOT_MIN_CAPITAL_USD)
  assert.equal(clampSlotCapital(-500), SLOT_MIN_CAPITAL_USD)
  assert.equal(clampSlotCapital('-1'), SLOT_MIN_CAPITAL_USD)
})

test('clamp: above the ceiling is capped', () => {
  assert.equal(clampSlotCapital(SLOT_MAX_CAPITAL_USD * 10), SLOT_MAX_CAPITAL_USD)
})

test('clamp: currency formatting a user might paste is accepted', () => {
  assert.equal(clampSlotCapital('$2,500'), 2500)
  assert.equal(clampSlotCapital(' 750 '), 750)
})

test('clamp: ordinary values pass through untouched', () => {
  for (const v of [SLOT_MIN_CAPITAL_USD, 100, 1000, 25_000, SLOT_MAX_CAPITAL_USD]) {
    assert.equal(clampSlotCapital(v), v)
  }
})

test('default is still $1,000 — untouched behaviour is unchanged', () => {
  assert.equal(SLOT_DEFAULT_CAPITAL_USD, 1000)
  const sim = simulateSlotDay(rows, DATE)
  assert.equal(sim.startingCapital, 1000)
  assert.equal(sim.slotCount, SLOT_COUNT)
  assert.equal(sim.capitalPerSlot, 200)
})

test('labels track the chosen amount', () => {
  assert.match(slotShortLabel(1000), /5 slots × \$200 = \$1,000/)
  assert.match(slotShortLabel(5000), /5 slots × \$1,000 = \$5,000/)
  assert.match(slotAssumptionLabel(5000), /\$5,000 had been split across 5/)
})

// ---- the real-data claims ----

test('dollars scale linearly with the starting amount', () => {
  const base = simulateSlotDay(rows, DATE, { startingCapital: 1000 })
  for (const mult of [2, 5, 12.5]) {
    const scaled = simulateSlotDay(rows, DATE, { startingCapital: 1000 * mult })
    assert.equal(scaled.capitalPerSlot, base.capitalPerSlot * mult)
    assert.ok(Math.abs(scaled.endingValue - base.endingValue * mult) < 0.01,
      `endingValue ${scaled.endingValue} != ${base.endingValue * mult}`)
    assert.ok(Math.abs(scaled.pnlUsd - base.pnlUsd * mult) < 0.01,
      `pnlUsd ${scaled.pnlUsd} != ${base.pnlUsd * mult}`)
  }
})

test('percentage return is invariant to the starting amount', () => {
  const a = simulateSlotDay(rows, DATE, { startingCapital: 1000 })
  const b = simulateSlotDay(rows, DATE, { startingCapital: 250_000 })
  assert.ok(Math.abs(a.pnlPct - b.pnlPct) < 1e-9, `${a.pnlPct} vs ${b.pnlPct}`)
})

test('the honesty counts do NOT move with the dollar amount', () => {
  // Which signals were taken, skipped or left unresolved is a function of slot
  // occupancy, not of size. If any of these drift, the amount has started
  // changing the strategy rather than rescaling it.
  const a = simulateSlotDay(rows, DATE, { startingCapital: 1000 })
  const b = simulateSlotDay(rows, DATE, { startingCapital: 750_000 })
  const invariantKeys = ['signalN', 'takenN', 'skippedN', 'unresolvedN', 'unresolvedStaleN', 'unresolvedNoPnlN', 'skippedResolvedN', 'slotCount'] as const
  for (const k of invariantKeys) {
    assert.equal(a[k], b[k], `${k} changed with capital: ${a[k]} -> ${b[k]}`)
  }
  assert.ok(Math.abs(a.skippedPctSum - b.skippedPctSum) < 1e-9, 'skippedPctSum changed with capital')
  assert.deepEqual(a.trades.map(t => t.ticker), b.trades.map(t => t.ticker), 'trade selection changed with capital')
})

test('slot count stays fixed regardless of amount', () => {
  for (const cap of [SLOT_MIN_CAPITAL_USD, 1000, SLOT_MAX_CAPITAL_USD]) {
    const sim = simulateSlotDay(rows, DATE, { startingCapital: cap })
    assert.equal(sim.slotCount, SLOT_COUNT)
    assert.equal(sim.slotBalances.length, SLOT_COUNT)
    assert.ok(Math.abs(sim.capitalPerSlot - cap / SLOT_COUNT) < 1e-9)
  }
})
