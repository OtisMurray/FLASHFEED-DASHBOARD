#!/usr/bin/env node --experimental-strip-types
/**
 * Verifies the fixed-slot capital simulation on the Positions page.
 *
 * Run against a live API response, not a fixture:
 *   curl -s 'http://localhost:3001/api/position-screener?historyDays=90' -o /tmp/positions.json
 *   node --experimental-strip-types app/scripts/verify-slot-sim.mjs /tmp/positions.json
 *
 * It imports src/lib/slotSim.ts DIRECTLY — the same module the page renders
 * from — so this cannot pass while the page computes something else. Same
 * convention as verify-notional.mjs, which covers the flat-per-trade display
 * this simulation sits alongside.
 *
 * Six things are checked, in descending order of how badly they would hurt:
 *
 *  1. INDEPENDENT REIMPLEMENTATION. The slot walk is re-derived below by a
 *     different method — an explicit occupancy timeline rather than a
 *     release-minute array — and must agree with the module trade for trade on
 *     every real session. Agreement between two implementations written from
 *     opposite directions is the only thing that makes the allocation credible.
 *  2. CAPACITY INVARIANTS. Never more than N positions funded at once; every
 *     skipped signal genuinely had all N slots busy at its entry minute; every
 *     funded signal genuinely had one free. This is what "skipped trades are
 *     correctly identified" means, checked against the timeline rather than
 *     against the same array that produced the answer.
 *  3. CONSERVATION. The total equals the sum of the slots, the sum of the
 *     per-trade dollar changes, and a per-slot compounding walk. Skipped and
 *     unresolved signals move exactly zero.
 *  4. HAND-CHECK LEDGER. One full session printed transition by transition,
 *     with each row's arithmetic asserted against the raw recorded trade it
 *     came from, so the math can be read rather than trusted.
 *  5. REFUSAL CASES. Stale and withheld-P&L rows hold their slot and compound
 *     nothing. Driven by synthetic rows, because a given day may contain none.
 *  6. DIVERGENCE FROM FLAT-PER-TRADE. Reported, not asserted: the two models
 *     must not be interchangeable, and seeing the gap is the point.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const {
  SLOT_COUNT,
  SLOT_STARTING_CAPITAL_USD,
  CAPITAL_PER_SLOT_USD,
  simulateSlotDay,
  slotSimDates,
  minuteOfDay,
  sessionCloseMinute,
  fmtSlotUsd,
  fmtSlotDelta,
} = await import(join(HERE, '../src/lib/slotSim.ts'))
const { dollarsFromPct } = await import(join(HERE, '../src/lib/notional.ts'))

const EPS = 1e-9
const CENT = 1e-6

let failures = 0
let checks = 0
function check(label, condition, detail = '') {
  checks += 1
  if (!condition) {
    failures += 1
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(title) { console.log(`\n${title}`) }
function hhmm(m) { return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` }

// ── input ────────────────────────────────────────────────────────────────────
const payloadPath = resolve(process.argv[2] || '/tmp/positions.json')
const payload = JSON.parse(readFileSync(payloadPath, 'utf8'))
const rows = payload.rows ?? []
if (!rows.length) {
  console.error(`No rows in ${payloadPath} — nothing to verify against.`)
  process.exit(1)
}
const dates = slotSimDates(rows)
if (!dates.length) {
  console.error(`No datable entered positions in ${payloadPath} — nothing to simulate.`)
  process.exit(1)
}
console.log(`Positions payload: ${payloadPath}`)
console.log(`  rows=${rows.length}  sessions=${dates.length} (${dates.join(', ')})`)
console.log(`  model: ${SLOT_COUNT} slots × $${CAPITAL_PER_SLOT_USD.toLocaleString()}`
  + ` = $${SLOT_STARTING_CAPITAL_USD.toLocaleString()}`)

// ── the independent reimplementation ─────────────────────────────────────────
// Same rules, opposite construction: this one materialises a minute-by-minute
// occupancy timeline and asks "is the pool full at this minute?", where the
// module keeps a per-slot release array and asks "is any slot free?". Both must
// answer identically, including WHICH slot, for every trade.
function slotWalkIndependent(allRows, date, slotCount = SLOT_COUNT, capital = SLOT_STARTING_CAPITAL_USD) {
  const identity = r => [r.ticker, r.date ?? '', r.entry_time ?? '', r.entry_price ?? ''].join('|')
  const byTrade = new Map()
  for (const row of allRows) {
    if (row.group === 'watch' || row.date !== date) continue
    if (minuteOfDay(row.entry_time) == null) continue
    const k = identity(row)
    const held = byTrade.get(k)
    if (!held || (held.data_status !== 'recorded' && row.data_status === 'recorded')) byTrade.set(k, row)
  }
  const signals = [...byTrade.values()].sort((a, b) =>
    (minuteOfDay(a.entry_time) - minuteOfDay(b.entry_time)) || a.ticker.localeCompare(b.ticker))

  const perSlot = capital / slotCount
  // occupancy[slot] = list of [start, end) intervals this slot held.
  const occupancy = Array.from({ length: slotCount }, () => [])
  const ledger = []
  for (const row of signals) {
    const entry = minuteOfDay(row.entry_time)
    const exit = minuteOfDay(row.exit_time)
    const release = Math.max(exit ?? sessionCloseMinute(row), entry + 1)
    // A slot is available if none of its intervals covers the entry minute.
    const busy = s => occupancy[s].some(([a, b]) => a <= entry && entry < b)
    let picked = null
    for (let s = 0; s < slotCount; s += 1) { if (!busy(s)) { picked = s; break } }
    if (picked == null) { ledger.push({ ticker: row.ticker, outcome: 'skipped', slot: null, entry, release }); continue }
    occupancy[picked].push([entry, release])
    const unresolved = row.data_status === 'stale' || row.pnl_pct == null || !Number.isFinite(row.pnl_pct)
    ledger.push({
      ticker: row.ticker,
      outcome: unresolved ? 'unresolved' : 'taken',
      slot: picked, entry, release,
      pnlPct: unresolved ? null : row.pnl_pct,
    })
  }
  // Balances walked separately, so a bug in allocation cannot hide in the money.
  const balances = Array(slotCount).fill(perSlot)
  for (const e of ledger) {
    if (e.outcome !== 'taken') continue
    balances[e.slot] *= 1 + e.pnlPct / 100
  }
  return { ledger, balances, endingValue: balances.reduce((a, b) => a + b, 0), occupancy }
}

// ── 1. independent reimplementation agrees, on every real session ────────────
section('1. Independent reimplementation — agrees trade for trade on every real session')
const sims = new Map()
for (const date of dates) {
  const sim = simulateSlotDay(rows, date)
  sims.set(date, sim)
  const ind = slotWalkIndependent(rows, date)
  check(`${date}: same signal count`, sim.trades.length === ind.ledger.length,
    `module=${sim.trades.length} independent=${ind.ledger.length}`)
  const n = Math.min(sim.trades.length, ind.ledger.length)
  let mismatches = 0
  for (let i = 0; i < n; i += 1) {
    const a = sim.trades[i]
    const b = ind.ledger[i]
    if (a.ticker !== b.ticker || a.outcome !== b.outcome || a.slot !== b.slot
      || a.entryMinute !== b.entry || a.releaseMinute !== b.release) {
      mismatches += 1
      if (mismatches <= 3) {
        console.error(`      module: ${a.ticker} ${a.outcome} slot=${a.slot} [${a.entryMinute},${a.releaseMinute})`)
        console.error(`      indep : ${b.ticker} ${b.outcome} slot=${b.slot} [${b.entry},${b.release})`)
      }
    }
  }
  check(`${date}: ticker/outcome/slot/interval identical on all ${n}`, mismatches === 0,
    `${mismatches} mismatched`)
  check(`${date}: ending value identical`, Math.abs(sim.endingValue - ind.endingValue) < CENT,
    `module=${sim.endingValue} independent=${ind.endingValue}`)
  for (let s = 0; s < SLOT_COUNT; s += 1) {
    check(`${date}: slot ${s} balance identical`, Math.abs(sim.slotBalances[s] - ind.balances[s]) < CENT,
      `module=${sim.slotBalances[s]} independent=${ind.balances[s]}`)
  }
  console.log(`  ${date}: ${sim.signalN} signals — ${sim.takenN} taken, ${sim.unresolvedN} unresolved,`
    + ` ${sim.skippedN} skipped → ${fmtSlotUsd(sim.endingValue)} (${fmtSlotDelta(sim.pnlUsd)},`
    + ` ${sim.pnlPct >= 0 ? '+' : ''}${sim.pnlPct.toFixed(2)}%)`)
}

// ── 2. capacity invariants, checked against the occupancy timeline ───────────
section('2. Capacity invariants — pool never over-subscribed, skips genuinely unavoidable')
for (const date of dates) {
  const sim = sims.get(date)
  const funded = sim.trades.filter(t => t.outcome !== 'skipped')

  // No two positions in the same slot at the same minute.
  let overlaps = 0
  for (let s = 0; s < SLOT_COUNT; s += 1) {
    const ivs = funded.filter(t => t.slot === s).sort((a, b) => a.entryMinute - b.entryMinute)
    for (let i = 1; i < ivs.length; i += 1) {
      if (ivs[i].entryMinute < ivs[i - 1].releaseMinute) overlaps += 1
    }
  }
  check(`${date}: no slot holds two positions at once`, overlaps === 0, `${overlaps} overlapping pairs`)

  // Peak concurrent funded positions never exceeds the slot count.
  const bounds = funded.flatMap(t => [t.entryMinute, t.releaseMinute])
  let peak = 0
  for (const m of bounds) {
    peak = Math.max(peak, funded.filter(t => t.entryMinute <= m && m < t.releaseMinute).length)
  }
  check(`${date}: peak funded positions <= ${SLOT_COUNT}`, peak <= SLOT_COUNT, `peak=${peak}`)

  // Every SKIPPED signal really had all N slots occupied at its entry minute,
  // counting only the trades that were actually funded BEFORE it.
  let wrongSkips = 0
  let wrongFills = 0
  for (let i = 0; i < sim.trades.length; i += 1) {
    const t = sim.trades[i]
    const priorFunded = sim.trades.slice(0, i).filter(p => p.outcome !== 'skipped')
    const busy = priorFunded.filter(p => p.entryMinute <= t.entryMinute && t.entryMinute < p.releaseMinute).length
    if (t.outcome === 'skipped' && busy < SLOT_COUNT) {
      wrongSkips += 1
      if (wrongSkips <= 3) console.error(`      ${t.ticker} @${hhmm(t.entryMinute)} skipped with only ${busy}/${SLOT_COUNT} busy`)
    }
    if (t.outcome !== 'skipped' && busy >= SLOT_COUNT) {
      wrongFills += 1
      if (wrongFills <= 3) console.error(`      ${t.ticker} @${hhmm(t.entryMinute)} funded with ${busy}/${SLOT_COUNT} busy`)
    }
  }
  check(`${date}: every skip had all ${SLOT_COUNT} slots busy`, wrongSkips === 0, `${wrongSkips} unjustified`)
  check(`${date}: every fill had a free slot`, wrongFills === 0, `${wrongFills} over-subscribed`)
  console.log(`  ${date}: peak ${peak}/${SLOT_COUNT} concurrent · ${sim.skippedN} skips, all justified`)
}

// ── 3. conservation ──────────────────────────────────────────────────────────
section('3. Conservation — the total is the slots, the trades, and the walk')
for (const date of dates) {
  const sim = sims.get(date)
  check(`${date}: endingValue === sum of slot balances`,
    Math.abs(sim.endingValue - sim.slotBalances.reduce((a, b) => a + b, 0)) < CENT)
  check(`${date}: startingCapital === ${SLOT_COUNT} × capitalPerSlot`,
    Math.abs(sim.startingCapital - sim.slotCount * sim.capitalPerSlot) < EPS)

  // Sum of per-trade dollar changes must reconstruct the total exactly.
  const tradeSum = sim.trades.reduce((a, t) => a + (t.pnlUsd ?? 0), 0)
  check(`${date}: sum of per-trade dollars === pnlUsd`, Math.abs(tradeSum - sim.pnlUsd) < CENT,
    `trades=${tradeSum} pnl=${sim.pnlUsd}`)
  check(`${date}: pnlPct === 100 × pnlUsd / startingCapital`,
    Math.abs(sim.pnlPct - (100 * sim.pnlUsd) / sim.startingCapital) < 1e-9)

  // Skipped and unresolved move exactly zero.
  check(`${date}: skipped signals contribute no dollars`,
    sim.trades.filter(t => t.outcome === 'skipped').every(t => t.pnlUsd === null))
  check(`${date}: unresolved signals contribute exactly zero`,
    sim.trades.filter(t => t.outcome === 'unresolved')
      .every(t => t.pnlUsd === 0 && t.balanceBefore === t.balanceAfter))

  // Per-slot compounding walk, recomputed from the taken trades alone.
  for (let s = 0; s < SLOT_COUNT; s += 1) {
    const walk = sim.trades
      .filter(t => t.slot === s && t.outcome === 'taken')
      .reduce((bal, t) => bal * (1 + t.pnlPct / 100), sim.capitalPerSlot)
    check(`${date}: slot ${s} closing balance === compounding walk`,
      Math.abs(walk - sim.slotBalances[s]) < CENT, `walk=${walk} slot=${sim.slotBalances[s]}`)
  }

  // Counts partition the signal set with nothing hidden.
  check(`${date}: taken + unresolved + skipped === signalN`,
    sim.takenN + sim.unresolvedN + sim.skippedN === sim.signalN,
    `${sim.takenN}+${sim.unresolvedN}+${sim.skippedN} != ${sim.signalN}`)
  check(`${date}: unresolved reasons partition unresolvedN`,
    sim.unresolvedStaleN + sim.unresolvedNoPnlN === sim.unresolvedN)

  // Every entered position in the payload for this session is accounted for.
  const identity = r => [r.ticker, r.date ?? '', r.entry_time ?? '', r.entry_price ?? ''].join('|')
  const entered = new Set(rows
    .filter(r => r.group !== 'watch' && r.date === date && minuteOfDay(r.entry_time) != null)
    .map(identity))
  check(`${date}: every entered position appears in the ledger`, entered.size === sim.signalN,
    `payload=${entered.size} ledger=${sim.signalN}`)
}

// ── 4. hand-check ledger for one full session ────────────────────────────────
// The busiest session, so the slot reuse and any skips are actually exercised.
const handDate = [...dates].sort((a, b) => sims.get(b).signalN - sims.get(a).signalN)[0]
const hand = sims.get(handDate)
section(`4. Hand-check ledger — ${handDate}, every transition against the raw recorded trade`)
console.log(`  ${SLOT_COUNT} slots open at ${fmtSlotUsd(hand.capitalPerSlot)} each`
  + ` = ${fmtSlotUsd(hand.startingCapital)}\n`)
console.log('   #  ENTRY EXIT  TICKER  OUTCOME     SLOT        BEFORE  ×    PNL%   =         AFTER')
console.log('  ' + '─'.repeat(84))
const rawByIdentity = new Map(rows
  .filter(r => r.date === handDate)
  .map(r => [[r.ticker, r.entry_time, r.entry_price].join('|'), r]))
hand.trades.forEach((t, i) => {
  const raw = rawByIdentity.get([t.ticker, t.entryTime, rows.find(r =>
    r.date === handDate && r.ticker === t.ticker && r.entry_time === t.entryTime)?.entry_price].join('|'))
  const exit = t.exitTime ?? `${hhmm(t.releaseMinute)}*`
  if (t.outcome === 'skipped') {
    console.log(`  ${String(i + 1).padStart(2)}  ${t.entryTime} ${exit.padEnd(6)}${t.ticker.padEnd(8)}`
      + `SKIPPED     —      all ${SLOT_COUNT} slots busy`
      + (t.pnlPct != null ? `  (missed ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}%)` : ''))
    return
  }
  if (t.outcome === 'unresolved') {
    console.log(`  ${String(i + 1).padStart(2)}  ${t.entryTime} ${exit.padEnd(6)}${t.ticker.padEnd(8)}`
      + `UNRESOLVED  ${t.slot}    ${fmtSlotUsd(t.balanceBefore).padStart(10)}`
      + `  held, carried forward unchanged → ${fmtSlotUsd(t.balanceAfter)} (${t.unresolvedReason})`)
    return
  }
  console.log(`  ${String(i + 1).padStart(2)}  ${t.entryTime} ${exit.padEnd(6)}${t.ticker.padEnd(8)}`
    + `taken       ${t.slot}    ${fmtSlotUsd(t.balanceBefore).padStart(10)}`
    + `  ${(t.pnlPct >= 0 ? '+' : '') + t.pnlPct.toFixed(2)}%`.padStart(9)
    + `   ${fmtSlotUsd(t.balanceAfter).padStart(12)}`)

  // Each transition asserted against the raw row it came from.
  check(`${handDate} #${i + 1} ${t.ticker}: pct matches the recorded trade`,
    raw != null && Object.is(raw.pnl_pct, t.pnlPct), `raw=${raw?.pnl_pct} ledger=${t.pnlPct}`)
  check(`${handDate} #${i + 1} ${t.ticker}: after === before × (1 + pct/100)`,
    Math.abs(t.balanceAfter - t.balanceBefore * (1 + t.pnlPct / 100)) < CENT)
  check(`${handDate} #${i + 1} ${t.ticker}: pnlUsd === after - before`,
    Math.abs(t.pnlUsd - (t.balanceAfter - t.balanceBefore)) < CENT)
  check(`${handDate} #${i + 1} ${t.ticker}: exit minute matches the recorded exit`,
    raw?.exit_time ? t.releaseMinute === minuteOfDay(raw.exit_time)
      : t.releaseMinute === Math.max(sessionCloseMinute(raw ?? {}), t.entryMinute + 1),
    `raw=${raw?.exit_time ?? 'session close'} ledger=${hhmm(t.releaseMinute)}`)
})
console.log('  ' + '─'.repeat(84))
hand.slotBalances.forEach((b, s) => {
  const n = hand.trades.filter(t => t.slot === s).length
  console.log(`  slot ${s}: ${fmtSlotUsd(hand.capitalPerSlot)} → ${fmtSlotUsd(b).padStart(10)}`
    + `  (${n} position${n === 1 ? '' : 's'}, ${fmtSlotDelta(b - hand.capitalPerSlot)})`)
})
console.log(`  TOTAL:  ${fmtSlotUsd(hand.startingCapital)} → ${fmtSlotUsd(hand.endingValue)}`
  + `  ${fmtSlotDelta(hand.pnlUsd)} (${hand.pnlPct >= 0 ? '+' : ''}${hand.pnlPct.toFixed(2)}%)`)
console.log(`  ${hand.takenN} taken · ${hand.unresolvedN} unresolved · ${hand.skippedN} skipped`
  + (hand.skippedN ? ` (missed ${hand.skippedPctSum >= 0 ? '+' : ''}${hand.skippedPctSum.toFixed(2)}pp`
    + ` across ${hand.skippedResolvedN})` : ''))
console.log('  * = no exit of its own; slot released at session close')

// ── 5. refusal cases ─────────────────────────────────────────────────────────
section('5. Refusal cases — unresolved positions hold capital and compound nothing')
const base = {
  group: 'closed_earlier', provenance: 'recorded', ticker: 'AAA', date: '2026-08-01',
  entry_time: '10:00', exit_time: '10:30', entry_price: 10, data_status: 'recorded',
  pnl_pct: 10, pnl_is_realized: true, rth_applied: true,
}
const oneWinner = simulateSlotDay([base], '2026-08-01')
check('a single +10% trade moves one slot only',
  Math.abs(oneWinner.endingValue - (SLOT_STARTING_CAPITAL_USD + CAPITAL_PER_SLOT_USD * 0.10)) < CENT,
  `got ${oneWinner.endingValue}`)
check('...and the other slots are untouched',
  oneWinner.slotBalances.filter(b => Math.abs(b - CAPITAL_PER_SLOT_USD) < CENT).length === SLOT_COUNT - 1)

const staleSim = simulateSlotDay([{ ...base, data_status: 'stale', pnl_pct: 42 }], '2026-08-01')
check('stale row: slot value carries forward unchanged, not zeroed, not compounded',
  Math.abs(staleSim.endingValue - SLOT_STARTING_CAPITAL_USD) < CENT, `got ${staleSim.endingValue}`)
check('stale row: counted as unresolved, not taken and not skipped',
  staleSim.unresolvedN === 1 && staleSim.unresolvedStaleN === 1 && staleSim.takenN === 0 && staleSim.skippedN === 0)
check('stale row: still occupied a slot', staleSim.trades[0].slot === 0)

const withheldSim = simulateSlotDay([{ ...base, pnl_pct: null, pnl_withheld_reason: 'price_basis' }], '2026-08-01')
check('withheld-P&L row: also unresolved, also holds its slot',
  withheldSim.unresolvedN === 1 && withheldSim.unresolvedNoPnlN === 1
  && Math.abs(withheldSim.endingValue - SLOT_STARTING_CAPITAL_USD) < CENT)

// An unresolved position must be able to EVICT a later signal — that is the
// whole reason it holds the slot rather than being dropped.
const crowd = Array.from({ length: SLOT_COUNT + 1 }, (_, i) => ({
  ...base, ticker: `T${i}`, entry_time: '10:00', exit_time: null, exit_reason: 'session_end',
  data_status: 'stale', pnl_pct: 5,
}))
const crowdSim = simulateSlotDay(crowd, '2026-08-01')
check(`${SLOT_COUNT + 1} simultaneous unresolved holds: ${SLOT_COUNT} fill, 1 skipped`,
  crowdSim.unresolvedN === SLOT_COUNT && crowdSim.skippedN === 1,
  `unresolved=${crowdSim.unresolvedN} skipped=${crowdSim.skippedN}`)
check('...and the total is still exactly the starting capital',
  Math.abs(crowdSim.endingValue - SLOT_STARTING_CAPITAL_USD) < CENT)

// Skipping must not quietly change the total either way.
const overflow = Array.from({ length: SLOT_COUNT + 2 }, (_, i) => ({
  ...base, ticker: `S${i}`, entry_time: '10:00', exit_time: '15:00', pnl_pct: 10,
}))
const overflowSim = simulateSlotDay(overflow, '2026-08-01')
check(`${SLOT_COUNT + 2} simultaneous winners: only ${SLOT_COUNT} are funded`,
  overflowSim.takenN === SLOT_COUNT && overflowSim.skippedN === 2,
  `taken=${overflowSim.takenN} skipped=${overflowSim.skippedN}`)
check('...total reflects the funded ones only',
  Math.abs(overflowSim.endingValue - SLOT_STARTING_CAPITAL_USD * 1.10) < CENT,
  `got ${overflowSim.endingValue}`)
check('...and the skipped percentage is reported, not absorbed',
  Math.abs(overflowSim.skippedPctSum - 20) < EPS && overflowSim.skippedResolvedN === 2,
  `sum=${overflowSim.skippedPctSum} n=${overflowSim.skippedResolvedN}`)

// Slot release at the same minute as the next entry: same 1-minute bar, so the
// capital is available. An off-by-one here silently halves effective capacity.
const backToBack = [
  { ...base, ticker: 'AAA', entry_time: '10:00', exit_time: '10:30', pnl_pct: 10 },
  { ...base, ticker: 'BBB', entry_time: '10:30', exit_time: '11:00', pnl_pct: 10 },
]
const b2b = simulateSlotDay(backToBack, '2026-08-01')
check('a slot freed at 10:30 funds a 10:30 entry (same slot, compounded)',
  b2b.takenN === 2 && b2b.skippedN === 0 && b2b.trades.every(t => t.slot === 0),
  `slots=${b2b.trades.map(t => t.slot)}`)
check('...and it compounds within the slot',
  Math.abs(b2b.slotBalances[0] - CAPITAL_PER_SLOT_USD * 1.1 * 1.1) < CENT,
  `got ${b2b.slotBalances[0]}`)

// Watch rows never entered and must not consume capital.
const withWatch = simulateSlotDay([base, { ...base, ticker: 'WCH', group: 'watch' }], '2026-08-01')
check('watch rows never occupy a slot', withWatch.signalN === 1)

// A duplicate trade (live + recorded) must fund ONE slot, not two.
const dupe = [
  { ...base, ticker: 'DUP', data_status: 'live', provenance: 'live' },
  { ...base, ticker: 'DUP', data_status: 'recorded', provenance: 'recorded' },
]
const dupeSim = simulateSlotDay(dupe, '2026-08-01')
check('a duplicated trade funds one slot, not two',
  dupeSim.signalN === 1 && dupeSim.takenN === 1, `signals=${dupeSim.signalN}`)

const emptyDay = simulateSlotDay([], '2026-08-01')
check('a session with no signals returns starting capital, flat',
  emptyDay.endingValue === SLOT_STARTING_CAPITAL_USD && emptyDay.pnlUsd === 0
  && emptyDay.pnlPct === 0 && emptyDay.signalN === 0)

// ── 6. divergence from the flat per-trade notional ───────────────────────────
section('6. Divergence from flat $1,000-per-trade (reported — the two must not agree)')
for (const date of dates) {
  const sim = sims.get(date)
  const flat = sim.trades
    .filter(t => t.outcome === 'taken')
    .reduce((a, t) => a + dollarsFromPct(t.pnlPct), 0)
  console.log(`  ${date}: flat-per-trade ${fmtSlotDelta(flat).padStart(11)} on ${sim.takenN} trades`
    + `  ·  ${SLOT_COUNT}-slot ${fmtSlotDelta(sim.pnlUsd).padStart(10)}`
    + `  ·  ratio ${flat !== 0 ? (sim.pnlUsd / flat).toFixed(2) : 'n/a'}×`)
}
console.log(`  Flat-per-trade deploys $${SLOT_STARTING_CAPITAL_USD.toLocaleString()} per position with no ceiling;`)
console.log(`  the slot model deploys $${SLOT_STARTING_CAPITAL_USD.toLocaleString()} in total. They answer`
  + ' different questions and are not interchangeable.')

// ── result ───────────────────────────────────────────────────────────────────
console.log('')
if (failures) {
  console.error(`✗ verify-slot-sim: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`✓ verify-slot-sim: ${checks} checks passed`)
