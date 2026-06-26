'use client'
import { useState } from 'react'
import { clsx } from 'clsx'
import { SourcesTab } from './SourcesTab'
import { KeywordsTab } from './KeywordsTab'
import { AccountsTab } from './AccountsTab'
import { ConfigTab } from './ConfigTab'
import { LogsTab } from './LogsTab'
import { DataTab } from './DataTab'
import { ImpersonateTab } from './ImpersonateTab'

const TABS = ['Sources', 'Keywords', 'Accounts', 'Config', 'Data', 'Logs', 'Impersonate'] as const
type Tab = (typeof TABS)[number]

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('Sources')

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-white font-semibold text-lg mb-4">Settings</h1>
      <div className="flex gap-1 border-b border-border mb-4 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={clsx(
              'px-3 py-2 text-sm transition-colors border-b-2 -mb-px whitespace-nowrap',
              tab === t ? 'text-white border-accent' : 'text-neutral border-transparent hover:text-white'
            )}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'Sources' && <SourcesTab />}
      {tab === 'Keywords' && <KeywordsTab />}
      {tab === 'Accounts' && <AccountsTab />}
      {tab === 'Config' && <ConfigTab />}
      {tab === 'Data' && <DataTab />}
      {tab === 'Logs' && <LogsTab />}
      {tab === 'Impersonate' && <ImpersonateTab />}
    </div>
  )
}
