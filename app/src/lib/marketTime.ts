export const MARKET_TIME_ZONE = "America/New_York";

export function toEpochMs(input: unknown): number | null {
  if (input == null) return null;
  if (input instanceof Date) return input.getTime();

  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    return input < 1_000_000_000_000 ? input * 1000 : input;
  }

  const raw = String(input).trim();
  if (!raw) return null;

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatMarketTime(input: unknown): string {
  const ms = toEpochMs(input);
  if (ms == null) return "--";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: MARKET_TIME_ZONE,
  }).format(new Date(ms));
}

export function formatMarketDateTime(input: unknown): string {
  const ms = toEpochMs(input);
  if (ms == null) return "--";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: MARKET_TIME_ZONE,
  }).format(new Date(ms));
}
