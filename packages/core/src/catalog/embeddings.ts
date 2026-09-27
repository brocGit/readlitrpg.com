// Book embeddings (DESIGN §7.2): the one model the site runs, Workers AI bge-base-en-v1.5 (768-d).
// The jobs Worker calls the Workers AI REST endpoint with its scoped Cloudflare API token rather
// than an `ai` binding: a binding makes every local `wrangler dev` (and CI) log in to Cloudflare.
// Vectors live in D1 and neighbors are found by brute force, which is fast enough for tens of
// thousands of books; Vectorize is the upgrade path after that.

import { and, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { sha256Hex } from "../crypto";
import type { Db } from "../db";
import { authors, bookAuthors, bookEmbeddings, books, bookTags, series, tags } from "../db/schema";
import { openInboxItem } from "../inbox";
import { SafeFetchError, safeFetch } from "../net/safe-fetch";
import { nowIso } from "../time";

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBED_DIMS = 768;

/** Turns texts into vectors. Injected, so tests and local runs don't need Cloudflare. */
export type Embedder = (texts: string[]) => Promise<number[][]>;

export function workersAiEmbedder(opts: {
  accountId: string;
  token: string;
  fetch?: typeof fetch;
}): Embedder {
  if (!/^[0-9a-f]{32}$/.test(opts.accountId)) throw new Error("CF_ACCOUNT_ID must be a 32-character hex id");
  return async (texts) => {
    const response = await safeFetch(
      `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/ai/run/${EMBED_MODEL}`,
      {
        allowHosts: ["api.cloudflare.com"],
        method: "POST",
        body: JSON.stringify({ text: texts }),
        headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
        timeoutMs: 20_000,
        maxBytes: 8_000_000,
        fetch: opts.fetch,
      },
    );
    if (response.status !== 200)
      throw new SafeFetchError("network", `Workers AI answered ${response.status}`);
    const body = JSON.parse(response.text) as { result?: { data?: number[][] } };
    const data = body.result?.data;
    if (!Array.isArray(data) || data.length !== texts.length || data.some((v) => v.length !== EMBED_DIMS)) {
      throw new Error("Workers AI returned an unexpected shape");
    }
    return data;
  };
}

export function encodeVector(v: number[]): string {
  const bytes = new Uint8Array(new Float32Array(v).buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function decodeVector(s: string): Float32Array {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface EmbeddingSource {
  title: string;
  subtitle?: string | null;
  seriesName?: string | null;
  seriesPosition?: number | null;
  authorNames: string[];
  primaryGenre?: string | null;
  tagNames: string[];
  summary?: string | null;
}

/** What we embed: our own words and the taxonomy, never a copied blurb. */
export function embeddingText(b: EmbeddingSource): string {
  const parts = [
    b.subtitle ? `${b.title}: ${b.subtitle}` : b.title,
    b.seriesName ? `${b.seriesName}${b.seriesPosition ? ` book ${b.seriesPosition}` : ""}` : "",
    b.authorNames.length ? `by ${b.authorNames.join(", ")}` : "",
    b.primaryGenre ? `Genre: ${b.primaryGenre.replace(/-/g, " ")}` : "",
    b.tagNames.length ? `Tags: ${b.tagNames.join(", ")}` : "",
    b.summary ?? "",
  ];
  return parts.filter(Boolean).join(". ").slice(0, 2000);
}

/** Books with no embedding, or changed since theirs was made. */
export async function booksToEmbed(db: Db, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: books.id })
    .from(books)
    .leftJoin(bookEmbeddings, eq(bookEmbeddings.bookId, books.id))
    .where(
      and(
        isNull(books.redirectTo),
        ne(books.visibility, "removed"),
        or(isNull(bookEmbeddings.bookId), lt(bookEmbeddings.updatedAt, books.updatedAt)),
      ),
    )
    .orderBy(books.updatedAt)
    .limit(limit);
  return rows.map((r) => r.id);
}

async function embeddingSources(db: Db, ids: string[]): Promise<Map<string, EmbeddingSource>> {
  const out = new Map<string, EmbeddingSource>();
  if (ids.length === 0) return out;
  const bookRows = await db
    .select({
      id: books.id,
      title: books.title,
      subtitle: books.subtitle,
      seriesName: series.name,
      seriesPosition: books.seriesPosition,
      primaryGenre: books.primaryGenre,
      summary: books.summaryAi,
    })
    .from(books)
    .leftJoin(series, eq(series.id, books.seriesId))
    .where(inArray(books.id, ids));
  for (const b of bookRows) out.set(b.id, { ...b, authorNames: [], tagNames: [] });
  const authorRows = await db
    .select({ bookId: bookAuthors.bookId, name: authors.name })
    .from(bookAuthors)
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(inArray(bookAuthors.bookId, ids))
    .orderBy(bookAuthors.position);
  for (const a of authorRows) out.get(a.bookId)?.authorNames.push(a.name);
  const tagRows = await db
    .select({ bookId: bookTags.bookId, name: tags.name })
    .from(bookTags)
    .innerJoin(tags, eq(tags.id, bookTags.tagId))
    .where(and(inArray(bookTags.bookId, ids), sql`${bookTags.score} >= 0.6`))
    .orderBy(sql`${bookTags.score} desc`);
  for (const t of tagRows) out.get(t.bookId)?.tagNames.push(t.name);
  return out;
}

/** Embed up to `ids.length` books (callers keep it ≤ 90). Returns the ids whose vector changed. */
export async function embedBooks(db: Db, ids: string[], embedder: Embedder): Promise<string[]> {
  const sources = await embeddingSources(db, ids);
  const existing = ids.length
    ? await db
        .select({ bookId: bookEmbeddings.bookId, textHash: bookEmbeddings.textHash })
        .from(bookEmbeddings)
        .where(inArray(bookEmbeddings.bookId, ids))
    : [];
  const hashes = new Map(existing.map((e) => [e.bookId, e.textHash]));
  const now = nowIso();
  const todo: { id: string; text: string; hash: string }[] = [];
  const touch: string[] = [];
  for (const id of ids) {
    const src = sources.get(id);
    if (!src) continue;
    const text = embeddingText(src);
    const hash = await sha256Hex(`${EMBED_MODEL}\n${text}`);
    if (hashes.get(id) === hash) touch.push(id);
    else todo.push({ id, text, hash });
  }
  if (touch.length) {
    await db.update(bookEmbeddings).set({ updatedAt: now }).where(inArray(bookEmbeddings.bookId, touch));
  }
  if (todo.length === 0) return [];
  const vectors = await embedder(todo.map((t) => t.text));
  const statements = todo.map((t, i) => {
    const values = {
      bookId: t.id,
      model: EMBED_MODEL,
      dims: EMBED_DIMS,
      vector: encodeVector(vectors[i] ?? []),
      textHash: t.hash,
      updatedAt: now,
    };
    return db
      .insert(bookEmbeddings)
      .values(values)
      .onConflictDoUpdate({
        target: bookEmbeddings.bookId,
        set: {
          model: values.model,
          dims: values.dims,
          vector: values.vector,
          textHash: values.textHash,
          updatedAt: now,
        },
      });
  });
  await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
  return todo.map((t) => t.id);
}

/**
 * Embedding-based duplicate check (DESIGN §7.4 tier 3): a changed book against the other books
 * that share an author. Near-identical vectors open a "Possible duplicate" inbox item.
 */
export async function embeddingDuplicates(db: Db, bookIds: string[], threshold: number): Promise<number> {
  let opened = 0;
  for (const bookId of bookIds) {
    const [mine] = await db.select().from(bookEmbeddings).where(eq(bookEmbeddings.bookId, bookId));
    if (!mine) continue;
    const authorIds = (
      await db.select({ id: bookAuthors.authorId }).from(bookAuthors).where(eq(bookAuthors.bookId, bookId))
    ).map((r) => r.id);
    if (authorIds.length === 0) continue;
    const others = await db
      .select({
        id: books.id,
        title: books.title,
        seriesId: books.seriesId,
        seriesPosition: books.seriesPosition,
        vector: bookEmbeddings.vector,
      })
      .from(bookAuthors)
      .innerJoin(books, eq(books.id, bookAuthors.bookId))
      .innerJoin(bookEmbeddings, eq(bookEmbeddings.bookId, books.id))
      .where(
        and(
          inArray(bookAuthors.authorId, authorIds),
          ne(books.id, bookId),
          isNull(books.redirectTo),
          ne(books.visibility, "removed"),
        ),
      )
      .limit(500);
    const v = decodeVector(mine.vector);
    const [self] = await db
      .select({ title: books.title, seriesId: books.seriesId, seriesPosition: books.seriesPosition })
      .from(books)
      .where(eq(books.id, bookId));
    const seen = new Set<string>();
    for (const o of others) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      // Volumes of one series share most of their embedding text, so two placed volumes are only
      // compared when they claim the same place in the same series.
      const bothPlaced = self?.seriesPosition != null && o.seriesPosition != null;
      if (bothPlaced && (self?.seriesId !== o.seriesId || self?.seriesPosition !== o.seriesPosition))
        continue;
      const similarity = cosine(v, decodeVector(o.vector));
      if (similarity < threshold) continue;
      const pair = [bookId, o.id].sort().join(":");
      const item = await openInboxItem(db, {
        type: "possible_duplicate",
        title: `Possible duplicate: "${self?.title ?? bookId}" and "${o.title}"`,
        subjectType: "book",
        subjectId: bookId,
        priority: 40,
        payload: {
          bookId,
          otherId: o.id,
          similarity: Math.round(similarity * 1000) / 1000,
          reason: "embedding",
        },
        dedupeKey: `dup:${pair}`,
      });
      if (item) opened++;
    }
  }
  return opened;
}
