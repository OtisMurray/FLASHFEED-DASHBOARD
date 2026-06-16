'use client'

interface Props {
  status?: { open: boolean; next_open?: string; next_close?: string } | null
}

export function MarketBanner({ status }: Props) {
  if (!status) return null
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg mb-3 text-xs ${
      status.open
        ? 'bg-emerald-500/10 border border-emerald-500/30'
        : 'bg-orange-500/10 border border-orange-500/30'
    }`}>
      <span className={`w-2 h-2 rounded-full ${status.open ? 'bg-emerald-500 animate-pulse' : 'bg-orange-500'}`} />
      <span className={status.open ? 'text-emerald-400' : 'text-orange-400'}>
        {status.open ? 'Market Open' : 'Market Closed'}
      </span>
      {!status.open && status.next_open && (
        <span className="text-neutral ml-1">Next open: {status.next_open}</span>
      )}
    </div>
  )
}
