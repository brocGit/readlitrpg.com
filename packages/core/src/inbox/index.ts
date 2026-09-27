// The Owner Inbox (DESIGN §8). M0 opens system alerts (dead-lettered messages, a broken audit
// chain); M2 adds editorial review items and default actions for items whose effect is already
// applied. Approval types with side effects, bulk actions and undo arrive with M7.

import { and, desc, eq, inArray, lte } from "drizzle-orm";
import type { Db } from "../db";
import { type INBOX_RECOMMENDATIONS, type InboxStatus, inboxItems } from "../db/schema";
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
  aiSummary?: string;
  aiRecommendation?: (typeof INBOX_RECOMMENDATIONS)[number];
  /** What happens if the owner doesn't act (DESIGN §8.2), and when. */
  defaultAction?: "approve" | "reject" | "expire" | "none";
  defaultActionAt?: string;
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
      aiSummary: item.aiSummary?.slice(0, 1000) ?? null,
      aiRecommendation: item.aiRecommendation ?? null,
      defaultAction: item.defaultAction ?? "none",
      defaultActionAt:
        item.defaultAction && item.defaultAction !== "none" ? (item.defaultActionAt ?? null) : null,
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

export async function getInboxItem(db: Db, id: string): Promise<InboxItem | null> {
  const [row] = await db.select().from(inboxItems).where(eq(inboxItems.id, id));
  return row ?? null;
}

/**
 * Items whose default action needs no side effect: the change is already live and the item only
 * asks the owner to look (e.g. a low-confidence tag check). Their default closes the item.
 * Types with side effects register handlers as they arrive (M6–M7).
 */
export const CLOSE_ONLY_DEFAULT_TYPES: ReadonlySet<string> = new Set(["tag_check", "scope_check"]);

/** Run due default actions (DESIGN §7.9: every heartbeat). Returns how many items were closed. */
export async function runInboxDefaults(db: Db, now = new Date()): Promise<number> {
  const due = await db
    .select()
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.status, "open"),
        inArray(inboxItems.type, [...CLOSE_ONLY_DEFAULT_TYPES]),
        lte(inboxItems.defaultActionAt, now.toISOString()),
      ),
    )
    .limit(100);
  let closed = 0;
  for (const item of due) {
    const status =
      item.defaultAction === "approve"
        ? "auto_approved"
        : item.defaultAction === "reject"
          ? "auto_rejected"
          : "expired";
    if (item.defaultAction === "none") continue;
    if (
      await decideInboxItem(db, item.id, {
        status,
        decidedBy: "system:default_action",
        reasonCode: "default_action",
      })
    ) {
      closed++;
    }
  }
  return closed;
}
