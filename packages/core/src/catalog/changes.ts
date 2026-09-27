// Change notifications (DESIGN §10.4): every change to a book by anyone but its author (the owner,
// an editorial run, an API refresh, readers) is recorded for each claimed author of the book and
// emailed to them in a daily batch. Books whose authors have no members record nothing.

import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { authorMembers, bookAuthors, changeNotifications, type FieldSource } from "../db/schema";
import { ulid } from "../ids";

const AUTHOR_SOURCES: ReadonlySet<string> = new Set(["author", "author_verified"]);

export const CHANGE_SOURCE_LABEL: Record<string, string> = {
  admin: "ReadLitRPG",
  ai: "An editorial run",
  api: "A book database (Open Library or Google Books)",
  research: "Research with a cited source",
  reader: "A reader suggestion",
  crowd: "Readers",
};

const FIELD_LABEL: Record<string, string> = {
  title: "title",
  subtitle: "subtitle",
  seriesId: "series",
  seriesPosition: "series position",
  firstPublished: "first published date",
  pageCount: "page count",
  wordCountEst: "word count",
  language: "language",
  pubStatus: "publication status",
  blurbAuthor: "blurb",
  summaryAi: "summary",
  hookAi: "hook",
  primaryGenre: "genre",
  inScope: "scope",
  crunchLevel: "crunch level",
  romanceLevel: "romance level",
  harem: "harem",
  contentFlags: "content notes",
  isAiGenerated: "AI-use label",
  tags: "tags",
  scores: "taste dials",
  release: "release date",
  visibility: "visibility",
};

export const changeLabel = (field: string) => FIELD_LABEL[field] ?? field;

/** Record one change for every claimed author of the book. Author-made changes are skipped. */
export async function recordBookChange(
  db: Db,
  bookId: string,
  source: FieldSource | "admin",
  fields: string[],
  diff: Record<string, unknown> | null = null,
): Promise<number> {
  if (AUTHOR_SOURCES.has(source) || fields.length === 0) return 0;
  const rows = await db
    .selectDistinct({ authorId: bookAuthors.authorId })
    .from(bookAuthors)
    .innerJoin(authorMembers, eq(authorMembers.authorId, bookAuthors.authorId))
    .where(eq(bookAuthors.bookId, bookId));
  if (rows.length === 0) return 0;
  const who = CHANGE_SOURCE_LABEL[source] ?? source;
  const summary = `${who} changed the ${[...new Set(fields.map(changeLabel))].join(", ")}`.slice(0, 300);
  await db
    .insert(changeNotifications)
    .values(rows.map((r) => ({ id: ulid(), authorId: r.authorId, bookId, source, summary, diff })));
  return rows.length;
}
