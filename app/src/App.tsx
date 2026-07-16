import { Routes, Route, Navigate } from 'react-router-dom'
import { AppShell }        from './components/shared/AppShell'
import { ApiHealthGate }   from './components/shared/ApiHealthGate'
import { OverviewPage }    from './pages/OverviewPage'
import { AIPage }          from './pages/AIPage'
import { NewsPage }        from './pages/NewsPage'
import { ScreenerPage }    from './pages/ScreenerPage'
import { DecisionMapPanel } from './pages/DecisionMapPanel'
import SocialPage from './pages/SocialPage'
import { ChartsPage }      from './pages/ChartsPage'
import { ChartsPage as SentChartsPage } from './pages/sentchart/ChartsPage'
import { ChartsGridPage }  from './pages/ChartsGridPage'
import { MomentumPage }    from './pages/MomentumPage'
import { CorrelationPage } from './pages/CorrelationPage'
import { SettingsPage }    from './pages/SettingsPage'
import { SystemHealthPage } from './pages/SystemHealthPage'
import { PredictionAuditPage } from './pages/PredictionAuditPage'

export default function App() {
  return (
    <ApiHealthGate>
      <AppShell>
        <Routes>
          <Route path="/"            element={<Navigate to="/overview" replace />} />
          <Route path="/overview"    element={<OverviewPage />} />
          <Route path="/ai"          element={<AIPage />} />
          <Route path="/news"        element={<NewsPage />} />
          <Route path="/screener"    element={<ScreenerPage />} />
          <Route path="/decision-map" element={<DecisionMapPanel />} />
          <Route path="/social"      element={<SocialPage />} />
          <Route path="/mirror"      element={<ChartsGridPage />} />
          <Route path="/charts"      element={<ChartsPage />} />
          <Route path="/sentcharts"  element={<SentChartsPage />} />
          <Route path="/charts-grid" element={<Navigate to="/charts?chartTab=grid" replace />} />
          <Route path="/momentum"    element={<MomentumPage />} />
          <Route path="/correlation" element={<CorrelationPage />} />
          <Route path="/prediction-audit" element={<PredictionAuditPage />} />
          <Route path="/system-health" element={<SystemHealthPage />} />
          <Route path="/settings"    element={<SettingsPage />} />
        </Routes>
      </AppShell>
    </ApiHealthGate>
  )
}
