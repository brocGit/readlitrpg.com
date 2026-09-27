// Timed email sequences (QUIZZES §3.4): the welcome emails after a confirmed quiz signup. A row per
// reader and sequence remembers the next step and when it's due; the welcome job sends due steps.

import { and, asc, eq, isNull, lte } from "drizzle-orm";
import type { Db } from "../db";
import { emailSequences } from "../db/schema";
import { nowIso } from "../time";

export type Sequence = "welcome" | "list_only";

/** E1 on confirmation, E2 on day 2, E3 on day 5, E4 on day 9. "Just the list" gets E1 only. */
export const WELCOME_DAYS = [0, 2, 5, 9] as const;

export async function startSequence(
  db: Db,
  userId: string,
  sequence: Sequence,
  context: Record<string, string>,
  now = new Date(),
) {
  await db
    .insert(emailSequences)
    .values({ userId, sequence, step: 1, nextAt: nowIso(now), context, startedAt: nowIso(now) })
    // Confirming twice doesn't restart the emails.
    .onConflictDoNothing();
}

export async function dueSteps(db: Db, now = new Date(), limit = 50) {
  return db
    .select()
    .from(emailSequences)
    .where(and(isNull(emailSequences.doneAt), lte(emailSequences.nextAt, nowIso(now))))
    .orderBy(asc(emailSequences.nextAt))
    .limit(limit);
}

/** Move past a step: schedule the next one, or finish. */
export async function advance(
  db: Db,
  row: { userId: string; sequence: Sequence; step: number; startedAt: string },
  now = new Date(),
) {
  const last = row.sequence === "list_only" ? 1 : WELCOME_DAYS.length;
  const next = row.step + 1;
  if (next > last) {
    await db
      .update(emailSequences)
      .set({ step: next, nextAt: null, doneAt: nowIso(now) })
      .where(and(eq(emailSequences.userId, row.userId), eq(emailSequences.sequence, row.sequence)));
    return;
  }
  const due = new Date(Date.parse(row.startedAt) + (WELCOME_DAYS[next - 1] ?? 0) * 86_400_000);
  await db
    .update(emailSequences)
    .set({ step: next, nextAt: nowIso(due < now ? now : due) })
    .where(and(eq(emailSequences.userId, row.userId), eq(emailSequences.sequence, row.sequence)));
}

/** Stop a sequence early: the reader unsubscribed, or the step no longer applies. */
export async function endSequence(db: Db, userId: string, sequence: Sequence, now = new Date()) {
  await db
    .update(emailSequences)
    .set({ nextAt: null, doneAt: nowIso(now) })
    .where(and(eq(emailSequences.userId, userId), eq(emailSequences.sequence, sequence)));
}
