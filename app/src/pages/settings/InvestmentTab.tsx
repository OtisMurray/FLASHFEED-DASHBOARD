import { Section } from './shared'
import { ILLUSTRATIVE_NOTIONAL_USD } from '@/lib/notional'
import { SLOT_COUNT, SLOT_STARTING_CAPITAL_USD } from '@/lib/slotSim'

export type InvestmentSettings = {
  position_policy?: {
    policy_id?: string
    canonical?: { threshold?: number; stop_pct?: number }
    tiers?: Record<string, { threshold?: number; stop_pct?: number }>
    tier_values_differentiated?: boolean
  }
  limits?: { thresholdMin?: number; thresholdMax?: number; stopPctMin?: number; stopPctMax?: number }
  corr_window_minutes?: number
  position_history?: { enabled?: boolean; interval_seconds?: number }
  rth?: { enforced_by?: string; authoritative_config?: string; observed_at?: string }
  position_sizing?: { available?: boolean; note?: string }
} | null

/**
 * Investment & risk.
 *
 * READ-ONLY, and that is the honest state of this system rather than an
 * unfinished tab. These values are not user preferences: they are the
 * parameters the recorded position history was measured at, and changing one
 * from a settings page would silently re-key history recorded under the old
 * one. The Positions page already exposes the two an operator may vary, and it
 * does so as an explicit what-if rather than as a saved setting.
 *
 * Every number is fetched from the module that owns it. Nothing is restated
 * here, so nothing here can drift from what the screeners actually run under.
 */
export function InvestmentTab({ settings }: { settings: InvestmentSettings }) {
  if (!settings) {
    return (
      <Section title="Investment & risk">
        <p className="text-sm text-neutral">Loading the current defaults…</p>
      </Section>
    )
  }

  const canonical = settings.position_policy?.canonical || {}
  const limits = settings.limits || {}
  const tiers = Object.entries(settings.position_policy?.tiers || {})
  const differentiated = settings.position_policy?.tier_values_differentiated

  return (
    <div className="space-y-6">
      <Section
        title="Entry & exit defaults"
        hint="What the screeners and the recorded position history run at. Read-only here — the Positions page varies them as an explicit what-if, which is not the same as a saved setting."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          <Stat
            label="Entry correlation threshold"
            value={fmt(canonical.threshold)}
            note={range(limits.thresholdMin, limits.thresholdMax)}
          />
          <Stat
            label="Trailing stop"
            value={canonical.stop_pct == null ? '--' : `${canonical.stop_pct}%`}
            note={range(limits.stopPctMin, limits.stopPctMax, '%')}
          />
          <Stat
            label="Correlation window"
            value={settings.corr_window_minutes == null ? '--' : `${settings.corr_window_minutes} min`}
            note="rolling window the strategy scores on"
          />
          <Stat
            label="Position recorder"
            value={settings.position_history?.enabled ? 'on' : 'off'}
            note={settings.position_history?.interval_seconds
              ? `every ${Math.round(settings.position_history.interval_seconds / 60)} min`
              : undefined}
          />
        </div>
        <p className="text-[11px] text-neutral mt-3">
          Policy <span className="font-mono">{settings.position_policy?.policy_id || 'unknown'}</span>.
        </p>
      </Section>

      <Section
        title="Per-tier parameters"
        hint={differentiated
          ? 'Tiers currently run at different values.'
          : 'The plumbing is tier-aware; every tier is currently seeded at the same values. Tier-specific numbers were backtested and lost money on four of five tiers, so they have not been applied.'}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-neutral border-b border-border">
                <th className="py-2 pr-3">Tier</th>
                <th className="py-2 pr-3 text-right">Threshold</th>
                <th className="py-2 pr-3 text-right">Trailing stop</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map(([tier, p]) => (
                <tr key={tier} className="border-b border-border/50">
                  <td className="py-2 pr-3 text-white">{tier}</td>
                  <td className="py-2 pr-3 text-right font-mono text-neutral">{fmt(p.threshold)}</td>
                  <td className="py-2 pr-3 text-right font-mono text-neutral">{p.stop_pct == null ? '--' : `${p.stop_pct}%`}</td>
                </tr>
              ))}
              {!tiers.length && (
                <tr><td colSpan={3} className="py-4 text-center text-neutral">No tier policy reported.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="Trading hours"
        hint="Enforced by the chart-service, which is where the gate binds. This service deliberately keeps no copy of the exemption list — a second copy of a trading gate's config is one that can disagree with the one actually binding."
      >
        <dl className="text-sm space-y-1">
          <Row term="Enforced by" desc={settings.rth?.enforced_by || '--'} />
          <Row term="Authoritative config" desc={settings.rth?.authoritative_config || '--'} />
          <Row term="What the gate did" desc={settings.rth?.observed_at || '--'} />
        </dl>
      </Section>

      <Section
        title="Position sizing"
        hint="There is no position sizing in this system, and this page does not add any."
      >
        <p className="text-sm text-neutral">
          {settings.position_sizing?.note
            || 'No position size is carried anywhere in the API.'}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
          <Stat
            label="Illustrative notional"
            value={`$${ILLUSTRATIVE_NOTIONAL_USD.toLocaleString()}`}
            note="per trade, display only"
          />
          <Stat
            label="Slot simulation"
            value={`$${SLOT_STARTING_CAPITAL_USD.toLocaleString()} / ${SLOT_COUNT} slots`}
            note="slot count is measured from recorded trades, not chosen"
          />
        </div>
      </Section>
    </div>
  )
}

function fmt(n?: number) {
  return n == null ? '--' : String(n)
}

function range(min?: number, max?: number, suffix = '') {
  if (min == null || max == null) return undefined
  return `adjustable ${min}${suffix}–${max}${suffix} on Positions`
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="border border-border rounded p-3 bg-bg/40">
      <div className="text-[10px] text-neutral uppercase tracking-wide">{label}</div>
      <div className="font-mono text-lg text-white mt-1">{value}</div>
      {note && <div className="text-[11px] text-neutral mt-0.5">{note}</div>}
    </div>
  )
}

function Row({ term, desc }: { term: string; desc: string }) {
  return (
    <div className="flex flex-col sm:flex-row sm:gap-3">
      <dt className="text-neutral sm:w-48 shrink-0">{term}</dt>
      <dd className="text-slate-200 break-words">{desc}</dd>
    </div>
  )
}
