import { useState } from 'react'

interface Props { onComplete?: () => void }

export function RunButton({ onComplete }: Props) {
  const [loading, setLoading] = useState(false)
  const run = async () => {
    setLoading(true)
    try {
      await fetch('/api/correlation/run', { method: 'POST' })
      onComplete?.()
    } finally {
      setLoading(false)
    }
  }
  return (
    <button
      onClick={run}
      disabled={loading}
      className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-sky-400 disabled:opacity-50 transition-colors"
    >
      {loading ? 'Running...' : 'Refresh Alignment Signals'}
    </button>
  )
}
