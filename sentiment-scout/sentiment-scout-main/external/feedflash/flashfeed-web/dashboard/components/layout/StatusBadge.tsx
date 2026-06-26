import { clsx } from 'clsx'

interface StatusBadgeProps {
  ok: boolean; label: string; warn?: boolean;
}

export function StatusBadge({ ok, label, warn }: StatusBadgeProps) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className={clsx(
        'w-1.5 h-1.5 rounded-full',
        warn ? 'bg-yellow-400' : ok ? 'bg-bull' : 'bg-bear'
      )} />
      <span className="text-neutral">{label}</span>
    </div>
  )
}
