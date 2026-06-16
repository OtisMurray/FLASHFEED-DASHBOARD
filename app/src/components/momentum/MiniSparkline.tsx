import { LineChart, Line, ResponsiveContainer } from 'recharts'

interface Props { prices: number[] }

export function MiniSparkline({ prices }: Props) {
  if (prices.length < 2) {
    return (
      <div className="w-[60px] h-[24px] flex items-center">
        <div className="w-full h-px bg-slate-600" />
      </div>
    )
  }
  const data = prices.map(v => ({ v }))
  const isUp = prices[prices.length - 1] >= prices[0]
  return (
    <div className="w-[60px] h-[24px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <Line
            type="monotone"
            dataKey="v"
            stroke={isUp ? '#10B981' : '#EF4444'}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
