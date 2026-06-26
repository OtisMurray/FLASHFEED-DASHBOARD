interface Props { label: string; onRemove: () => void }
export function FilterPill({ label, onRemove }: Props) {
  return (
    <span className="flex items-center gap-1 text-xs bg-accent/10 border border-accent/30 text-accent px-2 py-1 rounded">
      {label}
      <button onClick={onRemove} className="hover:text-white ml-1">×</button>
    </span>
  )
}
