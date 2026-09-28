// A reader's taste profile (DESIGN §9.7, QUIZZES §4): what they told us (the same MatchInputs a
// share link carries) plus what their book marks say. Level 1–5 shows how much we know, and each
// level visibly improves their matches.

import { and, count, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db";
import { appraisals, bookMarks, books, quizTakes, readerProfiles } from "../db/schema";
import { type MatchInputs, matchInputsSchema } from "../match/profile";
import { nowIso } from "../time";

export interface ReaderProfile {
  inputs: MatchInputs;
  readerClass: string | null;
  level: number;
  source: string | null;
  onboardedAt: string | null;
}

export const LEVEL_TITLES = [
  "",
  "Unclassified",
  "Classified",
  "Well-Read",
  "Fine-Tuned",
  "Appraiser",
] as const;

/** What a level-up toast says (QUIZZES §4.2); null when the level didn't rise. */
export interface LevelUp {
  level: number;
  title: string;
}

export function levelUp(level: number, previousLevel: number): LevelUp | null {
  return level > previousLevel ? { level, title: LEVEL_TITLES[level] ?? "" } : null;
}

export interface LevelFacts {
  quizTaken: boolean;
  /** Books rated in the Match Quiz or marked (loved, read, not finished). */
  booksRated: number;
  mustsAndNoes: boolean;
  appraisedBooks: number;
  importedRatings: number;
}

/** QUIZZES §4.2: the highest level whose condition holds (an import can skip straight to 5). */
export function levelFor(f: LevelFacts): number {
  if (f.appraisedBooks >= 3 || f.importedRatings >= 20) return 5;
  if (f.mustsAndNoes) return 4;
  if (f.booksRated >= 5) return 3;
  if (f.quizTaken) return 2;
  return 1;
}

export async function getReaderProfile(db: Db, userId: string): Promise<ReaderProfile> {
  const [row] = await db.select().from(readerProfiles).where(eq(readerProfiles.userId, userId));
  const parsed = matchInputsSchema.safeParse(row?.inputs ?? {});
  return {
    inputs: parsed.success ? parsed.data : {},
    readerClass: row?.readerClass ?? null,
    level: row?.level ?? 1,
    source: row?.source ?? null,
    onboardedAt: row?.onboardedAt ?? null,
  };
}

async function levelFacts(db: Db, userId: string, inputs: MatchInputs): Promise<LevelFacts> {
  const [marks, rated, appraised, takes] = await Promise.all([
    db
      .select({ n: count() })
      .from(bookMarks)
      .where(and(eq(bookMarks.userId, userId), inArray(bookMarks.status, ["loved", "read", "dnf"]))),
    db
      .select({ n: count() })
      .from(bookMarks)
      .where(and(eq(bookMarks.userId, userId), eq(bookMarks.source, "import"), isNotNull(bookMarks.rating))),
    db.selectDistinct({ bookId: appraisals.bookId }).from(appraisals).where(eq(appraisals.userId, userId)),
    db.select({ n: count() }).from(quizTakes).where(eq(quizTakes.userId, userId)),
  ]);
  return {
    quizTaken: Boolean(inputs.quiz) || (takes[0]?.n ?? 0) > 0,
    booksRated: (marks[0]?.n ?? 0) + (inputs.rated?.length ?? 0) + (inputs.loved?.length ?? 0),
    mustsAndNoes: (inputs.musts?.length ?? 0) > 0 && (inputs.noes?.length ?? 0) > 0,
    appraisedBooks: appraised.length,
    importedRatings: rated[0]?.n ?? 0,
  };
}

/**
 * Save stated tastes. `patch` replaces the keys it names (validated like a share link); the level
 * is recomputed. The reader class is computed by the caller, which has the match model.
 */
export async function saveReaderProfile(
  db: Db,
  userId: string,
  patch: Partial<MatchInputs>,
  opts: { source?: string; readerClass?: string | null; onboarded?: boolean } = {},
): Promise<ReaderProfile & { previousLevel: number }> {
  const current = await getReaderProfile(db, userId);
  const merged = matchInputsSchema.parse(
    Object.fromEntries(
      Object.entries({ ...current.inputs, ...patch }).filter(([, v]) => v !== undefined && v !== null),
    ),
  );
  const level = levelFor(await levelFacts(db, userId, merged));
  const now = nowIso();
  const values = {
    inputs: merged as Record<string, unknown>,
    level,
    readerClass: opts.readerClass === undefined ? current.readerClass : opts.readerClass,
    source: current.source ?? opts.source ?? null,
    onboardedAt: current.onboardedAt ?? (opts.onboarded ? now : null),
    updatedAt: now,
  };
  await db
    .insert(readerProfiles)
    .values({ userId, ...values, createdAt: now })
    .onConflictDoUpdate({ target: readerProfiles.userId, set: values });
  return { ...values, inputs: merged, previousLevel: current.level };
}

/** Recompute the level after marks or appraisals change, without touching the stated tastes. */
export async function refreshLevel(
  db: Db,
  userId: string,
): Promise<{ level: number; previousLevel: number }> {
  const { level, previousLevel } = await saveReaderProfile(db, userId, {});
  return { level, previousLevel };
}

/**
 * The inputs the match engine should use for this reader: their stated tastes, their five most
 * recent loved books (if they didn't name favorites), books they didn't finish as bounced, and
 * everything marked as read or loved so it isn't recommended again.
 */
export async function effectiveInputs(db: Db, userId: string): Promise<MatchInputs> {
  const { inputs } = await getReaderProfile(db, userId);
  const marks = await db
    .select({ slug: books.slug, status: bookMarks.status, rating: bookMarks.rating })
    .from(bookMarks)
    .innerJoin(books, eq(books.id, bookMarks.bookId))
    .where(eq(bookMarks.userId, userId))
    .orderBy(desc(bookMarks.updatedAt))
    .limit(300);
  const loved = marks.filter((m) => m.status === "loved").map((m) => m.slug);
  // Didn't finish, or finished and rated it 1–2 stars on import: both are "not for me".
  const dnf = marks
    .filter((m) => m.status === "dnf" || (m.rating !== null && m.rating <= 2))
    .map((m) => m.slug);
  const done = marks.filter((m) => m.status !== "want").map((m) => m.slug);
  return matchInputsSchema.parse({
    ...inputs,
    loved: inputs.loved?.length ? inputs.loved : loved.length ? loved.slice(0, 5) : undefined,
    bounced: inputs.bounced?.length
      ? inputs.bounced
      : dnf.length
        ? dnf.slice(0, 5).map((book) => ({ book }))
        : undefined,
    read: [...new Set([...(inputs.read ?? []), ...done])].slice(0, 50),
  });
}
