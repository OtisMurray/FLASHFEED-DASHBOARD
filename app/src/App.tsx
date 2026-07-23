import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { AppShell }        from './components/shared/AppShell'
import { ApiHealthGate }   from './components/shared/ApiHealthGate'

const OverviewPage = lazy(() => import('./pages/OverviewPage').then(m => ({ default: m.OverviewPage })))
const AIPage = lazy(() => import('./pages/AIPage').then(m => ({ default: m.AIPage })))
const NewsPage = lazy(() => import('./pages/NewsPage').then(m => ({ default: m.NewsPage })))
const ScreenerPage = lazy(() => import('./pages/ScreenerPage').then(m => ({ default: m.ScreenerPage })))
const DecisionMapPanel = lazy(() => import('./pages/DecisionMapPanel').then(m => ({ default: m.DecisionMapPanel })))
const SocialPage = lazy(() => import('./pages/SocialPage'))
const ChartsPage = lazy(() => import('./pages/ChartsPage').then(m => ({ default: m.ChartsPage })))
const EntryScreenerPage = lazy(() => import('./pages/sentchart/EntryScreenerPage').then(m => ({ default: m.EntryScreenerPage })))
const ExitScreenerPage = lazy(() => import('./pages/sentchart/ExitScreenerPage').then(m => ({ default: m.ExitScreenerPage })))
const V11ScreenerPage = lazy(() => import('./pages/sentchart/V11ScreenerPage').then(m => ({ default: m.V11ScreenerPage })))
const MirrorPage = lazy(() => import('./pages/MirrorPage').then(m => ({ default: m.MirrorPage })))
const MomentumPage = lazy(() => import('./pages/MomentumPage').then(m => ({ default: m.MomentumPage })))
const CorrelationPage = lazy(() => import('./pages/CorrelationPage').then(m => ({ default: m.CorrelationPage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })))
const SystemHealthPage = lazy(() => import('./pages/SystemHealthPage').then(m => ({ default: m.SystemHealthPage })))
const PredictionAuditPage = lazy(() => import('./pages/PredictionAuditPage').then(m => ({ default: m.PredictionAuditPage })))

function RouteLoading() {
  return (
    <div className="m-4 rounded-lg border border-border bg-surface p-4 text-sm text-neutral">
      Loading view...
    </div>
  )
}

export default function App() {
  return (
    <ApiHealthGate>
      <AppShell>
        <Suspense fallback={<RouteLoading />}>
          <Routes>
            <Route path="/"            element={<Navigate to="/overview" replace />} />
            <Route path="/overview"    element={<OverviewPage />} />
            <Route path="/ai"          element={<AIPage />} />
            <Route path="/news"        element={<NewsPage />} />
            <Route path="/screener"    element={<ScreenerPage />} />
            <Route path="/decision-map" element={<DecisionMapPanel />} />
            <Route path="/social"      element={<SocialPage />} />
            <Route path="/mirror"      element={<MirrorPage />} />
            <Route path="/charts"      element={<ChartsPage />} />
            <Route path="/entry-screener" element={<EntryScreenerPage />} />
            <Route path="/exit-screener"  element={<ExitScreenerPage />} />
            <Route path="/v11-screener"   element={<V11ScreenerPage />} />
            <Route path="/charts-grid" element={<Navigate to="/charts?chartTab=grid" replace />} />
            <Route path="/sentcharts" element={<Navigate to="/charts" replace />} />
            <Route path="/window-mirror" element={<Navigate to="/screener" replace />} />
            <Route path="/momentum"    element={<MomentumPage />} />
            <Route path="/correlation" element={<CorrelationPage />} />
            <Route path="/prediction-audit" element={<PredictionAuditPage />} />
            <Route path="/system-health" element={<SystemHealthPage />} />
            <Route path="/settings"    element={<SettingsPage />} />
          </Routes>
        </Suspense>
      </AppShell>
    </ApiHealthGate>
  )
}
