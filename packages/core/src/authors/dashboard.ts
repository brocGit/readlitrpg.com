// The author dashboard's read models (DESIGN §10.5): each book with its status, a completeness
// score and to-dos; aggregate stats (never which readers); and who changed each field.

import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { CHANGE_SOURCE_LABEL, changeLabel } from "../catalog/changes";
import type { Db } from "../db";
import {
  bookAuthors,
  bookFieldSources,
  bookLinks,
  bookMarks,
  books,
  bookTags,
  editions,
  follows,
  pageViewsDaily,
  releaseAsks,
  releases,
  series,
} from "../db/schema";

export interface DashboardBook {
  id: string;
  slug: string;
  title: string;
  visibility: string;
  series: string | null;
  position: number | null;
  nextRelease: { id: string; kind: string; date: string | null; precision: string; status: string } | null;
  completeness: number;
  todos: string[];
}

const chunks = <T>(list: T[], size = 90): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

export async function dashboardBooks(
  db: Db,
  authorIds: string[],
  now = new Date(),
): Promise<DashboardBook[]> {
  if (authorIds.length === 0) return [];
  const rows = await db
    .selectDistinct({
      id: books.id,
      slug: books.slug,
      title: books.title,
      visibility: books.visibility,
      seriesName: series.name,
      position: books.seriesPosition,
      cover: books.coverMediaId,
      blurb: books.blurbAuthor,
      genre: books.primaryGenre,
      firstPublished: books.firstPublished,
    })
    .from(books)
    .innerJoin(bookAuthors, eq(bookAuthors.bookId, books.id))
    .leftJoin(series, eq(series.id, books.seriesId))
    .where(and(inArray(bookAuthors.authorId, authorIds.slice(0, 90)), isNull(books.redirectTo)))
    .orderBy(desc(books.createdAt))
    .limit(500);
  const ids = rows.map((r) => r.id);
  const rels: (typeof releases.$inferSelect)[] = [];
  const linkCount = new Map<string, number>();
  const tagCount = new Map<string, number>();
  const audio = new Map<string, number>();
  const asks: { bookId: string; date: string }[] = [];
  for (const part of chunks(ids)) {
    rels.push(...(await db.select().from(releases).where(inArray(releases.bookId, part))));
    for (const r of await db
      .select({ id: bookLinks.bookId, n: sql<number>`count(*)` })
      .from(bookLinks)
      .where(inArray(bookLinks.bookId, part))
      .groupBy(bookLinks.bookId))
      linkCount.set(r.id, Number(r.n));
    for (const r of await db
      .select({ id: bookTags.bookId, n: sql<number>`count(*)` })
      .from(bookTags)
      .where(and(inArray(bookTags.bookId, part), gte(bookTags.score, 0.5)))
      .groupBy(bookTags.bookId))
      tagCount.set(r.id, Number(r.n));
    for (const r of await db
      .select({
        id: editions.bookId,
        n: sql<number>`(select count(*) from edition_narrators en where en.edition_id = "editions"."id")`,
      })
      .from(editions)
      .where(and(inArray(editions.bookId, part), eq(editions.format, "audiobook"))))
      audio.set(r.id, Number(r.n));
    asks.push(
      ...(await db
        .select({ bookId: releaseAsks.bookId, date: releaseAsks.date })
        .from(releaseAsks)
        .where(and(inArray(releaseAsks.bookId, part), isNull(releaseAsks.answeredAt)))),
    );
  }
  const today = now.toISOString().slice(0, 10);
  return rows.map((b) => {
    const mine = rels.filter((r) => r.bookId === b.id && r.status !== "cancelled");
    const next =
      mine
        .filter((r) => r.date === null || r.date >= today)
        .sort((x, y) => (x.date ?? "9999").localeCompare(y.date ?? "9999"))[0] ?? null;
    const checks: [boolean, string][] = [
      [Boolean(b.cover), "Add a cover"],
      [Boolean(b.blurb), "Add your blurb"],
      [(linkCount.get(b.id) ?? 0) > 0, "Add a store link"],
      [Boolean(b.genre), "Pick a genre"],
      [(tagCount.get(b.id) ?? 0) >= 3, "Add at least three tags"],
      [mine.length > 0 || Boolean(b.firstPublished), "Add the release date"],
      [!audio.has(b.id) || (audio.get(b.id) ?? 0) > 0, "Add the audiobook's narrator"],
    ];
    const todos = checks.filter(([ok]) => !ok).map(([, todo]) => todo);
    for (const a of asks.filter((x) => x.bookId === b.id))
      todos.unshift(`Confirm the release date (${a.date})`);
    return {
      id: b.id,
      slug: b.slug,
      title: b.title,
      visibility: b.visibility,
      series: b.seriesName,
      position: b.position,
      nextRelease: next
        ? {
            id: next.id,
            kind: next.kind,
            date: next.date,
            precision: next.datePrecision,
            status: next.status,
          }
        : null,
      completeness: Math.round((checks.filter(([ok]) => ok).length / checks.length) * 100),
      todos,
    };
  });
}

export interface BookStats {
  views: number;
  matchAppearances: number;
  follows: number;
  loved: number;
  read: number;
}

/** 90-day totals for one book. Aggregate only: nothing here says which readers (§10.5). */
export async function bookStats(
  db: Db,
  book: { id: string; slug: string },
  days = 90,
  now = new Date(),
): Promise<BookStats> {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const sinceDay = since.slice(0, 10);
  const [views, marks, fol] = await Promise.all([
    db
      .select({ kind: pageViewsDaily.kind, n: sql<number>`sum(${pageViewsDaily.views})` })
      .from(pageViewsDaily)
      .where(
        and(
          inArray(pageViewsDaily.kind, ["book", "match_appearance"]),
          eq(pageViewsDaily.key, book.slug),
          gte(pageViewsDaily.day, sinceDay),
        ),
      )
      .groupBy(pageViewsDaily.kind),
    db
      .select({ status: bookMarks.status, n: sql<number>`count(*)` })
      .from(bookMarks)
      .where(eq(bookMarks.bookId, book.id))
      .groupBy(bookMarks.status),
    db
      .select({ n: sql<number>`count(*)` })
      .from(follows)
      .where(
        and(eq(follows.targetType, "book"), eq(follows.targetId, book.id), gte(follows.createdAt, since)),
      ),
  ]);
  const byKind = new Map(views.map((v) => [v.kind, Number(v.n)]));
  const byMark = new Map(marks.map((m) => [m.status, Number(m.n)]));
  return {
    views: byKind.get("book") ?? 0,
    matchAppearances: byKind.get("match_appearance") ?? 0,
    follows: Number(fol[0]?.n ?? 0),
    loved: byMark.get("loved") ?? 0,
    read: (byMark.get("read") ?? 0) + (byMark.get("loved") ?? 0),
  };
}

const HISTORY_SOURCE: Record<string, string> = {
  ...CHANGE_SOURCE_LABEL,
  author: "You (before verification)",
  author_verified: "You",
};

/** Who or what changed each field, newest first (§10.5 "Change history"). */
export async function bookHistory(db: Db, bookId: string, limit = 60) {
  const rows = await db
    .select()
    .from(bookFieldSources)
    .where(eq(bookFieldSources.bookId, bookId))
    .orderBy(desc(bookFieldSources.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    field: changeLabel(r.field),
    who: HISTORY_SOURCE[r.source] ?? r.source,
    value:
      typeof r.value === "string"
        ? r.value.slice(0, 140)
        : r.value === null
          ? "(cleared)"
          : JSON.stringify(r.value).slice(0, 140),
    at: r.createdAt,
  }));
}
