export function formatNumber(num: number): string {
  if (num >= 1_000_000_000_000) {
    return `${(num / 1_000_000_000_000).toFixed(1)}T`;
  }
  if (num >= 1_000_000_000) {
    return `${(num / 1_000_000_000).toFixed(1)}B`;
  }
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`;
  }
  return num.toString();
}

export function formatPrice(price: number): string {
  return `$${price.toFixed(2)}`;
}

export function formatSentiment(sentiment: number): string {
  return sentiment >= 0 ? `+${sentiment.toFixed(2)}` : sentiment.toFixed(2);
}

export function getSentimentColor(sentiment: number): string {
  if (sentiment > 0.2) return "text-emerald-500";
  if (sentiment < -0.2) return "text-red-500";
  return "text-muted-foreground";
}

export function getSentimentBgColor(sentiment: number): string {
  if (sentiment > 0.2) return "bg-emerald-500";
  if (sentiment < -0.2) return "bg-red-500";
  return "bg-muted-foreground";
}

export function getAnalystLabel(
  rating: number | null
): { label: string; variant: "default" | "destructive" | "secondary" } {
  if (rating === null) return { label: "-", variant: "secondary" };
  if (rating > 0.2) return { label: "Buy", variant: "default" };
  if (rating < -0.2) return { label: "Sell", variant: "destructive" };
  return { label: "Hold", variant: "secondary" };
}

export function getRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hr ago`;
  return `${diffDays} day ago`;
}

export function formatMarketCap(cap: number | null): string {
  if (cap === null || cap === undefined) return "-";
  if (cap >= 1_000_000_000_000) return `${(cap / 1_000_000_000_000).toFixed(1)}T`;
  if (cap >= 1_000_000_000) return `${(cap / 1_000_000_000).toFixed(1)}B`;
  if (cap >= 1_000_000) return `${(cap / 1_000_000).toFixed(1)}M`;
  return cap.toString();
}
