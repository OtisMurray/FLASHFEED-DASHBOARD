import { TopBar } from './TopBar'
import { ToastProvider } from '@/components/shared/Toast'
import useSWR from 'swr'
import { clsx } from 'clsx'
import { useEffect, useState } from 'react'

const fetcher = (url: string) => fetch(url).then(r => r.json())

function ageLabel(seconds?: number | null) {
  if (seconds == null) return 'missing'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h`
}

function DataFreshnessBanner() {
  const { data } = useSWR('/api/dashboard/freshness', fetcher, {
    refreshInterval: 60_000,
    dedupingInterval: 60_000,
    keepPreviousData: true,
    revalidateOnFocus: false,
  })
  if (!data) return null
  const warning = data.status !== 'fresh'
  const sources = data.sources || {}
  return (
    <div className={clsx(
      'border-b px-3 py-1.5 text-[11px] md:px-4',
      warning ? 'border-amber-500/25 bg-amber-500/10 text-amber-100' : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-100'
    )}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold">{warning ? 'Freshness warning' : 'Data fresh'}</span>
        <span>Market: {data.market?.label || 'unknown'}</span>
        <span>News {ageLabel(sources.news?.age_seconds)}</span>
        <span>Screener {ageLabel(sources.screener?.age_seconds)}</span>
        <span>Social {ageLabel(sources.social?.age_seconds)}</span>
        <span>Decision Map {ageLabel(sources.decision_map?.age_seconds)}</span>
        {data.auto_refresh?.refresh_cycle_in_flight && <span className="text-sky-200">refresh running</span>}
      </div>
    </div>
  )
}

function useGoogleTranslateActive() {
  const [active, setActive] = useState(false)

  useEffect(() => {
    const check = () => {
      const classes = document.documentElement.classList
      setActive(classes.contains('translated-ltr') || classes.contains('translated-rtl'))
    }
    check()
    const observer = new MutationObserver(check)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return active
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const googleTranslateActive = useGoogleTranslateActive()

  return (
    <ToastProvider>
      <div
        className="flex bg-bg overflow-hidden"
        style={{
          height: googleTranslateActive ? 'calc(100vh - 40px)' : '100vh',
          marginTop: googleTranslateActive ? 40 : 0,
        }}
      >
        <div className="flex flex-col flex-1 min-w-0">
          <TopBar />
          <DataFreshnessBanner />
          <main className="flex-1 overflow-auto p-4 md:p-5">{children}</main>
        </div>
      </div>
    </ToastProvider>
  )
}
