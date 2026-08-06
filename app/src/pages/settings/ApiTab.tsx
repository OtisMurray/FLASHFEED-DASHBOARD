import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { jsonFetch } from './shared'

type Overview = { active_key_count: number; base_url: string }

const codeCls = 'bg-bg border border-border rounded px-2 py-0.5 text-xs font-mono text-sky-300'

export function ApiTab() {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    jsonFetch('/api/settings/api-overview').then(setOverview).catch(e => setError(String(e.message || e)))
  }, [])

  const base = overview?.base_url || window.location.origin

  return (
    <div className="space-y-6">
      <p className="text-sm text-neutral">Read-only access to FlashFeed's screener and news data.</p>

      {error && <div className="border border-red-500/40 bg-red-500/10 text-red-300 rounded-lg p-3 text-sm">{error}</div>}

      <div className="border border-border rounded-lg p-4 bg-bg/40 flex items-center gap-6">
        <div>
          <div className="text-2xl font-mono text-white">{overview?.active_key_count ?? '--'}</div>
          <div className="text-xs text-neutral">Active API keys across all accounts</div>
        </div>
      </div>

      <div className="border border-border rounded-lg p-4 space-y-3">
        <h2 className="text-white font-medium text-sm">Authentication</h2>
        <p className="text-xs text-neutral">
          Every request needs an API key in the <code className={codeCls}>Authorization</code> header:
        </p>
        <pre className="bg-bg border border-border rounded p-3 text-xs text-slate-300 overflow-x-auto">
{`curl -H "Authorization: Bearer ff_live_..." \\
  "${base}/api/v1/screener"`}
        </pre>
        <p className="text-xs text-neutral">
          Generate a personal key from <Link to="/account" className="text-accent hover:underline">your Account page</Link>.
        </p>
      </div>

      <div className="border border-border rounded-lg p-4 space-y-3">
        <h2 className="text-white font-medium text-sm">Endpoints</h2>
        <div className="space-y-2 text-xs">
          <div>
            <span className={codeCls}>GET /api/v1/screener</span>
            <span className="text-neutral ml-2">Latest screener rows for the tracked market universe.</span>
          </div>
          <div>
            <span className={codeCls}>GET /api/v1/news</span>
            <span className="text-neutral ml-2">Recent approved-source articles, with ticker and sentiment.</span>
          </div>
        </div>
      </div>
    </div>
  )
}
