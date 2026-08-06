import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { AppShell }        from './components/shared/AppShell'
import { ApiHealthGate }   from './components/shared/ApiHealthGate'
import { AuthProvider }    from './lib/useAuth'
import { RequireAuth } from './components/shared/RouteGuards'

const LoginPage = lazy(() => import('./pages/LoginPage').then(m => ({ default: m.LoginPage })))
const WatchlistPage = lazy(() => import('./pages/WatchlistPage').then(m => ({ default: m.WatchlistPage })))
const AccountPage = lazy(() => import('./pages/AccountPage').then(m => ({ default: m.AccountPage })))

const OverviewPage = lazy(() => import('./pages/OverviewPage').then(m => ({ default: m.OverviewPage })))
const AIPage = lazy(() => import('./pages/AIPage').then(m => ({ default: m.AIPage })))
const NewsPage = lazy(() => import('./pages/NewsPage').then(m => ({ default: m.NewsPage })))
const ScreenerPage = lazy(() => import('./pages/ScreenerPage').then(m => ({ default: m.ScreenerPage })))
const DecisionMapPanel = lazy(() => import('./pages/DecisionMapPanel').then(m => ({ default: m.DecisionMapPanel })))
const SocialPage = lazy(() => import('./pages/SocialPage'))
const ChartsPage = lazy(() => import('./pages/sentchart/ChartsPage').then(m => ({ default: m.ChartsPage })))
const ChartsGridPage = lazy(() => import('./pages/ChartsGridPage').then(m => ({ default: m.ChartsGridPage })))
// EntryScreenerPage and ExitScreenerPage are deliberately NOT imported. Both
// retired in favour of Positions, which is a strict superset of each. The source
// files stay in the tree (unrouted and unreferenced, so Vite drops them from the
// bundle) rather than being deleted, matching how earlier retirements were
// handled here — recoverable from git without shipping dead chunks.
const CVDPage = lazy(() => import('./pages/CVDPage').then(m => ({ default: m.CVDPage })))
const PositionsPage = lazy(() => import('./pages/sentchart/PositionsPage').then(m => ({ default: m.PositionsPage })))
const V11ScreenerPage = lazy(() => import('./pages/sentchart/V11ScreenerPage').then(m => ({ default: m.V11ScreenerPage })))
const LongTermFundamentalsPage = lazy(() => import('./pages/sentchart/LongTermFundamentalsPage').then(m => ({ default: m.LongTermFundamentalsPage })))
const SqueezeScreenerPage = lazy(() => import('./pages/sentchart/SqueezeScreenerPage').then(m => ({ default: m.SqueezeScreenerPage })))
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
    <AuthProvider>
    <ApiHealthGate>
      <AppShell>
        <Suspense fallback={<RouteLoading />}>
          <Routes>
            <Route path="/"            element={<Navigate to="/overview" replace />} />
            <Route path="/login"       element={<LoginPage />} />
            <Route path="/watchlist"   element={<WatchlistPage />} />
            <Route path="/account"     element={<RequireAuth><AccountPage /></RequireAuth>} />
            <Route path="/overview"    element={<OverviewPage />} />
            <Route path="/ai"          element={<AIPage />} />
            <Route path="/news"        element={<NewsPage />} />
            <Route path="/screener"    element={<ScreenerPage />} />
            <Route path="/decision-map" element={<DecisionMapPanel />} />
            <Route path="/social"      element={<SocialPage />} />
            <Route path="/mirror"      element={<MirrorPage />} />
            <Route path="/charts"      element={<ChartsPage />} />
            <Route path="/cvd"         element={<CVDPage />} />
            <Route path="/positions"      element={<PositionsPage />} />
            {/* Retired in favour of Positions. Redirect rather than 404: both had
                been linked and bookmarked for weeks, and Positions answers the
                same question with the same sim, so dropping someone on an error
                page would be worse than landing them on the superset. Same
                pattern as /window-mirror below. */}
            <Route path="/entry-screener" element={<Navigate to="/positions" replace />} />
            <Route path="/exit-screener"  element={<Navigate to="/positions" replace />} />
            <Route path="/squeeze-screener" element={<SqueezeScreenerPage />} />
            <Route path="/v11-screener"   element={<V11ScreenerPage />} />
            <Route path="/long-term-fundamentals" element={<LongTermFundamentalsPage />} />
            <Route path="/charts-grid" element={<ChartsGridPage />} />
            <Route path="/window-mirror" element={<Navigate to="/screener" replace />} />
            <Route path="/momentum"    element={<MomentumPage />} />
            <Route path="/correlation" element={<CorrelationPage />} />
            <Route path="/prediction-audit" element={<PredictionAuditPage />} />
            <Route path="/system-health" element={<SystemHealthPage />} />
            {/* Settings mutates keywords, sources and platform credentials, all of
                which the API now restricts to admins. Gate the page so a non-admin
                sees one clear message instead of a form that 401s on save. */}
            <Route path="/settings"    element={<RequireAuth><SettingsPage /></RequireAuth>} />
          </Routes>
        </Suspense>
      </AppShell>
    </ApiHealthGate>
    </AuthProvider>
  )
}
