import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { ToastProvider } from '@/components/shared/Toast'
import { ErrorBoundary } from './ErrorBoundary'

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <div className="flex h-screen bg-bg overflow-hidden">
        <Sidebar />
        <div className="flex flex-col flex-1 min-w-0">
          {/* Contain a TopBar crash so it can never blank the whole app. */}
          <ErrorBoundary label="the top bar">
            <TopBar />
          </ErrorBoundary>
          <main className="flex-1 overflow-auto p-4">
            {/* Contain page-render crashes so the shell/nav survive. */}
            <ErrorBoundary label="this page">{children}</ErrorBoundary>
          </main>
        </div>
      </div>
    </ToastProvider>
  )
}
