import { useEffect, useRef } from 'react'

interface Props {
  open: boolean
  onClose: () => void
  title: string
  wide?: boolean
  children: React.ReactNode
}

export function Modal({ open, onClose, title, wide, children }: Props) {
  const backdropRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      ref={backdropRef}
      onClick={e => { if (e.target === backdropRef.current) onClose() }}
      className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className={`bg-surface border border-border rounded-lg shadow-2xl flex flex-col max-h-[85vh] ${wide ? 'w-[90%] max-w-[700px]' : 'w-[90%] max-w-[520px]'}`}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-white font-semibold text-sm">{title}</h2>
          <button onClick={onClose} className="text-neutral hover:text-white text-lg leading-none">&times;</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  )
}
