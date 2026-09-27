// Writing book fields with provenance (DESIGN §6.4). Callers never update `books` columns covered
// by provenance directly: they append sources here, and the resolved values are recomputed.

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db";
import { AI_USE, bookFieldSources, books, type FieldSource, HAREM, IN_SCOPE, PUB_STATUS } from "../db/schema";
import { ulid } from "../ids";
import { CONTENT_FLAGS, GENRE_SLUGS } from "../taxonomy";
import { nowIso } from "../time";
import { recordBookChange } from "./changes";
import { type PreciseDate, titleKey } from "./normalize";
import { BOOK_FIELD_CLASSES, type BookField, resolveField, type SourcedValue } from "./provenance";

const preciseDate = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  precision: z.enum(["day", "month", "quarter", "year", "tba"]),
});

/** What each field accepts. Invalid values are rejected before they reach provenance. */
export const FIELD_SCHEMAS: Record<BookField, z.ZodType> = {
  title: z.string().min(1).max(300),
  subtitle: z.string().max(300).nullable(),
  seriesId: z.string().nullable(),
  seriesPosition: z.number().min(0).max(1000).nullable(),
  firstPublished: preciseDate.nullable(),
  pageCount: z.number().int().min(1).max(20_000).nullable(),
  wordCountEst: z.number().int().min(1_000).max(10_000_000).nullable(),
  language: z.string().regex(/^[a-z]{2}$/),
  pubStatus: z.enum(PUB_STATUS),
  blurbAuthor: z.string().max(5_000).nullable(),
  summaryAi: z.string().max(1_000).nullable(),
  hookAi: z.string().max(300).nullable(),
  primaryGenre: z
    .string()
    .refine((g) => GENRE_SLUGS.has(g), "not a genre tag")
    .nullable(),
  inScope: z.enum(IN_SCOPE),
  crunchLevel: z.number().int().min(0).max(3).nullable(),
  romanceLevel: z.number().int().min(0).max(4).nullable(),
  harem: z.enum(HAREM),
  contentFlags: z.array(z.string().refine((f) => CONTENT_FLAGS.includes(f), "unknown content flag")),
  isAiGenerated: z.enum(AI_USE),
};

export interface FieldWrite {
  field: BookField;
  value: unknown;
  confidence?: number | null;
}

export interface WriteContext {
  source: FieldSource;
  sourceRef?: string | null;
  createdBy?: string | null;
}

export class FieldValueError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
    this.name = "FieldValueError";
  }
}

/** Defaults for fields no source has set, matching the column defaults. */
const DEFAULTS: Partial<Record<BookField, unknown>> = {
  language: "en",
  pubStatus: "unknown",
  harem: "unknown",
  inScope: "unknown",
  isAiGenerated: "unknown",
  contentFlags: [],
};

/** Map resolved values onto `books` columns. */
function toColumns(field: BookField, value: unknown): Partial<typeof books.$inferInsert> {
  if (field === "firstPublished") {
    const v = value as PreciseDate | null | undefined;
    return { firstPublished: v?.date ?? null, firstPublishedPrecision: v?.precision ?? null };
  }
  return { [field]: value === undefined ? (DEFAULTS[field] ?? null) : value } as Partial<
    typeof books.$inferInsert
  >;
}

/**
 * Append field values from one source and recompute the affected fields on the book.
 * Values equal to that source's latest value are skipped, so re-running an import doesn't bloat
 * the provenance log. Returns the fields whose resolved value changed.
 */
export async function writeBookFields(
  db: Db,
  bookId: string,
  writes: FieldWrite[],
  ctx: WriteContext,
): Promise<BookField[]> {
  const valid: FieldWrite[] = [];
  for (const w of writes) {
    if (w.value === undefined) continue;
    // The AI never sets AI-use attestation, and only authors or the owner supply blurbs.
    if (w.field === "isAiGenerated" && (ctx.source === "ai" || ctx.source === "api")) continue;
    const parsed = FIELD_SCHEMAS[w.field].safeParse(w.value);
    if (!parsed.success)
      throw new FieldValueError(w.field, parsed.error.issues[0]?.message ?? "invalid value");
    valid.push({ ...w, value: parsed.data });
  }
  if (valid.length === 0) return [];
  const fields = [...new Set(valid.map((w) => w.field))];
  const existing = await loadSources(db, bookId, fields);

  const now = nowIso();
  const inserts = [];
  for (const w of valid) {
    const same = latestFromSource(existing.get(w.field) ?? [], ctx.source);
    if (same && JSON.stringify(same.value) === JSON.stringify(w.value)) continue;
    const row = {
      id: ulid(),
      bookId,
      field: w.field,
      value: w.value,
      source: ctx.source,
      sourceRef: ctx.sourceRef ?? null,
      confidence: w.confidence ?? null,
      createdBy: ctx.createdBy ?? null,
      createdAt: now,
    };
    inserts.push(row);
    existing.set(w.field, [...(existing.get(w.field) ?? []), row as SourcedValue]);
  }
  if (inserts.length === 0) return [];
  await db.insert(bookFieldSources).values(inserts);
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  const changed = await applyResolved(
    db,
    bookId,
    [...new Set(inserts.map((r) => r.field as BookField))],
    existing,
    diff,
  );
  // Authors hear about changes they didn't make (§10.4).
  await recordBookChange(db, bookId, ctx.source, changed, diff);
  return changed;
}

/** Recompute every provenance-backed field on a book (after a merge, or a precedence change). */
export async function resolveBookFields(db: Db, bookId: string): Promise<BookField[]> {
  const fields = Object.keys(BOOK_FIELD_CLASSES) as BookField[];
  return applyResolved(db, bookId, fields, await loadSources(db, bookId, fields));
}

async function applyResolved(
  db: Db,
  bookId: string,
  fields: BookField[],
  sources: Map<BookField, SourcedValue[]>,
  diff?: Record<string, { from: unknown; to: unknown }>,
): Promise<BookField[]> {
  const [current] = await db.select().from(books).where(eq(books.id, bookId));
  if (!current) return [];
  const patch: Partial<typeof books.$inferInsert> = {};
  const changed: BookField[] = [];
  for (const field of fields) {
    const resolved = resolveField(field, sources.get(field) ?? []);
    const cols = toColumns(field, resolved.value);
    for (const [col, value] of Object.entries(cols)) {
      if (col === "title" && (value === null || value === undefined)) continue;
      if (JSON.stringify((current as Record<string, unknown>)[col]) !== JSON.stringify(value)) {
        (patch as Record<string, unknown>)[col] = value;
        if (diff) diff[col] = { from: (current as Record<string, unknown>)[col] ?? null, to: value ?? null };
        if (!changed.includes(field)) changed.push(field);
      }
    }
  }
  // The matching key follows the title; the slug never changes (URLs are permanent).
  if (typeof patch.title === "string") patch.titleKey = titleKey(patch.title);
  if (changed.length)
    await db
      .update(books)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(books.id, bookId));
  return changed;
}

async function loadSources(
  db: Db,
  bookId: string,
  fields: BookField[],
): Promise<Map<BookField, SourcedValue[]>> {
  const rows = await db
    .select()
    .from(bookFieldSources)
    .where(and(eq(bookFieldSources.bookId, bookId), inArray(bookFieldSources.field, fields)));
  const map = new Map<BookField, SourcedValue[]>();
  for (const r of rows) {
    const list = map.get(r.field as BookField) ?? [];
    list.push({
      value: r.value,
      source: r.source,
      confidence: r.confidence,
      createdAt: r.createdAt,
      id: r.id,
    });
    map.set(r.field as BookField, list);
  }
  return map;
}

function latestFromSource(rows: SourcedValue[], source: FieldSource): SourcedValue | undefined {
  return rows
    .filter((r) => r.source === source)
    .sort((a, b) =>
      a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt),
    )
    .at(-1);
}
