// What the owner hears about, and when (DESIGN §8.4): a daily action email only when something is
// due or urgent, a Sunday summary, and instant alerts for the few things that can't wait. These
// functions gather the facts; the jobs Worker renders and sends them.

import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  sum,
} from "drizzle-orm";
import type { Db } from "../db";
import {
  adSlots,
  auditLog,
  authorMembers,
  bookings,
  books,
  campaigns,
  emailConsents,
  inboxItems,
  inventoryUnits,
  orders,
  pageViewsDaily,
  posts,
  quizTakes,
  refunds,
  subscriptions,
  users,
} from "../db/schema";
import { type InboxItem, OPEN_STATUSES } from "../inbox";
import { nowIso } from "../time";
import { undoOf } from "../undo";

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Admins get the owner's email. Only verified, active accounts. */
export async function ownerEmails(db: Db): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.isAdmin, true), eq(users.emailVerified, true), eq(users.state, "active")))
    .limit(5);
  return rows.map((r) => r.email);
}

/** Types that always alert at once, whatever their priority (§8.4). */
export const INSTANT_TYPES: ReadonlySet<string> = new Set([
  "security_event",
  "dispute",
  "editorial_run_held",
  "editorial_stale",
]);

/**
 * Items to alert about now: urgent and not yet alerted. Only recent ones, so a first deploy
 * doesn't page the owner about an old backlog.
 */
export async function pendingAlerts(db: Db, minPriority: number, now = new Date()): Promise<InboxItem[]> {
  return db
    .select()
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.status, "open"),
        isNull(inboxItems.alertedAt),
        gte(inboxItems.createdAt, iso(now.getTime() - 2 * DAY)),
        or(gte(inboxItems.priority, minPriority), inArray(inboxItems.type, [...INSTANT_TYPES])),
      ),
    )
    .orderBy(desc(inboxItems.priority))
    .limit(20);
}

export async function markAlerted(db: Db, ids: string[], now = new Date()): Promise<void> {
  for (let i = 0; i < ids.length; i += 90)
    await db
      .update(inboxItems)
      .set({ alertedAt: nowIso(now) })
      .where(inArray(inboxItems.id, ids.slice(i, i + 90)));
}

export interface DailyAction {
  due: InboxItem[];
  urgent: InboxItem[];
  open: number;
}

/** The daily action email's content, or null when nothing needs the owner (then no email). */
export async function dailyActions(db: Db, now = new Date()): Promise<DailyAction | null> {
  const soon = iso(now.getTime() + 2 * DAY);
  const due = await db
    .select()
    .from(inboxItems)
    .where(
      and(
        inArray(inboxItems.status, OPEN_STATUSES),
        or(lte(inboxItems.dueAt, soon), lte(inboxItems.defaultActionAt, soon)),
      ),
    )
    .orderBy(asc(sql`coalesce(${inboxItems.dueAt}, ${inboxItems.defaultActionAt})`))
    .limit(30);
  const urgent = await db
    .select()
    .from(inboxItems)
    .where(and(eq(inboxItems.status, "open"), gte(inboxItems.priority, 80)))
    .orderBy(desc(inboxItems.priority))
    .limit(30);
  const dueIds = new Set(due.map((d) => d.id));
  const onlyUrgent = urgent.filter((u) => !dueIds.has(u.id));
  if (!due.length && !onlyUrgent.length) return null;
  const [open] = await db
    .select({ n: count() })
    .from(inboxItems)
    .where(inArray(inboxItems.status, OPEN_STATUSES));
  return { due, urgent: onlyUrgent, open: open?.n ?? 0 };
}

export interface WeeklySummary {
  from: string;
  to: string;
  kpis: { layer: string; line: string }[];
  inbox: {
    opened: number;
    ownerDecided: number;
    autoDecided: number;
    openNow: number;
    automationRate: number;
  };
  /** Automated decisions of the week that can still be undone. */
  autoApproved: { auditId: string; title: string; status: string; undoable: boolean }[];
  scheduledPosts: { title: string; publishAt: string }[];
  bookedAds: { campaign: string; slot: string; periodStart: string }[];
  liveCampaigns: number;
}

const n = (v: unknown) => Number(v ?? 0);

export async function weeklySummary(db: Db, now = new Date()): Promise<WeeklySummary> {
  const weekAgo = iso(now.getTime() - 7 * DAY);
  const weekAhead = iso(now.getTime() + 7 * DAY);
  const today = now.toISOString().slice(0, 10);
  const dayAgo7 = weekAgo.slice(0, 10);

  const [weekly] = await db
    .select({
      total: count(),
      fresh: sql<number>`sum(case when ${emailConsents.confirmedAt} >= ${weekAgo} then 1 else 0 end)`,
    })
    .from(emailConsents)
    .where(and(eq(emailConsents.list, "weekly_digest"), eq(emailConsents.status, "active")));
  const [daily] = await db
    .select({ total: count() })
    .from(emailConsents)
    .where(and(eq(emailConsents.list, "daily_digest"), eq(emailConsents.status, "active")));
  const [catalog] = await db
    .select({
      total: count(),
      fresh: sql<number>`sum(case when ${books.publishedAt} >= ${weekAgo} then 1 else 0 end)`,
    })
    .from(books)
    .where(and(eq(books.visibility, "published"), isNull(books.redirectTo)));
  const [claimed] = await db.select({ total: countDistinct(authorMembers.authorId) }).from(authorMembers);
  const [claimedNew] = await db
    .select({ n: countDistinct(authorMembers.authorId) })
    .from(authorMembers)
    .where(gte(authorMembers.createdAt, weekAgo));
  const [views] = await db
    .select({ n: sum(pageViewsDaily.views) })
    .from(pageViewsDaily)
    .where(and(gte(pageViewsDaily.day, dayAgo7), lt(pageViewsDaily.day, today)));
  const [takes] = await db.select({ n: count() }).from(quizTakes).where(gte(quizTakes.createdAt, weekAgo));
  const [published] = await db
    .select({ n: count() })
    .from(posts)
    .where(and(eq(posts.status, "published"), gte(posts.publishedAt, weekAgo)));

  // Money (M8): card payments and refunds this week, and the subscriptions paying now.
  const [revenue] = await db
    .select({ n: sum(orders.chargedCents), c: count() })
    .from(orders)
    .where(
      and(
        gte(orders.paidAt, weekAgo),
        inArray(orders.status, ["paid", "partially_refunded", "refunded", "disputed"]),
      ),
    );
  const [refunded] = await db
    .select({ n: sum(refunds.amountCents) })
    .from(refunds)
    .where(
      and(gte(refunds.createdAt, weekAgo), eq(refunds.toCredits, false), eq(refunds.status, "succeeded")),
    );
  const [pros] = await db
    .select({ n: count() })
    .from(subscriptions)
    .where(inArray(subscriptions.status, ["active", "trialing", "past_due"]));

  const [opened] = await db.select({ n: count() }).from(inboxItems).where(gte(inboxItems.createdAt, weekAgo));
  const decided = await db
    .select({ auto: sql<number>`${inboxItems.decidedBy} like 'system:%'`.as("auto"), n: count() })
    .from(inboxItems)
    .where(gte(inboxItems.decidedAt, weekAgo))
    .groupBy(sql`auto`);
  const autoDecided = n(decided.find((d) => n(d.auto) === 1)?.n);
  const ownerDecided = n(decided.find((d) => n(d.auto) !== 1)?.n);
  const [openNow] = await db
    .select({ n: count() })
    .from(inboxItems)
    .where(inArray(inboxItems.status, OPEN_STATUSES));

  const autos = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, "inbox.default_action"), gte(auditLog.createdAt, weekAgo)))
    .orderBy(desc(auditLog.seq))
    .limit(50);
  const scheduled = await db
    .select({ title: posts.title, publishAt: posts.publishAt })
    .from(posts)
    .where(and(eq(posts.status, "scheduled"), lte(posts.publishAt, weekAhead)))
    .orderBy(asc(posts.publishAt))
    .limit(20);
  const booked = await db
    .select({
      campaign: campaigns.name,
      slotId: inventoryUnits.slotId,
      periodStart: inventoryUnits.periodStart,
    })
    .from(bookings)
    .innerJoin(inventoryUnits, eq(inventoryUnits.id, bookings.inventoryUnitId))
    .innerJoin(campaigns, eq(campaigns.id, bookings.campaignId))
    .where(
      and(
        eq(bookings.status, "confirmed"),
        gte(inventoryUnits.periodEnd, today),
        lte(inventoryUnits.periodStart, weekAhead.slice(0, 10)),
      ),
    )
    .orderBy(asc(inventoryUnits.periodStart))
    .limit(30);
  const slotKeys = await slotNames(db, [...new Set(booked.map((b) => b.slotId))]);
  const [live] = await db.select({ n: count() }).from(campaigns).where(eq(campaigns.status, "live"));

  const decidedTotal = autoDecided + ownerDecided;
  return {
    from: dayAgo7,
    to: today,
    // One line per strategy layer (STRATEGY: search, onboarding, the Patch Notes brand), then supply.
    kpis: [
      {
        layer: "Search",
        line: `${n(views?.n).toLocaleString("en-US")} page views in the last 7 days`,
      },
      {
        layer: "Onboarding",
        line: `${n(takes?.n).toLocaleString("en-US")} quiz takes`,
      },
      {
        layer: "Patch Notes",
        line: `${n(weekly?.total)} weekly subscribers (+${n(weekly?.fresh)}), ${n(daily?.total)} daily`,
      },
      {
        layer: "Catalog",
        line: `${n(catalog?.total)} published books (+${n(catalog?.fresh)}); ${n(claimed?.total)} claimed author profiles (+${n(claimedNew?.n)}); ${n(published?.n)} posts published`,
      },
      {
        layer: "Money",
        line: `$${(n(revenue?.n) / 100).toFixed(2)} paid by card (${n(revenue?.c)} orders), $${(n(refunded?.n) / 100).toFixed(2)} refunded; ${n(pros?.n)} Author Pro`,
      },
    ],
    inbox: {
      opened: opened?.n ?? 0,
      ownerDecided,
      autoDecided,
      openNow: openNow?.n ?? 0,
      automationRate: decidedTotal ? Math.round((autoDecided / decidedTotal) * 100) : 0,
    },
    autoApproved: autos.map((a) => {
      const d = (a.diff ?? {}) as { title?: string; status?: string };
      return {
        auditId: a.id,
        title: d.title ?? a.subjectId ?? "",
        status: d.status ?? "",
        undoable: undoOf(a) !== null,
      };
    }),
    scheduledPosts: scheduled.map((p) => ({ title: p.title, publishAt: p.publishAt ?? "" })),
    bookedAds: booked.map((b) => ({
      campaign: b.campaign,
      slot: slotKeys.get(b.slotId) ?? b.slotId,
      periodStart: b.periodStart,
    })),
    liveCampaigns: live?.n ?? 0,
  };
}

async function slotNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: adSlots.id, key: adSlots.key })
    .from(adSlots)
    .where(inArray(adSlots.id, ids.slice(0, 90)));
  return new Map(rows.map((r) => [r.id, r.key]));
}
