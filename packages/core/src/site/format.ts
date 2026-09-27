// Display helpers shared by pages, feeds and cards. Plain functions, so they're easy to test.

import { CONTENT_FLAG_DEFS, CRUNCH_LEVELS, ROMANCE_LEVELS } from "../taxonomy";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A release date at the precision we actually know: "3 Nov 2026", "Nov 2026", "Q1 2027", "2027", "TBA". */
export function formatDate(date: string | null, precision: string | null = "day"): string {
  if (!date || precision === "tba") return "TBA";
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(date);
  if (!m) return "TBA";
  const [, year, month, day] = m;
  const monthName = MONTHS[Number(month) - 1] ?? "";
  switch (precision) {
    case "year":
      return year ?? "TBA";
    case "quarter":
      return `Q${Math.floor((Number(month) - 1) / 3) + 1} ${year}`;
    case "month":
      return `${monthName} ${year}`;
    default:
      return day ? `${Number(day)} ${monthName} ${year}` : `${monthName} ${year}`;
  }
}

/** "15 h 20 min" */
export function formatDuration(minutes: number | null): string | null {
  if (!minutes || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

export const FORMAT_LABEL: Record<string, string> = {
  ebook: "Ebook",
  audiobook: "Audiobook",
  paperback: "Paperback",
  hardcover: "Hardcover",
  serial: "Web serial",
};

export const RELEASE_LABEL: Record<string, string> = {
  ebook: "Ebook",
  audio: "Audiobook",
  print: "Print",
  serial_start: "Serial starts",
  serial_complete: "Serial completes",
  ku_add: "Joins Kindle Unlimited",
};

export const LINK_LABEL: Record<string, string> = {
  amazon: "Amazon",
  audible: "Audible",
  royalroad: "Royal Road",
  kobo: "Kobo",
  apple: "Apple Books",
  google: "Google Play",
  bn: "Barnes & Noble",
  books2read: "Books2Read",
  scribblehub: "Scribble Hub",
  patreon: "Patreon",
  author_site: "Author's site",
};

export const SERIES_STATUS_LABEL: Record<string, string> = {
  ongoing: "Ongoing",
  complete: "Complete",
  hiatus: "On hiatus",
  no_recent_releases: "No recent releases",
  unknown: "Status unknown",
};

export const HAREM_LABEL: Record<string, string> = {
  none: "No harem",
  implied: "Harem implied",
  harem: "Harem",
  reverse_harem: "Reverse harem",
  unknown: "Harem: unknown",
};

const levelLabel = (levels: readonly { value: number; label: string }[]) => (value: number | null) =>
  value === null ? null : (levels.find((l) => l.value === value)?.label ?? null);
export const crunchLabel = levelLabel(CRUNCH_LEVELS);
export const romanceLabel = levelLabel(ROMANCE_LEVELS);

export const CONTENT_FLAG_LABEL: Record<string, string> = Object.fromEntries(
  CONTENT_FLAG_DEFS.map((f) => [f.slug, f.name]),
);

/**
 * Store links: an Amazon link carries the site's Associates tag when one is set (DESIGN §11.6,
 * §16.4). Links are stored normalized, so a tag here never doubles one already in the URL.
 */
export function storeLink(kind: string, url: string, amazonTag: string): { url: string; affiliate: boolean } {
  if (kind !== "amazon" || !amazonTag) return { url, affiliate: false };
  try {
    const u = new URL(url);
    if (!/(^|\.)amazon\.[a-z.]+$/.test(u.hostname)) return { url, affiliate: false };
    u.searchParams.set("tag", amazonTag);
    return { url: u.toString(), affiliate: true };
  } catch {
    return { url, affiliate: false };
  }
}

/** Position in a series, as readers say it: "Book 3", "Book 2.5". */
export const bookNumber = (position: number | null) =>
  position === null ? null : `Book ${Number.isInteger(position) ? position : position.toFixed(1)}`;
