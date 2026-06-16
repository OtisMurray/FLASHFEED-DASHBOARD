export function WatchPanel({
  lines,
  interval,
  onStop,
  onClear,
}: {
  lines: Array<{ text: string; type: string; ts: number }>
  interval: string
  onStop: () => void
  onClear: () => void
}) {
  return (
    <div className="fixed bottom-4 right-4 w-96 bg-gray-900 text-white rounded-lg shadow-lg overflow-hidden">
      <div className="bg-gray-800 px-4 py-2 flex justify-between items-center">
        <h3 className="font-semibold">Auto-Watch</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">{interval}s</span>
          <button onClick={onClear} className="px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded">Clear</button>
          <button onClick={onStop} className="px-2 py-1 text-xs bg-red-700 hover:bg-red-600 rounded">Stop</button>
        </div>
      </div>
      <div className="h-64 overflow-y-auto bg-gray-950 text-xs font-mono">
        {lines && lines.map((line, i) => (
          <div
            key={i}
            className={`px-4 py-1 ${
              line.type === 'error'
                ? 'text-red-400'
                : line.type === 'success'
                  ? 'text-green-400'
                  : 'text-gray-300'
            }`}
          >
            {line.text}
          </div>
        ))}
      </div>
    </div>
  )
}
