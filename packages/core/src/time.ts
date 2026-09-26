// Timestamps are UTC ISO-8601 strings (DESIGN §5.1). ISO strings sort correctly as text.

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

export function addHours(iso: string, hours: number): string {
  return addSeconds(iso, hours * 3600);
}

export function hoursBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 3_600_000;
}
