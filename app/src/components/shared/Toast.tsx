import { createContext, useContext, useState, useCallback, useRef } from 'react'
import { clsx } from 'clsx'

type ToastType = 'success' | 'error' | 'info' | 'warn'

interface ToastItem {
  id: number
  title: string
  message?: string
  type: ToastType
  latency?: number
}

interface ToastCtx {
  toast: (title: string, message?: string, type?: ToastType, latency?: number) => void
}

const Ctx = createContext<ToastCtx>({ toast: () => {} })
export const useToast = () => useContext(Ctx)

let _id = 0

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const timers = useRef<Map<number, NodeJS.Timeout>>(new Map())

  const toast = useCallback((title: string, message?: string, type: ToastType = 'info', latency?: number) => {
    const id = ++_id
    setToasts(t => [...t, { id, title, message, type, latency }])
    const timer = setTimeout(() => {
      setToasts(t => t.filter(x => x.id !== id))
      timers.current.delete(id)
    }, 4000)
    timers.current.set(id, timer)
  }, [])

  const dismiss = (id: number) => {
    setToasts(t => t.filter(x => x.id !== id))
    const timer = timers.current.get(id)
    if (timer) { clearTimeout(timer); timers.current.delete(id) }
  }

  const icons: Record<ToastType, string> = { success: '✓', error: '✗', info: '⚡', warn: '⚠' }
  const colors: Record<ToastType, string> = {
    success: 'border-l-emerald-500',
    error: 'border-l-red-500',
    info: 'border-l-sky-500',
    warn: 'border-l-yellow-500',
  }

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div
            key={t.id}
            onClick={() => dismiss(t.id)}
            className={clsx(
              'pointer-events-auto bg-surface border border-border border-l-[3px] rounded-lg px-3 py-2 shadow-2xl cursor-pointer',
              'animate-in slide-in-from-right min-w-[260px] max-w-[360px]',
              colors[t.type]
            )}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm">{icons[t.type]}</span>
              <span className="text-sm text-white font-medium flex-1">{t.title}</span>
              {t.latency != null && (
                <span className={clsx(
                  'text-[10px] font-mono px-1.5 py-0.5 rounded',
                  t.latency < 500 ? 'text-emerald-400 bg-emerald-500/10' :
                  t.latency < 2000 ? 'text-yellow-400 bg-yellow-500/10' :
                  'text-red-400 bg-red-500/10'
                )}>
                  {t.latency}ms
                </span>
              )}
            </div>
            {t.message && <p className="text-xs text-neutral mt-0.5 ml-5">{t.message}</p>}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}
