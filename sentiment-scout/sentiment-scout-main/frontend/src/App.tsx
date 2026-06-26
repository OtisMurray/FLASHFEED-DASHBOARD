import { Routes, Route, Navigate } from 'react-router-dom'
import { AppShell }        from './components/shared/AppShell'
import { OverviewPage }    from './pages/OverviewPage'
import { NewsPage }        from './pages/NewsPage'
import { ScreenerPage }    from './pages/ScreenerPage'
import { SocialPage }      from './pages/SocialPage'
import { ChartsPage }      from './pages/ChartsPage'
import { ChartsGridPage }  from './pages/ChartsGridPage'
import { MomentumPage }    from './pages/MomentumPage'
import { CorrelationPage } from './pages/CorrelationPage'
import { SettingsPage }    from './pages/SettingsPage'

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/"            element={<Navigate to="/overview" replace />} />
        <Route path="/overview"    element={<OverviewPage />} />
        <Route path="/news"        element={<NewsPage />} />
        <Route path="/screener"    element={<ScreenerPage />} />
        <Route path="/social"      element={<SocialPage />} />
        <Route path="/charts"      element={<ChartsPage />} />
        <Route path="/charts-grid" element={<ChartsGridPage />} />
        <Route path="/momentum"    element={<MomentumPage />} />
        <Route path="/correlation" element={<CorrelationPage />} />
        <Route path="/settings"    element={<SettingsPage />} />
      </Routes>
    </AppShell>
  )
}