// Release countdowns (DESIGN §9.10): "in 5 days", "Tomorrow", "Out today!" for releases whose day
// is known. The page renders one from the server's date, and a script redoes it with the reader's
// own date, so a cached page never shows a stale countdown for long and needs no script to show one.

export interface Countdown {
  text: string;
  /** "today" glows, "soon" (a week or less) is accented, "later" is quiet. */
  tone: "today" | "soon" | "later";
}

const DAY = 86_400_000;

/** `date` and `today` are YYYY-MM-DD. Nothing for past releases or ones more than 9 weeks out. */
export function countdown(date: string, today: string): Countdown | null {
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
  if (!Number.isFinite(days) || days < 0 || days > 63) return null;
  if (days === 0) return { text: "Out today!", tone: "today" };
  if (days === 1) return { text: "Tomorrow", tone: "soon" };
  if (days < 14) return { text: `in ${days} days`, tone: days <= 7 ? "soon" : "later" };
  return { text: `in ${Math.floor(days / 7)} weeks`, tone: "later" };
}

/** Today's date where the reader is, as YYYY-MM-DD. */
export function localToday(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
