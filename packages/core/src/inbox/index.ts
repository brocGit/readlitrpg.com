// The Owner Inbox (DESIGN §8). M0 opens system alerts (dead-lettered messages, a broken audit
// chain). Approval types, default actions and undo arrive with the owner console in M7.

import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { type InboxStatus, inboxItems } from "../db/schema";
import { ulid } from "../ids";
import { nowIso } from "../time";

export type InboxItem = typeof inboxItems.$inferSelect;

export interface NewInboxItem {
  type: string;
  title: string;
  subjectType?: string;
  subjectId?: string;
  payload?: unknown;
  /** Higher is more urgent. 100 = page the owner. */
  priority?: number;
  /** When set, a second item with the same key is not opened while the first exists. */
  dedupeKey?: string;
  dueAt?: string;
}

/** Open an item. Returns the new item, or null if one with the same dedupe key already exists. */
export async function openInboxItem(db: Db, item: NewInboxItem): Promise<InboxItem | null> {
  const now = nowIso();
  const rows = await db
    .insert(inboxItems)
    .values({
      id: ulid(),
      type: item.type,
      title: item.title.slice(0, 200),
      subjectType: item.subjectType ?? null,
      subjectId: item.subjectId ?? null,
      payload: item.payload ?? null,
      priority: item.priority ?? 50,
      dedupeKey: item.dedupeKey ?? null,
      dueAt: item.dueAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: inboxItems.dedupeKey })
    .returning();
  return rows[0] ?? null;
}

export const OPEN_STATUSES: InboxStatus[] = ["open", "snoozed"];

export async function listOpenInbox(db: Db, limit = 100): Promise<InboxItem[]> {
  return db
    .select()
    .from(inboxItems)
    .where(inArray(inboxItems.status, OPEN_STATUSES))
    .orderBy(desc(inboxItems.priority), desc(inboxItems.createdAt))
    .limit(limit);
}

/** Close an item. Only open or snoozed items can be decided; returns false if it was already closed. */
export async function decideInboxItem(
  db: Db,
  id: string,
  decision: {
    status: Exclude<InboxStatus, "open" | "snoozed">;
    decidedBy: string;
    reasonCode?: string;
    note?: string;
  },
): Promise<boolean> {
  const now = nowIso();
  const rows = await db
    .update(inboxItems)
    .set({
      status: decision.status,
      decidedBy: decision.decidedBy,
      decidedAt: now,
      reasonCode: decision.reasonCode ?? null,
      note: decision.note ?? null,
      updatedAt: now,
    })
    .where(and(eq(inboxItems.id, id), inArray(inboxItems.status, OPEN_STATUSES)))
    .returning({ id: inboxItems.id });
  return rows.length === 1;
}
