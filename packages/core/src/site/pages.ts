// Read models for the public entity pages (DESIGN §9.5, §17.1): one lookup by slug, then one
// batched round trip for everything the page shows. Only published, unmerged, unembargoed records
// are public; merged records answer with the survivor's slug so the page can 301 (§17.2).

import { type AnyColumn, and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import {
  authors,
  bookAuthors,
  bookLinks,
  bookScores,
  books,
  bookTags,
  catalogConfirmations,
  editionNarrators,
  editions,
  media,
  narrators,
  publishers,
  releases,
  series,
  tags,
} from "../db/schema";
import { DIALS, FACETS, STATS } from "../taxonomy";

export type Lookup<T> = { kind: "found"; data: T } | { kind: "redirect"; slug: string } | { kind: "missing" };

export interface Cover {
  key: string;
  width: number | null;
  height: number | null;
}

/** A book is public when it is published, not merged away and past any embargo. */
const publicBook = (now: string) =>
  and(
    eq(books.visibility, "published"),
    isNull(books.redirectTo),
    or(isNull(books.embargoUntil), lte(books.embargoUntil, now)),
  );

const coverJoin = and(eq(media.id, books.coverMediaId), eq(media.status, "approved"));

/**
 * Drizzle maps D1 batch results through row objects, so two selected columns with the same name
 * (books.slug and series.slug) collapse into one and every later field shifts. Batched joins
 * give repeated names an alias.
 */
const as = <T>(column: AnyColumn, name: string) => sql<T>`${column}`.as(name);

// ---------------------------------------------------------------------------------------------
// Merged records: follow redirect_to (a short chain at most) to the survivor's slug.

type Entity = "book" | "series" | "author";

async function survivorSlug(db: Db, entity: Entity, id: string): Promise<string | null> {
  const table = entity === "book" ? books : entity === "series" ? series : authors;
  let next: string | null = id;
  for (let hop = 0; hop < 5 && next; hop++) {
    const [row] = await db
      .select({ slug: table.slug, redirectTo: table.redirectTo })
      .from(table)
      .where(eq(table.id, next));
    if (!row) return null;
    if (!row.redirectTo) return row.slug;
    next = row.redirectTo;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Status screen and dial profile (§6.6–6.7)

export interface StatRow {
  key: string;
  name: string;
  value: number | null;
  /** "Readers say" once appraised enough, "Estimated" for descriptive stats, otherwise hidden (???). */
  label: "Readers say" | "Estimated" | "???";
  appraisals: number;
}

export interface DialRow {
  key: string;
  name: string;
  value: number;
  low: string;
  high: string;
}

const STAT_TYPE = new Map(STATS.map((s) => [s.key, s.type]));
/** "Lingers: long stretches of downtime…" → "Lingers"; "Hard rules; exact mechanics…" → "Hard rules". */
const short = (anchor: string) => (anchor.split(/[:;,]/)[0] ?? anchor).trim();

export function statusRows(
  scores: { key: string; kind: string; value: number | null; crowdN: number; public: boolean }[],
  minAppraisals: number,
): { stats: StatRow[]; dials: DialRow[] } {
  const byKey = new Map(scores.map((s) => [s.key, s]));
  const stats = STATS.map((def) => {
    const s = byKey.get(def.key);
    const shown = s?.public && s.value !== null;
    const label: StatRow["label"] = !shown
      ? "???"
      : (s?.crowdN ?? 0) >= minAppraisals || STAT_TYPE.get(def.key) === "judgment"
        ? "Readers say"
        : "Estimated";
    return {
      key: def.key,
      name: def.name,
      value: shown ? (s?.value ?? null) : null,
      label,
      appraisals: s?.crowdN ?? 0,
    };
  });
  const dials = DIALS.flatMap((def) => {
    const s = byKey.get(def.key);
    if (!s?.public || s.value === null) return [];
    return [
      {
        key: def.key,
        name: def.name,
        value: s.value,
        low: short(def.anchors["0"]),
        high: short(def.anchors["10"]),
      },
    ];
  });
  return { stats, dials };
}

// ---------------------------------------------------------------------------------------------
// Book page

export interface BookPage {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  /** The author's licensed blurb when the listing is claimed, otherwise our own summary (§16.5). */
  description: { text: string; by: "author" | "us" } | null;
  hook: string | null;
  cover: Cover | null;
  /** The rendered link-preview PNG, once the og job has drawn it (DESIGN §7.10). */
  ogImageKey: string | null;
  pageCount: number | null;
  wordCountEst: number | null;
  firstPublished: string | null;
  firstPublishedPrecision: string | null;
  pubStatus: string;
  primaryGenre: string | null;
  harem: string;
  crunchLevel: number | null;
  romanceLevel: number | null;
  contentFlags: string[];
  aiUse: string;
  updatedAt: string;
  series: {
    slug: string;
    name: string;
    status: string;
    position: number | null;
    prev: { slug: string; title: string; position: number | null } | null;
    next: { slug: string; title: string; position: number | null } | null;
    count: number;
  } | null;
  authors: { name: string; slug: string; role: string }[];
  editions: {
    format: string;
    isbn13: string | null;
    asin: string | null;
    publisher: string | null;
    narrationType: string | null;
    durationMinutes: number | null;
    kindleUnlimited: boolean;
    audiblePlus: boolean;
    narrators: { name: string; slug: string }[];
  }[];
  releases: {
    kind: string;
    date: string | null;
    precision: string;
    status: string;
    confirmedBy: string | null;
    confirmedAt: string | null;
    previousDate: string | null;
  }[];
  links: { kind: string; url: string; affiliateEligible: boolean }[];
  tags: { facet: string; facetName: string; tags: { slug: string; name: string; score: number }[] }[];
  stats: StatRow[];
  dials: DialRow[];
  confirmedBy: string[];
}

export interface PageOptions {
  now?: string;
  /** `tags.display_min` */
  displayMin: number;
  /** `stats.display_min_appraisals` */
  minAppraisals: number;
}

const FACET_NAME = new Map(FACETS.map((f) => [f.key, f.name]));
const FACET_ORDER = FACETS.map((f) => f.key);

export async function bookPage(db: Db, slug: string, opts: PageOptions): Promise<Lookup<BookPage>> {
  const now = opts.now ?? new Date().toISOString();
  const [row] = await db
    .select({
      book: books,
      seriesSlug: series.slug,
      seriesName: series.name,
      seriesStatus: series.status,
      coverKey: media.key,
      coverWidth: media.width,
      coverHeight: media.height,
    })
    .from(books)
    .leftJoin(series, eq(series.id, books.seriesId))
    .leftJoin(media, coverJoin)
    .where(eq(books.slug, slug));
  if (!row) return { kind: "missing" };
  const b = row.book;
  if (b.redirectTo) {
    const to = await survivorSlug(db, "book", b.redirectTo);
    return to ? { kind: "redirect", slug: to } : { kind: "missing" };
  }
  if (b.visibility !== "published" || (b.embargoUntil && b.embargoUntil > now)) return { kind: "missing" };

  const [authorRows, editionRows, releaseRows, linkRows, tagRows, scoreRows, siblings, confirmations] =
    await db.batch([
      db
        .select({ name: authors.name, slug: authors.slug, role: bookAuthors.role })
        .from(bookAuthors)
        .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
        .where(eq(bookAuthors.bookId, b.id))
        .orderBy(asc(bookAuthors.position)),
      db
        .select({
          id: editions.id,
          format: editions.format,
          isbn13: editions.isbn13,
          asin: editions.asin,
          publisher: as<string | null>(publishers.name, "publisher_name"),
          narrationType: editions.narrationType,
          durationMinutes: editions.durationMinutes,
          ku: editions.kindleUnlimited,
          audiblePlus: editions.audiblePlus,
          narratorName: as<string | null>(narrators.name, "narrator_name"),
          narratorSlug: as<string | null>(narrators.slug, "narrator_slug"),
        })
        .from(editions)
        .leftJoin(publishers, eq(publishers.id, editions.publisherId))
        .leftJoin(editionNarrators, eq(editionNarrators.editionId, editions.id))
        .leftJoin(narrators, eq(narrators.id, editionNarrators.narratorId))
        .where(eq(editions.bookId, b.id))
        .orderBy(asc(editions.format), asc(editionNarrators.position)),
      db
        .select()
        .from(releases)
        .where(and(eq(releases.bookId, b.id), sql`${releases.status} != 'cancelled'`))
        .orderBy(asc(releases.date)),
      db
        .select({ kind: bookLinks.kind, url: bookLinks.url, affiliateEligible: bookLinks.affiliateEligible })
        .from(bookLinks)
        .where(eq(bookLinks.bookId, b.id)),
      db
        .select({ slug: tags.slug, name: tags.name, facet: tags.facet, score: bookTags.score })
        .from(bookTags)
        .innerJoin(tags, eq(tags.id, bookTags.tagId))
        .where(
          and(eq(bookTags.bookId, b.id), gte(bookTags.score, opts.displayMin), eq(tags.status, "active")),
        )
        .orderBy(desc(bookTags.score)),
      db
        .select({
          key: bookScores.key,
          kind: bookScores.kind,
          value: bookScores.value,
          crowdN: bookScores.crowdN,
          public: bookScores.public,
        })
        .from(bookScores)
        .where(eq(bookScores.bookId, b.id)),
      db
        .select({ slug: books.slug, title: books.title, position: books.seriesPosition })
        .from(books)
        .where(and(eq(books.seriesId, b.seriesId ?? ""), publicBook(now)))
        .orderBy(asc(books.seriesPosition), asc(books.titleKey))
        .limit(300),
      db
        .selectDistinct({ source: catalogConfirmations.source })
        .from(catalogConfirmations)
        .where(and(eq(catalogConfirmations.subjectType, "book"), eq(catalogConfirmations.subjectId, b.id))),
    ]);

  const editionsOut = new Map<string, BookPage["editions"][number]>();
  for (const e of editionRows) {
    const ed = editionsOut.get(e.id) ?? {
      format: e.format,
      isbn13: e.isbn13,
      asin: e.asin,
      publisher: e.publisher,
      narrationType: e.narrationType,
      durationMinutes: e.durationMinutes,
      kindleUnlimited: Boolean(e.ku),
      audiblePlus: Boolean(e.audiblePlus),
      narrators: [],
    };
    if (e.narratorName && e.narratorSlug) ed.narrators.push({ name: e.narratorName, slug: e.narratorSlug });
    editionsOut.set(e.id, ed);
  }

  const grouped = new Map<string, { slug: string; name: string; score: number }[]>();
  for (const t of tagRows) grouped.set(t.facet, [...(grouped.get(t.facet) ?? []), t]);
  const tagGroups = [...grouped.entries()]
    .sort(([a], [b2]) => FACET_ORDER.indexOf(a) - FACET_ORDER.indexOf(b2))
    .map(([facet, list]) => ({ facet, facetName: FACET_NAME.get(facet) ?? facet, tags: list }));

  const at = siblings.findIndex((s) => s.slug === b.slug);
  const { stats, dials } = statusRows(scoreRows, opts.minAppraisals);
  const description =
    b.claimed && b.blurbAuthor
      ? { text: b.blurbAuthor, by: "author" as const }
      : b.summaryAi
        ? { text: b.summaryAi, by: "us" as const }
        : null;

  return {
    kind: "found",
    data: {
      id: b.id,
      slug: b.slug,
      title: b.title,
      subtitle: b.subtitle,
      description,
      hook: b.hookAi,
      cover: row.coverKey ? { key: row.coverKey, width: row.coverWidth, height: row.coverHeight } : null,
      ogImageKey: b.ogImageKey,
      pageCount: b.pageCount,
      wordCountEst: b.wordCountEst,
      firstPublished: b.firstPublished,
      firstPublishedPrecision: b.firstPublishedPrecision,
      pubStatus: b.pubStatus,
      primaryGenre: b.primaryGenre,
      harem: b.harem,
      crunchLevel: b.crunchLevel,
      romanceLevel: b.romanceLevel,
      contentFlags: b.contentFlags,
      aiUse: b.isAiGenerated,
      updatedAt: b.updatedAt,
      series:
        row.seriesSlug && row.seriesName
          ? {
              slug: row.seriesSlug,
              name: row.seriesName,
              status: row.seriesStatus ?? "unknown",
              position: b.seriesPosition,
              prev: at > 0 ? (siblings[at - 1] ?? null) : null,
              next: at >= 0 && at < siblings.length - 1 ? (siblings[at + 1] ?? null) : null,
              count: siblings.length,
            }
          : null,
      authors: authorRows,
      editions: [...editionsOut.values()],
      releases: releaseRows.map((r) => ({
        kind: r.kind,
        date: r.date,
        precision: r.datePrecision,
        status: r.status,
        confirmedBy: r.confirmedBy,
        confirmedAt: r.confirmedAt,
        previousDate: r.previousDate,
      })),
      links: linkRows,
      tags: tagGroups,
      stats,
      dials,
      confirmedBy: confirmations.map((c) => c.source),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Lists of books on series, author, narrator and tag pages

export interface BookListItem {
  id: string;
  slug: string;
  title: string;
  position: number | null;
  series: { slug: string; name: string } | null;
  hook: string | null;
  firstPublished: string | null;
  pubStatus: string;
  pageCount: number | null;
  cover: Cover | null;
}

const listFields = {
  id: books.id,
  slug: books.slug,
  title: books.title,
  position: books.seriesPosition,
  seriesSlug: as<string | null>(series.slug, "series_slug"),
  seriesName: as<string | null>(series.name, "series_name"),
  hook: books.hookAi,
  firstPublished: books.firstPublished,
  pubStatus: books.pubStatus,
  pageCount: books.pageCount,
  coverKey: media.key,
  coverWidth: media.width,
  coverHeight: media.height,
};

type ListRow = {
  id: string;
  slug: string;
  title: string;
  position: number | null;
  seriesSlug: string | null;
  seriesName: string | null;
  hook: string | null;
  firstPublished: string | null;
  pubStatus: string;
  pageCount: number | null;
  coverKey: string | null;
  coverWidth: number | null;
  coverHeight: number | null;
};

const toItem = (r: ListRow): BookListItem => ({
  id: r.id,
  slug: r.slug,
  title: r.title,
  position: r.position,
  series: r.seriesSlug && r.seriesName ? { slug: r.seriesSlug, name: r.seriesName } : null,
  hook: r.hook,
  firstPublished: r.firstPublished,
  pubStatus: r.pubStatus,
  pageCount: r.pageCount,
  cover: r.coverKey ? { key: r.coverKey, width: r.coverWidth, height: r.coverHeight } : null,
});

/** Public books by id, in the order given (matrix hits, similar-book rails). One query per 90 ids. */
export async function bookItems(db: Db, ids: string[], opts: { now?: string } = {}): Promise<BookListItem[]> {
  const now = opts.now ?? new Date().toISOString();
  const byId = new Map<string, BookListItem>();
  for (let k = 0; k < ids.length; k += 90) {
    const rows = await db
      .select(listFields)
      .from(books)
      .leftJoin(series, eq(series.id, books.seriesId))
      .leftJoin(media, coverJoin)
      .where(and(inArray(books.id, ids.slice(k, k + 90)), publicBook(now)));
    for (const r of rows) byId.set(r.id, toItem(r));
  }
  return ids.flatMap((id) => byId.get(id) ?? []);
}

export interface UpcomingRelease {
  id: string;
  updatedAt: string;
  bookSlug: string;
  title: string;
  series: { slug: string; name: string; position: number | null } | null;
  kind: string;
  date: string;
  precision: string;
  status: string;
  previousDate: string | null;
}

const releaseFields = {
  id: as<string>(releases.id, "release_id"),
  updatedAt: as<string>(releases.updatedAt, "release_updated_at"),
  bookSlug: books.slug,
  title: books.title,
  seriesSlug: as<string | null>(series.slug, "series_slug"),
  seriesName: as<string | null>(series.name, "series_name"),
  position: books.seriesPosition,
  kind: releases.kind,
  date: releases.date,
  precision: releases.datePrecision,
  status: releases.status,
  previousDate: releases.previousDate,
};

type ReleaseRow = {
  id: string;
  updatedAt: string;
  bookSlug: string;
  title: string;
  seriesSlug: string | null;
  seriesName: string | null;
  position: number | null;
  kind: string;
  date: string | null;
  precision: string;
  status: string;
  previousDate: string | null;
};

const toRelease = (r: ReleaseRow): UpcomingRelease => ({
  id: r.id,
  updatedAt: r.updatedAt,
  bookSlug: r.bookSlug,
  title: r.title,
  series:
    r.seriesSlug && r.seriesName ? { slug: r.seriesSlug, name: r.seriesName, position: r.position } : null,
  kind: r.kind,
  date: r.date ?? "",
  precision: r.precision,
  status: r.status,
  previousDate: r.previousDate,
});

const liveRelease = sql`${releases.status} != 'cancelled' and ${releases.date} is not null`;

// ---------------------------------------------------------------------------------------------
// Series page

export interface SeriesPage {
  slug: string;
  name: string;
  status: string;
  expectedLength: number | null;
  books: BookListItem[];
  authors: { name: string; slug: string }[];
  totalPages: number | null;
  audio: { books: number; minutes: number };
  kindleUnlimited: boolean;
  upcoming: UpcomingRelease[];
  updatedAt: string;
}

export async function seriesPage(
  db: Db,
  slug: string,
  opts: { now?: string } = {},
): Promise<Lookup<SeriesPage>> {
  const now = opts.now ?? new Date().toISOString();
  const [s] = await db.select().from(series).where(eq(series.slug, slug));
  if (!s) return { kind: "missing" };
  if (s.redirectTo) {
    const to = await survivorSlug(db, "series", s.redirectTo);
    return to ? { kind: "redirect", slug: to } : { kind: "missing" };
  }
  const inSeries = db
    .select({ id: books.id })
    .from(books)
    .where(and(eq(books.seriesId, s.id), publicBook(now)));
  const [bookRows, authorRows, editionRows, upcoming] = await db.batch([
    db
      .select(listFields)
      .from(books)
      .leftJoin(series, eq(series.id, books.seriesId))
      .leftJoin(media, coverJoin)
      .where(and(eq(books.seriesId, s.id), publicBook(now)))
      .orderBy(asc(books.seriesPosition), asc(books.titleKey))
      .limit(300),
    db
      .selectDistinct({ name: authors.name, slug: authors.slug })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(inArray(bookAuthors.bookId, inSeries)),
    db
      .select({
        bookId: editions.bookId,
        format: editions.format,
        minutes: editions.durationMinutes,
        ku: editions.kindleUnlimited,
      })
      .from(editions)
      .where(inArray(editions.bookId, inSeries)),
    db
      .select(releaseFields)
      .from(releases)
      .innerJoin(books, eq(books.id, releases.bookId))
      .leftJoin(series, eq(series.id, books.seriesId))
      .where(and(inArray(releases.bookId, inSeries), liveRelease, gte(releases.date, now.slice(0, 10))))
      .orderBy(asc(releases.date))
      .limit(20),
  ]);
  if (bookRows.length === 0) return { kind: "missing" };
  const audioBooks = new Set(editionRows.filter((e) => e.format === "audiobook").map((e) => e.bookId));
  const pages = bookRows.map((b) => b.pageCount);
  return {
    kind: "found",
    data: {
      slug: s.slug,
      name: s.name,
      status: s.status,
      expectedLength: s.expectedLength,
      books: bookRows.map(toItem),
      authors: authorRows,
      totalPages: pages.every((p) => p !== null) ? pages.reduce<number>((n, p) => n + (p ?? 0), 0) : null,
      audio: {
        books: audioBooks.size,
        minutes: editionRows
          .filter((e) => e.format === "audiobook")
          .reduce((n, e) => n + (e.minutes ?? 0), 0),
      },
      kindleUnlimited: editionRows.some((e) => e.ku),
      upcoming: upcoming.map(toRelease),
      updatedAt: s.updatedAt,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Author page

export interface AuthorPage {
  slug: string;
  name: string;
  bio: string | null;
  links: string[];
  verified: boolean;
  series: { slug: string; name: string; books: BookListItem[] }[];
  standalone: BookListItem[];
  upcoming: UpcomingRelease[];
  updatedAt: string;
}

export async function authorPage(
  db: Db,
  slug: string,
  opts: { now?: string } = {},
): Promise<Lookup<AuthorPage>> {
  const now = opts.now ?? new Date().toISOString();
  const [a] = await db.select().from(authors).where(eq(authors.slug, slug));
  if (!a) return { kind: "missing" };
  if (a.redirectTo) {
    const to = await survivorSlug(db, "author", a.redirectTo);
    return to ? { kind: "redirect", slug: to } : { kind: "missing" };
  }
  const theirs = db
    .select({ id: bookAuthors.bookId })
    .from(bookAuthors)
    .where(eq(bookAuthors.authorId, a.id));
  const [bookRows, upcoming] = await db.batch([
    db
      .select(listFields)
      .from(books)
      .leftJoin(series, eq(series.id, books.seriesId))
      .leftJoin(media, coverJoin)
      .where(and(inArray(books.id, theirs), publicBook(now)))
      .orderBy(asc(series.nameKey), asc(books.seriesPosition), asc(books.titleKey))
      .limit(500),
    db
      .select(releaseFields)
      .from(releases)
      .innerJoin(books, eq(books.id, releases.bookId))
      .leftJoin(series, eq(series.id, books.seriesId))
      .where(
        and(
          inArray(releases.bookId, theirs),
          publicBook(now),
          liveRelease,
          gte(releases.date, now.slice(0, 10)),
        ),
      )
      .orderBy(asc(releases.date))
      .limit(20),
  ]);
  if (bookRows.length === 0) return { kind: "missing" };
  const bySeries = new Map<string, { slug: string; name: string; books: BookListItem[] }>();
  const standalone: BookListItem[] = [];
  for (const r of bookRows.map(toItem)) {
    if (!r.series) standalone.push(r);
    else {
      const group = bySeries.get(r.series.slug) ?? { ...r.series, books: [] };
      group.books.push(r);
      bySeries.set(r.series.slug, group);
    }
  }
  return {
    kind: "found",
    data: {
      slug: a.slug,
      name: a.name,
      bio: a.verifiedAt ? a.bio : null,
      links: a.verifiedAt ? a.links : [],
      verified: Boolean(a.verifiedAt),
      series: [...bySeries.values()],
      standalone,
      upcoming: upcoming.map(toRelease),
      updatedAt: a.updatedAt,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Narrator page

export interface NarratorPage {
  slug: string;
  name: string;
  books: (BookListItem & { durationMinutes: number | null })[];
  upcoming: UpcomingRelease[];
}

export async function narratorPage(
  db: Db,
  slug: string,
  opts: { now?: string } = {},
): Promise<Lookup<NarratorPage>> {
  const now = opts.now ?? new Date().toISOString();
  const [n] = await db.select().from(narrators).where(eq(narrators.slug, slug));
  if (!n) return { kind: "missing" };
  const narrated = db
    .select({ id: editions.bookId })
    .from(editionNarrators)
    .innerJoin(editions, eq(editions.id, editionNarrators.editionId))
    .where(eq(editionNarrators.narratorId, n.id));
  const [bookRows, minutes, upcoming] = await db.batch([
    db
      .select(listFields)
      .from(books)
      .leftJoin(series, eq(series.id, books.seriesId))
      .leftJoin(media, coverJoin)
      .where(and(inArray(books.id, narrated), publicBook(now)))
      .orderBy(asc(series.nameKey), asc(books.seriesPosition), asc(books.titleKey))
      .limit(500),
    db
      .select({ bookId: editions.bookId, minutes: editions.durationMinutes })
      .from(editionNarrators)
      .innerJoin(editions, eq(editions.id, editionNarrators.editionId))
      .where(eq(editionNarrators.narratorId, n.id)),
    db
      .select(releaseFields)
      .from(releases)
      .innerJoin(books, eq(books.id, releases.bookId))
      .leftJoin(series, eq(series.id, books.seriesId))
      .where(
        and(
          inArray(releases.bookId, narrated),
          eq(releases.kind, "audio"),
          publicBook(now),
          liveRelease,
          gte(releases.date, now.slice(0, 10)),
        ),
      )
      .orderBy(asc(releases.date))
      .limit(20),
  ]);
  if (bookRows.length === 0) return { kind: "missing" };
  const byBook = new Map(minutes.map((m) => [m.bookId, m.minutes]));
  return {
    kind: "found",
    data: {
      slug: n.slug,
      name: n.name,
      books: bookRows.map((r) => ({ ...toItem(r), durationMinutes: byBook.get(r.id) ?? null })),
      upcoming: upcoming.map(toRelease),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// New & upcoming (§9.4, Phase 1): notable releases of published books around today.

export interface NewAndUpcoming {
  recent: UpcomingRelease[];
  upcoming: UpcomingRelease[];
}

export async function newAndUpcoming(
  db: Db,
  opts: { now?: string; pastDays?: number; aheadDays?: number; limit?: number; tagSlug?: string } = {},
): Promise<NewAndUpcoming> {
  const now = opts.now ?? new Date().toISOString();
  const today = now.slice(0, 10);
  const day = (offset: number) =>
    new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
  const from = day(-(opts.pastDays ?? 60));
  const to = day(opts.aheadDays ?? 365);
  const limit = opts.limit ?? 120;
  const tagged = opts.tagSlug
    ? inArray(
        releases.bookId,
        db
          .select({ id: bookTags.bookId })
          .from(bookTags)
          .innerJoin(tags, eq(tags.id, bookTags.tagId))
          .where(and(eq(tags.slug, opts.tagSlug), gte(bookTags.score, 0.5))),
      )
    : undefined;
  const base = (range: ReturnType<typeof and>) =>
    db
      .select(releaseFields)
      .from(releases)
      .innerJoin(books, eq(books.id, releases.bookId))
      .leftJoin(series, eq(series.id, books.seriesId))
      .where(and(publicBook(now), liveRelease, range, tagged));
  const [recent, upcoming] = await db.batch([
    base(and(gte(releases.date, from), sql`${releases.date} < ${today}`))
      .orderBy(desc(releases.date))
      .limit(limit),
    base(and(gte(releases.date, today), lte(releases.date, to)))
      .orderBy(asc(releases.date))
      .limit(limit),
  ]);
  return { recent: recent.map(toRelease), upcoming: upcoming.map(toRelease) };
}

// ---------------------------------------------------------------------------------------------
// Tags

export interface TagInfo {
  slug: string;
  name: string;
  facet: string;
  facetName: string;
  description: string;
  includeWhen: string | null;
  books: number;
}

/** The tag index: every active tag with how many published books carry it strongly. */
export async function tagIndex(db: Db, opts: PageOptions): Promise<TagInfo[]> {
  const now = opts.now ?? new Date().toISOString();
  const rows = await db
    .select({
      slug: tags.slug,
      name: tags.name,
      facet: tags.facet,
      description: tags.description,
      includeWhen: tags.includeWhen,
      // Written out with aliases: in a one-table select Drizzle drops the table names from
      // interpolated columns, which makes a correlated subquery ambiguous.
      books: sql<number>`(select count(*) from book_tags bt join books b on b.id = bt.book_id
        where bt.tag_id = "tags"."id" and bt.score >= ${opts.displayMin}
        and b.visibility = 'published' and b.redirect_to is null
        and (b.embargo_until is null or b.embargo_until <= ${now}))`,
    })
    .from(tags)
    .where(eq(tags.status, "active"))
    .orderBy(asc(tags.facet), asc(tags.sort), asc(tags.name));
  return rows
    .sort((a, b) => FACET_ORDER.indexOf(a.facet) - FACET_ORDER.indexOf(b.facet))
    .map((r) => ({ ...r, facetName: FACET_NAME.get(r.facet) ?? r.facet, books: Number(r.books) }));
}

/** One tag, or where a retired tag now lives. */
export async function tagLookup(db: Db, slug: string): Promise<Lookup<Omit<TagInfo, "books">>> {
  const [t] = await db.select().from(tags).where(eq(tags.slug, slug));
  if (!t) return { kind: "missing" };
  if (t.status === "retired") {
    if (!t.replacedBy) return { kind: "missing" };
    // replaced_by holds the replacement's slug (data/taxonomy.yaml).
    const [to] = await db.select({ slug: tags.slug }).from(tags).where(eq(tags.slug, t.replacedBy));
    return to ? { kind: "redirect", slug: to.slug } : { kind: "missing" };
  }
  if (t.status !== "active") return { kind: "missing" };
  return {
    kind: "found",
    data: {
      slug: t.slug,
      name: t.name,
      facet: t.facet,
      facetName: FACET_NAME.get(t.facet) ?? t.facet,
      description: t.description,
      includeWhen: t.includeWhen,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Recently published books (tag feeds)

export interface PublishedItem extends BookListItem {
  publishedAt: string;
  authors: string;
}

export async function recentlyPublished(
  db: Db,
  opts: { now?: string; tagSlug?: string; limit?: number } = {},
): Promise<PublishedItem[]> {
  const now = opts.now ?? new Date().toISOString();
  const tagged = opts.tagSlug
    ? inArray(
        books.id,
        db
          .select({ id: bookTags.bookId })
          .from(bookTags)
          .innerJoin(tags, eq(tags.id, bookTags.tagId))
          .where(and(eq(tags.slug, opts.tagSlug), gte(bookTags.score, 0.5))),
      )
    : undefined;
  const rows = await db
    .select({
      ...listFields,
      publishedAt: books.publishedAt,
      authors: sql<string>`(select group_concat(a.name, ', ') from book_authors ba join authors a on a.id = ba.author_id where ba.book_id = "books"."id")`,
    })
    .from(books)
    .leftJoin(series, eq(series.id, books.seriesId))
    .leftJoin(media, coverJoin)
    .where(and(publicBook(now), sql`${books.publishedAt} is not null`, tagged))
    .orderBy(desc(books.publishedAt))
    .limit(opts.limit ?? 30);
  return rows.map((r) => ({ ...toItem(r), publishedAt: r.publishedAt ?? now, authors: r.authors ?? "" }));
}
