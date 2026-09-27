// Building the feature matrix from D1 (DESIGN §7.8), and storing it in KV. Tables are read with
// keyset pagination (a few thousand rows a query), so a 20k-book catalog stays well under D1's
// 1,000-queries-per-invocation limit.

import { and, asc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { decodeVector } from "../catalog/embeddings";
import { sha256Hex } from "../crypto";
import type { Db } from "../db";
import {
  bookAuthors,
  bookEmbeddings,
  bookScores,
  books,
  bookTags,
  editions,
  series,
  tags,
} from "../db/schema";
import {
  assembleMatrix,
  decodeMatrix,
  encodeMatrix,
  type FeatureMatrix,
  type MatrixBookInput,
} from "./matrix";

const PAGE = 2000;

export interface BuildOptions {
  /** The console's preview may include drafts; the public model never does. */
  includeDrafts?: boolean;
  now?: Date;
}

/** Data completeness, until community signals exist (DESIGN §7.8 quality prior). */
export function qualityPrior(b: {
  confirmed: boolean;
  classified: boolean;
  summary: boolean;
  dialsKnown: number;
  formats: number;
  embedding: boolean;
  seriesKnown: boolean;
  strongTags: number;
}): number {
  return (
    (b.confirmed ? 0.25 : 0) +
    (b.classified ? 0.2 : 0) +
    (b.summary ? 0.1 : 0) +
    0.2 * Math.min(1, b.dialsKnown / 17) +
    (b.formats > 0 ? 0.1 : 0) +
    (b.embedding ? 0.05 : 0) +
    (b.seriesKnown ? 0.05 : 0) +
    (b.strongTags >= 5 ? 0.05 : 0)
  );
}

export async function collectMatrixInputs(db: Db, opts: BuildOptions = {}): Promise<MatrixBookInput[]> {
  const visible = opts.includeDrafts
    ? inArray(books.visibility, ["published", "draft"])
    : eq(books.visibility, "published");
  const rows: {
    id: string;
    slug: string;
    seriesId: string | null;
    seriesPosition: number | null;
    seriesStatus: string | null;
    harem: string;
    contentFlags: string[];
    isAiGenerated: string;
    inScope: string;
    crunchLevel: number | null;
    romanceLevel: number | null;
    firstPublished: string | null;
    confirmedAt: string | null;
    classifiedAt: string | null;
    summaryAi: string | null;
    primaryGenre: string | null;
  }[] = [];
  for (let cursor = ""; ; ) {
    const page = await db
      .select({
        id: books.id,
        slug: books.slug,
        seriesId: books.seriesId,
        seriesPosition: books.seriesPosition,
        seriesStatus: series.status,
        harem: books.harem,
        contentFlags: books.contentFlags,
        isAiGenerated: books.isAiGenerated,
        inScope: books.inScope,
        crunchLevel: books.crunchLevel,
        romanceLevel: books.romanceLevel,
        firstPublished: books.firstPublished,
        confirmedAt: books.confirmedAt,
        classifiedAt: books.classifiedAt,
        summaryAi: books.summaryAi,
        primaryGenre: books.primaryGenre,
      })
      .from(books)
      .leftJoin(series, eq(series.id, books.seriesId))
      .where(and(visible, isNull(books.redirectTo), ne(books.inScope, "no"), gt(books.id, cursor)))
      .orderBy(asc(books.id))
      .limit(PAGE);
    rows.push(...page);
    if (page.length < PAGE) break;
    cursor = page.at(-1)?.id ?? cursor;
  }
  const include = new Set(rows.map((r) => r.id));
  const authorsBy = new Map<string, { id: string; position: number }[]>();
  for (let a = "", b = ""; ; ) {
    const page = await db
      .select({ bookId: bookAuthors.bookId, authorId: bookAuthors.authorId, position: bookAuthors.position })
      .from(bookAuthors)
      .where(sql`(${bookAuthors.bookId}, ${bookAuthors.authorId}) > (${a}, ${b})`)
      .orderBy(asc(bookAuthors.bookId), asc(bookAuthors.authorId))
      .limit(PAGE * 2);
    for (const r of page) {
      if (!include.has(r.bookId)) continue;
      authorsBy.set(r.bookId, [...(authorsBy.get(r.bookId) ?? []), { id: r.authorId, position: r.position }]);
    }
    if (page.length < PAGE * 2) break;
    const last = page.at(-1);
    a = last?.bookId ?? a;
    b = last?.authorId ?? b;
  }
  const tagSlug = new Map(
    (await db.select({ id: tags.id, slug: tags.slug }).from(tags)).map((t) => [t.id, t.slug]),
  );
  const tagsBy = new Map<string, Record<string, number>>();
  for (let a = "", b = ""; ; ) {
    const page = await db
      .select({ bookId: bookTags.bookId, tagId: bookTags.tagId, score: bookTags.score })
      .from(bookTags)
      .where(sql`(${bookTags.bookId}, ${bookTags.tagId}) > (${a}, ${b})`)
      .orderBy(asc(bookTags.bookId), asc(bookTags.tagId))
      .limit(PAGE * 2);
    for (const r of page) {
      const slug = tagSlug.get(r.tagId);
      if (!include.has(r.bookId) || !slug || r.score < 0.2) continue;
      const m = tagsBy.get(r.bookId) ?? {};
      m[slug] = r.score;
      tagsBy.set(r.bookId, m);
    }
    if (page.length < PAGE * 2) break;
    const last = page.at(-1);
    a = last?.bookId ?? a;
    b = last?.tagId ?? b;
  }
  const scoresBy = new Map<string, { dials: MatrixBookInput["dials"]; stats: MatrixBookInput["stats"] }>();
  for (let a = "", b = ""; ; ) {
    const page = await db
      .select({
        bookId: bookScores.bookId,
        key: bookScores.key,
        kind: bookScores.kind,
        value: bookScores.value,
        confidence: bookScores.confidence,
        public: bookScores.public,
      })
      .from(bookScores)
      .where(sql`(${bookScores.bookId}, ${bookScores.key}) > (${a}, ${b})`)
      .orderBy(asc(bookScores.bookId), asc(bookScores.key))
      .limit(PAGE * 2);
    for (const r of page) {
      if (!include.has(r.bookId)) continue;
      const entry = scoresBy.get(r.bookId) ?? { dials: {}, stats: {} };
      if (r.kind === "dial") entry.dials[r.key] = { value: r.value, confidence: r.confidence };
      else entry.stats[r.key] = { value: r.value, confidence: r.confidence, public: r.public };
      scoresBy.set(r.bookId, entry);
    }
    if (page.length < PAGE * 2) break;
    const last = page.at(-1);
    a = last?.bookId ?? a;
    b = last?.key ?? b;
  }
  const formatsBy = new Map<string, { formats: Set<string>; ku: boolean }>();
  for (let cursor = ""; ; ) {
    const page = await db
      .select({
        id: editions.id,
        bookId: editions.bookId,
        format: editions.format,
        ku: editions.kindleUnlimited,
      })
      .from(editions)
      .where(gt(editions.id, cursor))
      .orderBy(asc(editions.id))
      .limit(PAGE);
    for (const r of page) {
      if (!include.has(r.bookId)) continue;
      const f = formatsBy.get(r.bookId) ?? { formats: new Set<string>(), ku: false };
      f.formats.add(r.format);
      f.ku ||= Boolean(r.ku);
      formatsBy.set(r.bookId, f);
    }
    if (page.length < PAGE) break;
    cursor = page.at(-1)?.id ?? cursor;
  }
  const embeddingsBy = new Map<string, Float32Array>();
  for (let cursor = ""; ; ) {
    // Vectors are ~4 KB each: smaller pages.
    const page = await db
      .select({ bookId: bookEmbeddings.bookId, vector: bookEmbeddings.vector })
      .from(bookEmbeddings)
      .where(gt(bookEmbeddings.bookId, cursor))
      .orderBy(asc(bookEmbeddings.bookId))
      .limit(250);
    for (const r of page) if (include.has(r.bookId)) embeddingsBy.set(r.bookId, decodeVector(r.vector));
    if (page.length < 250) break;
    cursor = page.at(-1)?.bookId ?? cursor;
  }

  return rows.map((r) => {
    const sc = scoresBy.get(r.id) ?? { dials: {}, stats: {} };
    // The primary genre counts as a certain genre tag, so filters and lists can use it.
    const tg = { ...(tagsBy.get(r.id) ?? {}) };
    if (r.primaryGenre) tg[r.primaryGenre] = Math.max(tg[r.primaryGenre] ?? 0, 1);
    const fm = formatsBy.get(r.id);
    const emb = embeddingsBy.get(r.id) ?? null;
    const year = r.firstPublished ? Number(r.firstPublished.slice(0, 4)) : null;
    return {
      id: r.id,
      slug: r.slug,
      seriesId: r.seriesId,
      seriesPosition: r.seriesPosition,
      seriesStatus: r.seriesId ? (r.seriesStatus ?? "unknown") : null,
      authorIds: (authorsBy.get(r.id) ?? []).sort((a, b) => a.position - b.position).map((a) => a.id),
      harem: r.harem,
      contentFlags: r.contentFlags ?? [],
      formats: [...(fm?.formats ?? [])],
      kindleUnlimited: fm?.ku ?? false,
      aiUse: r.isAiGenerated,
      inScope: r.inScope,
      crunchLevel: r.crunchLevel,
      romanceLevel: r.romanceLevel,
      year: year && Number.isFinite(year) ? year : null,
      quality: qualityPrior({
        confirmed: Boolean(r.confirmedAt),
        classified: Boolean(r.classifiedAt),
        summary: Boolean(r.summaryAi),
        dialsKnown: Object.values(sc.dials).filter((d) => d.value !== null).length,
        formats: fm?.formats.size ?? 0,
        embedding: emb !== null,
        seriesKnown: Boolean(r.seriesId && r.seriesStatus && r.seriesStatus !== "unknown"),
        strongTags: Object.values(tg).filter((s) => s >= 0.6).length,
      }),
      dials: sc.dials,
      stats: sc.stats,
      tags: tg,
      embedding: emb,
    };
  });
}

export async function buildMatrix(db: Db, opts: BuildOptions = {}): Promise<FeatureMatrix> {
  const inputs = await collectMatrixInputs(db, opts);
  const builtAt = (opts.now ?? new Date()).toISOString();
  // The version changes only when the content does, so rebuilding an unchanged catalog is a no-op.
  const digest = (
    await sha256Hex(
      JSON.stringify(
        inputs.map((b) => ({ ...b, embedding: b.embedding ? Array.from(b.embedding).slice(0, 8) : null })),
      ),
    )
  ).slice(0, 12);
  return assembleMatrix(inputs, `${inputs.length}-${digest}`, builtAt);
}

// ---------------------------------------------------------------------------------------------
// KV storage: the blob under its version, and a small pointer to the current one.

export const MODEL_POINTER_KEY = "match:model:current";
const modelKey = (version: string) => `match:model:v:${version}`;
const KEEP_VERSIONS = 3;

export interface ModelPointer {
  version: string;
  builtAt: string;
  n: number;
  bytes: number;
  previous: string[];
  /** Set by a rollback: scheduled builds leave the model alone until someone rebuilds by hand. */
  pinned?: boolean;
}

export async function readPointer(kv: KVNamespace): Promise<ModelPointer | null> {
  return kv.get<ModelPointer>(MODEL_POINTER_KEY, { type: "json", cacheTtl: 60 });
}

/**
 * Store a built matrix and point at it. Returns false when that version was already current, or
 * when a rollback pinned the model and this isn't a forced (hand-started) build.
 */
export async function storeMatrix(
  kv: KVNamespace,
  m: FeatureMatrix,
  opts: { force?: boolean } = {},
): Promise<{ stored: boolean; pointer: ModelPointer }> {
  const current = await kv.get<ModelPointer>(MODEL_POINTER_KEY, "json");
  if (current?.pinned && !opts.force) return { stored: false, pointer: current };
  if (current?.version === m.version) {
    if (current.pinned) await kv.put(MODEL_POINTER_KEY, JSON.stringify({ ...current, pinned: false }));
    return { stored: false, pointer: { ...current, pinned: false } };
  }
  const blob = encodeMatrix(m);
  await kv.put(modelKey(m.version), blob);
  const previous = current ? [current.version, ...current.previous].slice(0, KEEP_VERSIONS - 1) : [];
  const pointer: ModelPointer = {
    version: m.version,
    builtAt: m.builtAt,
    n: m.n,
    bytes: blob.byteLength,
    previous,
  };
  await kv.put(MODEL_POINTER_KEY, JSON.stringify(pointer));
  for (const old of current ? [current.version, ...current.previous].slice(KEEP_VERSIONS - 1) : []) {
    await kv.delete(modelKey(old));
  }
  return { stored: true, pointer };
}

/**
 * Roll back to the previous version (the console's undo for a bad build). The bad version is
 * dropped and the pointer pinned, so the next scheduled build doesn't put it straight back.
 */
export async function rollbackMatrix(kv: KVNamespace): Promise<ModelPointer | null> {
  const current = await kv.get<ModelPointer>(MODEL_POINTER_KEY, "json");
  const target = current?.previous[0];
  if (!current || !target) return null;
  const blob = await kv.get(modelKey(target), "arrayBuffer");
  if (!blob) return null;
  const m = decodeMatrix(blob);
  const pointer: ModelPointer = {
    version: m.version,
    builtAt: m.builtAt,
    n: m.n,
    bytes: blob.byteLength,
    previous: current.previous.slice(1),
    pinned: true,
  };
  await kv.put(MODEL_POINTER_KEY, JSON.stringify(pointer));
  await kv.delete(modelKey(current.version));
  return pointer;
}

// The web Worker keeps the current matrix in isolate memory and checks the pointer at most once
// a minute (KV's own read cache is 60 s too).
let cached: { version: string; matrix: FeatureMatrix; checkedAt: number } | null = null;

export async function loadMatrix(kv: KVNamespace, now = Date.now()): Promise<FeatureMatrix | null> {
  if (cached && now - cached.checkedAt < 60_000) return cached.matrix;
  const pointer = await readPointer(kv);
  if (!pointer) return cached?.matrix ?? null;
  if (cached?.version === pointer.version) {
    cached.checkedAt = now;
    return cached.matrix;
  }
  const blob = await kv.get(modelKey(pointer.version), { type: "arrayBuffer", cacheTtl: 3600 });
  if (!blob) return cached?.matrix ?? null;
  const matrix = decodeMatrix(blob);
  cached = { version: pointer.version, matrix, checkedAt: now };
  return matrix;
}

/** Tests, and the console right after it changes the model. */
export function resetMatrixCache() {
  cached = null;
}
