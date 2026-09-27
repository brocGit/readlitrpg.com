// Read models for the owner console's catalog pages.

import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Db } from "../db";
import {
  authors,
  bookAuthors,
  bookFieldSources,
  bookLinks,
  books,
  bookTags,
  catalogConfirmations,
  catalogMerges,
  editionNarrators,
  editions,
  narrators,
  type Origin,
  publishers,
  releases,
  series,
  tags,
  type Visibility,
} from "../db/schema";
import { nameKey, titleKey } from "./normalize";

export interface BookFilters {
  q?: string;
  visibility?: Visibility;
  confirmed?: "yes" | "no";
  origin?: Origin;
}

export async function listBooks(db: Db, filters: BookFilters, limit = 50, offset = 0) {
  const conditions: SQL[] = [isNull(books.redirectTo)];
  if (filters.visibility) conditions.push(eq(books.visibility, filters.visibility));
  else conditions.push(ne(books.visibility, "removed"));
  if (filters.confirmed === "yes") conditions.push(isNotNull(books.confirmedAt));
  if (filters.confirmed === "no") conditions.push(isNull(books.confirmedAt));
  if (filters.origin) conditions.push(eq(books.origin, filters.origin));
  if (filters.q?.trim()) {
    const tk = titleKey(filters.q);
    const ak = nameKey(filters.q);
    const byAuthor = db
      .select({ id: bookAuthors.bookId })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(like(authors.nameKey, `%${ak}%`));
    const bySeries = db
      .select({ id: series.id })
      .from(series)
      .where(like(series.nameKey, `%${ak}%`));
    const matchers = [inArray(books.id, byAuthor), inArray(books.seriesId, bySeries)];
    if (tk) matchers.push(like(books.titleKey, `%${tk}%`));
    const any = or(...matchers);
    if (any) conditions.push(any);
  }
  const rows = await db
    .select({
      id: books.id,
      title: books.title,
      slug: books.slug,
      visibility: books.visibility,
      origin: books.origin,
      confirmedAt: books.confirmedAt,
      enrichStatus: books.enrichStatus,
      primaryGenre: books.primaryGenre,
      seriesName: series.name,
      seriesPosition: books.seriesPosition,
      updatedAt: books.updatedAt,
      authorNames: sql<string>`(select group_concat(${authors.name}, ', ') from ${bookAuthors} join ${authors} on ${authors.id} = ${bookAuthors.authorId} where ${bookAuthors.bookId} = ${books.id})`,
    })
    .from(books)
    .leftJoin(series, eq(series.id, books.seriesId))
    .where(and(...conditions))
    .orderBy(asc(series.name), asc(books.seriesPosition), asc(books.titleKey))
    .limit(limit)
    .offset(offset);
  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(books)
    .leftJoin(series, eq(series.id, books.seriesId))
    .where(and(...conditions));
  return { rows, total };
}

export async function catalogSummary(db: Db) {
  const rows = await db
    .select({
      visibility: books.visibility,
      confirmed: sql<number>`${books.confirmedAt} is not null`,
      n: count(),
    })
    .from(books)
    .where(isNull(books.redirectTo))
    .groupBy(books.visibility, sql`${books.confirmedAt} is not null`);
  const sum = (pred: (r: (typeof rows)[number]) => boolean) => rows.filter(pred).reduce((a, r) => a + r.n, 0);
  return {
    total: sum((r) => r.visibility !== "removed"),
    published: sum((r) => r.visibility === "published"),
    readyToPublish: sum((r) => r.visibility === "draft" && Boolean(r.confirmed)),
    awaitingConfirmation: sum((r) => r.visibility === "draft" && !r.confirmed),
    hidden: sum((r) => r.visibility === "hidden"),
  };
}

export async function getBookDetail(db: Db, id: string) {
  const [book] = await db.select().from(books).where(eq(books.id, id));
  if (!book) return null;
  const [bookSeries] = book.seriesId
    ? await db.select().from(series).where(eq(series.id, book.seriesId))
    : [];
  const bookAuthorRows = await db
    .select({ id: authors.id, name: authors.name, slug: authors.slug, role: bookAuthors.role })
    .from(bookAuthors)
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(eq(bookAuthors.bookId, id))
    .orderBy(asc(bookAuthors.position));
  const editionRows = await db
    .select({ edition: editions, publisher: publishers.name })
    .from(editions)
    .leftJoin(publishers, eq(publishers.id, editions.publisherId))
    .where(eq(editions.bookId, id));
  const narratorRows = editionRows.length
    ? await db
        .select({ editionId: editionNarrators.editionId, name: narrators.name })
        .from(editionNarrators)
        .innerJoin(narrators, eq(narrators.id, editionNarrators.narratorId))
        .where(
          inArray(
            editionNarrators.editionId,
            editionRows.map((e) => e.edition.id),
          ),
        )
    : [];
  const links = await db.select().from(bookLinks).where(eq(bookLinks.bookId, id));
  const releaseRows = await db
    .select()
    .from(releases)
    .where(eq(releases.bookId, id))
    .orderBy(asc(releases.date));
  const tagRows = await db
    .select({
      slug: tags.slug,
      name: tags.name,
      facet: tags.facet,
      score: bookTags.score,
      sources: bookTags.sources,
      adminLocked: bookTags.adminLocked,
    })
    .from(bookTags)
    .innerJoin(tags, eq(tags.id, bookTags.tagId))
    .where(eq(bookTags.bookId, id))
    .orderBy(desc(bookTags.score));
  const confirmations = await db
    .select()
    .from(catalogConfirmations)
    .where(and(eq(catalogConfirmations.subjectType, "book"), eq(catalogConfirmations.subjectId, id)));
  const provenance = await db
    .select()
    .from(bookFieldSources)
    .where(eq(bookFieldSources.bookId, id))
    .orderBy(desc(bookFieldSources.createdAt))
    .limit(100);
  const merges = await db
    .select()
    .from(catalogMerges)
    .where(
      and(
        eq(catalogMerges.entityType, "book"),
        or(eq(catalogMerges.winnerId, id), eq(catalogMerges.loserId, id)),
      ),
    )
    .orderBy(desc(catalogMerges.mergedAt));
  return {
    book,
    series: bookSeries ?? null,
    authors: bookAuthorRows,
    editions: editionRows.map((e) => ({
      ...e.edition,
      publisher: e.publisher,
      narrators: narratorRows.filter((n) => n.editionId === e.edition.id).map((n) => n.name),
    })),
    links,
    releases: releaseRows,
    tags: tagRows,
    confirmations,
    provenance,
    merges,
  };
}

/** Find a book by id or slug (for "merge into…"). */
export async function findBookRef(db: Db, ref: string) {
  const [row] = await db
    .select({ id: books.id, title: books.title, redirectTo: books.redirectTo })
    .from(books)
    .where(or(eq(books.id, ref.trim()), eq(books.slug, ref.trim())))
    .limit(1);
  return row ?? null;
}

/** Drafts that pass the publication gate: the owner's "publish everything confirmed" button. */
export async function publishableDraftIds(db: Db, limit = 500): Promise<string[]> {
  const rows = await db
    .select({ id: books.id })
    .from(books)
    .where(
      and(
        eq(books.visibility, "draft"),
        isNotNull(books.confirmedAt),
        isNull(books.redirectTo),
        ne(books.inScope, "no"),
      ),
    )
    .limit(limit);
  return rows.map((r) => r.id);
}
