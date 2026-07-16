export function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={`flex min-w-0 items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-xs font-medium ${
      ok
        ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
        : 'bg-red-500/20 border-red-500/50 text-red-300'
    }`}>
      <div className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${ok ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
      <span className="min-w-0 max-w-[9rem] truncate">{label}</span>
    </div>
  )
}
