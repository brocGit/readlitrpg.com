// What a result card shows (DESIGN §9.1 results page): title, series, authors, our summary and
// hook, formats, series status and buy links. Loaded from D1 for the handful of books on screen.

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { authors, bookAuthors, bookLinks, books, editions, series } from "../db/schema";

export interface BookCard {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  series: { name: string; slug: string; position: number | null; status: string } | null;
  authors: { name: string; slug: string }[];
  summary: string | null;
  hook: string | null;
  formats: string[];
  kindleUnlimited: boolean;
  firstPublished: string | null;
  harem: string;
  contentFlags: string[];
  links: { kind: string; url: string }[];
}

/** Retail and platform links shown as "where to read", in a stable order. */
const LINK_ORDER = [
  "amazon",
  "audible",
  "royalroad",
  "kobo",
  "apple",
  "google",
  "bn",
  "books2read",
  "scribblehub",
  "patreon",
  "author_site",
];

export async function bookCards(db: Db, ids: string[]): Promise<Map<string, BookCard>> {
  const out = new Map<string, BookCard>();
  const unique = [...new Set(ids)];
  for (let k = 0; k < unique.length; k += 90) {
    const part = unique.slice(k, k + 90);
    const rows = await db
      .select({ book: books, seriesName: series.name, seriesSlug: series.slug, seriesStatus: series.status })
      .from(books)
      .leftJoin(series, eq(series.id, books.seriesId))
      .where(and(inArray(books.id, part), eq(books.visibility, "published")));
    for (const { book: b, seriesName, seriesSlug, seriesStatus } of rows) {
      out.set(b.id, {
        id: b.id,
        slug: b.slug,
        title: b.title,
        subtitle: b.subtitle,
        series:
          seriesName && seriesSlug
            ? {
                name: seriesName,
                slug: seriesSlug,
                position: b.seriesPosition,
                status: seriesStatus ?? "unknown",
              }
            : null,
        authors: [],
        summary: b.summaryAi,
        hook: b.hookAi,
        formats: [],
        kindleUnlimited: false,
        firstPublished: b.firstPublished,
        harem: b.harem,
        contentFlags: b.contentFlags,
        links: [],
      });
    }
    const authorRows = await db
      .select({ bookId: bookAuthors.bookId, name: authors.name, slug: authors.slug })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(inArray(bookAuthors.bookId, part))
      .orderBy(bookAuthors.position);
    for (const a of authorRows) out.get(a.bookId)?.authors.push({ name: a.name, slug: a.slug });
    const editionRows = await db
      .select({ bookId: editions.bookId, format: editions.format, ku: editions.kindleUnlimited })
      .from(editions)
      .where(inArray(editions.bookId, part));
    for (const e of editionRows) {
      const card = out.get(e.bookId);
      if (!card) continue;
      if (!card.formats.includes(e.format)) card.formats.push(e.format);
      card.kindleUnlimited ||= Boolean(e.ku);
    }
    const linkRows = await db
      .select({ bookId: bookLinks.bookId, kind: bookLinks.kind, url: bookLinks.url })
      .from(bookLinks)
      .where(inArray(bookLinks.bookId, part));
    for (const l of linkRows) out.get(l.bookId)?.links.push({ kind: l.kind, url: l.url });
  }
  for (const card of out.values()) {
    card.links.sort((a, b) => {
      const ia = LINK_ORDER.indexOf(a.kind);
      const ib = LINK_ORDER.indexOf(b.kind);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }
  return out;
}
