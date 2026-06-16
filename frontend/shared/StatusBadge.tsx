export function StatusBadge({ status = "connected" }: { status?: string }) {
  const isConnected = status === "connected" || status === "ok" || status === "healthy"

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 12px",
        borderRadius: 999,
        background: "#f8fafc",
        color: isConnected ? "#16a34a" : "#dc2626",
        fontSize: 13,
        fontWeight: 600,
      }}
    >
      ● {isConnected ? "Connected" : status}
    </span>
  )
}
