// Enrichment (DESIGN §7.3 step 3, §7.15 sources 2–3). Looks books up in Open Library and Google
// Books. A match (same author, same title) confirms the record for the publication gate and adds
// facts the APIs know (page count, first publication date) as `api`-sourced values.

import { and, asc, eq, inArray, isNull, lt, ne, or } from "drizzle-orm";
import type { Db } from "../db";
import { authors, bookAuthors, books, editions } from "../db/schema";
import type { Logger } from "../log";
import { SafeFetchError, safeFetch } from "../net/safe-fetch";
import { nowIso } from "../time";
import { addConfirmation } from "./confirm";
import { writeBookFields } from "./fields";
import {
  extractVolume,
  nameKey,
  type PreciseDate,
  parseDate,
  titleKey,
  trigramSimilarity,
} from "./normalize";

export interface Candidate {
  source: "openlibrary" | "google_books";
  ref: string;
  title: string;
  authors: string[];
  pageCount: number | null;
  published: PreciseDate | null;
  isbns: string[];
}

export interface EnrichDeps {
  fetch?: typeof fetch;
  googleBooksKey?: string;
  log?: Logger;
}

// ---------------------------------------------------------------------------------------------
// Open Library search API (https://openlibrary.org/dev/docs/api/search)

interface OpenLibraryDoc {
  key?: string;
  title?: string;
  subtitle?: string;
  author_name?: string[];
  first_publish_year?: number;
  isbn?: string[];
  number_of_pages_median?: number;
}

export async function searchOpenLibrary(
  query: { title: string; author: string } | { isbn: string },
  deps: EnrichDeps,
): Promise<Candidate[]> {
  const params = new URLSearchParams({
    fields: "key,title,subtitle,author_name,first_publish_year,isbn,number_of_pages_median",
    limit: "5",
  });
  if ("isbn" in query) params.set("isbn", query.isbn);
  else {
    params.set("title", query.title);
    params.set("author", query.author);
  }
  const res = await safeFetch(`https://openlibrary.org/search.json?${params}`, {
    allowHosts: ["openlibrary.org"],
    fetch: deps.fetch,
  });
  if (res.status !== 200) throw new SafeFetchError("network", `Open Library answered ${res.status}`);
  const json = JSON.parse(res.text) as { docs?: OpenLibraryDoc[] };
  return (json.docs ?? [])
    .filter((d) => d.key && d.title)
    .map((d) => ({
      source: "openlibrary" as const,
      ref: d.key ?? "",
      title: d.title ?? "",
      authors: d.author_name ?? [],
      pageCount: d.number_of_pages_median ?? null,
      published: d.first_publish_year
        ? { date: `${d.first_publish_year}-01-01`, precision: "year" as const }
        : null,
      isbns: (d.isbn ?? []).filter((i) => /^97[89]\d{10}$/.test(i)).slice(0, 10),
    }));
}

// ---------------------------------------------------------------------------------------------
// Google Books API (https://developers.google.com/books/docs/v1/using)

interface GoogleVolume {
  id?: string;
  volumeInfo?: {
    title?: string;
    authors?: string[];
    publishedDate?: string;
    pageCount?: number;
    industryIdentifiers?: { type?: string; identifier?: string }[];
  };
}

export async function searchGoogleBooks(
  query: { title: string; author: string } | { isbn: string },
  deps: EnrichDeps,
): Promise<Candidate[]> {
  const q = "isbn" in query ? `isbn:${query.isbn}` : `intitle:"${query.title}" inauthor:"${query.author}"`;
  const params = new URLSearchParams({ q, maxResults: "5", printType: "books" });
  if (deps.googleBooksKey) params.set("key", deps.googleBooksKey);
  const res = await safeFetch(`https://www.googleapis.com/books/v1/volumes?${params}`, {
    allowHosts: ["www.googleapis.com"],
    fetch: deps.fetch,
  });
  if (res.status !== 200) throw new SafeFetchError("network", `Google Books answered ${res.status}`);
  const json = JSON.parse(res.text) as { items?: GoogleVolume[] };
  return (json.items ?? [])
    .filter((v) => v.id && v.volumeInfo?.title)
    .map((v) => {
      const info = v.volumeInfo ?? {};
      return {
        source: "google_books" as const,
        ref: v.id ?? "",
        title: info.title ?? "",
        authors: info.authors ?? [],
        pageCount: info.pageCount && info.pageCount > 0 ? info.pageCount : null,
        published: info.publishedDate ? parseDate(info.publishedDate) : null,
        isbns: (info.industryIdentifiers ?? [])
          .filter((i) => i.type === "ISBN_13" && i.identifier)
          .map((i) => i.identifier ?? ""),
      };
    });
}

// ---------------------------------------------------------------------------------------------
// Matching

export interface BookFacts {
  title: string;
  authorNames: string[];
  isbns: string[];
}

/** The candidate that is this book: an author in common, and the same title (or ISBN). */
export function pickMatch(book: BookFacts, candidates: Candidate[]): Candidate | null {
  const ourAuthors = new Set(book.authorNames.map(nameKey));
  const ourKey = titleKey(book.title);
  const ourVolume = extractVolume(book.title) ?? 1;
  let best: { c: Candidate; score: number } | null = null;
  for (const c of candidates) {
    if (!c.authors.some((a) => ourAuthors.has(nameKey(a)))) continue;
    if (book.isbns.some((i) => c.isbns.includes(i))) return c;
    const key = titleKey(c.title);
    if ((extractVolume(c.title) ?? 1) !== ourVolume) continue;
    const score = key === ourKey ? 1 : trigramSimilarity(key, ourKey);
    if (score >= 0.85 && (!best || score > best.score)) best = { c, score };
  }
  return best?.c ?? null;
}

// ---------------------------------------------------------------------------------------------
// Enriching one book

export type EnrichOutcome =
  | { status: "matched"; sources: Candidate["source"][] }
  | { status: "no_match" | "error" };

export async function enrichBook(db: Db, bookId: string, deps: EnrichDeps): Promise<EnrichOutcome> {
  const [book] = await db.select().from(books).where(eq(books.id, bookId));
  if (!book) return { status: "error" };
  const authorRows = await db
    .select({ name: authors.name })
    .from(bookAuthors)
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(eq(bookAuthors.bookId, bookId))
    .orderBy(asc(bookAuthors.position));
  const isbns = (await db.select({ isbn: editions.isbn13 }).from(editions).where(eq(editions.bookId, bookId)))
    .map((e) => e.isbn)
    .filter((i): i is string => !!i);
  const facts: BookFacts = { title: book.title, authorNames: authorRows.map((a) => a.name), isbns };
  const firstAuthor = facts.authorNames[0];
  if (!firstAuthor) return { status: "no_match" };
  const byTitle = { title: book.title.replace(/\s*[([].*$/, ""), author: firstAuthor };

  const matched: Candidate[] = [];
  let failures = 0;
  const lookups: [Candidate["source"], () => Promise<Candidate[]>][] = [
    ["openlibrary", () => searchOpenLibrary(isbns[0] ? { isbn: isbns[0] } : byTitle, deps)],
  ];
  if (deps.googleBooksKey) {
    lookups.push(["google_books", () => searchGoogleBooks(isbns[0] ? { isbn: isbns[0] } : byTitle, deps)]);
  }
  for (const [source, lookup] of lookups) {
    try {
      let match = pickMatch(facts, await lookup());
      // An ISBN search that misses can still match by title.
      if (!match && isbns[0]) {
        match = pickMatch(
          facts,
          await (source === "openlibrary"
            ? searchOpenLibrary(byTitle, deps)
            : searchGoogleBooks(byTitle, deps)),
        );
      }
      if (match) matched.push(match);
    } catch (error) {
      failures++;
      deps.log?.warn("enrich.lookup_failed", { source, book_id: bookId, error });
    }
  }

  const now = nowIso();
  if (matched.length === 0) {
    const status = failures === lookups.length ? "error" : "no_match";
    await db.update(books).set({ enrichStatus: status, enrichedAt: now }).where(eq(books.id, bookId));
    return { status };
  }
  for (const m of matched) {
    await addConfirmation(db, {
      subjectType: "book",
      subjectId: bookId,
      source: m.source,
      sourceRef: m.ref,
      evidence: { title: m.title, authors: m.authors.slice(0, 5), published: m.published?.date ?? null },
    });
    await writeBookFields(
      db,
      bookId,
      [
        { field: "pageCount", value: m.pageCount && m.pageCount >= 20 ? m.pageCount : undefined },
        { field: "firstPublished", value: m.published ?? undefined },
      ],
      { source: "api", sourceRef: `${m.source}:${m.ref}` },
    );
  }
  await db.update(books).set({ enrichStatus: "matched", enrichedAt: now }).where(eq(books.id, bookId));
  return { status: "matched", sources: matched.map((m) => m.source) };
}

/** Books due for a lookup: never tried, or a miss or error older than `retryDays`. */
export async function booksToEnrich(
  db: Db,
  limit: number,
  retryDays: number,
  now = new Date(),
): Promise<string[]> {
  const before = new Date(now.getTime() - retryDays * 86_400_000).toISOString();
  const rows = await db
    .select({ id: books.id })
    .from(books)
    .where(
      and(
        isNull(books.redirectTo),
        ne(books.visibility, "removed"),
        or(
          eq(books.enrichStatus, "pending"),
          and(inArray(books.enrichStatus, ["no_match", "error"]), lt(books.enrichedAt, before)),
        ),
      ),
    )
    .orderBy(asc(books.createdAt))
    .limit(limit);
  return rows.map((r) => r.id);
}
