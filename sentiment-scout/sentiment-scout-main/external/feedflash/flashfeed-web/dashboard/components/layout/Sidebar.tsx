'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { clsx } from 'clsx'
import { SentimentModal } from '@/components/shared/SentimentModal'

const NAV = [
  { href: '/news', label: 'News', icon: '📰' },
  { href: '/screener', label: 'Screener', icon: '🔍' },
  { href: '/social', label: 'Social', icon: '💬' },
  { href: '/charts', label: 'Charts', icon: '📊' },
  { href: '/momentum', label: 'Momentum', icon: '📈' },
  { href: '/correlation', label: 'Correlation', icon: '🔗' },
]

export function Sidebar() {
  const pathname = usePathname()
  const [showSentiment, setShowSentiment] = useState(false)

  return (
    <>
      <aside className="w-[220px] bg-surface border-r border-border flex-shrink-0 flex flex-col">
        <div className="px-4 py-4 border-b border-border">
          <div className="text-accent font-bold text-lg tracking-tight font-mono">⚡ FlashFeed</div>
          <div className="text-neutral text-xs mt-0.5">Financial Intelligence</div>
        </div>
        <nav className="flex-1 py-2">
          {NAV.map(({ href, label, icon }) => {
            const active = pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                className={clsx(
                  'flex items-center gap-3 px-4 py-2.5 text-sm transition-colors',
                  active
                    ? 'text-white bg-slate-700/50 border-l-2 border-accent'
                    : 'text-neutral hover:text-white hover:bg-slate-800'
                )}
              >
                <span>{icon}</span>
                <span>{label}</span>
              </Link>
            )
          })}
        </nav>

        {/* Operations */}
        <div className="border-t border-border p-2 space-y-0.5">
          <button
            onClick={() => setShowSentiment(true)}
            className="w-full flex items-center gap-3 px-4 py-2 text-sm text-neutral hover:text-white hover:bg-slate-800 rounded transition-colors"
          >
            <span>🧠</span><span>Sentiment</span>
          </button>
          <Link href="/settings" className="flex items-center gap-3 px-4 py-2 text-sm text-neutral hover:text-white hover:bg-slate-800 rounded transition-colors">
            <span>⚙</span><span>Settings</span>
          </Link>
        </div>
      </aside>

      <SentimentModal open={showSentiment} onClose={() => setShowSentiment(false)} />
    </>
  )
}
