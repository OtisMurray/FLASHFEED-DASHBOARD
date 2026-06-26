interface Props { value: number }

export function CorrelationBar({ value }: Props) {
  const pct = Math.abs(value) * 50
  const isPos = value >= 0
  return (
    <div className="flex items-center w-28 h-2 bg-slate-700 rounded-full overflow-hidden">
      {isPos ? (
        <>
          <div style={{ width: '50%' }} />
          <div style={{ width: `${pct}%` }} className="h-full bg-emerald-500 rounded-full" />
        </>
      ) : (
        <>
          <div style={{ width: `${50 - pct}%` }} />
          <div style={{ width: `${pct}%` }} className="h-full bg-red-500 rounded-full" />
          <div style={{ width: '50%' }} />
        </>
      )}
    </div>
  )
}
