// Appraise (DESIGN §6.7): after reading a book, a reader answers up to five one-tap questions about
// its lowest-confidence or still-hidden (`???`) keys. Answers become crowd evidence on book_scores,
// so readers, not the AI, decide how well a book delivers.

import { and, avg, count, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../db";
import { appraisals, bookScores, users } from "../db/schema";
import { ulid } from "../ids";
import { openInboxItem } from "../inbox";
import { DIAL_KEYS, DIALS, STAT_KEYS, STATS } from "../taxonomy";
import { nowIso } from "../time";
import { isScorePublic, resolveScore } from "./scores";

export type AppraisalAnswer = "less" | "right" | "more" | "yes" | "mixed" | "no";

export interface AppraisalQuestion {
  key: string;
  kind: "dial" | "stat";
  prompt: string;
  choices: { answer: AppraisalAnswer; label: string }[];
}

const STAT_PROMPTS: Record<string, string> = {
  competent_mc: "Is the MC competent: sharp decisions, learns from mistakes?",
  rule_of_cool: "Lots of 'hell yes' abilities, gear and set pieces?",
  number_go_up: "Frequent, satisfying progression beats?",
  build_payoff: "Do skill, stat and class choices matter and pay off?",
  earned_power: "Are the MC's gains earned rather than handed out?",
  system_consistency: "Does the system stay consistent with its own rules?",
  hype: "Big cathartic payoffs that land?",
  low_drama: "Free of manufactured drama and misunderstandings?",
  party_chemistry: "Do the companions and banter work?",
  rootable_mc: "Easy to root for the MC?",
  fast_start: "Does it hook you and start progressing early?",
  satisfying_endings: "Does the book resolve its main arc?",
};

const DIAL_NAMES = new Map(DIALS.map((d) => [d.key, d.name]));
const STAT_TYPES = new Map(STATS.map((s) => [s.key, s.type]));

export function questionFor(key: string): AppraisalQuestion | null {
  if (STAT_KEYS.has(key)) {
    return {
      key,
      kind: "stat",
      prompt: STAT_PROMPTS[key] ?? key,
      choices: [
        { answer: "yes", label: "Mostly yes" },
        { answer: "mixed", label: "Mixed" },
        { answer: "no", label: "Mostly no" },
      ],
    };
  }
  if (DIAL_KEYS.has(key)) {
    const name = (DIAL_NAMES.get(key) ?? key).toLowerCase();
    return {
      key,
      kind: "dial",
      prompt: `${DIAL_NAMES.get(key) ?? key}: compared with what we say, it felt…`,
      choices: [
        { answer: "less", label: `Less ${name}` },
        { answer: "right", label: "About right" },
        { answer: "more", label: `More ${name}` },
      ],
    };
  }
  return null;
}

/** A 0–10 value from a one-tap answer. Dial answers are relative to what the page showed. */
export function answerValue(answer: AppraisalAnswer, shown: number | null): number {
  switch (answer) {
    case "yes":
      return 8;
    case "mixed":
      return 5;
    case "no":
      return 2;
    case "less":
      return Math.max(0, (shown ?? 5) - 2);
    case "right":
      return shown ?? 5;
    case "more":
      return Math.min(10, (shown ?? 5) + 2);
  }
}

/** Up to five keys: hidden judgment stats first, then the lowest-confidence dials and stats. */
export async function appraisalQuestions(db: Db, bookId: string, limit = 5): Promise<AppraisalQuestion[]> {
  const rows = await db.select().from(bookScores).where(eq(bookScores.bookId, bookId));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const keys = [...STATS.map((s) => s.key), ...DIALS.map((d) => d.key)];
  const ranked = keys
    .map((key) => {
      const r = byKey.get(key);
      const hiddenJudgment = STAT_TYPES.get(key) === "judgment" && !r?.public;
      return { key, rank: (hiddenJudgment ? -1 : 0) + (r?.confidence ?? 0) };
    })
    .sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
  return ranked
    .slice(0, limit)
    .map((r) => questionFor(r.key))
    .filter((q): q is AppraisalQuestion => q !== null);
}

export class AppraisalError extends Error {
  constructor(
    readonly reason: "not_eligible" | "own_book" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

export const APPRAISE_MIN_ACCOUNT_DAYS = 7;
/** New accounts (under this many days) appraising one book in a burst are held for review. */
const BURST_ACCOUNT_DAYS = 30;
const BURST_WINDOW_HOURS = 24;
const BURST_MIN = 10;

export interface AppraiseInput {
  userId: string;
  bookId: string;
  answers: { key: string; answer: AppraisalAnswer }[];
  /** What the page showed for each dial, for relative answers. */
  shown?: Record<string, number | null>;
  /** Author ids the reader manages (M6); a reader can't appraise their own book. */
  managedAuthorIds?: string[];
  bookAuthorIds?: string[];
  minAppraisals: number;
}

/**
 * Record appraisals and fold them into the book's scores. Only accounts at least 7 days old with
 * a verified email can appraise; one appraisal per reader, book and key (DESIGN §6.7).
 */
export async function submitAppraisals(
  db: Db,
  input: AppraiseInput,
  now = new Date(),
): Promise<{ held: boolean; revealed: string[] }> {
  const [user] = await db
    .select({ createdAt: users.createdAt, emailVerified: users.emailVerified, state: users.state })
    .from(users)
    .where(eq(users.id, input.userId));
  const ageDays = user ? (now.getTime() - new Date(user.createdAt).getTime()) / 86_400_000 : 0;
  if (!user?.emailVerified || user.state !== "active" || ageDays < APPRAISE_MIN_ACCOUNT_DAYS) {
    throw new AppraisalError(
      "not_eligible",
      "Appraising opens once your account is a week old and your email is verified.",
    );
  }
  if (input.bookAuthorIds?.some((a) => input.managedAuthorIds?.includes(a))) {
    throw new AppraisalError("own_book", "Authors and their teams can't appraise their own books.");
  }
  const answers = input.answers.filter((a) => questionFor(a.key)).slice(0, 12);
  if (answers.length === 0) throw new AppraisalError("invalid", "No questions answered.");

  // Brigading check: many new accounts appraising the same book at once.
  const since = new Date(now.getTime() - BURST_WINDOW_HOURS * 3_600_000).toISOString();
  const newAccountCutoff = new Date(now.getTime() - BURST_ACCOUNT_DAYS * 86_400_000);
  const [burst] = await db
    .select({ n: sql<number>`count(distinct ${appraisals.userId})` })
    .from(appraisals)
    .innerJoin(users, eq(users.id, appraisals.userId))
    .where(
      and(
        eq(appraisals.bookId, input.bookId),
        gte(appraisals.createdAt, since),
        gte(users.createdAt, newAccountCutoff),
      ),
    );
  const isNewAccount = new Date(user.createdAt) >= newAccountCutoff;
  const held = isNewAccount && (burst?.n ?? 0) + 1 >= BURST_MIN;
  if (held) {
    await openInboxItem(db, {
      type: "appraisal_burst",
      title: "A burst of appraisals from new accounts is on hold",
      subjectType: "book",
      subjectId: input.bookId,
      priority: 60,
      payload: { bookId: input.bookId, since },
      dedupeKey: `appraisal_burst:${input.bookId}:${since.slice(0, 10)}`,
    });
  }

  const stamp = nowIso(now);
  const statements = answers.map((a) =>
    db
      .insert(appraisals)
      .values({
        id: ulid(),
        userId: input.userId,
        bookId: input.bookId,
        key: a.key,
        value: answerValue(a.answer, input.shown?.[a.key] ?? null),
        status: held ? "held" : "counted",
        createdAt: stamp,
        updatedAt: stamp,
      })
      .onConflictDoUpdate({
        target: [appraisals.userId, appraisals.bookId, appraisals.key],
        set: { value: answerValue(a.answer, input.shown?.[a.key] ?? null), updatedAt: stamp },
      }),
  );
  await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
  const revealed = held
    ? []
    : await recalibrate(
        db,
        input.bookId,
        answers.map((a) => a.key),
        input.minAppraisals,
      );
  return { held, revealed };
}

/** Fold counted appraisals into book_scores. Returns stats that just became public ("Identified!"). */
export async function recalibrate(
  db: Db,
  bookId: string,
  keys: string[],
  minAppraisals: number,
): Promise<string[]> {
  if (keys.length === 0) return [];
  const crowd = await db
    .select({ key: appraisals.key, mean: avg(appraisals.value), n: count() })
    .from(appraisals)
    .where(
      and(eq(appraisals.bookId, bookId), eq(appraisals.status, "counted"), inArray(appraisals.key, keys)),
    )
    .groupBy(appraisals.key);
  const existing = await db
    .select()
    .from(bookScores)
    .where(and(eq(bookScores.bookId, bookId), inArray(bookScores.key, keys)));
  const byKey = new Map(existing.map((r) => [r.key, r]));
  const revealed: string[] = [];
  const now = nowIso();
  for (const c of crowd) {
    const row = byKey.get(c.key);
    const kind: "dial" | "stat" = DIAL_KEYS.has(c.key) ? "dial" : "stat";
    const crowdMean = c.mean === null ? null : Number(c.mean);
    const evidence = {
      aiValue: row?.aiValue ?? null,
      aiConfidence: row?.aiConfidence ?? null,
      authorValue: row?.authorValue ?? null,
      crowdMean,
      crowdN: c.n,
    };
    const resolved = row?.adminLocked ? { value: row.value, confidence: 1 } : resolveScore(evidence);
    const isPublic = Boolean(row?.adminLocked) || isScorePublic(kind, c.key, resolved, c.n, minAppraisals);
    if (isPublic && !row?.public && kind === "stat") revealed.push(c.key);
    await db
      .insert(bookScores)
      .values({
        bookId,
        key: c.key,
        kind,
        value: resolved.value,
        confidence: resolved.confidence,
        crowdMean,
        crowdN: c.n,
        public: isPublic,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [bookScores.bookId, bookScores.key],
        set: {
          value: resolved.value,
          confidence: resolved.confidence,
          crowdMean,
          crowdN: c.n,
          public: isPublic,
          updatedAt: now,
        },
      });
  }
  return revealed;
}
