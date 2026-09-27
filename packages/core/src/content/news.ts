// The news desk's data side (DESIGN §14.6; STRATEGY §6 "News is daily"). Every hour, catalog
// changes become tips (new announcements, date changes, cancellations, completed series). Every
// morning they go into "Today in LitRPG" with the books out today and what's coming this week.
// Roundups (§14.1) are built the same way. All of it is templated from our own data: every book
// renders as a live card or link, and every date and count in the text comes from the catalog.

import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import type { Db } from "../db";
import { books, newsTips, posts, releases, series } from "../db/schema";
import { ulid } from "../ids";
import { formatDate, RELEASE_LABEL } from "../site/format";
import { releasesBetween, type UpcomingRelease } from "../site/pages";
import { nowIso } from "../time";

const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) => day(new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000));

const kindLabel = (kind: string) => (RELEASE_LABEL[kind] ?? kind).toLowerCase();

const publicBook = (now: string) =>
  and(
    eq(books.visibility, "published"),
    isNull(books.redirectTo),
    sql`(${books.embargoUntil} is null or ${books.embargoUntil} <= ${now})`,
  );

async function addTip(
  db: Db,
  t: {
    kind: string;
    subject: string;
    dedupeKey: string;
    bookId?: string;
    seriesId?: string;
    data: Record<string, unknown>;
  },
): Promise<boolean> {
  const rows = await db
    .insert(newsTips)
    .values({
      id: ulid(),
      source: "data",
      kind: t.kind,
      subject: t.subject.slice(0, 300),
      bookId: t.bookId ?? null,
      seriesId: t.seriesId ?? null,
      data: t.data,
      dedupeKey: t.dedupeKey,
    })
    .onConflictDoNothing()
    .returning({ id: newsTips.id });
  return rows.length === 1;
}

/**
 * Turn recent catalog changes into tips (`news.from_catalog`, hourly). The lookback overlaps the
 * schedule and the dedupe keys make repeats harmless. Returns how many new tips were added.
 */
export async function collectCatalogTips(db: Db, now = new Date(), lookbackHours = 3): Promise<number> {
  const since = new Date(now.getTime() - lookbackHours * 3_600_000).toISOString();
  const nowS = now.toISOString();
  const today = day(now);
  const fields = {
    releaseId: releases.id,
    bookId: books.id,
    slug: books.slug,
    title: books.title,
    kind: releases.kind,
    date: releases.date,
    precision: releases.datePrecision,
    previousDate: releases.previousDate,
    status: releases.status,
  };
  const [moved, created, newlyPublished, cancelled, completed] = await Promise.all([
    db
      .select(fields)
      .from(releases)
      .innerJoin(books, eq(books.id, releases.bookId))
      .where(
        and(
          publicBook(nowS),
          gte(releases.updatedAt, since),
          isNotNull(releases.previousDate),
          isNotNull(releases.date),
          ne(releases.status, "cancelled"),
        ),
      )
      .limit(100),
    db
      .select(fields)
      .from(releases)
      .innerJoin(books, eq(books.id, releases.bookId))
      .where(
        and(
          publicBook(nowS),
          gte(releases.createdAt, since),
          gt(releases.date, today),
          ne(releases.status, "cancelled"),
        ),
      )
      .limit(100),
    db
      .select(fields)
      .from(releases)
      .innerJoin(books, eq(books.id, releases.bookId))
      .where(
        and(
          publicBook(nowS),
          gte(books.publishedAt, since),
          gt(releases.date, today),
          ne(releases.status, "cancelled"),
        ),
      )
      .limit(100),
    db
      .select(fields)
      .from(releases)
      .innerJoin(books, eq(books.id, releases.bookId))
      .where(and(publicBook(nowS), gte(releases.updatedAt, since), eq(releases.status, "cancelled")))
      .limit(50),
    db
      .select({ id: series.id, slug: series.slug, name: series.name })
      .from(series)
      .where(and(eq(series.status, "complete"), gte(series.updatedAt, since), isNull(series.redirectTo)))
      .limit(50),
  ]);
  let added = 0;
  for (const r of moved)
    if (r.previousDate && r.previousDate !== r.date)
      added += Number(
        await addTip(db, {
          kind: "date_moved",
          subject: r.title,
          bookId: r.bookId,
          dedupeKey: `moved:${r.releaseId}:${r.date}`,
          data: { slug: r.slug, kind: r.kind, from: r.previousDate, to: r.date, precision: r.precision },
        }),
      );
  for (const r of [...created, ...newlyPublished])
    added += Number(
      await addTip(db, {
        kind: "announced",
        subject: r.title,
        bookId: r.bookId,
        dedupeKey: `announced:${r.releaseId}`,
        data: { slug: r.slug, kind: r.kind, date: r.date, precision: r.precision },
      }),
    );
  for (const r of cancelled)
    added += Number(
      await addTip(db, {
        kind: "cancelled",
        subject: r.title,
        bookId: r.bookId,
        dedupeKey: `cancelled:${r.releaseId}`,
        data: { slug: r.slug, kind: r.kind },
      }),
    );
  for (const s of completed)
    added += Number(
      await addTip(db, {
        kind: "completed",
        subject: s.name,
        seriesId: s.id,
        dedupeKey: `completed:${s.id}`,
        data: { slug: s.slug },
      }),
    );
  return added;
}

/** A templated post, ready to save (see publishAutoPost). */
export interface AutoBuilt {
  type: "daily" | "roundup";
  title: string;
  slug: string;
  dek: string;
  bodyMd: string;
  genKey: string;
  noindex: boolean;
  /** What it was built from, kept on the post (§14.4) for an editorial run's prose later. */
  data: Record<string, unknown>;
  /** How many distinct things it reports. */
  items: number;
  tipIds: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (parts: string[]) =>
  parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
const longDate = (date: string, withYear = false) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
const monthName = (month: string) =>
  new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

const uniqueBooks = (rs: UpcomingRelease[]) => [...new Map(rs.map((r) => [r.bookSlug, r])).values()];

/** Cards for the first few books, then plain links, so a big day stays readable. */
function bookBlock(rs: UpcomingRelease[], cards = 10): string[] {
  const out = rs.slice(0, cards).map((r) => `[[book:${r.bookSlug}]]`);
  const rest = rs.slice(cards);
  if (rest.length) out.push(rest.map((r) => `- [[book:${r.bookSlug}]]`).join("\n"));
  return out;
}

const AUDIO = ["audio"];
const BOOKS = ["ebook", "print", "serial_start"];

/** "Today in LitRPG" for `date` (YYYY-MM-DD), from releases and the tips not yet reported. */
export async function buildDailyPost(db: Db, date: string, now = new Date()): Promise<AutoBuilt> {
  const nowS = now.toISOString();
  const [todays, week, tips, briefs] = await Promise.all([
    releasesBetween(db, date, date, { now: nowS, limit: 200 }),
    releasesBetween(db, addDays(date, 1), addDays(date, 7), { now: nowS, limit: 60 }),
    db
      .select()
      .from(newsTips)
      .where(and(eq(newsTips.source, "data"), eq(newsTips.status, "new")))
      .orderBy(newsTips.createdAt)
      .limit(200),
    db
      .select({ slug: posts.slug, title: posts.title })
      .from(posts)
      .where(
        and(
          eq(posts.type, "news"),
          eq(posts.status, "published"),
          gte(posts.publishedAt, `${addDays(date, -1)}T00:00:00.000Z`),
        ),
      )
      .orderBy(desc(posts.publishedAt))
      .limit(20),
  ]);
  const out = uniqueBooks(todays.filter((r) => BOOKS.includes(r.kind)));
  const audio = uniqueBooks(todays.filter((r) => AUDIO.includes(r.kind)));
  const ku = uniqueBooks(todays.filter((r) => r.kind === "ku_add"));
  const byKind = (k: string) => tips.filter((t) => t.kind === k);
  const announced = byKind("announced");
  const movedTips = byKind("date_moved");
  const cancelledTips = byKind("cancelled");
  const completedTips = byKind("completed");
  const d = (t: (typeof tips)[number]) => (t.data ?? {}) as Record<string, string>;

  const parts: string[] = [];
  const sections: { heading: string; refs: string[] }[] = [];
  const section = (heading: string, refs: string[], lines: string[]) => {
    parts.push(`## ${heading}`, ...lines);
    sections.push({ heading, refs });
  };
  if (out.length)
    section(
      "Out today",
      out.map((r) => r.bookSlug),
      [`${plural(out.length, "new book")} today.`, ...bookBlock(out)],
    );
  if (audio.length)
    section(
      "New audiobooks",
      audio.map((r) => r.bookSlug),
      bookBlock(audio),
    );
  if (ku.length)
    section(
      "New in Kindle Unlimited",
      ku.map((r) => r.bookSlug),
      bookBlock(ku),
    );
  if (announced.length)
    section(
      "Newly announced",
      announced.map((t) => d(t).slug ?? ""),
      [
        announced
          .map(
            (t) =>
              `- [[book:${d(t).slug}]]: ${kindLabel(d(t).kind ?? "")} due ${formatDate(d(t).date ?? null, d(t).precision ?? "day")}`,
          )
          .join("\n"),
      ],
    );
  if (movedTips.length)
    section(
      "Date changes",
      movedTips.map((t) => d(t).slug ?? ""),
      [
        movedTips
          .map((t) => {
            const later = (d(t).to ?? "") > (d(t).from ?? "");
            return `- [[book:${d(t).slug}]]: ${kindLabel(d(t).kind ?? "")} ${later ? "delayed" : "moved up"} from ${formatDate(d(t).from ?? null, "day")} to ${formatDate(d(t).to ?? null, d(t).precision ?? "day")}`;
          })
          .join("\n"),
      ],
    );
  if (cancelledTips.length)
    section(
      "Cancelled",
      cancelledTips.map((t) => d(t).slug ?? ""),
      [
        cancelledTips
          .map((t) => `- [[book:${d(t).slug}]]: the ${kindLabel(d(t).kind ?? "")} release is off`)
          .join("\n"),
      ],
    );
  if (completedTips.length)
    section(
      "Series completed",
      [],
      [completedTips.map((t) => `- [[series:${d(t).slug}]] is complete.`).join("\n")],
    );
  if (briefs.length)
    section(
      "From the news desk",
      [],
      [briefs.map((b) => `- [${b.title.replace(/[[\]]/g, "")}](/news/${b.slug})`).join("\n")],
    );
  const coming = uniqueBooks(week).slice(0, 12);
  if (coming.length)
    section(
      "Coming this week",
      coming.map((r) => r.bookSlug),
      [coming.map((r) => `- [[book:${r.bookSlug}]]: ${kindLabel(r.kind)}, ${longDate(r.date)}`).join("\n")],
    );
  parts.push("Want this every morning? [Get Patch Notes Daily](/subscribe?list=daily_digest) by email.");

  const counts = [
    out.length ? `${plural(out.length, "book")} out today` : "",
    audio.length ? plural(audio.length, "new audiobook") : "",
    announced.length ? plural(announced.length, "new announcement") : "",
    movedTips.length ? plural(movedTips.length, "date change") : "",
    completedTips.length ? plural(completedTips.length, "series completed", "series completed") : "",
  ].filter(Boolean);
  const items =
    out.length +
    audio.length +
    ku.length +
    announced.length +
    movedTips.length +
    cancelledTips.length +
    completedTips.length +
    briefs.length;
  return {
    type: "daily",
    title: `Today in LitRPG: ${longDate(date)}`,
    slug: `today-in-litrpg-${date}`,
    dek: counts.length
      ? `${list(counts).charAt(0).toUpperCase()}${list(counts).slice(1)}.`
      : "A quiet day on the release calendar. Here's what's coming this week.",
    bodyMd: parts.join("\n\n"),
    genKey: `daily:${date}`,
    noindex: false,
    data: { date, sections },
    items,
    tipIds: tips
      .filter((t) => ["announced", "date_moved", "cancelled", "completed"].includes(t.kind))
      .map((t) => t.id),
  };
}

/** Mark tips as reported in a post, so tomorrow's roundup doesn't repeat them. */
export async function markTipsUsed(db: Db, tipIds: string[], postId: string): Promise<void> {
  for (let i = 0; i < tipIds.length; i += 90)
    await db
      .update(newsTips)
      .set({ status: "used", postId, updatedAt: nowIso() })
      .where(inArray(newsTips.id, tipIds.slice(i, i + 90)));
}

/** Monday of the ISO week containing `date`. */
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}

/** "New LitRPG & Progression Fantasy Releases: Week of October 5" (Mondays). Null when too thin. */
export async function buildWeeklyRoundup(db: Db, now: Date, minBooks: number): Promise<AutoBuilt | null> {
  const monday = weekStart(day(now));
  const rs = await releasesBetween(db, monday, addDays(monday, 6), { now: now.toISOString(), limit: 200 });
  const books_ = uniqueBooks(rs.filter((r) => BOOKS.includes(r.kind)));
  const audio = uniqueBooks(rs.filter((r) => AUDIO.includes(r.kind)));
  const distinct = new Set([...books_, ...audio].map((r) => r.bookSlug)).size;
  if (distinct < minBooks) return null;
  const week = new Date(`${monday}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  const parts: string[] = [];
  const sections: { heading: string; refs: string[] }[] = [];
  if (books_.length) {
    parts.push("## New books this week", ...bookBlock(books_, 40));
    sections.push({ heading: "New books this week", refs: books_.map((r) => r.bookSlug) });
  }
  if (audio.length) {
    parts.push("## New audiobooks this week", ...bookBlock(audio, 40));
    sections.push({ heading: "New audiobooks this week", refs: audio.map((r) => r.bookSlug) });
  }
  parts.push("Dates move: every card above shows what our release database says right now.");
  return {
    type: "roundup",
    title: `New LitRPG & Progression Fantasy Releases: Week of ${week}`,
    slug: `new-litrpg-releases-week-of-${monday}`,
    dek: `${list([books_.length ? plural(books_.length, "new book") : "", audio.length ? plural(audio.length, "audiobook") : ""].filter(Boolean))} out this week.`,
    bodyMd: parts.join("\n\n"),
    genKey: `roundup:weekly:${monday}`,
    noindex: false,
    data: { week: monday, sections },
    items: distinct,
    tipIds: [],
  };
}

/** The roundups due on this day of the month (1st: audiobooks and new series; 15th: most followed). */
export async function buildMonthlyRoundups(db: Db, now: Date, minBooks: number): Promise<AutoBuilt[]> {
  const today = day(now);
  const month = today.slice(0, 7);
  const first = `${month}-01`;
  const last = addDays(day(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1))), -1);
  const nowS = now.toISOString();
  const out: AutoBuilt[] = [];
  const name = monthName(month);
  if (now.getUTCDate() === 1) {
    const audio = uniqueBooks(
      await releasesBetween(db, first, last, { now: nowS, kinds: AUDIO, limit: 200 }),
    );
    if (audio.length >= minBooks)
      out.push({
        type: "roundup",
        title: `LitRPG Audiobooks Coming in ${name}`,
        slug: `litrpg-audiobooks-${month}`,
        dek: `${plural(audio.length, "audiobook")} dated for ${name}.`,
        bodyMd: [
          "## Audiobooks this month",
          ...audio.map((r) => `[[book:${r.bookSlug}]]\n\n${longDate(r.date)}`),
          `See the full calendar on [New & upcoming](/new).`,
        ].join("\n\n"),
        genKey: `roundup:audio:${month}`,
        noindex: false,
        data: { month, sections: [{ heading: "Audiobooks this month", refs: audio.map((r) => r.bookSlug) }] },
        items: audio.length,
        tipIds: [],
      });
    const starts = uniqueBooks(
      (await releasesBetween(db, first, last, { now: nowS, kinds: BOOKS, limit: 200 })).filter(
        (r) => r.series?.position === 1,
      ),
    );
    if (starts.length >= minBooks)
      out.push({
        type: "roundup",
        title: `New LitRPG Series Starting in ${name}`,
        slug: `new-litrpg-series-${month}`,
        dek: `${plural(starts.length, "first book")} of new series, out in ${name}.`,
        bodyMd: ["## Book one, out this month", ...bookBlock(starts, 40)].join("\n\n"),
        genKey: `roundup:new-series:${month}`,
        noindex: false,
        data: {
          month,
          sections: [{ heading: "Book one, out this month", refs: starts.map((r) => r.bookSlug) }],
        },
        items: starts.length,
        tipIds: [],
      });
  }
  if (now.getUTCDate() === 15) {
    const rows = await db
      .select({
        slug: books.slug,
        date: releases.date,
        kind: releases.kind,
        followers:
          sql<number>`(select count(*) from follows f where (f.target_type = 'book' and f.target_id = ${books.id}) or (f.target_type = 'series' and f.target_id = ${books.seriesId}))`.as(
            "followers",
          ),
      })
      .from(releases)
      .innerJoin(books, eq(books.id, releases.bookId))
      .where(
        and(
          publicBook(nowS),
          gte(releases.date, today),
          lte(releases.date, addDays(today, 60)),
          eq(releases.datePrecision, "day"),
          ne(releases.status, "cancelled"),
          inArray(releases.kind, ["ebook", "audio", "print", "serial_start"]),
        ),
      )
      .orderBy(desc(sql`followers`))
      .limit(60);
    const top = [
      ...new Map(rows.filter((r) => Number(r.followers) > 0).map((r) => [r.slug, r])).values(),
    ].slice(0, 20);
    if (top.length >= minBooks)
      out.push({
        type: "roundup",
        title: "The Most-Followed Upcoming LitRPG Releases",
        slug: `most-followed-upcoming-litrpg-${month}`,
        dek: "The dated releases our readers are following most, over the next two months.",
        bodyMd: [
          "## Most followed",
          ...top.map((r) => `[[book:${r.slug}]]\n\n${kindLabel(r.kind)}, ${longDate(r.date ?? today)}`),
          "Follow a book or series to get an email on release day.",
        ].join("\n\n"),
        genKey: `roundup:most-followed:${month}`,
        noindex: false,
        data: { month, sections: [{ heading: "Most followed", refs: top.map((r) => r.slug) }] },
        items: top.length,
        tipIds: [],
      });
  }
  return out;
}
