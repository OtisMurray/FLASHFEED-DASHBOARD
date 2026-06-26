import { RunButton } from './RunButton'

interface Props { onRun: () => void }

export function EmptyState({ onRun }: Props) {
  return (
    <div className="max-w-lg mx-auto mt-12">
      <div className="bg-surface border border-border rounded-lg p-6">
        <h2 className="text-white font-semibold mb-2">How alignment works</h2>
        <p className="text-neutral text-sm leading-relaxed mb-4">
          FlashFeed compares recent ticker sentiment with the latest stored quote move.
          Refresh alignment signals after fetching fresh articles and quotes to populate this table.
        </p>
        <RunButton onComplete={onRun} />
      </div>
    </div>
  )
}
