// Merging duplicate books (DESIGN §7.4). The loser keeps its row with redirect_to pointing at the
// survivor, so its URL keeps working. Everything moved is recorded, so a merge can be undone.

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db";
import {
  bookAuthors,
  bookFieldSources,
  bookLinks,
  books,
  bookTags,
  catalogConfirmations,
  catalogMerges,
  editions,
  releases,
  type Visibility,
} from "../db/schema";
import { ulid } from "../ids";
import { nowIso } from "../time";
import { resolveBookFields } from "./fields";

interface Moved {
  editions: string[];
  links: string[];
  releases: string[];
  fieldSources: string[];
  confirmations: string[];
  tags: string[];
  authorsAdded: string[];
  loser: { visibility: Visibility; confirmedAt: string | null };
  winner: { confirmedAt: string | null };
}

/** D1 allows 100 bound parameters per statement; keep id lists well under that. */
function chunks<T>(list: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export class MergeError extends Error {
  override name = "MergeError";
}

export async function mergeBooks(
  db: Db,
  winnerId: string,
  loserId: string,
  actorId: string,
): Promise<string> {
  if (winnerId === loserId) throw new MergeError("a book can't be merged into itself");
  const [winner] = await db.select().from(books).where(eq(books.id, winnerId));
  const [loser] = await db.select().from(books).where(eq(books.id, loserId));
  if (!winner || !loser) throw new MergeError("book not found");
  if (winner.redirectTo || loser.redirectTo) throw new MergeError("one of these books was already merged");

  const ids = async <T extends { id: string }>(rows: Promise<T[]>) => (await rows).map((r) => r.id);
  const moved: Moved = {
    editions: await ids(db.select({ id: editions.id }).from(editions).where(eq(editions.bookId, loserId))),
    links: [],
    releases: await ids(db.select({ id: releases.id }).from(releases).where(eq(releases.bookId, loserId))),
    fieldSources: await ids(
      db
        .select({ id: bookFieldSources.id })
        .from(bookFieldSources)
        .where(eq(bookFieldSources.bookId, loserId)),
    ),
    confirmations: [],
    tags: [],
    authorsAdded: [],
    loser: { visibility: loser.visibility, confirmedAt: loser.confirmedAt },
    winner: { confirmedAt: winner.confirmedAt },
  };

  // Links, confirmations and tags move only where the winner doesn't already have the same one.
  const winnerUrls = new Set(
    (await db.select({ url: bookLinks.url }).from(bookLinks).where(eq(bookLinks.bookId, winnerId))).map(
      (r) => r.url,
    ),
  );
  moved.links = (
    await db
      .select({ id: bookLinks.id, url: bookLinks.url })
      .from(bookLinks)
      .where(eq(bookLinks.bookId, loserId))
  )
    .filter((l) => !winnerUrls.has(l.url))
    .map((l) => l.id);
  const confirmationKey = (c: { source: string; sourceRef: string }) => `${c.source}:${c.sourceRef}`;
  const winnerConfirmations = new Set(
    (
      await db
        .select({ source: catalogConfirmations.source, sourceRef: catalogConfirmations.sourceRef })
        .from(catalogConfirmations)
        .where(
          and(eq(catalogConfirmations.subjectType, "book"), eq(catalogConfirmations.subjectId, winnerId)),
        )
    ).map(confirmationKey),
  );
  moved.confirmations = (
    await db
      .select({
        id: catalogConfirmations.id,
        source: catalogConfirmations.source,
        sourceRef: catalogConfirmations.sourceRef,
      })
      .from(catalogConfirmations)
      .where(and(eq(catalogConfirmations.subjectType, "book"), eq(catalogConfirmations.subjectId, loserId)))
  )
    .filter((c) => !winnerConfirmations.has(confirmationKey(c)))
    .map((c) => c.id);
  const winnerTags = new Set(
    (await db.select({ tagId: bookTags.tagId }).from(bookTags).where(eq(bookTags.bookId, winnerId))).map(
      (r) => r.tagId,
    ),
  );
  moved.tags = (await db.select({ tagId: bookTags.tagId }).from(bookTags).where(eq(bookTags.bookId, loserId)))
    .map((r) => r.tagId)
    .filter((t) => !winnerTags.has(t));
  const winnerAuthors = new Set(
    (
      await db.select({ id: bookAuthors.authorId }).from(bookAuthors).where(eq(bookAuthors.bookId, winnerId))
    ).map((r) => r.id),
  );
  const loserAuthors = await db.select().from(bookAuthors).where(eq(bookAuthors.bookId, loserId));
  moved.authorsAdded = loserAuthors.filter((a) => !winnerAuthors.has(a.authorId)).map((a) => a.authorId);

  const now = nowIso();
  const mergeId = ulid();
  const statements = [
    ...chunks(moved.editions).map((c) =>
      db.update(editions).set({ bookId: winnerId, updatedAt: now }).where(inArray(editions.id, c)),
    ),
    ...chunks(moved.links).map((c) =>
      db.update(bookLinks).set({ bookId: winnerId }).where(inArray(bookLinks.id, c)),
    ),
    ...chunks(moved.releases).map((c) =>
      db.update(releases).set({ bookId: winnerId, updatedAt: now }).where(inArray(releases.id, c)),
    ),
    ...chunks(moved.fieldSources).map((c) =>
      db.update(bookFieldSources).set({ bookId: winnerId }).where(inArray(bookFieldSources.id, c)),
    ),
    ...chunks(moved.confirmations).map((c) =>
      db.update(catalogConfirmations).set({ subjectId: winnerId }).where(inArray(catalogConfirmations.id, c)),
    ),
    ...chunks(moved.tags).map((c) =>
      db
        .update(bookTags)
        .set({ bookId: winnerId })
        .where(and(eq(bookTags.bookId, loserId), inArray(bookTags.tagId, c))),
    ),
    ...loserAuthors
      .filter((a) => moved.authorsAdded.includes(a.authorId))
      .map((a) =>
        db
          .insert(bookAuthors)
          .values({ ...a, bookId: winnerId })
          .onConflictDoNothing(),
      ),
    db
      .update(books)
      .set({ redirectTo: winnerId, visibility: "removed", updatedAt: now })
      .where(eq(books.id, loserId)),
    db
      .update(books)
      .set({ confirmedAt: winner.confirmedAt ?? loser.confirmedAt, updatedAt: now })
      .where(eq(books.id, winnerId)),
    db
      .insert(catalogMerges)
      .values({
        id: mergeId,
        entityType: "book",
        winnerId,
        loserId,
        moved,
        mergedBy: actorId,
        mergedAt: now,
      }),
  ];
  for (const batch of chunks(statements, 40))
    await db.batch(batch as [(typeof batch)[number], ...typeof batch]);
  await resolveBookFields(db, winnerId);
  return mergeId;
}

/** Undo a merge: move everything back and restore the loser as it was. */
export async function unmergeBooks(db: Db, mergeId: string, actorId: string): Promise<void> {
  const [merge] = await db
    .select()
    .from(catalogMerges)
    .where(and(eq(catalogMerges.id, mergeId), isNull(catalogMerges.undoneAt)));
  if (!merge || merge.entityType !== "book") throw new MergeError("merge not found or already undone");
  const { winnerId, loserId } = merge;
  const moved = merge.moved as Moved;
  const now = nowIso();
  const statements = [
    ...chunks(moved.editions).map((c) =>
      db.update(editions).set({ bookId: loserId, updatedAt: now }).where(inArray(editions.id, c)),
    ),
    ...chunks(moved.links).map((c) =>
      db.update(bookLinks).set({ bookId: loserId }).where(inArray(bookLinks.id, c)),
    ),
    ...chunks(moved.releases).map((c) =>
      db.update(releases).set({ bookId: loserId, updatedAt: now }).where(inArray(releases.id, c)),
    ),
    ...chunks(moved.fieldSources).map((c) =>
      db.update(bookFieldSources).set({ bookId: loserId }).where(inArray(bookFieldSources.id, c)),
    ),
    ...chunks(moved.confirmations).map((c) =>
      db.update(catalogConfirmations).set({ subjectId: loserId }).where(inArray(catalogConfirmations.id, c)),
    ),
    ...chunks(moved.tags).map((c) =>
      db
        .update(bookTags)
        .set({ bookId: loserId })
        .where(and(eq(bookTags.bookId, winnerId), inArray(bookTags.tagId, c))),
    ),
    ...chunks(moved.authorsAdded).map((c) =>
      db.delete(bookAuthors).where(and(eq(bookAuthors.bookId, winnerId), inArray(bookAuthors.authorId, c))),
    ),
    db
      .update(books)
      .set({
        redirectTo: null,
        visibility: moved.loser.visibility,
        confirmedAt: moved.loser.confirmedAt,
        updatedAt: now,
      })
      .where(eq(books.id, loserId)),
    db
      .update(books)
      .set({ confirmedAt: moved.winner.confirmedAt, updatedAt: now })
      .where(eq(books.id, winnerId)),
    db.update(catalogMerges).set({ undoneAt: now, undoneBy: actorId }).where(eq(catalogMerges.id, mergeId)),
  ];
  for (const batch of chunks(statements, 40))
    await db.batch(batch as [(typeof batch)[number], ...typeof batch]);
  await resolveBookFields(db, winnerId);
  await resolveBookFields(db, loserId);
}
