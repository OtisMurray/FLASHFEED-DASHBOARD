'use client'

interface MACDData {
  macd: Array<{ time: string | number; value: number }>
  signal: Array<{ time: string | number; value: number }>
  histogram: Array<{ time: string | number; value: number }>
}

interface Props { data?: MACDData }

function finite(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function path(points: Array<{ x: number; y: number }>) {
  return points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')
}

export function MACDChart({ data }: Props) {
  const macd = (data?.macd || []).map(row => ({ ...row, value: finite(row.value) }))
  const signal = (data?.signal || []).map(row => ({ ...row, value: finite(row.value) }))
  const histogram = (data?.histogram || []).map(row => ({ ...row, value: finite(row.value) }))

  if (!macd.length && !histogram.length) {
    return <div className="w-full h-full flex items-center justify-center text-[11px] text-neutral">No MACD data</div>
  }

  const width = 1000
  const height = 120
  const pad = { left: 34, right: 34, top: 12, bottom: 16 }
  const values = [...macd, ...signal, ...histogram].map(row => row.value)
  const maxAbs = Math.max(0.001, ...values.map(value => Math.abs(value)))
  const x = (index: number, count: number) => pad.left + (index / Math.max(1, count - 1)) * (width - pad.left - pad.right)
  const y = (value: number) => pad.top + ((maxAbs - value) / (maxAbs * 2)) * (height - pad.top - pad.bottom)
  const zeroY = y(0)
  const macdPath = path(macd.map((row, index) => ({ x: x(index, macd.length), y: y(row.value) })))
  const signalPath = path(signal.map((row, index) => ({ x: x(index, signal.length), y: y(row.value) })))
  const barW = Math.max(2, Math.min(12, (width - pad.left - pad.right) / Math.max(1, histogram.length) * 0.55))

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full" preserveAspectRatio="none" role="img" aria-label="MACD chart">
      <rect width={width} height={height} fill="transparent" />
      <line x1={pad.left} x2={width - pad.right} y1={zeroY} y2={zeroY} stroke="#334155" strokeWidth="1" strokeDasharray="5 5" />
      {histogram.map((row, index) => {
        const barX = x(index, histogram.length) - barW / 2
        const barY = Math.min(y(row.value), zeroY)
        const barH = Math.max(1, Math.abs(y(row.value) - zeroY))
        return <rect key={index} x={barX} y={barY} width={barW} height={barH} fill={row.value >= 0 ? 'rgba(16,185,129,0.55)' : 'rgba(239,68,68,0.55)'} rx="1" />
      })}
      {macdPath && <path d={macdPath} fill="none" stroke="#38bdf8" strokeWidth="2.2" />}
      {signalPath && <path d={signalPath} fill="none" stroke="#f59e0b" strokeWidth="2.2" />}
      <text x={pad.left} y={height - 4} fill="#38bdf8" fontSize="10" fontFamily="monospace">MACD</text>
      <text x={pad.left + 45} y={height - 4} fill="#f59e0b" fontSize="10" fontFamily="monospace">signal</text>
    </svg>
  )
}
