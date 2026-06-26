export function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-gray-100 text-sm">
      <div className={`w-2 h-2 rounded-full ${ok ? 'bg-green-500' : 'bg-red-500'}`} />
      <span className={ok ? 'text-green-700' : 'text-red-700'}>{label}</span>
    </div>
  )
}
