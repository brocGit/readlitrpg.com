// The publication gate (DESIGN §7.15): nothing seeded from model knowledge goes public on the
// model's word alone. A record needs at least one independent confirmation: an Open Library,
// Google Books or Creators API match, a cited research source, an author claim, or the owner.

import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db";
import { books, type ConfirmationSource, catalogConfirmations } from "../db/schema";
import { ulid } from "../ids";
import { nowIso } from "../time";

export interface Confirmation {
  subjectType: "book" | "series" | "author";
  subjectId: string;
  source: ConfirmationSource;
  sourceRef?: string;
  evidence?: unknown;
  createdBy?: string | null;
}

/** Record a confirmation (idempotent per source and reference). Returns true if it was new. */
export async function addConfirmation(db: Db, c: Confirmation): Promise<boolean> {
  const now = nowIso();
  const inserted = await db
    .insert(catalogConfirmations)
    .values({
      id: ulid(),
      subjectType: c.subjectType,
      subjectId: c.subjectId,
      source: c.source,
      sourceRef: c.sourceRef ?? "",
      evidence: c.evidence ?? null,
      createdBy: c.createdBy ?? null,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: catalogConfirmations.id });
  if (c.subjectType === "book") {
    await db
      .update(books)
      .set({ confirmedAt: now, updatedAt: now })
      .where(and(eq(books.id, c.subjectId), isNull(books.confirmedAt)));
  }
  return inserted.length === 1;
}

export type GateResult = { ok: true } | { ok: false; reason: string };

type GateBook = Pick<
  typeof books.$inferSelect,
  "confirmedAt" | "inScope" | "redirectTo" | "visibility" | "title"
>;

/** Can this book be published? Pure, so the console can show why not. */
export function publicationGate(book: GateBook): GateResult {
  if (book.redirectTo) return { ok: false, reason: "merged into another book" };
  if (book.visibility === "removed") return { ok: false, reason: "removed" };
  if (!book.confirmedAt) return { ok: false, reason: "needs an independent confirmation" };
  if (book.inScope === "no") return { ok: false, reason: "marked out of scope" };
  return { ok: true };
}

export async function setVisibility(
  db: Db,
  bookId: string,
  visibility: "published" | "hidden" | "draft",
): Promise<GateResult> {
  const [book] = await db.select().from(books).where(eq(books.id, bookId));
  if (!book) return { ok: false, reason: "not found" };
  if (visibility === "published") {
    const gate = publicationGate(book);
    if (!gate.ok) return gate;
  }
  const now = nowIso();
  await db
    .update(books)
    .set({
      visibility,
      updatedAt: now,
      ...(visibility === "published" && !book.publishedAt ? { publishedAt: now } : {}),
    })
    .where(eq(books.id, bookId));
  return { ok: true };
}
