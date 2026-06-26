export function SentimentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
         onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl p-6 w-[480px]"
           onClick={e => e.stopPropagation()}>
        <div className="text-white font-semibold mb-4">Sentiment Analysis</div>
        <p className="text-neutral text-sm">Coming soon.</p>
        <button onClick={onClose}
                className="mt-4 px-4 py-2 bg-accent text-white text-sm rounded">
          Close
        </button>
      </div>
    </div>
  )
}