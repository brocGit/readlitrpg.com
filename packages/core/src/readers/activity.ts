// What a reader does on the site (DESIGN §9.6): follows with a notification choice, book marks
// (loved / read / didn't finish / want), saved matches and searches, and a private calendar feed.

import { and, asc, count, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { randomToken, sha256Hex } from "../crypto";
import type { Db } from "../db";
import {
  authors,
  bookAuthors,
  bookMarks,
  books,
  bookTags,
  editionNarrators,
  editions,
  type FOLLOW_NOTIFY,
  type FollowTarget,
  feedTokens,
  follows,
  type MarkStatus,
  narrators,
  publishers,
  type QUERY_ALERTS,
  type QUERY_KINDS,
  releases,
  savedQueries,
  series,
  tags,
} from "../db/schema";
import { ulid } from "../ids";
import { nowIso } from "../time";
import { refreshLevel } from "./profile";

export class ActivityError extends Error {}

type Notify = (typeof FOLLOW_NOTIFY)[number];

function targetTable(type: FollowTarget) {
  switch (type) {
    case "author":
      return { table: authors, name: authors.name, slug: authors.slug, id: authors.id, path: "/authors/" };
    case "series":
      return { table: series, name: series.name, slug: series.slug, id: series.id, path: "/series/" };
    case "narrator":
      return {
        table: narrators,
        name: narrators.name,
        slug: narrators.slug,
        id: narrators.id,
        path: "/narrators/",
      };
    case "tag":
      return { table: tags, name: tags.name, slug: tags.slug, id: tags.id, path: "/tags/" };
    case "book":
      return { table: books, name: books.title, slug: books.slug, id: books.id, path: "/books/" };
    case "publisher":
      return {
        table: publishers,
        name: publishers.name,
        slug: publishers.slug,
        id: publishers.id,
        path: "/",
      };
  }
}

/** Pages know slugs; follows store ids, which survive renames. */
export async function resolveTarget(
  db: Db,
  type: FollowTarget,
  slug: string,
): Promise<{ id: string; name: string } | null> {
  const t = targetTable(type);
  const [row] = await db.select({ id: t.id, name: t.name }).from(t.table).where(eq(t.slug, slug));
  return row ?? null;
}

export async function setFollow(
  db: Db,
  userId: string,
  type: FollowTarget,
  slug: string,
  notify: Notify | null,
): Promise<boolean> {
  const target = await resolveTarget(db, type, slug);
  if (!target) throw new ActivityError("nothing to follow there");
  if (notify === null) {
    await db
      .delete(follows)
      .where(and(eq(follows.userId, userId), eq(follows.targetType, type), eq(follows.targetId, target.id)));
    return false;
  }
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(follows).where(eq(follows.userId, userId));
  if (n >= 500) throw new ActivityError("you're following 500 things already");
  await db
    .insert(follows)
    .values({ userId, targetType: type, targetId: target.id, notify, createdAt: nowIso() })
    .onConflictDoUpdate({ target: [follows.userId, follows.targetType, follows.targetId], set: { notify } });
  return true;
}

export async function followState(
  db: Db,
  userId: string,
  type: FollowTarget,
  slug: string,
): Promise<Notify | null> {
  const target = await resolveTarget(db, type, slug);
  if (!target) return null;
  const [row] = await db
    .select({ notify: follows.notify })
    .from(follows)
    .where(and(eq(follows.userId, userId), eq(follows.targetType, type), eq(follows.targetId, target.id)));
  return row?.notify ?? null;
}

export interface FollowRow {
  type: FollowTarget;
  id: string;
  name: string;
  path: string;
  notify: Notify;
  createdAt: string;
}

export async function followsFor(db: Db, userId: string): Promise<FollowRow[]> {
  const rows = await db
    .select()
    .from(follows)
    .where(eq(follows.userId, userId))
    .orderBy(desc(follows.createdAt));
  const out: FollowRow[] = [];
  const byType = new Map<FollowTarget, typeof rows>();
  for (const r of rows) byType.set(r.targetType, [...(byType.get(r.targetType) ?? []), r]);
  for (const [type, list] of byType) {
    const t = targetTable(type);
    for (let k = 0; k < list.length; k += 90) {
      const part = list.slice(k, k + 90);
      const names = await db
        .select({ id: t.id, name: t.name, slug: t.slug })
        .from(t.table)
        .where(
          inArray(
            t.id,
            part.map((p) => p.targetId),
          ),
        );
      for (const p of part) {
        const n = names.find((x) => x.id === p.targetId);
        if (n)
          out.push({
            type,
            id: p.targetId,
            name: n.name,
            path: `${t.path}${n.slug}`,
            notify: p.notify,
            createdAt: p.createdAt,
          });
      }
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---------------------------------------------------------------------------------------------
// Book marks

export async function setMark(
  db: Db,
  userId: string,
  bookSlug: string,
  status: MarkStatus | null,
  source: "site" | "email" | "import" = "site",
  rating: number | null = null,
): Promise<{ status: MarkStatus | null; level: number; previousLevel: number }> {
  const [book] = await db
    .select({ id: books.id })
    .from(books)
    .where(and(eq(books.slug, bookSlug), eq(books.visibility, "published")));
  if (!book) throw new ActivityError("no such book");
  if (status === null) {
    await db.delete(bookMarks).where(and(eq(bookMarks.userId, userId), eq(bookMarks.bookId, book.id)));
  } else {
    const now = nowIso();
    await db
      .insert(bookMarks)
      .values({ userId, bookId: book.id, status, rating, source, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [bookMarks.userId, bookMarks.bookId],
        set: { status, rating, source, updatedAt: now },
      });
  }
  const level = await refreshLevel(db, userId);
  return { status, ...level };
}

export async function marksFor(db: Db, userId: string, bookSlugs?: string[]) {
  const where = bookSlugs?.length
    ? and(eq(bookMarks.userId, userId), inArray(books.slug, bookSlugs.slice(0, 90)))
    : eq(bookMarks.userId, userId);
  return db
    .select({
      slug: books.slug,
      title: books.title,
      status: bookMarks.status,
      rating: bookMarks.rating,
      updatedAt: bookMarks.updatedAt,
    })
    .from(bookMarks)
    .innerJoin(books, eq(books.id, bookMarks.bookId))
    .where(where)
    .orderBy(desc(bookMarks.updatedAt))
    .limit(1000);
}

// ---------------------------------------------------------------------------------------------
// Saved matches and searches (alerts when a new book fits)

export const MAX_SAVED = 20;

export async function saveQuery(
  db: Db,
  userId: string,
  q: {
    kind: (typeof QUERY_KINDS)[number];
    name: string;
    params: string;
    alert?: (typeof QUERY_ALERTS)[number];
  },
): Promise<string> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(savedQueries)
    .where(eq(savedQueries.userId, userId));
  if (n >= MAX_SAVED) throw new ActivityError(`you can keep ${MAX_SAVED} saved matches and searches`);
  const id = ulid();
  const now = nowIso();
  await db.insert(savedQueries).values({
    id,
    userId,
    kind: q.kind,
    name: q.name.trim().slice(0, 80) || (q.kind === "match" ? "My match" : "My search"),
    params: q.params.slice(0, 4000),
    alert: q.alert ?? "digest",
    lastAlertedAt: now,
    createdAt: now,
  });
  return id;
}

export async function savedFor(db: Db, userId: string) {
  return db
    .select()
    .from(savedQueries)
    .where(eq(savedQueries.userId, userId))
    .orderBy(desc(savedQueries.createdAt));
}

export async function updateSaved(
  db: Db,
  userId: string,
  id: string,
  patch: { alert?: (typeof QUERY_ALERTS)[number]; remove?: boolean },
) {
  const own = and(eq(savedQueries.id, id), eq(savedQueries.userId, userId));
  if (patch.remove) await db.delete(savedQueries).where(own);
  else if (patch.alert) await db.update(savedQueries).set({ alert: patch.alert }).where(own);
}

// ---------------------------------------------------------------------------------------------
// Private calendar feed (DESIGN §9.6): a revocable token; the feed holds public data only.

export async function issueFeedToken(db: Db, userId: string): Promise<string> {
  const now = nowIso();
  await db
    .update(feedTokens)
    .set({ revokedAt: now })
    .where(and(eq(feedTokens.userId, userId), isNull(feedTokens.revokedAt)));
  const token = randomToken();
  await db
    .insert(feedTokens)
    .values({ id: ulid(), userId, tokenHash: await sha256Hex(token), kind: "ics", createdAt: now });
  return token;
}

export async function revokeFeedTokens(db: Db, userId: string): Promise<void> {
  await db
    .update(feedTokens)
    .set({ revokedAt: nowIso() })
    .where(and(eq(feedTokens.userId, userId), isNull(feedTokens.revokedAt)));
}

export async function hasFeed(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: feedTokens.id })
    .from(feedTokens)
    .where(and(eq(feedTokens.userId, userId), isNull(feedTokens.revokedAt)));
  return Boolean(row);
}

export async function feedOwner(db: Db, token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{30,64}$/.test(token)) return null;
  const [row] = await db
    .select({ userId: feedTokens.userId })
    .from(feedTokens)
    .where(and(eq(feedTokens.tokenHash, await sha256Hex(token)), isNull(feedTokens.revokedAt)));
  return row?.userId ?? null;
}

/**
 * Upcoming and recent releases of everything a reader follows (books, series, authors, narrators'
 * audiobooks, tags), public books only. Used by the private feed and the release-day alerts.
 */
export async function followedBookIds(db: Db, userId: string, opts: { notify?: Notify[] } = {}) {
  const notify = opts.notify ?? ["digest", "instant"];
  const f = await db
    .select({ type: follows.targetType, id: follows.targetId })
    .from(follows)
    .where(and(eq(follows.userId, userId), inArray(follows.notify, notify)));
  const ids = (t: FollowTarget) =>
    f
      .filter((x) => x.type === t)
      .map((x) => x.id)
      .slice(0, 90);
  const conds = [
    ids("book").length ? inArray(books.id, ids("book")) : undefined,
    ids("series").length ? inArray(books.seriesId, ids("series")) : undefined,
    ids("author").length
      ? inArray(
          books.id,
          db
            .select({ id: bookAuthors.bookId })
            .from(bookAuthors)
            .where(inArray(bookAuthors.authorId, ids("author"))),
        )
      : undefined,
    ids("narrator").length
      ? inArray(
          books.id,
          db
            .select({ id: editions.bookId })
            .from(editionNarrators)
            .innerJoin(editions, eq(editions.id, editionNarrators.editionId))
            .where(inArray(editionNarrators.narratorId, ids("narrator"))),
        )
      : undefined,
    ids("tag").length
      ? inArray(
          books.id,
          db
            .select({ id: bookTags.bookId })
            .from(bookTags)
            .where(and(inArray(bookTags.tagId, ids("tag")), gte(bookTags.score, 0.5))),
        )
      : undefined,
  ].filter((c): c is NonNullable<typeof c> => Boolean(c));
  return conds.length ? or(...conds) : undefined;
}

export async function followedReleases(
  db: Db,
  userId: string,
  opts: { from: string; to: string; notify?: Notify[] },
) {
  const cond = await followedBookIds(db, userId, { notify: opts.notify });
  if (!cond) return [];
  return db
    .select({
      id: releases.id,
      updatedAt: releases.updatedAt,
      bookSlug: books.slug,
      title: books.title,
      kind: releases.kind,
      date: releases.date,
      precision: releases.datePrecision,
      status: releases.status,
      previousDate: releases.previousDate,
      position: books.seriesPosition,
      seriesName: sql<string | null>`(select name from series s where s.id = ${books.seriesId})`,
    })
    .from(releases)
    .innerJoin(books, eq(books.id, releases.bookId))
    .where(
      and(
        cond,
        eq(books.visibility, "published"),
        isNull(books.redirectTo),
        sql`${releases.status} != 'cancelled' and ${releases.date} is not null`,
        gte(releases.date, opts.from),
        sql`${releases.date} <= ${opts.to}`,
      ),
    )
    .orderBy(asc(releases.date))
    .limit(300);
}
