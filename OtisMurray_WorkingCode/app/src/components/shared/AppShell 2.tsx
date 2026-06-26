import { TopBar } from './TopBar'
import { ToastProvider } from '@/components/shared/Toast'

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <div className="flex h-screen bg-bg overflow-hidden">
        <div className="flex flex-col flex-1 min-w-0">
          <TopBar />
          <main className="flex-1 overflow-auto p-4 md:p-5">{children}</main>
        </div>
      </div>
    </ToastProvider>
  )
}
