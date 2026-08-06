import { useState } from 'react'
import { clsx } from 'clsx'
import { SourcesTab } from './settings/SourcesTab'
import { KeywordsTab } from './settings/KeywordsTab'
import { AccountsTab } from './settings/AccountsTab'
import { ConfigTab } from './settings/ConfigTab'
import { LogsTab } from './settings/LogsTab'
import { ApiTab } from './settings/ApiTab'
import { ImpersonateTab } from './settings/ImpersonateTab'

const TABS = [
  { key: 'sources', label: 'Sources', Component: SourcesTab },
  { key: 'keywords', label: 'Keywords', Component: KeywordsTab },
  { key: 'accounts', label: 'Accounts', Component: AccountsTab },
  { key: 'config', label: 'Config', Component: ConfigTab },
  { key: 'logs', label: 'Logs', Component: LogsTab },
  { key: 'api', label: 'API', Component: ApiTab },
  { key: 'impersonate', label: 'Impersonate', Component: ImpersonateTab },
] as const

type TabKey = typeof TABS[number]['key']

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('sources')
  const Active = TABS.find(t => t.key === activeTab)?.Component ?? SourcesTab

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-white font-semibold text-2xl">Settings</h1>
      </div>

      <div className="flex border-b border-border overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={clsx(
              'px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px',
              activeTab === t.key
                ? 'text-white border-accent'
                : 'text-neutral border-transparent hover:text-white',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="bg-surface border border-border rounded-lg p-4">
        <Active />
      </div>
    </div>
  )
}
