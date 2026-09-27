// The editorial work queue (DESIGN §7.1, §7.13). The jobs Worker fills it; runs claim items in
// priority order through the editorial API. A claim expires after `editorial.claim_hours`, so a run
// that dies mid-way never strands work.

import { and, asc, count, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db";
import { type EditorialKind, editorialQueue, type QueueStatus } from "../db/schema";
import { ulid } from "../ids";
import { addSeconds, nowIso } from "../time";

export type QueueItem = typeof editorialQueue.$inferSelect;

export interface EnqueueInput {
  kind: EditorialKind;
  subjectType: string;
  subjectId: string;
  priority: number;
  payload?: unknown;
  dueAt?: string;
}

/** The one-open-item-per-cause key. */
export function openKeyFor(item: Pick<EnqueueInput, "kind" | "subjectType" | "subjectId">): string {
  return `${item.kind}:${item.subjectType}:${item.subjectId}`;
}

/** Add work. Items whose cause already has an open item are skipped. Returns how many were added. */
export async function enqueue(db: Db, items: EnqueueInput[]): Promise<number> {
  if (items.length === 0) return 0;
  const now = nowIso();
  let added = 0;
  // Twelve columns a row: eight rows keep a statement under D1's 100 bound parameters.
  for (let i = 0; i < items.length; i += 8) {
    const rows = await db
      .insert(editorialQueue)
      .values(
        items.slice(i, i + 8).map((item) => ({
          id: ulid(),
          kind: item.kind,
          subjectType: item.subjectType,
          subjectId: item.subjectId,
          payload: item.payload ?? null,
          priority: item.priority,
          status: "queued" as const,
          openKey: openKeyFor(item),
          dueAt: item.dueAt ?? null,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing({ target: editorialQueue.openKey })
      .returning({ id: editorialQueue.id });
    added += rows.length;
  }
  return added;
}

export interface ClaimOptions {
  runId: string;
  kinds: EditorialKind[];
  limit: number;
  claimHours: number;
  now?: Date;
}

/**
 * Claim the most urgent queued items in one statement. D1 runs statements one at a time, so two
 * runs pulling at once can never claim the same item.
 */
export async function claimItems(db: Db, opts: ClaimOptions): Promise<QueueItem[]> {
  const now = (opts.now ?? new Date()).toISOString();
  const next = db
    .select({ id: editorialQueue.id })
    .from(editorialQueue)
    .where(and(eq(editorialQueue.status, "queued"), inArray(editorialQueue.kind, opts.kinds)))
    .orderBy(desc(editorialQueue.priority), asc(editorialQueue.createdAt))
    .limit(opts.limit);
  const rows = await db
    .update(editorialQueue)
    .set({
      status: "claimed",
      claimedByRun: opts.runId,
      claimedAt: now,
      claimExpiresAt: addSeconds(now, opts.claimHours * 3600),
      attempts: sql`${editorialQueue.attempts} + 1`,
      updatedAt: now,
    })
    .where(inArray(editorialQueue.id, next))
    .returning();
  // RETURNING comes back in table order; hand the run its work most urgent first.
  return rows.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
}

/** Items this run holds, by id. Anything not claimed by the run is left out. */
export async function claimedByRun(db: Db, runId: string, ids: string[]): Promise<Map<string, QueueItem>> {
  const out = new Map<string, QueueItem>();
  for (let i = 0; i < ids.length; i += 90) {
    const rows = await db
      .select()
      .from(editorialQueue)
      .where(
        and(
          inArray(editorialQueue.id, ids.slice(i, i + 90)),
          eq(editorialQueue.claimedByRun, runId),
          eq(editorialQueue.status, "claimed"),
        ),
      );
    for (const r of rows) out.set(r.id, r);
  }
  return out;
}

/** Close an item. Clearing the open key lets the same cause be queued again later. */
export async function closeItem(
  db: Db,
  id: string,
  status: Extract<QueueStatus, "done" | "rejected" | "expired">,
) {
  const now = nowIso();
  await db
    .update(editorialQueue)
    .set({ status, openKey: null, doneAt: now, updatedAt: now })
    .where(eq(editorialQueue.id, id));
}

/** Put a run's unanswered items back in the queue (when it finishes, or is abandoned). */
export async function releaseRunClaims(db: Db, runId: string): Promise<number> {
  const now = nowIso();
  const rows = await db
    .update(editorialQueue)
    .set({ status: "queued", claimedByRun: null, claimedAt: null, claimExpiresAt: null, updatedAt: now })
    .where(and(eq(editorialQueue.claimedByRun, runId), eq(editorialQueue.status, "claimed")))
    .returning({ id: editorialQueue.id });
  return rows.length;
}

/** Items tried this many times without an answer are expired instead of requeued. */
export const MAX_ATTEMPTS = 3;

export async function expireStaleClaims(
  db: Db,
  now = new Date(),
): Promise<{ released: number; expired: number }> {
  const nowText = now.toISOString();
  const stale = and(eq(editorialQueue.status, "claimed"), lt(editorialQueue.claimExpiresAt, nowText));
  const expired = await db
    .update(editorialQueue)
    .set({ status: "expired", openKey: null, doneAt: nowText, updatedAt: nowText })
    .where(and(stale, sql`${editorialQueue.attempts} >= ${MAX_ATTEMPTS}`))
    .returning({ id: editorialQueue.id });
  const released = await db
    .update(editorialQueue)
    .set({ status: "queued", claimedByRun: null, claimedAt: null, claimExpiresAt: null, updatedAt: nowText })
    .where(stale)
    .returning({ id: editorialQueue.id });
  return { released: released.length, expired: expired.length };
}

export interface QueueDepth {
  kind: EditorialKind;
  status: QueueStatus;
  n: number;
  oldest: string | null;
}

export async function queueDepth(db: Db): Promise<QueueDepth[]> {
  return db
    .select({
      kind: editorialQueue.kind,
      status: editorialQueue.status,
      n: count(),
      oldest: sql<string | null>`min(${editorialQueue.createdAt})`,
    })
    .from(editorialQueue)
    .where(inArray(editorialQueue.status, ["queued", "claimed"]))
    .groupBy(editorialQueue.kind, editorialQueue.status);
}

/** The oldest queued item, for the watchdog: work that sits unclaimed is what the owner must hear about. */
export async function oldestQueued(db: Db): Promise<string | null> {
  const [row] = await db
    .select({ createdAt: editorialQueue.createdAt })
    .from(editorialQueue)
    .where(and(eq(editorialQueue.status, "queued"), isNotNull(editorialQueue.createdAt)))
    .orderBy(asc(editorialQueue.createdAt))
    .limit(1);
  return row?.createdAt ?? null;
}
