import { useState, useEffect } from 'react'

interface Settings {
  theme?: string
  notifications?: boolean
  autoRefresh?: boolean
  refreshInterval?: number
}

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({
    theme: 'dark',
    notifications: true,
    autoRefresh: true,
    refreshInterval: 60,
  })
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    // Load settings from API
    const loadSettings = async () => {
      try {
        const res = await fetch('/api/settings')
        const data = await res.json()
        setSettings(data)
      } catch (error) {
        console.error('Failed to load settings:', error)
      }
    }
    loadSettings()
  }, [])

  const handleSave = async () => {
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      if (res.ok) {
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }
    } catch (error) {
      console.error('Failed to save settings:', error)
    }
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-3xl font-bold mb-8">⚙ Settings</h1>

      <div className="bg-gray-900 rounded-lg p-6 space-y-6">
        {/* Theme */}
        <div className="border-b border-gray-800 pb-6">
          <label className="block text-sm font-semibold mb-3">Theme</label>
          <select
            value={settings.theme || 'dark'}
            onChange={(e) => setSettings({ ...settings, theme: e.target.value })}
            className="w-full px-4 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:border-blue-500 outline-none"
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="auto">Auto</option>
          </select>
        </div>

        {/* Notifications */}
        <div className="border-b border-gray-800 pb-6">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={settings.notifications !== false}
              onChange={(e) => setSettings({ ...settings, notifications: e.target.checked })}
              className="w-5 h-5 cursor-pointer"
            />
            <span className="text-sm font-semibold">Enable Notifications</span>
          </label>
        </div>

        {/* Auto Refresh */}
        <div className="border-b border-gray-800 pb-6">
          <label className="flex items-center gap-3 mb-3">
            <input
              type="checkbox"
              checked={settings.autoRefresh !== false}
              onChange={(e) => setSettings({ ...settings, autoRefresh: e.target.checked })}
              className="w-5 h-5 cursor-pointer"
            />
            <span className="text-sm font-semibold">Auto Refresh</span>
          </label>
          {settings.autoRefresh !== false && (
            <div className="ml-8">
              <label className="block text-xs text-gray-400 mb-2">Refresh Interval (seconds)</label>
              <input
                type="number"
                min="10"
                max="3600"
                value={settings.refreshInterval || 60}
                onChange={(e) => setSettings({ ...settings, refreshInterval: parseInt(e.target.value) })}
                className="w-32 px-4 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:border-blue-500 outline-none"
              />
            </div>
          )}
        </div>

        {/* Save Button */}
        <div className="flex gap-3 pt-4">
          <button
            onClick={handleSave}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition-colors"
          >
            💾 Save Settings
          </button>
          {saved && (
            <div className="flex items-center gap-2 text-green-400">
              <span>✓ Saved!</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
