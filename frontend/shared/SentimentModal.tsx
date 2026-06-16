export function SentimentModal({
  open,
  onClose,
}: {
  open?: boolean
  onClose?: () => void
}) {
  if (!open) return null

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420,
          borderRadius: 12,
          background: "#17243a",
          color: "#e5eefb",
          padding: 20,
          border: "1px solid #2a3b55",
        }}
      >
        <h2 style={{ marginTop: 0 }}>Sentiment</h2>
        <p style={{ color: "#9fb2cc" }}>
          Sentiment details will connect to the AI ranking and momentum layer.
        </p>
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  )
}
