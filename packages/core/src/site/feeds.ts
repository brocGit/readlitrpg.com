// Public feeds (DESIGN §9.4, Appendix A): RSS for new books and release news, iCalendar for
// release days. Built as plain strings: both formats are small and well specified.

import { bookNumber, formatDate, RELEASE_LABEL } from "./format";
import type { PublishedItem, UpcomingRelease } from "./pages";

const xml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] ?? c,
  );

export interface RssItem {
  title: string;
  link: string;
  guid: string;
  pubDate: string;
  description: string;
}

export function rss(
  channel: { title: string; link: string; self: string; description: string },
  items: RssItem[],
): string {
  const newest =
    items
      .map((i) => i.pubDate)
      .sort()
      .at(-1) ?? new Date(0).toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${xml(channel.title)}</title>
<link>${xml(channel.link)}</link>
<atom:link href="${xml(channel.self)}" rel="self" type="application/rss+xml"/>
<description>${xml(channel.description)}</description>
<language>en</language>
<lastBuildDate>${new Date(newest).toUTCString()}</lastBuildDate>
${items
  .map(
    (i) => `<item>
<title>${xml(i.title)}</title>
<link>${xml(i.link)}</link>
<guid isPermaLink="false">${xml(i.guid)}</guid>
<pubDate>${new Date(i.pubDate).toUTCString()}</pubDate>
<description>${xml(i.description)}</description>
</item>`,
  )
  .join("\n")}
</channel>
</rss>
`;
}

const seriesPart = (r: UpcomingRelease) =>
  r.series
    ? ` (${r.series.name}${bookNumber(r.series.position) ? `, ${bookNumber(r.series.position)}` : ""})`
    : "";

/** A release as a feed item: it reappears when its date changes, since the guid includes the date. */
export function releaseItem(r: UpcomingRelease, origin: string): RssItem {
  const kind = RELEASE_LABEL[r.kind] ?? r.kind;
  const when = formatDate(r.date, r.precision);
  const delayed =
    r.status === "slipped" && r.previousDate ? ` Delayed from ${formatDate(r.previousDate, "day")}.` : "";
  return {
    title: `${r.title}${seriesPart(r)}: ${kind}, ${when}`,
    link: `${origin}/books/${r.bookSlug}`,
    guid: `release:${r.id}:${r.date}`,
    pubDate: r.updatedAt,
    description: `${kind} release of ${r.title}${seriesPart(r)}: ${when}.${delayed}`,
  };
}

export function publishedItem(b: PublishedItem, origin: string, tagName?: string): RssItem {
  return {
    title: `${tagName ? `New in ${tagName}: ` : "New: "}${b.title}${b.authors ? ` by ${b.authors}` : ""}`,
    link: `${origin}/books/${b.slug}`,
    guid: `book:${b.id}`,
    pubDate: b.publishedAt,
    description: b.hook ?? `${b.title}${b.authors ? ` by ${b.authors}` : ""} is now on ReadLitRPG.`,
  };
}

// ---------------------------------------------------------------------------------------------
// iCalendar (RFC 5545)

const icsText = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Lines longer than 75 octets are folded with CRLF + space. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join("\r\n ");
}

const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d+/, "").slice(0, 15) + "Z";

/**
 * Only releases with a known day become events: a calendar entry on the 1st of a month would
 * claim a date nobody announced.
 */
export function ics(name: string, releases: UpcomingRelease[], origin: string): string {
  const events = releases
    .filter((r) => r.precision === "day" && /^\d{4}-\d{2}-\d{2}$/.test(r.date))
    .map((r) => {
      const day = r.date.replace(/-/g, "");
      const next = new Date(Date.parse(`${r.date}T00:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10)
        .replace(/-/g, "");
      const item = releaseItem(r, origin);
      return [
        "BEGIN:VEVENT",
        `UID:${r.id}@readlitrpg.com`,
        `DTSTAMP:${stamp(r.updatedAt)}`,
        `DTSTART;VALUE=DATE:${day}`,
        `DTEND;VALUE=DATE:${next}`,
        `SUMMARY:${icsText(item.title)}`,
        `DESCRIPTION:${icsText(item.description)}`,
        `URL:${item.link}`,
        "TRANSP:TRANSPARENT",
        "END:VEVENT",
      ];
    });
  return `${[
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ReadLitRPG//Releases//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(name)}`,
    ...events.flat(),
    "END:VCALENDAR",
  ]
    .map(fold)
    .join("\r\n")}\r\n`;
}
