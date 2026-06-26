import { RunButton } from './RunButton'

interface Props { onRun: () => void }

export function EmptyState({ onRun }: Props) {
  return (
    <div className="max-w-lg mx-auto mt-12">
      <div className="bg-surface border border-border rounded-lg p-6">
        <h2 className="text-white font-semibold mb-2">How correlation works</h2>
        <p className="text-neutral text-sm leading-relaxed mb-4">
          FlashFeed measures whether news sentiment for a ticker moves in step with its price.
          Run a correlation pass after fetching fresh articles to populate this table.
        </p>
        <RunButton onComplete={onRun} />
      </div>
    </div>
  )
}
