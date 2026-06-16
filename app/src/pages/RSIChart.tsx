'use client'

interface Props { data: Array<{ time: string | number; value: number }> }

function finite(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function path(points: Array<{ x: number; y: number }>) {
  return points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')
}

export function RSIChart({ data }: Props) {
  const rows = data.map(row => ({ ...row, value: Math.max(0, Math.min(100, finite(row.value))) }))
  if (!rows.length) {
    return <div className="w-full h-full flex items-center justify-center text-[11px] text-neutral">No RSI data</div>
  }

  const width = 1000
  const height = 120
  const pad = { left: 34, right: 34, top: 12, bottom: 16 }
  const x = (index: number) => pad.left + (index / Math.max(1, rows.length - 1)) * (width - pad.left - pad.right)
  const y = (value: number) => pad.top + ((100 - value) / 100) * (height - pad.top - pad.bottom)
  const line = path(rows.map((row, index) => ({ x: x(index), y: y(row.value) })))

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full" preserveAspectRatio="none" role="img" aria-label="RSI chart">
      <rect width={width} height={height} fill="transparent" />
      {[30, 50, 70].map(level => (
        <g key={level}>
          <line x1={pad.left} x2={width - pad.right} y1={y(level)} y2={y(level)} stroke={level === 50 ? '#334155' : level > 50 ? 'rgba(239,68,68,0.45)' : 'rgba(16,185,129,0.45)'} strokeWidth="1" strokeDasharray={level === 50 ? '5 5' : '7 5'} />
          <text x={width - pad.right + 6} y={y(level) + 4} fill="#64748b" fontSize="10" fontFamily="monospace">{level}</text>
        </g>
      ))}
      <path d={line} fill="none" stroke="#a78bfa" strokeWidth="2.5" />
    </svg>
  )
}
