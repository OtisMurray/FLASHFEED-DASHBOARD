"use client";

interface ScoreGaugeProps {
  sentiment: number; // -1 to +1
  size?: number;
}

export function ScoreGauge({ sentiment, size = 160 }: ScoreGaugeProps) {
  const cx = size / 2;
  const cy = size / 2 + 10;
  const radius = size / 2 - 20;
  const strokeWidth = 12;

  // Arc from -90deg (left) to 90deg (right) = 180deg semicircle
  const startAngle = -180;
  const endAngle = 0;
  const sweepAngle = endAngle - startAngle;

  // Needle angle: sentiment -1 = left (-180deg), +1 = right (0deg)
  const needleAngle = startAngle + ((sentiment + 1) / 2) * sweepAngle;
  const needleRad = (needleAngle * Math.PI) / 180;
  const needleLength = radius - 10;
  const needleX = cx + needleLength * Math.cos(needleRad);
  const needleY = cy + needleLength * Math.sin(needleRad);

  // Arc path helper
  const polarToCartesian = (angle: number) => {
    const rad = (angle * Math.PI) / 180;
    return {
      x: cx + radius * Math.cos(rad),
      y: cy + radius * Math.sin(rad),
    };
  };

  const arcStart = polarToCartesian(startAngle);
  const arcEnd = polarToCartesian(endAngle);
  const arcMid = polarToCartesian(startAngle + sweepAngle / 2);

  // Create two arcs: red (left) and green (right)
  const redArcPath = `M ${arcStart.x} ${arcStart.y} A ${radius} ${radius} 0 0 1 ${arcMid.x} ${arcMid.y}`;
  const greenArcPath = `M ${arcMid.x} ${arcMid.y} A ${radius} ${radius} 0 0 1 ${arcEnd.x} ${arcEnd.y}`;

  const label =
    sentiment > 0.3
      ? "Bullish"
      : sentiment < -0.3
        ? "Bearish"
        : "Neutral";

  const labelColor =
    sentiment > 0.3
      ? "#10b981"
      : sentiment < -0.3
        ? "#ef4444"
        : "#94a3b8";

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size / 2 + 30} viewBox={`0 0 ${size} ${size / 2 + 30}`}>
        <defs>
          <linearGradient id="redGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#ef4444" />
            <stop offset="100%" stopColor="#f59e0b" />
          </linearGradient>
          <linearGradient id="greenGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#f59e0b" />
            <stop offset="100%" stopColor="#10b981" />
          </linearGradient>
        </defs>

        {/* Background arc */}
        <path
          d={`M ${arcStart.x} ${arcStart.y} A ${radius} ${radius} 0 0 1 ${arcEnd.x} ${arcEnd.y}`}
          fill="none"
          stroke="#1e293b"
          strokeWidth={strokeWidth + 4}
          strokeLinecap="round"
        />

        {/* Red half */}
        <path
          d={redArcPath}
          fill="none"
          stroke="url(#redGrad)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />

        {/* Green half */}
        <path
          d={greenArcPath}
          fill="none"
          stroke="url(#greenGrad)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />

        {/* Needle */}
        <line
          x1={cx}
          y1={cy}
          x2={needleX}
          y2={needleY}
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        />
        <circle cx={cx} cy={cy} r={4} fill="currentColor" />

        {/* Labels */}
        <text x={arcStart.x - 5} y={cy + 16} fill="#ef4444" fontSize="10" textAnchor="end">
          -1
        </text>
        <text x={arcEnd.x + 5} y={cy + 16} fill="#10b981" fontSize="10" textAnchor="start">
          +1
        </text>
      </svg>
      <div className="text-center -mt-1">
        <div className="text-2xl font-bold font-mono" style={{ color: labelColor }}>
          {sentiment >= 0 ? "+" : ""}{sentiment.toFixed(2)}
        </div>
        <div className="text-xs text-dim">{label}</div>
      </div>
    </div>
  );
}
