// Editorial runs (DESIGN §7.1 step 5): one row per Claude session, plus audit entries when it
// starts and finishes. The run's counters feed the circuit breaker (§7.11) and the watchdog (§7.13).

import { and, desc, eq, lt, sql } from "drizzle-orm";
import { appendAudit } from "../audit";
import type { Db } from "../db";
import { editorialRuns } from "../db/schema";
import { ulid } from "../ids";
import { circuitTrips } from "../policy/publish";
import { addHours, nowIso } from "../time";
import { releaseRunClaims } from "./queue";

export type EditorialRun = typeof editorialRuns.$inferSelect;

export async function startRun(
  db: Db,
  input: { kind: EditorialRun["kind"]; label?: string; skills?: Record<string, string> },
): Promise<EditorialRun> {
  const run = {
    id: ulid(),
    kind: input.kind,
    label: input.label ?? null,
    status: "running" as const,
    startedAt: nowIso(),
    skills: input.skills ?? null,
  };
  const [row] = await db.insert(editorialRuns).values(run).returning();
  await appendAudit(db, {
    actor: { type: "editorial_run", id: run.id },
    action: "editorial.run_start",
    subjectType: "editorial_run",
    subjectId: run.id,
    diff: { kind: run.kind, label: run.label, skills: run.skills },
  });
  if (!row) throw new Error("startRun: insert returned nothing");
  return row;
}

export async function getRun(db: Db, id: string): Promise<EditorialRun | null> {
  const [row] = await db.select().from(editorialRuns).where(eq(editorialRuns.id, id));
  return row ?? null;
}

export async function listRuns(db: Db, limit = 50): Promise<EditorialRun[]> {
  return db.select().from(editorialRuns).orderBy(desc(editorialRuns.startedAt)).limit(limit);
}

export interface OutcomeCounts {
  accepted?: number;
  rejected?: number;
  held?: number;
  claimed?: number;
}

/** Add to a run's counters, then trip the circuit breaker if too much has failed validation. */
export async function recordOutcomes(
  db: Db,
  runId: string,
  delta: OutcomeCounts,
  circuit: { rejectShare: number; minProposals: number },
): Promise<EditorialRun | null> {
  const [row] = await db
    .update(editorialRuns)
    .set({
      itemsClaimed: sql`${editorialRuns.itemsClaimed} + ${delta.claimed ?? 0}`,
      proposalsAccepted: sql`${editorialRuns.proposalsAccepted} + ${delta.accepted ?? 0}`,
      proposalsRejected: sql`${editorialRuns.proposalsRejected} + ${delta.rejected ?? 0}`,
      proposalsHeld: sql`${editorialRuns.proposalsHeld} + ${delta.held ?? 0}`,
    })
    .where(eq(editorialRuns.id, runId))
    .returning();
  if (!row || row.circuitOpen) return row ?? null;
  const trips = circuitTrips(
    { accepted: row.proposalsAccepted, rejected: row.proposalsRejected, held: row.proposalsHeld },
    circuit,
  );
  if (!trips) return row;
  const [opened] = await db
    .update(editorialRuns)
    .set({ circuitOpen: true })
    .where(eq(editorialRuns.id, runId))
    .returning();
  await appendAudit(db, {
    actor: { type: "system", id: "editorial.circuit" },
    action: "editorial.circuit_open",
    subjectType: "editorial_run",
    subjectId: runId,
    diff: { accepted: row.proposalsAccepted, rejected: row.proposalsRejected, held: row.proposalsHeld },
  });
  return opened ?? row;
}

export async function finishRun(
  db: Db,
  runId: string,
  input: { status: "succeeded" | "failed" | "abandoned"; notes?: string; actor?: "editorial_run" | "system" },
): Promise<EditorialRun | null> {
  const released = await releaseRunClaims(db, runId);
  const [row] = await db
    .update(editorialRuns)
    .set({ status: input.status, finishedAt: nowIso(), notes: input.notes ?? null })
    .where(and(eq(editorialRuns.id, runId), eq(editorialRuns.status, "running")))
    .returning();
  if (!row) return null;
  await appendAudit(db, {
    actor:
      input.actor === "system"
        ? { type: "system", id: "editorial.watchdog" }
        : { type: "editorial_run", id: runId },
    action: "editorial.run_finish",
    subjectType: "editorial_run",
    subjectId: runId,
    diff: {
      status: row.status,
      claimed: row.itemsClaimed,
      accepted: row.proposalsAccepted,
      rejected: row.proposalsRejected,
      held: row.proposalsHeld,
      released,
      circuitOpen: row.circuitOpen,
    },
  });
  return row;
}

/** A run still "running" after this long has died without finishing. */
export const RUN_MAX_HOURS = 12;

export async function abandonStaleRuns(db: Db, now = new Date()): Promise<number> {
  const cutoff = addHours(now.toISOString(), -RUN_MAX_HOURS);
  const stale = await db
    .select({ id: editorialRuns.id })
    .from(editorialRuns)
    .where(and(eq(editorialRuns.status, "running"), lt(editorialRuns.startedAt, cutoff)));
  for (const r of stale) {
    await finishRun(db, r.id, { status: "abandoned", notes: "no finish within 12 hours", actor: "system" });
  }
  return stale.length;
}

export async function lastSucceededRun(db: Db): Promise<EditorialRun | null> {
  const [row] = await db
    .select()
    .from(editorialRuns)
    .where(eq(editorialRuns.status, "succeeded"))
    .orderBy(desc(editorialRuns.finishedAt))
    .limit(1);
  return row ?? null;
}
