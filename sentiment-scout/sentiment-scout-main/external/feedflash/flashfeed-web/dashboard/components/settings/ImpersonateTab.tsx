'use client'
import { useState } from 'react'

export function ImpersonateTab() {
  const [url, setUrl] = useState('')
  const [browser, setBrowser] = useState('chrome')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<any>(null)

  const runTest = async () => {
    if (!url.trim()) return
    setLoading(true); setResult(null)
    try {
      const res = await fetch('/api/impersonate-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), browser }),
      })
      setResult(await res.json())
    } finally { setLoading(false) }
  }

  return (
    <div>
      <p className="text-neutral text-xs mb-3">
        Test TLS impersonation against a URL. Uses curl-impersonate to bypass bot detection.
      </p>
      <div className="flex gap-2 mb-4 flex-wrap">
        <input
          value={url} onChange={e => setUrl(e.target.value)}
          placeholder="https://example.com/feed"
          onKeyDown={e => e.key === 'Enter' && runTest()}
          className="flex-[2] min-w-[200px] bg-bg border border-border text-sm text-white rounded px-3 py-2 focus:outline-none focus:border-accent placeholder:text-slate-600"
        />
        <select value={browser} onChange={e => setBrowser(e.target.value)}
          className="w-[130px] bg-bg border border-border text-sm text-neutral rounded px-3 py-2 focus:outline-none focus:border-accent">
          <option value="chrome">Chrome</option>
          <option value="firefox">Firefox</option>
          <option value="safari">Safari</option>
          <option value="rotate">Rotate</option>
        </select>
        <button onClick={runTest} disabled={loading || !url.trim()}
          className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-sky-400 disabled:opacity-50 transition-colors">
          {loading ? 'Testing...' : 'Test'}
        </button>
      </div>

      {result && (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-3">
            <span className={`w-2 h-2 rounded-full ${result.success ? 'bg-emerald-500' : 'bg-red-500'}`} />
            <span className={`text-sm font-medium ${result.success ? 'text-emerald-400' : 'text-red-400'}`}>
              {result.success ? 'Success' : 'Failed'}
            </span>
            {result.status && <span className="text-xs text-neutral">HTTP {result.status}</span>}
            {result.latency != null && (
              <span className="text-xs font-mono text-neutral ml-auto">{result.latency}ms</span>
            )}
          </div>
          {result.headers && (
            <div className="px-4 py-2 border-b border-border">
              <div className="text-[10px] text-neutral uppercase tracking-wide mb-1">Response Headers</div>
              <div className="text-xs font-mono text-slate-400 max-h-[120px] overflow-y-auto">
                {Object.entries(result.headers).slice(0, 10).map(([k, v]) => (
                  <div key={k}><span className="text-neutral">{k}:</span> {String(v)}</div>
                ))}
              </div>
            </div>
          )}
          {result.body_preview && (
            <div className="px-4 py-2">
              <div className="text-[10px] text-neutral uppercase tracking-wide mb-1">Body Preview</div>
              <pre className="text-xs font-mono text-slate-400 max-h-[200px] overflow-y-auto whitespace-pre-wrap">
                {result.body_preview}
              </pre>
            </div>
          )}
          {result.error && (
            <div className="px-4 py-3 text-xs text-red-400">{result.error}</div>
          )}
        </div>
      )}
    </div>
  )
}
