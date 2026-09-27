// Storing quiz takes (QUIZZES §4.3) and deciding which quizzes are live. Takes are anonymous by
// default: a random id in the reader's browser, answers, and the result. Nothing identifies the
// person unless they later sign in on the same browser.

import { and, count, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { appendAudit } from "../audit";
import { randomToken } from "../crypto";
import type { Db } from "../db";
import { quizDaily, quizStatus, quizTakes } from "../db/schema";
import { nowIso } from "../time";
import { QUIZZES, type Quiz } from "./engine";

export const ANONYMOUS_TAKE_DAYS = 90;

export interface NewTake {
  quiz: Quiz;
  answers: string[];
  outcomeKey: string;
  score?: number;
  source?: string;
  partyRef?: string | null;
  userId?: string | null;
}

export async function recordTake(db: Db, t: NewTake): Promise<string> {
  const id = randomToken(16);
  const now = nowIso();
  const day = now.slice(0, 10);
  await db.batch([
    db.insert(quizTakes).values({
      id,
      quizSlug: t.quiz.slug,
      userId: t.userId ?? null,
      answers: t.answers,
      outcomeKey: t.outcomeKey,
      score: t.score ?? null,
      source: (t.source ?? "onsite").slice(0, 30),
      partyRef: t.partyRef ?? null,
      createdAt: now,
      attachedAt: t.userId ? now : null,
    }),
    db
      .insert(quizDaily)
      .values({ quizSlug: t.quiz.slug, day, outcomeKey: t.outcomeKey, takes: 1, parties: t.partyRef ? 1 : 0 })
      .onConflictDoUpdate({
        target: [quizDaily.quizSlug, quizDaily.day, quizDaily.outcomeKey],
        set: {
          takes: sql`${quizDaily.takes} + 1`,
          parties: sql`${quizDaily.parties} + ${t.partyRef ? 1 : 0}`,
        },
      }),
  ]);
  return id;
}

/** Only the result of a take is ever shared (Party up compares results, never answers). */
export async function takeOutcome(
  db: Db,
  id: string,
): Promise<{ quizSlug: string; outcomeKey: string } | null> {
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(id)) return null;
  const [row] = await db
    .select({ quizSlug: quizTakes.quizSlug, outcomeKey: quizTakes.outcomeKey })
    .from(quizTakes)
    .where(eq(quizTakes.id, id));
  return row ?? null;
}

/** Attach this browser's takes to an account once the reader signs in (QUIZZES §4.3). */
export async function attachTakes(db: Db, userId: string, ids: string[]): Promise<number> {
  const valid = ids.filter((id) => /^[A-Za-z0-9_-]{16,40}$/.test(id)).slice(0, 50);
  if (valid.length === 0) return 0;
  const rows = await db
    .update(quizTakes)
    .set({ userId, attachedAt: nowIso() })
    .where(and(inArray(quizTakes.id, valid), isNull(quizTakes.userId)))
    .returning({ id: quizTakes.id });
  return rows.length;
}

export async function purgeAnonymousTakes(db: Db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ANONYMOUS_TAKE_DAYS * 86_400_000).toISOString();
  const rows = await db
    .delete(quizTakes)
    .where(and(isNull(quizTakes.userId), lt(quizTakes.createdAt, cutoff)))
    .returning({ id: quizTakes.id });
  return rows.length;
}

// ---------------------------------------------------------------------------------------------
// Which quizzes are live: content in git, the go-live decision in the console (audited).

export async function quizStatuses(db: Db): Promise<Map<string, "live" | "retired">> {
  const rows = await db.select({ slug: quizStatus.slug, status: quizStatus.status }).from(quizStatus);
  return new Map(rows.map((r) => [r.slug, r.status]));
}

export async function liveQuizzes(db: Db): Promise<Quiz[]> {
  const statuses = await quizStatuses(db);
  return QUIZZES.filter((q) => statuses.get(q.slug) === "live");
}

export async function isLive(db: Db, slug: string): Promise<boolean> {
  const [row] = await db
    .select({ status: quizStatus.status })
    .from(quizStatus)
    .where(eq(quizStatus.slug, slug));
  return row?.status === "live";
}

export async function setQuizStatus(
  db: Db,
  slug: string,
  status: "live" | "retired",
  actorId: string,
): Promise<void> {
  if (!QUIZZES.some((q) => q.slug === slug)) throw new Error(`no quiz "${slug}"`);
  const now = nowIso();
  await db
    .insert(quizStatus)
    .values({ slug, status, updatedBy: actorId, updatedAt: now })
    .onConflictDoUpdate({ target: quizStatus.slug, set: { status, updatedBy: actorId, updatedAt: now } });
  await appendAudit(db, {
    actor: { type: "admin", id: actorId },
    action: status === "live" ? "quiz.publish" : "quiz.retire",
    subjectType: "quiz",
    subjectId: slug,
  });
}

/** Outcome shares over the last N days, for the console (QUIZZES §3.5). */
export async function quizStats(db: Db, days = 30, now = new Date()) {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .select({
      quizSlug: quizDaily.quizSlug,
      outcomeKey: quizDaily.outcomeKey,
      takes: sql<number>`sum(${quizDaily.takes})`,
      parties: sql<number>`sum(${quizDaily.parties})`,
    })
    .from(quizDaily)
    .where(gte(quizDaily.day, since))
    .groupBy(quizDaily.quizSlug, quizDaily.outcomeKey)
    .orderBy(desc(sql`sum(${quizDaily.takes})`));
}

export async function takeCount(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(quizTakes);
  return row?.n ?? 0;
}
