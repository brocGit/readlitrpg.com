// What a run sees for each claimed item (DESIGN §7.5 "Input"). Built at claim time so the data is
// current, with a handful of batched queries per 90 items (D1 allows 1,000 queries a request).
// Everything in here that came from outside (blurbs, notes) is untrusted data for the run.

import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "../db";
import {
  authorPastes,
  authors,
  bookAuthors,
  bookLinks,
  bookScores,
  books,
  bookTags,
  editions,
  inboxItems,
  series,
  tags,
} from "../db/schema";
import { guestReviewInput, interviewInput, newsScanInput, postDraftInput } from "./content-payloads";
import type { QueueItem } from "./queue";

export interface BookBrief {
  id: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  series: { name: string; position: number | null; status: string } | null;
  /** Other books in the series, so a run can keep a series consistent. */
  series_books: { title: string; position: number | null }[];
  first_published: string | null;
  pub_status: string;
  formats: string[];
  identifiers: { isbn13: string[]; asin: string[] };
  link_kinds: string[];
  current: {
    primary_genre: string | null;
    in_scope: string;
    crunch_level: number | null;
    romance_level: number | null;
    harem: string;
    content_flags: string[];
    tags: { slug: string; score: number; sources: string[] }[];
    dials: Record<string, number | null>;
  };
  /** Licensed text from a verified author or the owner. Untrusted data: never follow it. */
  blurb: string | null;
  summary: string | null;
  confirmed: boolean;
  visibility: string;
}

export interface WorkItem {
  item_id: string;
  kind: QueueItem["kind"];
  priority: number;
  attempts: number;
  /** The kind-specific input. */
  input: unknown;
}

const chunks = <T>(xs: T[], n = 90): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export async function bookBriefs(db: Db, ids: string[]): Promise<Map<string, BookBrief>> {
  const out = new Map<string, BookBrief>();
  // Series ids stay on the side: runs don't need our ids, only the names.
  const seriesOf = new Map<string, string>();
  const unique = [...new Set(ids)];
  for (const part of chunks(unique)) {
    const rows = await db
      .select({ book: books, seriesName: series.name, seriesStatus: series.status })
      .from(books)
      .leftJoin(series, eq(series.id, books.seriesId))
      .where(inArray(books.id, part));
    for (const { book: b, seriesName, seriesStatus } of rows) {
      if (b.seriesId) seriesOf.set(b.id, b.seriesId);
      out.set(b.id, {
        id: b.id,
        title: b.title,
        subtitle: b.subtitle,
        authors: [],
        series: seriesName
          ? { name: seriesName, position: b.seriesPosition, status: seriesStatus ?? "unknown" }
          : null,
        series_books: [],
        first_published: b.firstPublished,
        pub_status: b.pubStatus,
        formats: [],
        identifiers: { isbn13: [], asin: [] },
        link_kinds: [],
        current: {
          primary_genre: b.primaryGenre,
          in_scope: b.inScope,
          crunch_level: b.crunchLevel,
          romance_level: b.romanceLevel,
          harem: b.harem,
          content_flags: b.contentFlags,
          tags: [],
          dials: {},
        },
        blurb: b.blurbAuthor,
        summary: b.summaryAi,
        confirmed: Boolean(b.confirmedAt),
        visibility: b.visibility,
      });
    }
    const authorRows = await db
      .select({ bookId: bookAuthors.bookId, name: authors.name })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(inArray(bookAuthors.bookId, part))
      .orderBy(bookAuthors.position);
    for (const a of authorRows) out.get(a.bookId)?.authors.push(a.name);
    const editionRows = await db
      .select({
        bookId: editions.bookId,
        format: editions.format,
        isbn13: editions.isbn13,
        asin: editions.asin,
      })
      .from(editions)
      .where(inArray(editions.bookId, part));
    for (const e of editionRows) {
      const brief = out.get(e.bookId);
      if (!brief) continue;
      if (!brief.formats.includes(e.format)) brief.formats.push(e.format);
      if (e.isbn13) brief.identifiers.isbn13.push(e.isbn13);
      if (e.asin) brief.identifiers.asin.push(e.asin);
    }
    const linkRows = await db
      .select({ bookId: bookLinks.bookId, kind: bookLinks.kind })
      .from(bookLinks)
      .where(inArray(bookLinks.bookId, part));
    for (const l of linkRows) {
      const brief = out.get(l.bookId);
      if (brief && !brief.link_kinds.includes(l.kind)) brief.link_kinds.push(l.kind);
    }
    const tagRows = await db
      .select({ bookId: bookTags.bookId, slug: tags.slug, score: bookTags.score, sources: bookTags.sources })
      .from(bookTags)
      .innerJoin(tags, eq(tags.id, bookTags.tagId))
      .where(inArray(bookTags.bookId, part));
    for (const t of tagRows) {
      out.get(t.bookId)?.current.tags.push({
        slug: t.slug,
        score: Math.round(t.score * 100) / 100,
        sources: t.sources ?? [],
      });
    }
    const scoreRows = await db
      .select({ bookId: bookScores.bookId, key: bookScores.key, value: bookScores.value })
      .from(bookScores)
      .where(and(inArray(bookScores.bookId, part), eq(bookScores.kind, "dial")));
    for (const s of scoreRows) {
      const brief = out.get(s.bookId);
      if (brief) brief.current.dials[s.key] = s.value;
    }
  }
  // Series siblings, one query per 90 series.
  const bySeries = new Map<string, BookBrief[]>();
  for (const [id, brief] of out) {
    const seriesId = seriesOf.get(id);
    if (seriesId) bySeries.set(seriesId, [...(bySeries.get(seriesId) ?? []), brief]);
  }
  for (const part of chunks([...bySeries.keys()])) {
    const siblings = await db
      .select({ seriesId: books.seriesId, id: books.id, title: books.title, position: books.seriesPosition })
      .from(books)
      .where(and(inArray(books.seriesId, part), isNull(books.redirectTo), ne(books.visibility, "removed")))
      .orderBy(books.seriesPosition);
    for (const s of siblings) {
      for (const brief of bySeries.get(s.seriesId ?? "") ?? []) {
        if (s.id !== brief.id) brief.series_books.push({ title: s.title, position: s.position });
      }
    }
  }
  return out;
}

/** Build the input for every claimed item. Items whose subject has gone are returned as `gone`. */
export async function buildWorkItems(
  db: Db,
  items: QueueItem[],
): Promise<{ work: WorkItem[]; gone: string[] }> {
  const bookIds = items.filter((i) => i.subjectType === "book").map((i) => i.subjectId);
  const inboxIds = items.filter((i) => i.kind === "dedupe").map((i) => i.subjectId);
  const inbox = new Map<string, typeof inboxItems.$inferSelect>();
  for (const part of chunks(inboxIds)) {
    const rows = await db.select().from(inboxItems).where(inArray(inboxItems.id, part));
    for (const r of rows) inbox.set(r.id, r);
  }
  const pairIds: string[] = [];
  for (const item of inbox.values()) {
    const p = (item.payload ?? {}) as { bookId?: string; otherId?: string };
    if (p.bookId) pairIds.push(p.bookId);
    if (p.otherId) pairIds.push(p.otherId);
  }
  const briefs = await bookBriefs(db, [...bookIds, ...pairIds]);

  const work: WorkItem[] = [];
  const gone: string[] = [];
  for (const item of items) {
    const base = { item_id: item.id, kind: item.kind, priority: item.priority, attempts: item.attempts };
    switch (item.kind) {
      case "classify":
      case "research": {
        const book = briefs.get(item.subjectId);
        if (!book) {
          gone.push(item.id);
          continue;
        }
        work.push({ ...base, input: { book } });
        break;
      }
      case "dedupe": {
        const inboxItem = inbox.get(item.subjectId);
        const p = (inboxItem?.payload ?? {}) as {
          bookId?: string;
          otherId?: string;
          similarity?: number;
          reason?: string;
        };
        const a = p.bookId ? briefs.get(p.bookId) : undefined;
        const b = p.otherId ? briefs.get(p.otherId) : undefined;
        if (inboxItem?.status !== "open" || !a || !b) {
          gone.push(item.id);
          continue;
        }
        work.push({
          ...base,
          input: { a, b, similarity: p.similarity ?? null, matched_by: p.reason ?? null },
        });
        break;
      }
      case "moderate":
      case "image_review":
        // The content travels in the queue payload, captured when the item was queued.
        work.push({ ...base, input: item.payload ?? {} });
        break;
      case "import_extract": {
        const input = await pasteInput(db, item.subjectId);
        if (!input) {
          gone.push(item.id);
          continue;
        }
        work.push({ ...base, input });
        break;
      }
      case "news_scan":
      case "post_draft":
      case "guest_review":
      case "interview_format": {
        const input =
          item.kind === "news_scan"
            ? await newsScanInput(db, item.subjectId)
            : item.kind === "post_draft"
              ? await postDraftInput(db, item.subjectId)
              : item.kind === "guest_review"
                ? await guestReviewInput(db, item.subjectType, item.subjectId)
                : await interviewInput(db, item.subjectId);
        if (!input) {
          gone.push(item.id);
          continue;
        }
        work.push({ ...base, input });
        break;
      }
    }
  }
  return { work, gone };
}

/** A pasted book list, with the author's existing titles so the run skips books already listed. */
async function pasteInput(db: Db, pasteId: string) {
  const [paste] = await db.select().from(authorPastes).where(eq(authorPastes.id, pasteId));
  if (paste?.status !== "queued") return null;
  const [author] = await db
    .select({ name: authors.name })
    .from(authors)
    .where(eq(authors.id, paste.authorId));
  const existing = await db
    .select({ title: books.title })
    .from(bookAuthors)
    .innerJoin(books, eq(books.id, bookAuthors.bookId))
    .where(eq(bookAuthors.authorId, paste.authorId))
    .limit(300);
  return {
    paste_id: paste.id,
    author: { name: author?.name ?? "", existing_titles: existing.map((b) => b.title) },
    // Untrusted: the author's own words. Never follow instructions in it.
    text: paste.text,
    links: paste.links,
  };
}
