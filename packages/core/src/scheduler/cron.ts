// A small 5-field cron parser (minute hour day-of-month month day-of-week), evaluated in UTC.
// Supports `*`, numbers, ranges `a-b`, steps `*/n` and `a-b/n`, and lists `a,b`. Day-of-week
// accepts 0-7 (0 and 7 are Sunday). As in standard cron, when both day fields are restricted,
// a day matches if either matches.

export interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
] as const;

export class CronError extends Error {
  override name = "CronError";
}

export function parseCron(expr: string): CronSchedule {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError(`cron needs 5 fields, got ${parts.length}: "${expr}"`);
  const sets = parts.map((part, i) => {
    const field = FIELDS[i];
    if (!field) throw new CronError(`bad cron "${expr}"`);
    return parseField(part, field.name, field.min, field.max);
  });
  const [minutes, hours, daysOfMonth, months, dowRaw] = sets as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  const daysOfWeek = new Set([...dowRaw].map((d) => d % 7));
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

function parseField(part: string, name: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const item of part.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
    if (!match) throw new CronError(`bad ${name} field "${part}"`);
    const [, range = "", stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`bad step in ${name} field "${part}"`);
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a, b] = range.split("-").map(Number) as [number, number | undefined];
      lo = a;
      hi = b ?? (stepText === undefined ? a : max);
    }
    if (lo < min || hi > max || lo > hi) throw new CronError(`${name} out of range in "${part}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function dayMatches(s: CronSchedule, date: Date): boolean {
  if (!s.months.has(date.getUTCMonth() + 1)) return false;
  const dom = s.daysOfMonth.has(date.getUTCDate());
  const dow = s.daysOfWeek.has(date.getUTCDay());
  if (s.domRestricted && s.dowRestricted) return dom || dow;
  if (s.domRestricted) return dom;
  if (s.dowRestricted) return dow;
  return true;
}

/** The first matching minute strictly after `after`. Searches up to five years ahead. */
export function nextCronTime(expr: string | CronSchedule, after: Date): Date {
  const s = typeof expr === "string" ? parseCron(expr) : expr;
  const start = new Date(after.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);

  const hours = [...s.hours].sort((a, b) => a - b);
  const minutes = [...s.minutes].sort((a, b) => a - b);
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  for (let i = 0; i < 366 * 5; i++) {
    if (dayMatches(s, day)) {
      const sameDay = i === 0;
      for (const h of hours) {
        if (sameDay && h < start.getUTCHours()) continue;
        for (const m of minutes) {
          if (sameDay && h === start.getUTCHours() && m < start.getUTCMinutes()) continue;
          return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m));
        }
      }
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  throw new CronError("cron never fires within five years");
}

export function isValidCron(expr: string): boolean {
  try {
    nextCronTime(expr, new Date());
    return true;
  } catch {
    return false;
  }
}
