'use client'
import { useState } from 'react'

interface Props { onComplete?: () => void }

export function RunButton({ onComplete }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const run = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/correlation/run', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.success === false) throw new Error(data?.error || `Run failed (${res.status})`)
      onComplete?.()
    } catch (err: any) {
      setError(err?.message || 'Unable to refresh signals')
    } finally {
      setLoading(false)
    }
  }
  return <div className="text-right">
    <button
        onClick={run}
        disabled={loading}
        className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-sky-400 disabled:opacity-50 transition-colors"
      >
        {loading ? 'Running...' : 'Refresh Alignment Signals'}
      </button>
      {error && <div className="mt-1 max-w-[260px] text-xs text-red-300">{error}</div>}
    </div>
}
