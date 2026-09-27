// The owner's billing console (DESIGN §8.5 Billing, §12.8): a month at a glance, orders with their
// refunds, and a CSV of the month for bookkeeping. Read-only here; money moves in refunds.ts,
// credits.ts and promo.ts, each audited by the console.

import { and, count, desc, eq, gte, inArray, lt, sql, sum } from "drizzle-orm";
import type { Db } from "../db";
import {
  advertisers,
  creditsLedger,
  type OrderStatus,
  orderItems,
  orders,
  refunds,
  subscriptions,
} from "../db/schema";

const monthRange = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, 1)).toISOString();
  const end = new Date(Date.UTC(y ?? 1970, m ?? 1, 1)).toISOString();
  return { start, end };
};

export interface BillingSummary {
  month: string;
  paidCents: number;
  refundedCents: number;
  creditsOutstandingCents: number;
  activeSubscriptions: number;
  openDisputes: number;
  orders: number;
}

export async function billingSummary(db: Db, month: string): Promise<BillingSummary> {
  const { start, end } = monthRange(month);
  const [paid] = await db
    .select({ n: sum(orders.chargedCents), c: count() })
    .from(orders)
    .where(
      and(
        inArray(orders.status, ["paid", "partially_refunded", "refunded", "disputed"]),
        gte(orders.paidAt, start),
        lt(orders.paidAt, end),
      ),
    );
  const [back] = await db
    .select({ n: sum(refunds.amountCents) })
    .from(refunds)
    .where(
      and(
        eq(refunds.toCredits, false),
        eq(refunds.status, "succeeded"),
        gte(refunds.createdAt, start),
        lt(refunds.createdAt, end),
      ),
    );
  const [credits] = await db.select({ n: sum(creditsLedger.deltaCents) }).from(creditsLedger);
  const [subs] = await db
    .select({ n: count() })
    .from(subscriptions)
    .where(inArray(subscriptions.status, ["active", "trialing", "past_due"]));
  const [disputes] = await db.select({ n: count() }).from(orders).where(eq(orders.status, "disputed"));
  return {
    month,
    paidCents: Number(paid?.n ?? 0),
    orders: Number(paid?.c ?? 0),
    refundedCents: Number(back?.n ?? 0),
    creditsOutstandingCents: Number(credits?.n ?? 0),
    activeSubscriptions: Number(subs?.n ?? 0),
    openDisputes: Number(disputes?.n ?? 0),
  };
}

export async function listOrders(db: Db, opts: { status?: OrderStatus; limit?: number } = {}) {
  return db
    .select({ order: orders, advertiser: advertisers.name })
    .from(orders)
    .leftJoin(advertisers, eq(advertisers.id, orders.advertiserId))
    .where(opts.status ? eq(orders.status, opts.status) : undefined)
    .orderBy(desc(orders.createdAt))
    .limit(opts.limit ?? 100);
}

export async function orderDetail(db: Db, id: string) {
  const [row] = await db
    .select({ order: orders, advertiser: advertisers })
    .from(orders)
    .leftJoin(advertisers, eq(advertisers.id, orders.advertiserId))
    .where(eq(orders.id, id));
  if (!row) return null;
  const [items, back] = await Promise.all([
    db.select().from(orderItems).where(eq(orderItems.orderId, id)),
    db.select().from(refunds).where(eq(refunds.orderId, id)).orderBy(desc(refunds.createdAt)),
  ]);
  return { ...row, items, refunds: back };
}

export async function listSubscriptions(db: Db, limit = 100) {
  return db
    .select({ sub: subscriptions, advertiser: advertisers.name })
    .from(subscriptions)
    .leftJoin(advertisers, eq(advertisers.id, subscriptions.advertiserId))
    .orderBy(desc(subscriptions.updatedAt))
    .limit(limit);
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Quote everything that needs it, and defuse spreadsheet formulas.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/**
 * The month for bookkeeping (§12.8): every order, refund and credit movement, one row each, amounts
 * in cents. Stripe's own fees come from its balance report, not from here.
 */
export async function monthCsv(db: Db, month: string): Promise<string> {
  const { start, end } = monthRange(month);
  const header = [
    "type",
    "date",
    "id",
    "order_id",
    "advertiser",
    "kind",
    "status",
    "amount_cents",
    "discount_cents",
    "credits_cents",
    "charged_cents",
    "refunded_cents",
    "reason",
    "stripe_id",
  ];
  const rows: unknown[][] = [];
  for (const { order: o, advertiser } of await db
    .select({ order: orders, advertiser: advertisers.name })
    .from(orders)
    .leftJoin(advertisers, eq(advertisers.id, orders.advertiserId))
    .where(and(gte(orders.createdAt, start), lt(orders.createdAt, end)))
    .orderBy(orders.createdAt))
    rows.push([
      "order",
      o.paidAt ?? o.createdAt,
      o.id,
      o.id,
      advertiser,
      o.kind,
      o.status,
      o.amountCents,
      o.discountCents,
      o.creditsCents,
      o.chargedCents,
      o.refundedCents,
      "",
      o.stripePaymentIntentId ?? o.stripeInvoiceId ?? o.stripeCheckoutSessionId,
    ]);
  for (const r of await db
    .select()
    .from(refunds)
    .where(and(gte(refunds.createdAt, start), lt(refunds.createdAt, end)))
    .orderBy(refunds.createdAt))
    rows.push([
      r.toCredits ? "refund_to_credit" : "refund",
      r.createdAt,
      r.id,
      r.orderId,
      "",
      "",
      r.status,
      -r.amountCents,
      "",
      "",
      "",
      "",
      r.reasonCode,
      r.stripeRefundId,
    ]);
  for (const c of await db
    .select({ entry: creditsLedger, advertiser: advertisers.name })
    .from(creditsLedger)
    .leftJoin(advertisers, eq(advertisers.id, creditsLedger.advertiserId))
    .where(and(gte(creditsLedger.createdAt, start), lt(creditsLedger.createdAt, end)))
    .orderBy(creditsLedger.createdAt))
    rows.push([
      "credit",
      c.entry.createdAt,
      c.entry.id,
      c.entry.ref,
      c.advertiser,
      "",
      "",
      c.entry.deltaCents,
      "",
      "",
      "",
      "",
      c.entry.reason,
      "",
    ]);
  return `${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n")}\n`;
}

/** Outstanding credit per advertiser, largest first (liabilities for the books). */
export async function creditBalances(db: Db, limit = 50) {
  return db
    .select({
      advertiserId: creditsLedger.advertiserId,
      name: advertisers.name,
      balance: sql<number>`sum(${creditsLedger.deltaCents})`.as("balance"),
    })
    .from(creditsLedger)
    .leftJoin(advertisers, eq(advertisers.id, creditsLedger.advertiserId))
    .groupBy(creditsLedger.advertiserId)
    .orderBy(desc(sql`balance`))
    .limit(limit);
}
