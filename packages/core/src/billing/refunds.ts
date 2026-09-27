// Refunds (DESIGN §12.5). The card part goes back through Stripe with an idempotency key per order
// and reason, so a retry never refunds twice; the part paid with credits goes back as credits.
// Every refund is a row, and the order moves to refunded or partially_refunded.

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { refunds } from "../db/schema";
import { ulid } from "../ids";
import { addCredit } from "./credits";
import { getOrder, type Order, transitionOrder } from "./orders";
import type { StripeApi } from "./stripe";

export class RefundError extends Error {}

/** What has already gone back, to the card and as credits. */
export async function refundedSoFar(db: Db, orderId: string): Promise<{ card: number; credits: number }> {
  const rows = await db
    .select({ toCredits: refunds.toCredits, n: sql<number>`sum(${refunds.amountCents})` })
    .from(refunds)
    .where(and(eq(refunds.orderId, orderId), eq(refunds.status, "succeeded")))
    .groupBy(refunds.toCredits);
  return {
    card: Number(rows.find((r) => !r.toCredits)?.n ?? 0),
    credits: Number(rows.find((r) => r.toCredits)?.n ?? 0),
  };
}

/**
 * What can still go back: `total` across card and credits (a promo discount isn't money), and how
 * much of it may go to the card. A card part already returned as credits can't be refunded again.
 */
export async function refundable(db: Db, order: Order): Promise<{ total: number; card: number }> {
  const done = await refundedSoFar(db, order.id);
  const total = Math.max(0, order.chargedCents + order.creditsCents - done.card - done.credits);
  return { total, card: Math.min(total, Math.max(0, order.chargedCents - done.card)) };
}

export interface RefundRequest {
  orderId: string;
  /** Back to the card through Stripe. */
  cardCents: number;
  /** Back as promo credits (the credits used, or the card part when the advertiser chose credits). */
  creditCents: number;
  reasonCode: string;
  note?: string | null;
  /** "system" for deterministic rules, or the admin's user id. */
  initiatedBy: string;
}

export async function refundOrder(
  db: Db,
  stripe: StripeApi | null,
  r: RefundRequest,
  now = new Date(),
): Promise<{ cardCents: number; creditCents: number }> {
  const order = await getOrder(db, r.orderId);
  if (!order) throw new RefundError("no such order");
  if (!["paid", "partially_refunded", "disputed"].includes(order.status))
    throw new RefundError(`a ${order.status} order can't be refunded`);
  const left = await refundable(db, order);
  const card = Math.max(0, Math.min(r.cardCents, left.card));
  // Credits may exceed the credits used when the advertiser takes a card refund as credit instead.
  const credit = Math.max(0, Math.min(r.creditCents, left.total - card));
  if (card + credit === 0) return { cardCents: 0, creditCents: 0 };

  if (card > 0) {
    if (!stripe) throw new RefundError("Stripe isn't configured");
    if (!order.stripePaymentIntentId) throw new RefundError("the order has no card payment");
    const id = ulid();
    await db.insert(refunds).values({
      id,
      orderId: order.id,
      amountCents: card,
      toCredits: false,
      reasonCode: r.reasonCode,
      note: r.note ?? null,
      initiatedBy: r.initiatedBy,
      status: "pending",
    });
    try {
      const refund = await stripe.createRefund(
        { paymentIntent: order.stripePaymentIntentId, amountCents: card, metadata: { order_id: order.id } },
        `refund:${order.id}:${r.reasonCode}:${card}`,
      );
      await db
        .update(refunds)
        .set({ stripeRefundId: refund.id, status: refund.status === "failed" ? "failed" : "succeeded" })
        .where(eq(refunds.id, id));
    } catch (error) {
      await db.update(refunds).set({ status: "failed" }).where(eq(refunds.id, id));
      throw error;
    }
  }
  if (credit > 0 && order.advertiserId) {
    await addCredit(
      db,
      {
        advertiserId: order.advertiserId,
        amountCents: credit,
        reason:
          r.reasonCode === "rejected"
            ? "rejection"
            : r.reasonCode === "cancelled"
              ? "cancellation"
              : "refund",
        ref: order.id,
        note: r.note ?? null,
        createdBy: r.initiatedBy,
      },
      now,
    );
    await db.insert(refunds).values({
      id: ulid(),
      orderId: order.id,
      amountCents: credit,
      toCredits: true,
      reasonCode: r.reasonCode,
      note: r.note ?? null,
      initiatedBy: r.initiatedBy,
      status: "succeeded",
    });
  }
  const done = await refundedSoFar(db, order.id);
  const total = done.card + done.credits;
  const paid = order.chargedCents + order.creditsCents;
  await transitionOrder(
    db,
    order.id,
    total >= paid ? "refunded" : "partially_refunded",
    { refundedCents: total },
    now,
  );
  return { cardCents: card, creditCents: credit };
}
