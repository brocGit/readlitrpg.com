// The media pipeline (DESIGN §15.7, §16.5). An image is checked and its original kept in the
// PRIVATE bucket; a job re-encodes it into WebP variants in MEDIA (which also strips EXIF and GPS),
// attaches covers to their book and queues the image for an editorial review. Readers only ever
// see the re-encoded variants.

import { and, asc, desc, eq, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { randomToken } from "../crypto";
import type { Db } from "../db";
import { books, catalogConfirmations, editions, MEDIA_SOURCES, type MediaSource, media } from "../db/schema";
import { enqueue } from "../editorial/queue";
import { ulid } from "../ids";
import type { Logger } from "../log";
import { SafeFetchError, safeFetchBytes } from "../net/safe-fetch";
import { nowIso } from "../time";
import { checkImage, FETCHED_COVER_RULES, type ImageRules, MediaError, sha256Hex } from "./image";
import { COVER_WIDTHS, variantKey } from "./variants";

/** Re-encode to WebP at a width (never upscaled). The Images binding in Workers; a stand-in in tests. */
export type Transformer = (bytes: Uint8Array, width: number) => Promise<Uint8Array>;

export interface MediaBuckets {
  private: R2Bucket;
  media: R2Bucket;
}

export interface NewImage {
  purpose: "cover" | "author_photo" | "blog" | "ad";
  source: MediaSource;
  subjectType?: "book";
  subjectId?: string;
  uploadedBy?: string | null;
}

/** Check an image and keep the original privately. Returns the media id; processing comes later. */
export async function acceptImage(
  db: Db,
  buckets: Pick<MediaBuckets, "private">,
  bytes: Uint8Array,
  meta: NewImage,
  rules: ImageRules,
): Promise<{ id: string; duplicate: boolean }> {
  const checked = checkImage(bytes, rules);
  const sha256 = await sha256Hex(bytes);
  const [same] = await db
    .select({ id: media.id })
    .from(media)
    .where(
      and(
        eq(media.sha256, sha256),
        ne(media.status, "rejected"),
        meta.subjectId ? eq(media.subjectId, meta.subjectId) : isNull(media.subjectId),
      ),
    )
    .limit(1);
  if (same) return { id: same.id, duplicate: true };
  const id = ulid();
  const key = `uploads/${id}`;
  await buckets.private.put(key, bytes, { httpMetadata: { contentType: checked.mime } });
  await db.insert(media).values({
    id,
    bucket: "private",
    key,
    originalKey: key,
    mime: checked.mime,
    bytes: checked.bytes,
    width: checked.width,
    height: checked.height,
    sha256,
    uploadedBy: meta.uploadedBy ?? null,
    purpose: meta.purpose,
    source: meta.source,
    subjectType: meta.subjectType ?? null,
    subjectId: meta.subjectId ?? null,
    status: "pending",
  });
  return { id, duplicate: false };
}

const rank = (source: string | null) => MEDIA_SOURCES.indexOf((source ?? "openlibrary") as MediaSource);

/** A new cover replaces the current one unless the current one came from a stronger source. */
async function attachCover(db: Db, bookId: string, mediaId: string, source: MediaSource, now: string) {
  const [book] = await db
    .select({ cover: books.coverMediaId, currentSource: media.source })
    .from(books)
    .leftJoin(media, eq(media.id, books.coverMediaId))
    .where(eq(books.id, bookId));
  if (!book) return false;
  if (book.cover && rank(book.currentSource) > rank(source)) return false;
  await db.update(books).set({ coverMediaId: mediaId, updatedAt: now }).where(eq(books.id, bookId));
  return true;
}

export interface ProcessDeps {
  transform: Transformer;
  /** Where readers (and the image review run) see MEDIA, e.g. https://media.readlitrpg.com */
  mediaOrigin: string;
  reviewPriority?: number;
  log?: Logger;
  now?: Date;
}

/** Turn pending originals into public variants. Returns how many images were handled. */
export async function processPendingMedia(
  db: Db,
  buckets: MediaBuckets,
  deps: ProcessDeps,
  limit = 5,
): Promise<number> {
  const pending = await db
    .select()
    .from(media)
    .where(and(isNull(media.processedAt), eq(media.status, "pending"), eq(media.bucket, "private")))
    .orderBy(asc(media.createdAt))
    .limit(limit);
  for (const row of pending) {
    const now = nowIso(deps.now);
    try {
      const original = await buckets.private.get(row.originalKey ?? row.key);
      if (!original) throw new MediaError("the original is missing");
      const bytes = new Uint8Array(await original.arrayBuffer());
      const prefix = `${row.purpose === "cover" ? "covers" : row.purpose}/${randomToken(12)}`;
      for (const width of COVER_WIDTHS) {
        const out = await deps.transform(bytes, width);
        await buckets.media.put(variantKey(prefix, width), out, {
          httpMetadata: { contentType: "image/webp", cacheControl: "public, max-age=31536000, immutable" },
        });
      }
      await db
        .update(media)
        .set({ bucket: "media", key: prefix, status: "approved", processedAt: now, error: null })
        .where(eq(media.id, row.id));
      if (row.purpose === "cover" && row.subjectType === "book" && row.subjectId) {
        await attachCover(db, row.subjectId, row.id, row.source, now);
      }
      // Shown now, reviewed next run (DESIGN §15.7: trusted sources show immediately).
      await enqueue(db, [
        {
          kind: "image_review",
          subjectType: "media",
          subjectId: row.id,
          priority: deps.reviewPriority ?? 80,
          payload: {
            url: `${deps.mediaOrigin.replace(/\/$/, "")}/${variantKey(prefix, 640)}`,
            purpose: row.purpose,
            source: row.source,
            subject: row.subjectType && row.subjectId ? { type: row.subjectType, id: row.subjectId } : null,
          },
        },
      ]);
    } catch (error) {
      deps.log?.warn("media.process_failed", { id: row.id, error });
      await db
        .update(media)
        .set({
          status: "rejected",
          processedAt: now,
          error: String(error instanceof Error ? error.message : error).slice(0, 300),
        })
        .where(eq(media.id, row.id));
    }
  }
  return pending.length;
}

/** An image review run blocked it: hide it everywhere it's used (DESIGN §15.7). */
export async function rejectMedia(db: Db, mediaId: string): Promise<void> {
  await db.update(media).set({ status: "rejected" }).where(eq(media.id, mediaId));
  await db
    .update(books)
    .set({ coverMediaId: null, updatedAt: nowIso() })
    .where(eq(books.coverMediaId, mediaId));
}

// ---------------------------------------------------------------------------------------------
// Covers from Open Library (DESIGN §16.5: a licensed source, per its terms). Books without a cover
// are tried by the cover id Open Library gave us, then by ISBN, and not again for `retryDays`.

export interface CoverDeps {
  fetch?: typeof fetch;
  pause?: (ms: number) => Promise<void>;
  log?: Logger;
  now?: Date;
  retryDays?: number;
}

const COVER_HOSTS = ["covers.openlibrary.org", "archive.org"];

export async function fetchOpenLibraryCovers(
  db: Db,
  buckets: Pick<MediaBuckets, "private">,
  deps: CoverDeps,
  limit = 10,
): Promise<{ checked: number; found: number }> {
  const now = deps.now ?? new Date();
  const cutoff = new Date(now.getTime() - (deps.retryDays ?? 30) * 86_400_000).toISOString();
  const candidates = await db
    .select({ id: books.id })
    .from(books)
    .where(
      and(
        isNull(books.coverMediaId),
        isNull(books.redirectTo),
        inArray(books.visibility, ["published", "draft"]),
        ne(books.inScope, "no"),
        or(isNull(books.coverCheckedAt), lt(books.coverCheckedAt, cutoff)),
      ),
    )
    // Published books first: they're the ones readers see.
    .orderBy(desc(books.visibility), asc(books.coverCheckedAt), asc(books.id))
    .limit(limit);
  let found = 0;
  for (const { id } of candidates) {
    const [isbns, confirmations] = await Promise.all([
      db.select({ isbn: editions.isbn13 }).from(editions).where(eq(editions.bookId, id)),
      db
        .select({ evidence: catalogConfirmations.evidence })
        .from(catalogConfirmations)
        .where(
          and(
            eq(catalogConfirmations.subjectType, "book"),
            eq(catalogConfirmations.subjectId, id),
            eq(catalogConfirmations.source, "openlibrary"),
          ),
        ),
    ]);
    const coverIds = confirmations
      .map((c) => (c.evidence as { coverId?: unknown } | null)?.coverId)
      .filter((v): v is number => typeof v === "number" && Number.isInteger(v) && v > 0);
    const urls = [
      ...coverIds.map((c) => `https://covers.openlibrary.org/b/id/${c}-L.jpg`),
      ...isbns
        .map((e) => e.isbn)
        .filter((i): i is string => Boolean(i && /^97[89]\d{10}$/.test(i)))
        .slice(0, 2)
        .map((i) => `https://covers.openlibrary.org/b/isbn/${i}-L.jpg?default=false`),
    ];
    for (const url of urls) {
      try {
        const res = await safeFetchBytes(url, {
          allowHosts: COVER_HOSTS,
          maxBytes: FETCHED_COVER_RULES.maxBytes,
          timeoutMs: 8_000,
          fetch: deps.fetch,
        });
        if (res.status !== 200) continue;
        await acceptImage(
          db,
          buckets,
          res.bytes,
          { purpose: "cover", source: "openlibrary", subjectType: "book", subjectId: id },
          FETCHED_COVER_RULES,
        );
        found++;
        break;
      } catch (error) {
        // Placeholders (Open Library's 1×1 "no cover") and odd shapes fail the check: try the next.
        if (!(error instanceof MediaError || error instanceof SafeFetchError)) throw error;
        deps.log?.info("media.cover_skipped", { book: id, url, reason: error.message });
      } finally {
        await deps.pause?.(1_000);
      }
    }
    await db
      .update(books)
      .set({ coverCheckedAt: nowIso(now) })
      .where(eq(books.id, id));
  }
  return { checked: candidates.length, found };
}
