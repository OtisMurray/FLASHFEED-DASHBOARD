// Floating watch-output terminal. Props are the ones TopBar actually passes
// (`lines`, `interval`, `onStop`, `onClear`); a previous version expected
// `watchLines`/`watchInterval`, so `lines` arrived undefined and `.map()` threw,
// blanking the whole app. `lines` defaults to [] so it can never crash on mount.
export function WatchPanel({
  lines = [],
  interval,
  onStop,
  onClear,
}: {
  lines?: Array<{ text: string; type: string; ts: number }>
  interval: string
  onStop: () => void
  onClear: () => void
}) {
  return (
    <div className="fixed bottom-4 right-4 w-96 bg-gray-900 text-white rounded-lg shadow-lg overflow-hidden z-50">
      <div className="bg-gray-800 px-4 py-2 flex justify-between items-center">
        <h3 className="font-semibold text-sm">Watch Output · every {interval}s</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={onClear}
            className="text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded"
          >
            Clear
          </button>
          <button
            onClick={onStop}
            className="text-xs px-2 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded"
          >
            Stop
          </button>
        </div>
      </div>
      <div className="h-64 overflow-y-auto bg-gray-950 text-xs font-mono">
        {lines.map((line, i) => (
          <div
            key={i}
            className={`px-4 py-1 ${
              line.type === 'err'
                ? 'text-red-400'
                : line.type === 'new'
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
