export function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm font-medium ${
      ok
        ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
        : 'bg-red-500/20 border-red-500/50 text-red-300'
    }`}>
      <div className={`w-2 h-2 rounded-full ${ok ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
      <span>{label}</span>
    </div>
  )
}
