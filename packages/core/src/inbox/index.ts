// The Owner Inbox (DESIGN §8). M0 opens system alerts (dead-lettered messages, a broken audit
// chain); M2 adds editorial review items and default actions for items whose effect is already
// applied; M6 and M7 add types whose decision acts, snooze, bulk approval of low-risk items, and
// undo: a decision's handler returns how to reverse it, and that goes in the audit log (§8.3).

import { and, asc, desc, eq, inArray, isNotNull, lte, type SQL, sql } from "drizzle-orm";
import { appendAudit } from "../audit";
import type { StripeApi } from "../billing/stripe";
import { isProAuthor } from "../billing/subscriptions";
import type { Db } from "../db";
import {
  authors,
  type INBOX_RECOMMENDATIONS,
  type InboxStatus,
  inboxItems,
  type TRUST_LEVELS,
} from "../db/schema";
import { ulid } from "../ids";
import type { Settings } from "../settings";
import { nowIso } from "../time";
import type { UndoSpec } from "../undo";

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
  /** 0–100, from automated checks (an ad creative's flags, a guest post's review). */
  riskScore?: number;
  /** What happens if the owner doesn't act (DESIGN §8.2), and when. */
  defaultAction?: "approve" | "reject" | "expire" | "none";
  defaultActionAt?: string;
}

/** Open an item. Returns the new item, or null if one with the same dedupe key already exists. */
export async function openInboxItem(db: Db, item: NewInboxItem): Promise<InboxItem | null> {
  const now = nowIso();
  // Author Pro's priority review (M8): items about a Pro author sort ahead, short of "urgent".
  const authorId = (item.payload as { authorId?: unknown } | null | undefined)?.authorId;
  const base = item.priority ?? 50;
  const priority =
    typeof authorId === "string" && base < 79 && (await isProAuthor(db, authorId))
      ? Math.min(79, base + 15)
      : base;
  const rows = await db
    .insert(inboxItems)
    .values({
      id: ulid(),
      type: item.type,
      title: item.title.slice(0, 200),
      subjectType: item.subjectType ?? null,
      subjectId: item.subjectId ?? null,
      payload: item.payload ?? null,
      priority,
      dedupeKey: item.dedupeKey ?? null,
      dueAt: item.dueAt ?? null,
      aiSummary: item.aiSummary?.slice(0, 1000) ?? null,
      aiRecommendation: item.aiRecommendation ?? null,
      riskScore: item.riskScore ?? null,
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

/** Priority first, then whatever is due soonest (a deadline or a default action), then newest. */
const inboxOrder: SQL[] = [
  desc(inboxItems.priority),
  sql`coalesce(${inboxItems.dueAt}, ${inboxItems.defaultActionAt}) is null`,
  asc(sql`coalesce(${inboxItems.dueAt}, ${inboxItems.defaultActionAt})`),
  desc(inboxItems.createdAt),
];

/** Open items; snoozed ones only when asked for (they come back by themselves). */
export async function listOpenInbox(
  db: Db,
  limit = 100,
  opts: { snoozed?: boolean } = {},
): Promise<InboxItem[]> {
  return db
    .select()
    .from(inboxItems)
    .where(opts.snoozed ? eq(inboxItems.status, "snoozed") : eq(inboxItems.status, "open"))
    .orderBy(...inboxOrder)
    .limit(limit);
}

/** Open items and how many of them are urgent (priority 80+), in one query: the console's inbox badge. */
export async function countOpenInbox(db: Db): Promise<{ open: number; urgent: number }> {
  const [row] = await db
    .select({
      open: sql<number>`count(*)`,
      urgent: sql<number>`coalesce(sum(case when ${inboxItems.priority} >= 80 then 1 else 0 end), 0)`,
    })
    .from(inboxItems)
    .where(eq(inboxItems.status, "open"));
  return { open: Number(row?.open ?? 0), urgent: Number(row?.urgent ?? 0) };
}

export async function countSnoozed(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(inboxItems)
    .where(eq(inboxItems.status, "snoozed"));
  return Number(row?.n ?? 0);
}

export const SNOOZE_CHOICES = [
  { key: "4h", label: "4 hours", hours: 4 },
  { key: "1d", label: "Tomorrow", hours: 24 },
  { key: "3d", label: "3 days", hours: 72 },
  { key: "1w", label: "A week", hours: 168 },
] as const;

/** Hide an open item until `until`. Its default action still runs on time. */
export async function snoozeInboxItem(db: Db, id: string, until: Date, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(inboxItems)
    .set({ status: "snoozed", snoozedUntil: until.toISOString(), updatedAt: nowIso(now) })
    .where(and(eq(inboxItems.id, id), eq(inboxItems.status, "open")))
    .returning({ id: inboxItems.id });
  return rows.length === 1;
}

/** "Wake now" from the snoozed list. */
export async function wakeInboxItem(db: Db, id: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(inboxItems)
    .set({ status: "open", snoozedUntil: null, updatedAt: nowIso(now) })
    .where(and(eq(inboxItems.id, id), eq(inboxItems.status, "snoozed")))
    .returning({ id: inboxItems.id });
  return rows.length === 1;
}

/** Bring back snoozed items whose time is up (every heartbeat). */
export async function wakeSnoozed(db: Db, now = new Date()): Promise<number> {
  const rows = await db
    .update(inboxItems)
    .set({ status: "open", snoozedUntil: null, updatedAt: nowIso(now) })
    .where(
      and(
        eq(inboxItems.status, "snoozed"),
        isNotNull(inboxItems.snoozedUntil),
        lte(inboxItems.snoozedUntil, now.toISOString()),
      ),
    )
    .returning({ id: inboxItems.id });
  return rows.length;
}

/** Canned reasons for a rejection (§8.1). The text goes to the author unless the owner writes one. */
export const REJECT_REASONS = [
  { code: "out_of_scope", label: "Out of scope", text: "It's outside what ReadLitRPG covers." },
  { code: "duplicate", label: "Duplicate", text: "We already have this." },
  {
    code: "unverifiable",
    label: "Can't verify",
    text: "We couldn't confirm the details from a public source.",
  },
  {
    code: "quality",
    label: "Not ready",
    text: "It doesn't meet our standards yet. You're welcome to try again.",
  },
  { code: "policy", label: "Against policy", text: "It breaks our content policy." },
  { code: "other", label: "Other (write a note)", text: "" },
] as const;

export function rejectNote(code: string | undefined, note: string | undefined): string | undefined {
  const typed = note?.trim();
  if (typed) return typed;
  return REJECT_REASONS.find((r) => r.code === code)?.text || undefined;
}

/** "Auto-approves in 2 d 4 h", "Closes itself in 3 h", or "Waits for you". */
export function countdown(item: InboxItem, now = new Date()): string {
  if (!item.defaultActionAt || !item.defaultAction || item.defaultAction === "none") return "Waits for you";
  const verb =
    item.defaultAction === "approve"
      ? CLOSE_ONLY_DEFAULT_TYPES.has(item.type)
        ? "Closes itself"
        : "Auto-approves"
      : item.defaultAction === "reject"
        ? "Auto-rejects"
        : "Expires";
  const ms = Date.parse(item.defaultActionAt) - now.getTime();
  if (ms <= 0) return `${verb} on the next check`;
  const h = Math.floor(ms / 3_600_000);
  const d = Math.floor(h / 24);
  const left =
    d > 0 ? `${d} d ${h % 24} h` : h > 0 ? `${h} h` : `${Math.max(1, Math.round(ms / 60_000))} min`;
  return `${verb} in ${left}`;
}

/**
 * Items safe to approve in bulk (§8.1): they would approve themselves anyway or the review says
 * approve, nobody flagged them, and they aren't urgent. Anything needing judgment stays out.
 */
export function isLowRisk(item: InboxItem, handlers: Record<string, InboxHandler>, maxRisk: number): boolean {
  if (item.status !== "open") return false;
  if (!handlers[item.type]?.approve && !CLOSE_ONLY_DEFAULT_TYPES.has(item.type)) return false;
  if (JUDGMENT_TYPES.has(item.type) || item.priority >= 80) return false;
  if (item.aiRecommendation === "reject" || item.aiRecommendation === "escalate") return false;
  if ((item.riskScore ?? 0) > maxRisk) return false;
  return item.defaultAction === "approve" || item.aiRecommendation === "approve";
}

/** Types that always need the owner's own eyes, whatever a review says. */
const JUDGMENT_TYPES: ReadonlySet<string> = new Set([
  "possible_duplicate",
  "claim_conflict",
  "protected_change",
  "verification_manual",
  "security_event",
  "dispute",
  "refund_request",
  "rights_request",
]);

const LEVELS: readonly (typeof TRUST_LEVELS)[number][] = ["T-1", "T0", "T1", "T2"];

/** The author an item is about, if any (submissions, edits, guest posts carry one). */
export function itemAuthorId(item: InboxItem): string | null {
  const p = item.payload as Record<string, unknown> | null;
  const v = p && typeof p === "object" ? p.authorId : null;
  return typeof v === "string" && v ? v : null;
}

/**
 * "Trust this author" (§8.1): one step up, to T1 at most. T2 (ads without review) is set on the
 * author's page, never from a card. Returns the change for the audit log and its undo.
 */
export async function trustAuthor(
  db: Db,
  authorId: string,
  now = new Date(),
): Promise<{ from: string; to: string } | null> {
  const [a] = await db.select({ trust: authors.trustLevel }).from(authors).where(eq(authors.id, authorId));
  if (!a) return null;
  const i = LEVELS.indexOf(a.trust as (typeof LEVELS)[number]);
  const to = LEVELS[Math.min(i + 1, LEVELS.indexOf("T1"))];
  if (!to || i >= LEVELS.indexOf("T1")) return null;
  await db
    .update(authors)
    .set({ trustLevel: to, updatedAt: nowIso(now) })
    .where(eq(authors.id, authorId));
  return { from: a.trust, to };
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
 */
export const CLOSE_ONLY_DEFAULT_TYPES: ReadonlySet<string> = new Set(["tag_check", "scope_check"]);

export interface InboxDecisionContext {
  decidedBy: string;
  note?: string;
  now: Date;
  settings: Settings;
  /** Where links in posts a decision publishes point (M7). */
  renderEnv?: { origin: string; mediaOrigin: string };
  /** For decisions that refund (rejecting a paid ad, M8). Null where Stripe isn't configured. */
  stripe?: StripeApi | null;
  /** For decisions that change a setting (approving price suggestions, M8). */
  kv?: KVNamespace;
}

/**
 * What approving or rejecting an item of one type does (e.g. publish a listing). A handler returns
 * how to reverse what it did, when that can be done (§8.3); the caller audits it.
 */
export interface InboxHandler {
  approve?(db: Db, item: InboxItem, ctx: InboxDecisionContext): HandlerResult;
  reject?(db: Db, item: InboxItem, ctx: InboxDecisionContext): HandlerResult;
}

// biome-ignore lint/suspicious/noConfusingVoidType: a handler with nothing to undo returns nothing.
export type HandlerResult = Promise<UndoSpec | null | undefined | void>;

export interface DecideOutcome {
  /** False when the item was already closed. */
  changed: boolean;
  undo: UndoSpec | null;
}

/**
 * Decide an item: run its handler's side effect, then close it. Handlers are idempotent, so an
 * item decided twice at once (a click racing the default) does its work once in effect.
 */
export async function decideWithHandler(
  db: Db,
  item: InboxItem,
  decision: "approve" | "reject",
  handlers: Record<string, InboxHandler>,
  ctx: InboxDecisionContext & { reasonCode?: string },
  status?: Exclude<InboxStatus, "open" | "snoozed">,
): Promise<DecideOutcome> {
  if (!OPEN_STATUSES.includes(item.status as InboxStatus)) return { changed: false, undo: null };
  const undo = (await handlers[item.type]?.[decision]?.(db, item, ctx)) ?? null;
  const changed = await decideInboxItem(db, item.id, {
    status: status ?? (decision === "approve" ? "approved" : "rejected"),
    decidedBy: ctx.decidedBy,
    note: ctx.note,
    reasonCode: status?.startsWith("auto_") ? "default_action" : ctx.reasonCode,
  });
  return { changed, undo: changed ? undo : null };
}

/** Run due default actions (DESIGN §7.9: every heartbeat). Returns how many items were closed. */
export async function runInboxDefaults(
  db: Db,
  now = new Date(),
  opts: {
    handlers?: Record<string, InboxHandler>;
    settings?: Settings;
    renderEnv?: InboxDecisionContext["renderEnv"];
    stripe?: StripeApi | null;
  } = {},
): Promise<number> {
  const handlers = opts.handlers ?? {};
  const types = [...new Set([...CLOSE_ONLY_DEFAULT_TYPES, ...Object.keys(handlers)])];
  // Snoozed items too: snoozing hides an item from the owner, it doesn't hold anyone up.
  const due = await db
    .select()
    .from(inboxItems)
    .where(
      and(
        inArray(inboxItems.status, OPEN_STATUSES),
        inArray(inboxItems.type, types),
        lte(inboxItems.defaultActionAt, now.toISOString()),
      ),
    )
    .limit(100);
  let closed = 0;
  for (const item of due) {
    if (item.defaultAction === "none" || !item.defaultAction) continue;
    const decision = item.defaultAction === "reject" ? "reject" : "approve";
    const status =
      item.defaultAction === "approve"
        ? "auto_approved"
        : item.defaultAction === "reject"
          ? "auto_rejected"
          : "expired";
    let outcome: DecideOutcome = { changed: false, undo: null };
    if (handlers[item.type] && opts.settings && item.defaultAction !== "expire") {
      outcome = await decideWithHandler(
        db,
        item,
        decision,
        handlers,
        {
          decidedBy: "system:default_action",
          now,
          settings: opts.settings,
          renderEnv: opts.renderEnv,
          stripe: opts.stripe,
        },
        status,
      );
    } else if (CLOSE_ONLY_DEFAULT_TYPES.has(item.type)) {
      outcome.changed = await decideInboxItem(db, item.id, {
        status,
        decidedBy: "system:default_action",
        reasonCode: "default_action",
      });
    }
    if (!outcome.changed) continue;
    closed++;
    // Every automated decision is on the record, with its undo (§8.3, the weekly summary's list).
    await appendAudit(db, {
      actor: { type: "system", id: "default_action" },
      action: "inbox.default_action",
      subjectType: "inbox_item",
      subjectId: item.id,
      diff: {
        type: item.type,
        title: item.title,
        status,
        ...(outcome.undo ? { undo: outcome.undo } : {}),
      },
    });
  }
  return closed;
}
