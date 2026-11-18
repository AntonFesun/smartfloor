export function formatUAH(value: number): string {
  const formatted = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 }).format(value);
  return `₴${formatted}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  const sign = ms < 0 ? "-" : "";
  const totalSeconds = Math.round(Math.abs(ms) / 1000);
  if (totalSeconds < 60) return `${sign}${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${sign}${minutes}m` : `${sign}${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${sign}${hours}h` : `${sign}${hours}h ${remainder}m`;
}

export function formatClock(iso: string): string {
  return new Intl.DateTimeFormat("uk-UA", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function formatAgo(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  if (ms < 15_000) return "just now";
  return `${formatDuration(ms)} ago`;
}
