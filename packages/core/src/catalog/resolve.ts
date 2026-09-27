// Entity resolution (DESIGN §7.4). Duplicate books and authors are the most expensive data-quality
// failure, so matching runs in tiers: exact identifiers, then strong keys, then fuzzy candidates
// that a person (or an editorial run) decides. Fuzzy matches never merge on their own.

import { and, eq, inArray, isNull, like, or } from "drizzle-orm";
import type { Db } from "../db";
import {
  authors,
  bookAuthors,
  books,
  editions,
  narrators,
  type Origin,
  type posts,
  publishers,
  series,
} from "../db/schema";
import { ulid } from "../ids";
import { cleanText, extractVolume, nameKey, slugify, trigramSimilarity } from "./normalize";

type SlugTable =
  | typeof books
  | typeof authors
  | typeof series
  | typeof publishers
  | typeof narrators
  | typeof posts;

/** A slug not yet taken: the base, then base-<hint>, then base-2, base-3… Slugs never change later. */
export async function uniqueSlug(
  db: Db,
  table: SlugTable,
  base: string,
  hints: string[] = [],
): Promise<string> {
  const root = slugify(base);
  const taken = new Set(
    (
      await db
        .select({ slug: table.slug })
        .from(table)
        .where(like(table.slug, `${root}%`))
    ).map((r) => r.slug),
  );
  const candidates = [root, ...hints.filter(Boolean).map((h) => slugify(`${root} ${h}`))];
  for (const c of candidates) if (!taken.has(c)) return c;
  for (let n = 2; n < 10_000; n++) if (!taken.has(`${root}-${n}`)) return `${root}-${n}`;
  return `${root}-${ulid().toLowerCase()}`;
}

export interface Resolution {
  id: string;
  created: boolean;
  warning?: string;
}

export async function findOrCreateAuthor(db: Db, rawName: string, origin: Origin): Promise<Resolution> {
  const name = cleanText(rawName);
  const key = nameKey(name);
  const found = await db
    .select({ id: authors.id })
    .from(authors)
    .where(and(eq(authors.nameKey, key), isNull(authors.redirectTo)))
    .limit(2);
  if (found[0]) {
    return {
      id: found[0].id,
      created: false,
      ...(found.length > 1 ? { warning: `more than one author named "${name}"; used the first` } : {}),
    };
  }
  const id = ulid();
  await db
    .insert(authors)
    .values({ id, slug: await uniqueSlug(db, authors, name), name, nameKey: key, origin });
  return { id, created: true };
}

/**
 * Series names collide across authors ("Awakening", "Ascension"), so a match needs an author in
 * common, unless the existing series has no books yet.
 */
export async function findOrCreateSeries(
  db: Db,
  rawName: string,
  authorIds: string[],
  origin: Origin,
): Promise<Resolution> {
  const name = cleanText(rawName);
  const key = nameKey(name);
  const candidates = await db
    .select({ id: series.id })
    .from(series)
    .where(and(eq(series.nameKey, key), isNull(series.redirectTo)));
  if (candidates.length > 0) {
    const ids = candidates.map((c) => c.id);
    const withBooks = await db
      .selectDistinct({ seriesId: books.seriesId, authorId: bookAuthors.authorId })
      .from(books)
      .innerJoin(bookAuthors, eq(bookAuthors.bookId, books.id))
      .where(inArray(books.seriesId, ids));
    const shared = withBooks.find((r) => authorIds.includes(r.authorId));
    if (shared?.seriesId) return { id: shared.seriesId, created: false };
    const empty = ids.find((id) => !withBooks.some((r) => r.seriesId === id));
    if (empty) return { id: empty, created: false };
  }
  const [firstAuthor] = authorIds.length
    ? await db
        .select({ name: authors.name })
        .from(authors)
        .where(eq(authors.id, authorIds[0] ?? ""))
    : [];
  const id = ulid();
  await db.insert(series).values({
    id,
    slug: await uniqueSlug(db, series, name, [firstAuthor?.name ?? ""]),
    name,
    nameKey: key,
    origin,
  });
  return {
    id,
    created: true,
    ...(candidates.length
      ? { warning: `another series is also called "${name}"; created a separate one` }
      : {}),
  };
}

export async function findOrCreatePublisher(db: Db, rawName: string): Promise<string> {
  const name = cleanText(rawName);
  const key = nameKey(name);
  const [found] = await db
    .select({ id: publishers.id })
    .from(publishers)
    .where(eq(publishers.nameKey, key))
    .limit(1);
  if (found) return found.id;
  const id = ulid();
  await db
    .insert(publishers)
    .values({ id, slug: await uniqueSlug(db, publishers, name), name, nameKey: key });
  return id;
}

export async function findOrCreateNarrator(db: Db, rawName: string): Promise<string> {
  const name = cleanText(rawName);
  const key = nameKey(name);
  const [found] = await db
    .select({ id: narrators.id })
    .from(narrators)
    .where(eq(narrators.nameKey, key))
    .limit(1);
  if (found) return found.id;
  const id = ulid();
  await db.insert(narrators).values({ id, slug: await uniqueSlug(db, narrators, name), name, nameKey: key });
  return id;
}

/** Follow merge redirects to the surviving book. */
export async function survivingBookId(db: Db, id: string): Promise<string | null> {
  let current = id;
  for (let hops = 0; hops < 5; hops++) {
    const [row] = await db.select({ redirectTo: books.redirectTo }).from(books).where(eq(books.id, current));
    if (!row) return null;
    if (!row.redirectTo) return current;
    current = row.redirectTo;
  }
  return current;
}

export interface MatchQuery {
  asins: string[];
  isbns: string[];
  audibleAsins: string[];
  authorIds: string[];
  titleKey: string;
  title: string;
  seriesId: string | null;
  position: number | null;
}

export type MatchKind = "asin" | "isbn" | "audible_asin" | "title" | "series_position";

export interface MatchResult {
  match: { bookId: string; by: MatchKind } | null;
  /** Fuzzy candidates for a person to decide (DESIGN §7.4 tier 3). */
  candidates: { bookId: string; similarity: number }[];
}

/** Series positions: unknown is compatible with anything. */
const compatible = (a: number | null, b: number | null) => a === null || b === null || a === b;

/**
 * Volume numbers in titles: book 1 often carries no number ("Delve" vs "Delve 2"), so a missing
 * number only matches volume 1.
 */
const sameVolume = (a: number | null, b: number | null) => (a ?? 1) === (b ?? 1);

/** Every word of the shorter key appears in the longer one ("founding" in "land founding"). */
function contained(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 5) return false;
  const words = new Set(long.split(" "));
  return short.split(" ").every((w) => words.has(w));
}

export async function matchBook(db: Db, q: MatchQuery, fuzzyMin: number): Promise<MatchResult> {
  // Tier 1: identifiers.
  if (q.asins.length || q.isbns.length || q.audibleAsins.length) {
    const conditions = [
      q.asins.length ? inArray(editions.asin, q.asins) : undefined,
      q.isbns.length ? inArray(editions.isbn13, q.isbns) : undefined,
      q.audibleAsins.length ? inArray(editions.audibleAsin, q.audibleAsins) : undefined,
    ].filter((c) => c !== undefined);
    const hits = await db
      .select({
        bookId: editions.bookId,
        asin: editions.asin,
        isbn13: editions.isbn13,
        audibleAsin: editions.audibleAsin,
      })
      .from(editions)
      .where(or(...conditions));
    const hit = hits[0];
    if (hit) {
      const bookId = await survivingBookId(db, hit.bookId);
      if (bookId) {
        const by: MatchKind =
          hit.asin && q.asins.includes(hit.asin)
            ? "asin"
            : hit.isbn13 && q.isbns.includes(hit.isbn13)
              ? "isbn"
              : "audible_asin";
        return { match: { bookId, by }, candidates: [] };
      }
    }
  }

  if (q.authorIds.length === 0) return { match: null, candidates: [] };
  // Tiers 2 and 3 compare against everything these authors have written.
  const theirs = await db
    .selectDistinct({
      id: books.id,
      titleKey: books.titleKey,
      title: books.title,
      seriesId: books.seriesId,
      position: books.seriesPosition,
    })
    .from(books)
    .innerJoin(bookAuthors, eq(bookAuthors.bookId, books.id))
    .where(and(inArray(bookAuthors.authorId, q.authorIds), isNull(books.redirectTo)));

  const volume = extractVolume(q.title);
  const strong = theirs.find(
    (b) =>
      b.titleKey === q.titleKey &&
      compatible(b.position, q.position) &&
      sameVolume(extractVolume(b.title), volume),
  );
  if (strong) return { match: { bookId: strong.id, by: "title" }, candidates: [] };
  if (q.seriesId && q.position !== null) {
    const slot = theirs.find((b) => b.seriesId === q.seriesId && b.position === q.position);
    if (slot) return { match: { bookId: slot.id, by: "series_position" }, candidates: [] };
  }

  const candidates = theirs
    .filter((b) => compatible(b.position, q.position) && sameVolume(extractVolume(b.title), volume))
    .map((b) => ({
      bookId: b.id,
      similarity: trigramSimilarity(b.titleKey, q.titleKey),
      contained: contained(b.titleKey, q.titleKey),
    }))
    .filter((c) => c.similarity >= fuzzyMin || c.contained)
    .map(({ bookId, similarity }) => ({ bookId, similarity }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3);
  return { match: null, candidates };
}
