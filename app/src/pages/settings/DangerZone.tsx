import { useEffect, useState } from 'react'
import { jsonFetch, inputCls } from './shared'

type ResetCollection = {
  name: string
  label: string
  note: string
  exists: boolean
  count: number
}

type Preview = {
  collections: ResetCollection[]
  total_rows: number
  confirm_phrase: string
}

type ResetResult = {
  name: string
  label: string
  exists: boolean
  deleted: number
  error?: string
}

/**
 * Scoped data reset.
 *
 * Destructive, so the dialog is built to be read rather than clicked through:
 * it names every collection with its live row count before anything happens,
 * and the button stays disabled until the confirmation phrase is typed. The
 * phrase is checked on the server too — this control is a guard against a
 * mis-click, not a security boundary.
 *
 * The counts are re-fetched when the panel opens rather than cached from page
 * load, so what the dialog promises to delete is what is actually there.
 */
export function DangerZone({ onError, onSaved }: { onError: (m: string) => void; onSaved: (m: string) => void }) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ResetResult[] | null>(null)

  useEffect(() => {
    if (!open) return
    setPreview(null)
    setResult(null)
    setTyped('')
    jsonFetch('/api/settings/reset-preview')
      .then(setPreview)
      .catch(e => onError(String(e.message || e)))
    // onError is stable enough for this one-shot load; re-running on its
    // identity would refetch the counts on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const phrase = preview?.confirm_phrase ?? 'RESET'
  const armed = typed === phrase && !busy

  const run = async () => {
    setBusy(true)
    try {
      const data = await jsonFetch('/api/settings/reset', {
        method: 'POST',
        body: JSON.stringify({ confirm: typed }),
      })
      setResult(data.results || [])
      setTyped('')
      onSaved(`Cleared ${data.deleted_total} rows${data.failed_count ? ` — ${data.failed_count} collection(s) failed` : ''}`)
      const fresh = await jsonFetch('/api/settings/reset-preview')
      setPreview(fresh)
    } catch (e) {
      onError(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border border-red-500/40 rounded-lg p-4 bg-red-500/[0.04] space-y-3">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-red-300 font-medium text-sm">Danger zone</h2>
          <p className="text-xs text-neutral mt-1 max-w-2xl">
            Clears simulated position history and the cached or derived data computed around it.
            Credentials, connections, sources, keywords, accounts and raw collected news and social
            messages are never touched.
          </p>
        </div>
        <button
          onClick={() => setOpen(v => !v)}
          className="text-xs border border-red-500/40 text-red-300 rounded px-3 py-2 hover:text-red-200 whitespace-nowrap"
        >
          {open ? 'Cancel' : 'Reset database…'}
        </button>
      </div>

      {open && (
        <div className="border border-border rounded-lg p-3 bg-bg/60 space-y-3">
          {!preview && !result && <div className="text-sm text-neutral">Counting rows…</div>}

          {preview && !result && (
            <>
              <div className="text-xs text-neutral">
                This will permanently delete{' '}
                <span className="text-white font-mono">{preview.total_rows.toLocaleString()}</span> rows across{' '}
                {preview.collections.filter(c => c.exists).length} collections:
              </div>

              <div className="overflow-x-auto max-h-64 overflow-y-auto border border-border rounded">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="text-left text-neutral border-b border-border">
                      <th className="py-1.5 px-2">Collection</th>
                      <th className="py-1.5 px-2 text-right">Rows</th>
                      <th className="py-1.5 px-2">Recovery</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.collections.map(c => (
                      <tr key={c.name} className={`border-b border-border/50 ${c.exists ? '' : 'opacity-40'}`}>
                        <td className="py-1.5 px-2 text-white">
                          {c.label}
                          <div className="text-[10px] text-neutral font-mono">{c.name}</div>
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono text-neutral">
                          {c.exists ? c.count.toLocaleString() : '--'}
                        </td>
                        <td className="py-1.5 px-2 text-neutral">{c.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* The one consequence that cannot be undone by waiting. */}
              <div className="border border-yellow-500/40 bg-yellow-500/10 text-yellow-200 rounded p-2.5 text-xs">
                Position history is written by the scheduler at the canonical parameters and past
                sessions cannot be re-simulated. Clearing it permanently removes the realized P&L
                the Positions page reports; it rebuilds only as new sessions are recorded.
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-neutral">
                  Type <span className="font-mono text-white">{phrase}</span> to enable:
                </span>
                <input
                  value={typed}
                  onChange={e => setTyped(e.target.value)}
                  placeholder={phrase}
                  aria-label={`Type ${phrase} to confirm`}
                  className={`${inputCls} w-32 font-mono`}
                />
                <button
                  onClick={run}
                  disabled={!armed}
                  className="text-xs bg-red-700 text-white rounded px-3 py-2 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {busy ? 'Clearing…' : 'Reset now'}
                </button>
              </div>
            </>
          )}

          {result && (
            <>
              <div className="text-sm text-white">Reset complete.</div>
              <div className="overflow-x-auto max-h-64 overflow-y-auto border border-border rounded">
                <table className="w-full text-xs">
                  <tbody>
                    {result.filter(r => r.exists).map(r => (
                      <tr key={r.name} className="border-b border-border/50">
                        <td className="py-1.5 px-2 text-white">{r.label}</td>
                        <td className="py-1.5 px-2 text-right font-mono text-neutral">
                          {r.error ? <span className="text-red-300">{r.error}</span> : `${r.deleted.toLocaleString()} deleted`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="text-xs border border-border text-neutral rounded px-3 py-2 hover:text-white"
              >
                Close
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
