import { useEffect, useState } from 'react'

type HealthState = 'checking' | 'ok' | 'degraded' | 'unreachable'

type HealthData = {
  ok?: boolean
  status?: string
  db?: string
  time?: string
}

export function ApiHealthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<HealthState>('checking')
  const [health, setHealth] = useState<HealthData | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const check = async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' })
        if (!res.ok) throw new Error(`health ${res.status}`)
        const data: HealthData = await res.json()
        if (cancelled) return
        setHealth(data)
        setState(data.status === 'ok' || data.ok !== false ? 'ok' : 'degraded')
      } catch {
        if (cancelled) return
        setState('unreachable')
        retryTimer = setTimeout(() => {
          if (!cancelled) setAttempt(value => value + 1)
        }, 3000)
      }
    }

    check()
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [attempt])

  if (state === 'ok' || state === 'degraded') return <>{children}</>

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#06101a] p-6">
      <div className="w-full max-w-md space-y-5 text-center">
        <div>
          <div className="font-mono text-2xl font-bold tracking-tight text-accent">FlashFeed</div>
          <div className="mt-1 text-xs uppercase tracking-wide text-neutral">Financial Intelligence</div>
        </div>

        {state === 'checking' && (
          <div className="space-y-3">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            <p className="text-sm text-neutral">Connecting to the API...</p>
          </div>
        )}

        {state === 'unreachable' && (
          <div className="space-y-4">
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
              <p className="font-medium text-red-300">API unreachable</p>
              <p className="mt-1 text-sm text-neutral">The dashboard is waiting for the backend at port 3001.</p>
            </div>
            <div className="rounded-lg border border-border bg-surface p-4 text-left text-sm">
              <p className="font-medium text-white">Start the local stack:</p>
              <code className="mt-2 block rounded bg-bg/70 px-3 py-2 text-xs text-accent">docker compose up -d</code>
              <p className="mt-2 text-xs text-neutral">Retrying automatically every 3 seconds.</p>
            </div>
            <button
              onClick={() => setAttempt(value => value + 1)}
              className="rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400"
            >
              Retry Now
            </button>
          </div>
        )}

        {health?.db && <p className="text-xs text-neutral">Last database state: {health.db}</p>}
      </div>
    </div>
  )
}
