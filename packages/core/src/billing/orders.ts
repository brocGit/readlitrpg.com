// Orders and their state machine (DESIGN §12.4). Every transition is one conditional UPDATE from
// the states it's allowed from, so a webhook arriving twice, or out of order, changes nothing.
//
//   open ──(completed)──▶ paid ──(refund full)──▶ refunded
//     │                    │ └──(refund part)──▶ partially_refunded
//     └──(expired)──▶ expired   └──(dispute)──▶ disputed ──(won/lost)──▶ paid | refunded

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { type OrderKind, type OrderStatus, orderItems, orders } from "../db/schema";
import { ulid } from "../ids";
import { nowIso } from "../time";

export type Order = typeof orders.$inferSelect;

export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  open: ["paid", "expired", "cancelled"],
  paid: ["refunded", "partially_refunded", "disputed"],
  partially_refunded: ["refunded", "partially_refunded", "disputed"],
  disputed: ["paid", "refunded", "partially_refunded"],
  refunded: [],
  expired: [],
  cancelled: [],
};

/** The states an order can reach `to` from. */
export function fromStates(to: OrderStatus): OrderStatus[] {
  return (Object.keys(ORDER_TRANSITIONS) as OrderStatus[]).filter((s) => ORDER_TRANSITIONS[s].includes(to));
}

/** Move an order to `to` if it's allowed from where it is now. Returns whether it moved. */
export async function transitionOrder(
  db: Db,
  id: string,
  to: OrderStatus,
  patch: Partial<typeof orders.$inferInsert> = {},
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(orders)
    .set({ ...patch, status: to, updatedAt: nowIso(now) })
    .where(and(eq(orders.id, id), inArray(orders.status, fromStates(to))))
    .returning({ id: orders.id });
  return rows.length === 1;
}

/** Stripe won't charge less than $0.50 (USD). */
export const STRIPE_MIN_CHARGE_CENTS = 50;

/**
 * Split a price into discount, credits and what the card pays (§12.5: credits first). A remainder
 * under Stripe's minimum is avoided by using a little less credit, then a little less discount.
 */
export function settle(
  amountCents: number,
  discountCents: number,
  creditsAvailable: number,
): { discountCents: number; creditsCents: number; chargeCents: number } {
  let discount = Math.max(0, Math.min(discountCents, amountCents));
  let credits = Math.max(0, Math.min(creditsAvailable, amountCents - discount));
  let charge = amountCents - discount - credits;
  if (charge > 0 && charge < STRIPE_MIN_CHARGE_CENTS) {
    let need = STRIPE_MIN_CHARGE_CENTS - charge;
    const fromCredits = Math.min(need, credits);
    credits -= fromCredits;
    need -= fromCredits;
    const fromDiscount = Math.min(need, discount);
    discount -= fromDiscount;
    charge = amountCents - discount - credits;
  }
  return { discountCents: discount, creditsCents: credits, chargeCents: charge };
}

export interface NewOrder {
  advertiserId?: string | null;
  userId?: string | null;
  kind: OrderKind;
  amountCents: number;
  discountCents?: number;
  creditsCents?: number;
  chargedCents?: number;
  promoCodeId?: string | null;
  expiresAt?: string | null;
  createdBy: string;
  items: {
    campaignId?: string | null;
    bookingId?: string | null;
    description: string;
    amountCents: number;
  }[];
}

export async function createOrder(db: Db, o: NewOrder, now = new Date()): Promise<Order> {
  const id = ulid();
  const at = nowIso(now);
  const [order] = await db
    .insert(orders)
    .values({
      id,
      advertiserId: o.advertiserId ?? null,
      userId: o.userId ?? null,
      kind: o.kind,
      status: "open",
      amountCents: o.amountCents,
      discountCents: o.discountCents ?? 0,
      creditsCents: o.creditsCents ?? 0,
      chargedCents: o.chargedCents ?? 0,
      promoCodeId: o.promoCodeId ?? null,
      expiresAt: o.expiresAt ?? null,
      createdBy: o.createdBy,
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  // Six columns a row: 15 rows keep a statement under D1's 100 bound parameters.
  for (let i = 0; i < o.items.length; i += 15)
    await db.insert(orderItems).values(
      o.items.slice(i, i + 15).map((it) => ({
        id: ulid(),
        orderId: id,
        campaignId: it.campaignId ?? null,
        bookingId: it.bookingId ?? null,
        description: it.description.slice(0, 200),
        amountCents: it.amountCents,
      })),
    );
  if (!order) throw new Error("order insert failed");
  return order;
}

export async function getOrder(db: Db, id: string): Promise<Order | null> {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  return row ?? null;
}

export async function orderBySession(db: Db, sessionId: string): Promise<Order | null> {
  const [row] = await db.select().from(orders).where(eq(orders.stripeCheckoutSessionId, sessionId));
  return row ?? null;
}

export async function orderByPaymentIntent(db: Db, paymentIntent: string): Promise<Order | null> {
  const [row] = await db.select().from(orders).where(eq(orders.stripePaymentIntentId, paymentIntent));
  return row ?? null;
}

export async function itemsOf(db: Db, orderId: string) {
  return db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
}

export async function ordersFor(db: Db, ids: string[]) {
  return ids.length
    ? db
        .select()
        .from(orders)
        .where(inArray(orders.id, ids.slice(0, 90)))
    : [];
}
