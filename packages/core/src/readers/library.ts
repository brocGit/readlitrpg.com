// Importing a reader's library (DESIGN §9.7 option A, §7.15): the CSV export from Goodreads or The
// StoryGraph. Rows are stored, then a job matches them to the catalog in chunks (ISBN first, then
// title and author) and turns them into book marks. We never fetch anything from those sites.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { parseCsv } from "../catalog/imports";
import { nameKey, normalizeIsbn, titleKey } from "../catalog/normalize";
import type { Db } from "../db";
import {
  authors,
  bookAuthors,
  bookMarks,
  books,
  editions,
  type IMPORT_SOURCES,
  libraryImportRows,
  libraryImports,
  type MarkStatus,
} from "../db/schema";
import { ulid } from "../ids";
import { nowIso } from "../time";
import { refreshLevel } from "./profile";

export class LibraryImportError extends Error {}

export interface LibraryRow {
  title: string;
  author: string;
  isbn: string | null;
  /** 1–5 stars, or null when not rated. */
  rating: number | null;
  status: MarkStatus;
}

const header = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Goodreads wraps ISBNs as ="9781234567890". */
const cleanIsbn = (v: string | undefined) => normalizeIsbn((v ?? "").replace(/[="]/g, ""));

function statusFor(shelf: string, rating: number | null): MarkStatus | null {
  const s = shelf.trim().toLowerCase();
  if (s === "to-read" || s === "to read") return "want";
  if (s === "did-not-finish" || s === "dnf" || s === "did not finish") return "dnf";
  if (s === "currently-reading" || s === "currently reading") return null;
  if (rating !== null && rating >= 4) return "loved";
  return "read";
}

export function parseLibrary(text: string): { source: (typeof IMPORT_SOURCES)[number]; rows: LibraryRow[] } {
  const table = parseCsv(text);
  const head = (table[0] ?? []).map(header);
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const isGoodreads = head.includes("exclusive shelf") || head.includes("my rating");
  const isStorygraph = head.includes("read status") || head.includes("star rating");
  if (!isGoodreads && !isStorygraph)
    throw new LibraryImportError("that isn't a Goodreads or StoryGraph export (no shelf or rating columns)");
  const iTitle = col("title");
  const iAuthor = col("author", "authors");
  const iIsbn = isGoodreads ? col("isbn13") : col("isbn uid", "isbn");
  const iIsbn10 = isGoodreads ? col("isbn") : -1;
  const iRating = col("my rating", "star rating");
  const iShelf = col("exclusive shelf", "read status");
  if (iTitle < 0 || iAuthor < 0) throw new LibraryImportError("the file has no title or author column");
  const rows: LibraryRow[] = [];
  for (const r of table.slice(1, 5001)) {
    const title = (r[iTitle] ?? "").trim();
    const author = (r[iAuthor] ?? "").split(",")[0]?.trim() ?? "";
    if (!title || !author) continue;
    const stars = Number.parseFloat(r[iRating] ?? "");
    // Goodreads writes 0 for "not rated".
    const rating = Number.isFinite(stars) && stars > 0 ? Math.min(5, Math.max(1, Math.round(stars))) : null;
    const status = statusFor(r[iShelf] ?? "read", rating);
    if (!status) continue;
    rows.push({
      title: title.slice(0, 300),
      author: author.slice(0, 200),
      isbn: cleanIsbn(r[iIsbn]) ?? cleanIsbn(iIsbn10 >= 0 ? r[iIsbn10] : undefined),
      rating,
      status,
    });
  }
  if (rows.length === 0) throw new LibraryImportError("no books found in that file");
  return { source: isGoodreads ? "goodreads" : "storygraph", rows };
}

export async function createLibraryImport(
  db: Db,
  userId: string,
  text: string,
): Promise<{ id: string; total: number }> {
  const { source, rows } = parseLibrary(text);
  const id = ulid();
  await db
    .insert(libraryImports)
    .values({ id, userId, source, status: "queued", total: rows.length, createdAt: nowIso() });
  // Four columns a row: 20 rows keep a statement under D1's 100 bound parameters.
  for (let i = 0; i < rows.length; i += 20) {
    await db
      .insert(libraryImportRows)
      .values(rows.slice(i, i + 20).map((payload, k) => ({ importId: id, rowNum: i + k + 1, payload })));
  }
  return { id, total: rows.length };
}

/** Match one row to a published book: ISBN first, then the title key with an author's name key. */
async function matchRow(db: Db, row: LibraryRow): Promise<string | null> {
  if (row.isbn) {
    const [e] = await db
      .select({ id: books.id })
      .from(editions)
      .innerJoin(books, eq(books.id, editions.bookId))
      .where(and(eq(editions.isbn13, row.isbn), eq(books.visibility, "published")));
    if (e) return e.id;
  }
  const tk = titleKey(row.title.replace(/\s*\([^)]*#\s*\d+(\.\d+)?\)\s*$/, ""));
  if (!tk) return null;
  const [b] = await db
    .select({ id: books.id })
    .from(books)
    .innerJoin(bookAuthors, eq(bookAuthors.bookId, books.id))
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(
      and(
        eq(books.titleKey, tk),
        eq(authors.nameKey, nameKey(row.author)),
        eq(books.visibility, "published"),
      ),
    )
    .limit(1);
  return b?.id ?? null;
}

/** Process the next chunk of the oldest queued import. Returns rows processed (0 = nothing to do). */
export async function processLibraryChunk(
  db: Db,
  chunk = 40,
): Promise<{ importId: string | null; processed: number; remaining: number }> {
  const [imp] = await db
    .select()
    .from(libraryImports)
    .where(inArray(libraryImports.status, ["queued", "processing"]))
    .orderBy(asc(libraryImports.createdAt))
    .limit(1);
  if (!imp) return { importId: null, processed: 0, remaining: 0 };
  const rows = await db
    .select()
    .from(libraryImportRows)
    .where(and(eq(libraryImportRows.importId, imp.id), eq(libraryImportRows.status, "pending")))
    .orderBy(asc(libraryImportRows.rowNum))
    .limit(chunk);
  let matched = 0;
  const now = nowIso();
  for (const r of rows) {
    const row = r.payload as LibraryRow;
    const bookId = await matchRow(db, row);
    if (bookId) {
      matched++;
      await db
        .insert(bookMarks)
        .values({
          userId: imp.userId,
          bookId,
          status: row.status,
          rating: row.rating,
          source: "import",
          createdAt: now,
          updatedAt: now,
        })
        // What the reader marked on this site wins over an imported shelf.
        .onConflictDoNothing();
    }
    await db
      .update(libraryImportRows)
      .set({ status: bookId ? "matched" : "unmatched", bookId })
      .where(and(eq(libraryImportRows.importId, imp.id), eq(libraryImportRows.rowNum, r.rowNum)));
  }
  const remaining = Math.max(0, imp.total - imp.processed - rows.length);
  const done = rows.length < chunk || remaining === 0;
  await db
    .update(libraryImports)
    .set({
      status: done ? "done" : "processing",
      processed: sql`${libraryImports.processed} + ${rows.length}`,
      matched: sql`${libraryImports.matched} + ${matched}`,
      finishedAt: done ? now : null,
    })
    .where(eq(libraryImports.id, imp.id));
  if (done) {
    // The rows were only needed to match; the marks are what the reader keeps.
    await db.delete(libraryImportRows).where(eq(libraryImportRows.importId, imp.id));
    await refreshLevel(db, imp.userId);
  }
  return { importId: imp.id, processed: rows.length, remaining: done ? 0 : remaining };
}

export async function importsFor(db: Db, userId: string) {
  return db
    .select()
    .from(libraryImports)
    .where(eq(libraryImports.userId, userId))
    .orderBy(sql`${libraryImports.createdAt} desc`)
    .limit(10);
}
