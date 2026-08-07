import { useEffect, useState } from 'react'

// Trading alerts (Entry / Exit / News).
//
// Every control here is bound to a real backend field — nothing is cosmetic.
// Channels the server cannot actually deliver on are disabled with the reason
// shown, rather than rendered as working switches that would silently no-op.

const jsonFetch = (url: string, init?: RequestInit) =>
  fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init }).then(r => r.json())

const inputCls = 'bg-bg border border-border rounded px-2 py-1.5 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-accent'

interface AlertPreferences {
  alertEmail: string | null
  emailEnabled: boolean
  smsEnabled: boolean
  entryEnabled: boolean
  exitEnabled: boolean
  newsEnabled: boolean
  tickerScope: 'all' | 'selected'
  tickers: string[]
  newsTickers: string[]
  minAiScore: number
  maxPerDay: number | null
  newsCooldownMinutes: number
  updatedAt: string | null
}

interface LoadResponse {
  ok: boolean
  preferences: AlertPreferences
  accountEmail: string
  phone: string | null
  emailAvailable: boolean
  smsAvailable: boolean
}

const Toggle = ({ checked, onChange, label, hint, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean
}) => (
  <label className={`flex items-start gap-2.5 text-xs ${disabled ? 'opacity-50' : ''}`}>
    <input type="checkbox" checked={checked} disabled={disabled} className="mt-0.5"
      onChange={e => onChange(e.target.checked)} />
    <span className="min-w-0">
      <span className="text-white">{label}</span>
      {hint && <span className="block text-neutral mt-0.5">{hint}</span>}
    </span>
  </label>
)

function TickerEditor({ tickers, onChange }: { tickers: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const t = draft.trim().toUpperCase()
    if (!t || tickers.includes(t)) { setDraft(''); return }
    onChange([...tickers, t]); setDraft('')
  }
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input value={draft} onChange={e => setDraft(e.target.value.toUpperCase())}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          placeholder="Ticker" className={`${inputCls} flex-1 font-mono`} />
        <button type="button" onClick={add}
          className="px-3 py-1.5 bg-accent text-white text-xs rounded hover:bg-sky-400">Add</button>
      </div>
      {tickers.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tickers.map(t => (
            <span key={t} className="text-xs font-mono bg-bg border border-border rounded-full px-2 py-1 text-white">
              {t}
              <button type="button" onClick={() => onChange(tickers.filter(x => x !== t))}
                className="ml-1.5 text-neutral hover:text-red-400">×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export function TradingAlertsCard() {
  const [prefs, setPrefs] = useState<AlertPreferences | null>(null)
  const [meta, setMeta] = useState<Omit<LoadResponse, 'preferences' | 'ok'> | null>(null)
  const [phone, setPhone] = useState('')
  const [alertEmail, setAlertEmail] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<'email' | 'sms' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    jsonFetch('/api/auth/alert-preferences')
      .then((d: LoadResponse) => {
        if (!d?.ok) { setError('Could not load alert settings.'); return }
        setPrefs(d.preferences)
        setMeta({ accountEmail: d.accountEmail, phone: d.phone, emailAvailable: d.emailAvailable, smsAvailable: d.smsAvailable })
        setPhone(d.phone || '')
        setAlertEmail(d.preferences.alertEmail || '')
      })
      .catch(() => setError('Could not load alert settings.'))
  }, [])

  // Loading state is explicit: rendering defaults first and correcting them a
  // moment later would briefly show every user "alerts off" regardless of their
  // real saved settings.
  if (!prefs || !meta) {
    return (
      <section className="bg-surface border border-border rounded-lg p-4">
        <h2 className="text-sm font-semibold text-white">Trading alerts</h2>
        <p className="text-xs text-neutral mt-2">{error || 'Loading your alert settings…'}</p>
      </section>
    )
  }

  const patch = (changes: Partial<AlertPreferences> & { phone?: string }) =>
    setPrefs(p => (p ? { ...p, ...changes } as AlertPreferences : p))

  async function save(extra: Record<string, unknown> = {}) {
    setSaving(true); setError(''); setNotice('')
    try {
      const body = { ...prefs, phone: phone.trim(), alertEmail: alertEmail.trim(), ...extra }
      const data = await jsonFetch('/api/auth/alert-preferences', { method: 'PUT', body: JSON.stringify({ preferences: body }) })
      if (!data.ok) { setError(data.error || 'Could not save.'); return }
      setPrefs(data.preferences)
      setAlertEmail(data.preferences.alertEmail || '')
      setPhone(data.phone || '')
      setNotice('Saved.')
    } catch {
      setError('Could not save.')
    } finally {
      setSaving(false)
    }
  }

  async function sendTest(channel: 'email' | 'sms') {
    setTesting(channel); setError(''); setNotice('')
    try {
      const data = await jsonFetch('/api/auth/alert-test', { method: 'POST', body: JSON.stringify({ channel }) })
      if (!data.ok) setError(data.error || `Could not send the test ${channel}.`)
      else setNotice(`Test ${channel === 'email' ? 'email' : 'text'} sent to ${data.sentTo}.`)
    } catch {
      setError(`Could not send the test ${channel}.`)
    } finally {
      setTesting(null)
    }
  }

  const emailBlocked = !meta.emailAvailable
  const smsBlocked = !meta.smsAvailable
  const noPhone = !/^\+[1-9]\d{6,14}$/.test(phone.trim())

  return (
    <section className="bg-surface border border-border rounded-lg p-4 space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-white">Trading alerts</h2>
        <p className="text-xs text-neutral mt-1">
          Notifications when the FlashFeed strategy records a simulated entry or exit, and news on tickers you follow.
          These are strategy alerts — not brokerage orders.
        </p>
      </div>

      {error && <div className="border border-red-500/40 bg-red-500/10 text-red-300 rounded p-2 text-xs">{error}</div>}
      {notice && !error && <div className="border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 rounded p-2 text-xs">{notice}</div>}

      {/* 1. Contact information */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Contact</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <label className="block text-[11px] text-neutral mb-1">Alert email</label>
            <input value={alertEmail} onChange={e => setAlertEmail(e.target.value)}
              placeholder={meta.accountEmail} className={`${inputCls} w-full`} />
            <p className="text-[11px] text-neutral mt-1">Leave blank to use {meta.accountEmail}.</p>
          </div>
          <div>
            <label className="block text-[11px] text-neutral mb-1">Mobile number</label>
            <input value={phone} onChange={e => setPhone(e.target.value)}
              placeholder="+15551234567" className={`${inputCls} w-full font-mono`} />
            <p className="text-[11px] text-neutral mt-1">Used for text alerts. Does not change your 2FA method.</p>
          </div>
        </div>
      </div>

      {/* 2. Delivery methods */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">How to reach you</h3>
        <div className="space-y-2">
          <Toggle checked={prefs.emailEnabled} disabled={emailBlocked}
            onChange={v => patch({ emailEnabled: v })}
            label="Email alerts"
            hint={emailBlocked ? 'Unavailable — email delivery is not configured on the server.' : undefined} />
          <Toggle checked={prefs.smsEnabled} disabled={smsBlocked || noPhone}
            onChange={v => patch({ smsEnabled: v })}
            label="Text message alerts"
            hint={smsBlocked
              ? 'Unavailable — text delivery is not configured on the server.'
              : noPhone ? 'Add a mobile number above (format +15551234567) to enable texts.' : undefined} />
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="button" onClick={() => sendTest('email')} disabled={emailBlocked || testing !== null}
            className="px-3 py-1.5 border border-border text-neutral text-xs rounded hover:text-white hover:border-accent disabled:opacity-40">
            {testing === 'email' ? 'Sending…' : 'Send test email'}
          </button>
          <button type="button" onClick={() => sendTest('sms')} disabled={smsBlocked || noPhone || testing !== null}
            className="px-3 py-1.5 border border-border text-neutral text-xs rounded hover:text-white hover:border-accent disabled:opacity-40">
            {testing === 'sms' ? 'Sending…' : 'Send test text'}
          </button>
        </div>
      </div>

      {/* 3. Alert types */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">What to alert on</h3>
        <Toggle checked={prefs.entryEnabled} onChange={v => patch({ entryEnabled: v })}
          label="Entry alerts" hint="When the strategy records a new simulated position." />
        <Toggle checked={prefs.exitEnabled} onChange={v => patch({ exitEnabled: v })}
          label="Exit alerts" hint="When a position you were alerted about closes." />
        <Toggle checked={prefs.newsEnabled} onChange={v => patch({ newsEnabled: v })}
          label="News alerts" hint="Headlines on the tickers you list below." />
      </div>

      {/* 4. Scope */}
      {(prefs.entryEnabled || prefs.exitEnabled) && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Which positions</h3>
          <div className="flex flex-wrap gap-2">
            {(['all', 'selected'] as const).map(scope => (
              <button key={scope} type="button" onClick={() => patch({ tickerScope: scope })}
                className={`px-3 py-1.5 rounded border text-xs ${prefs.tickerScope === scope
                  ? 'bg-accent text-white border-accent' : 'border-border text-neutral hover:text-white'}`}>
                {scope === 'all' ? 'All qualifying positions' : 'Only selected tickers'}
              </button>
            ))}
          </div>
          {prefs.tickerScope === 'selected' && (
            <TickerEditor tickers={prefs.tickers} onChange={next => patch({ tickers: next })} />
          )}
        </div>
      )}

      {prefs.newsEnabled && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">News tickers</h3>
          <TickerEditor tickers={prefs.newsTickers} onChange={next => patch({ newsTickers: next })} />
          {!prefs.newsTickers.length && (
            <p className="text-[11px] text-amber-400">Add at least one ticker — news alerts need an explicit list.</p>
          )}
        </div>
      )}

      {/* 5. Volume controls */}
      <details className="group">
        <summary className="text-xs font-semibold text-slate-300 uppercase tracking-wide cursor-pointer select-none hover:text-white">
          Alert preferences
        </summary>
        <div className="mt-3 space-y-3">
          <div>
            <label className="block text-[11px] text-neutral mb-1">
              Minimum AI ranking score: <span className="text-white font-mono">{prefs.minAiScore}</span>
            </label>
            <input type="range" min={0} max={100} step={5} value={prefs.minAiScore}
              onChange={e => patch({ minAiScore: Number(e.target.value) })} className="w-full accent-sky-500" />
            <p className="text-[11px] text-neutral">Filters notifications only — it does not change which positions the strategy takes.</p>
          </div>
          <div>
            <label className="block text-[11px] text-neutral mb-1">Maximum alerts per day</label>
            <div className="flex flex-wrap gap-2">
              {([5, 10, 20, null] as const).map(limit => (
                <button key={String(limit)} type="button" onClick={() => patch({ maxPerDay: limit })}
                  className={`px-3 py-1.5 rounded border text-xs ${prefs.maxPerDay === limit
                    ? 'bg-accent text-white border-accent' : 'border-border text-neutral hover:text-white'}`}>
                  {limit ?? 'Unlimited'}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-neutral mt-1">
              Applies to entry and news alerts. An exit for a position you were already alerted about is always sent.
            </p>
          </div>
          <div>
            <label className="block text-[11px] text-neutral mb-1">News cooldown per ticker</label>
            <div className="flex flex-wrap gap-2">
              {[15, 30, 60].map(mins => (
                <button key={mins} type="button" onClick={() => patch({ newsCooldownMinutes: mins })}
                  className={`px-3 py-1.5 rounded border text-xs ${prefs.newsCooldownMinutes === mins
                    ? 'bg-accent text-white border-accent' : 'border-border text-neutral hover:text-white'}`}>
                  {mins} min
                </button>
              ))}
            </div>
            <p className="text-[11px] text-neutral mt-1">Never delays entry or exit alerts.</p>
          </div>
        </div>
      </details>

      <div className="flex items-center gap-3 pt-1">
        <button type="button" onClick={() => save()} disabled={saving}
          className="px-4 py-2 bg-accent text-white text-xs font-medium rounded hover:bg-sky-400 disabled:opacity-40">
          {saving ? 'Saving…' : 'Save alert settings'}
        </button>
        {prefs.updatedAt && (
          <span className="text-[11px] text-neutral">
            Alerts active since {new Date(prefs.updatedAt).toLocaleString()}
          </span>
        )}
      </div>
    </section>
  )
}
