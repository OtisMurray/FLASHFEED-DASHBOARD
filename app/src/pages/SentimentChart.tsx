'use client'

interface Props { data: Array<{ time: string | number; value: number }> }

function finite(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function path(points: Array<{ x: number; y: number }>) {
  return points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')
}

export function SentimentChart({ data }: Props) {
  const rows = data.map(row => ({ ...row, value: finite(row.value) }))
  if (!rows.length) {
    return <div className="w-full h-full flex items-center justify-center text-[11px] text-neutral">No series data</div>
  }

  const width = 1000
  const height = 120
  const pad = { left: 34, right: 28, top: 12, bottom: 18 }
  const values = rows.map(row => row.value)
  const maxAbs = Math.max(0.1, ...values.map(value => Math.abs(value)))
  const x = (index: number) => pad.left + (index / Math.max(1, rows.length - 1)) * (width - pad.left - pad.right)
  const y = (value: number) => pad.top + ((maxAbs - value) / (maxAbs * 2)) * (height - pad.top - pad.bottom)
  const line = path(rows.map((row, index) => ({ x: x(index), y: y(row.value) })))
  const zeroY = y(0)

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full" preserveAspectRatio="none" role="img" aria-label="Signal chart">
      <rect width={width} height={height} fill="transparent" />
      <line x1={pad.left} x2={width - pad.right} y1={zeroY} y2={zeroY} stroke="#334155" strokeWidth="1" strokeDasharray="5 5" />
      {[0.25, 0.5, 0.75].map(f => (
        <line key={f} x1={pad.left} x2={width - pad.right} y1={pad.top + f * (height - pad.top - pad.bottom)} y2={pad.top + f * (height - pad.top - pad.bottom)} stroke="#172033" strokeWidth="1" />
      ))}
      {rows.map((row, index) => {
        const value = row.value
        const barY = Math.min(y(value), zeroY)
        const barH = Math.max(1, Math.abs(y(value) - zeroY))
        const barW = Math.max(2, Math.min(14, (width - pad.left - pad.right) / rows.length * 0.55))
        const color = value > 0.15 ? 'rgba(16,185,129,0.68)' : value < -0.15 ? 'rgba(239,68,68,0.68)' : 'rgba(148,163,184,0.48)'
        return <rect key={index} x={x(index) - barW / 2} y={barY} width={barW} height={barH} fill={color} rx="1" />
      })}
      <path d={line} fill="none" stroke="#38bdf8" strokeWidth="2" />
      <text x={width - pad.right + 5} y={y(maxAbs) + 4} fill="#64748b" fontSize="10" fontFamily="monospace">{maxAbs.toFixed(2)}</text>
      <text x={width - pad.right + 5} y={y(-maxAbs) + 4} fill="#64748b" fontSize="10" fontFamily="monospace">{(-maxAbs).toFixed(2)}</text>
    </svg>
  )
}
