// Deterministic tag suggestions (DESIGN §10.3): instant, no AI. Tags from the series' other books,
// the author's other books, and blurb keywords matched against each tag's name and synonyms. Authors
// see them pre-selected in the submission form; the owner sees them on the book page.

import { and, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "../db";
import { bookAuthors, books, bookTags, tags } from "../db/schema";
import { TAGS } from "../taxonomy";

export interface TagSuggestion {
  slug: string;
  name: string;
  facet: string;
  /** 0–1, how strongly the evidence points at this tag. */
  score: number;
  reasons: string[];
}

/** Scores at or above this on a sibling book count as that book having the tag. */
const SIBLING_MIN = 0.6;

function normalizeText(s: string): string {
  return ` ${s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}

const KEYWORDS: { slug: string; terms: string[] }[] = TAGS.filter(
  (t) => (t.status ?? "active") === "active",
).map((t) => ({
  slug: t.slug,
  terms: [
    ...new Set(
      [t.name, t.slug.replace(/-/g, " "), ...(t.synonyms ?? [])]
        .map((term) => normalizeText(term).trim())
        .filter((term) => term.length >= 3),
    ),
  ],
}));

/** Tags whose name or a synonym appears as a whole phrase in the text. Returns slug → the term that matched. */
export function keywordTags(text: string): Map<string, string> {
  const hay = normalizeText(text);
  const found = new Map<string, string>();
  for (const { slug, terms } of KEYWORDS) {
    const hit = terms.find((term) => hay.includes(` ${term} `));
    if (hit) found.set(slug, hit);
  }
  return found;
}

export interface SuggestInput {
  seriesId?: string | null;
  authorIds?: string[];
  text?: string | null;
  /** The book being tagged, so it doesn't count as its own sibling. */
  bookId?: string;
}

export async function suggestTags(db: Db, input: SuggestInput, limit = 20): Promise<TagSuggestion[]> {
  const evidence = new Map<string, { score: number; reasons: string[] }>();
  const add = (slug: string, score: number, reason: string) => {
    const e = evidence.get(slug) ?? { score: 0, reasons: [] };
    // Independent signals agreeing push the score up a little; the strongest signal leads.
    e.score = Math.min(1, Math.max(e.score, score) + (e.score > 0 ? 0.05 : 0));
    e.reasons.push(reason);
    evidence.set(slug, e);
  };

  const live = and(isNull(books.redirectTo), ne(books.visibility, "removed"));
  const notSelf = input.bookId ? ne(books.id, input.bookId) : undefined;

  const seriesBookIds = new Set<string>();
  if (input.seriesId) {
    const siblings = await db
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.seriesId, input.seriesId), live, notSelf));
    for (const s of siblings) seriesBookIds.add(s.id);
    await addSiblingTags(db, [...seriesBookIds], (slug, share, n) =>
      add(slug, 0.9 * share, `${n} of ${seriesBookIds.size} books in the series`),
    );
  }

  const authorIds = (input.authorIds ?? []).slice(0, 10);
  if (authorIds.length) {
    const rows = await db
      .select({ id: books.id })
      .from(bookAuthors)
      .innerJoin(books, eq(books.id, bookAuthors.bookId))
      .where(and(inArray(bookAuthors.authorId, authorIds), live, notSelf))
      .limit(200);
    const others = [...new Set(rows.map((r) => r.id))].filter((id) => !seriesBookIds.has(id));
    await addSiblingTags(db, others, (slug, share, n) =>
      add(slug, 0.5 * share, `${n} of the author's ${others.length} other books`),
    );
  }

  if (input.text) {
    for (const [slug, term] of keywordTags(input.text)) add(slug, 0.6, `the text mentions “${term}”`);
  }

  const bySlug = new Map(TAGS.map((t) => [t.slug, t]));
  return [...evidence.entries()]
    .map(([slug, e]) => {
      const def = bySlug.get(slug);
      return {
        slug,
        name: def?.name ?? slug,
        facet: def?.facet ?? "",
        score: Math.round(e.score * 100) / 100,
        reasons: e.reasons,
      };
    })
    .filter((s) => s.score >= 0.3)
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .slice(0, limit);
}

async function addSiblingTags(
  db: Db,
  bookIds: string[],
  onTag: (slug: string, share: number, count: number) => void,
): Promise<void> {
  if (bookIds.length === 0) return;
  const counts = new Map<string, number>();
  for (let i = 0; i < bookIds.length; i += 90) {
    const rows = await db
      .select({ slug: tags.slug, bookId: bookTags.bookId })
      .from(bookTags)
      .innerJoin(tags, eq(tags.id, bookTags.tagId))
      .where(
        and(
          inArray(bookTags.bookId, bookIds.slice(i, i + 90)),
          gte(bookTags.score, SIBLING_MIN),
          eq(tags.status, "active"),
        ),
      );
    for (const r of rows) counts.set(r.slug, (counts.get(r.slug) ?? 0) + 1);
  }
  for (const [slug, n] of counts) onTag(slug, n / bookIds.length, n);
}

/** Suggestions for a book already in the catalog, leaving out tags it already shows. */
export async function suggestTagsForBook(
  db: Db,
  bookId: string,
  displayMin: number,
  limit = 20,
): Promise<TagSuggestion[]> {
  const [book] = await db
    .select({ seriesId: books.seriesId, blurb: books.blurbAuthor, summary: books.summaryAi })
    .from(books)
    .where(eq(books.id, bookId));
  if (!book) return [];
  const authorRows = await db
    .select({ id: bookAuthors.authorId })
    .from(bookAuthors)
    .where(eq(bookAuthors.bookId, bookId));
  const shown = await db
    .select({ slug: tags.slug })
    .from(bookTags)
    .innerJoin(tags, eq(tags.id, bookTags.tagId))
    .where(and(eq(bookTags.bookId, bookId), gte(bookTags.score, displayMin)));
  const hide = new Set(shown.map((s) => s.slug));
  const all = await suggestTags(
    db,
    {
      bookId,
      seriesId: book.seriesId,
      authorIds: authorRows.map((a) => a.id),
      text: [book.blurb, book.summary].filter(Boolean).join("\n"),
    },
    limit + hide.size,
  );
  return all.filter((s) => !hide.has(s.slug)).slice(0, limit);
}
