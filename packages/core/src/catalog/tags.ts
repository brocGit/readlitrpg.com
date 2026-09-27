// Tag evidence per source, and the resolved score (DESIGN §6.2).

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db";
import { bookTags, type FieldSource, tags } from "../db/schema";
import { nowIso } from "../time";
import { resolveTagScore } from "./provenance";

export interface TagWrite {
  slug: string;
  /** 0–1. For the AI: its confidence. For authors: > 0.5 means "yes, this applies". For admin: the locked score. */
  value: number;
}

/** Record tag evidence from one source and recompute the scores. Unknown slugs are returned, not written. */
export async function writeBookTags(
  db: Db,
  bookId: string,
  writes: TagWrite[],
  source: FieldSource,
  crowdMinVotes: number,
): Promise<{ written: string[]; unknown: string[] }> {
  if (writes.length === 0) return { written: [], unknown: [] };
  const slugs = [...new Set(writes.map((w) => w.slug))];
  const tagRows = await db
    .select({ id: tags.id, slug: tags.slug })
    .from(tags)
    .where(and(inArray(tags.slug, slugs), eq(tags.status, "active")));
  const idBySlug = new Map(tagRows.map((t) => [t.slug, t.id]));
  const unknown = slugs.filter((s) => !idBySlug.has(s));
  const tagIds = [...idBySlug.values()];
  if (tagIds.length === 0) return { written: [], unknown };

  const existing = await db
    .select()
    .from(bookTags)
    .where(and(eq(bookTags.bookId, bookId), inArray(bookTags.tagId, tagIds)));
  const byTag = new Map(existing.map((r) => [r.tagId, r]));
  const now = nowIso();
  const statements = [];
  for (const w of writes) {
    const tagId = idBySlug.get(w.slug);
    if (!tagId) continue;
    const value = Math.min(1, Math.max(0, w.value));
    const row = byTag.get(tagId) ?? {
      bookId,
      tagId,
      score: 0,
      aiConfidence: null,
      authorAsserted: null,
      crowdUp: 0,
      crowdDown: 0,
      adminLocked: false,
      adminValue: null,
      sources: [] as string[],
      updatedAt: now,
    };
    const next = { ...row };
    switch (source) {
      case "admin":
        next.adminLocked = true;
        next.adminValue = value;
        break;
      case "author":
      case "author_verified":
        next.authorAsserted = value > 0.5;
        break;
      case "crowd":
      case "reader":
        if (value > 0.5) next.crowdUp += 1;
        else next.crowdDown += 1;
        break;
      default:
        // ai, research, api: a confidence that the tag applies.
        next.aiConfidence = value;
    }
    next.sources = [...new Set([...(row.sources ?? []), source])];
    next.score = resolveTagScore(next, crowdMinVotes);
    next.updatedAt = now;
    byTag.set(tagId, next);
    statements.push(
      db
        .insert(bookTags)
        .values(next)
        .onConflictDoUpdate({
          target: [bookTags.bookId, bookTags.tagId],
          set: {
            score: next.score,
            aiConfidence: next.aiConfidence,
            authorAsserted: next.authorAsserted,
            crowdUp: next.crowdUp,
            crowdDown: next.crowdDown,
            adminLocked: next.adminLocked,
            adminValue: next.adminValue,
            sources: next.sources,
            updatedAt: now,
          },
        }),
    );
  }
  if (statements.length) await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
  return { written: slugs.filter((s) => idBySlug.has(s)), unknown };
}

/**
 * A classification is the AI's whole answer about a book's tags: record the listed tags and clear
 * the AI's earlier evidence for any tag it no longer lists. Other sources' evidence is untouched.
 */
export async function replaceAiTags(
  db: Db,
  bookId: string,
  writes: TagWrite[],
  crowdMinVotes: number,
): Promise<{ written: string[]; cleared: string[]; unknown: string[] }> {
  const result = await writeBookTags(db, bookId, writes, "ai", crowdMinVotes);
  const keep = new Set(result.written);
  const rows = await db
    .select({ row: bookTags, slug: tags.slug })
    .from(bookTags)
    .innerJoin(tags, eq(tags.id, bookTags.tagId))
    .where(and(eq(bookTags.bookId, bookId), isNotNull(bookTags.aiConfidence)));
  const stale = rows.filter((r) => !keep.has(r.slug));
  if (stale.length === 0) return { ...result, cleared: [] };
  const now = nowIso();
  const statements = stale.map(({ row }) => {
    const next = { ...row, aiConfidence: null, sources: (row.sources ?? []).filter((s) => s !== "ai") };
    return db
      .update(bookTags)
      .set({
        aiConfidence: null,
        sources: next.sources,
        score: resolveTagScore(next, crowdMinVotes),
        updatedAt: now,
      })
      .where(and(eq(bookTags.bookId, bookId), eq(bookTags.tagId, row.tagId)));
  });
  await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
  return { ...result, cleared: stale.map((r) => r.slug) };
}
