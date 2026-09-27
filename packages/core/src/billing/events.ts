// Processing recorded Stripe events (DESIGN §12.3), in the jobs Worker. Each event is a pointer:
// we re-read the object from Stripe and act on its current state, through transitions that only
// move forward, so duplicates and reordering are harmless. Five failures open an inbox item.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { confirmPaidOrder, expireOrder } from "../ads/paid";
import { appendAudit } from "../audit";
import { notifyAuthor } from "../authors/notices";
import type { Db } from "../db";
import { advertisers, authors, campaigns, orders, refunds, stripeEvents, subscriptions } from "../db/schema";
import { ulid } from "../ids";
import { openInboxItem } from "../inbox";
import type { Settings } from "../settings";
import { nowIso } from "../time";
import { getOrder, orderByPaymentIntent, orderBySession, transitionOrder } from "./orders";
import { refundedSoFar } from "./refunds";
import type { StripeApi } from "./stripe";
import { grantQuarterlyCredit, upsertSubscription } from "./subscriptions";

export const MAX_EVENT_ATTEMPTS = 5;

export interface EventContext {
  stripe: StripeApi;
  settings: Settings;
  now: Date;
}

export async function processStripeEvents(
  db: Db,
  ctx: EventContext,
  limit = 20,
): Promise<{ processed: number; failed: number }> {
  const queued = await db
    .select()
    .from(stripeEvents)
    .where(eq(stripeEvents.status, "queued"))
    .orderBy(asc(stripeEvents.receivedAt))
    .limit(limit);
  let processed = 0;
  let failed = 0;
  for (const e of queued) {
    try {
      await handle(db, e.type, e.objectId ?? "", ctx);
      await db
        .update(stripeEvents)
        .set({ status: "processed", processedAt: nowIso(ctx.now), attempts: e.attempts + 1, error: null })
        .where(eq(stripeEvents.eventId, e.eventId));
      processed++;
    } catch (error) {
      failed++;
      const attempts = e.attempts + 1;
      const giveUp = attempts >= MAX_EVENT_ATTEMPTS;
      await db
        .update(stripeEvents)
        .set({ attempts, error: String(error).slice(0, 500), ...(giveUp ? { status: "failed" } : {}) })
        .where(eq(stripeEvents.eventId, e.eventId));
      if (giveUp)
        await openInboxItem(db, {
          type: "system_alert",
          title: `A Stripe event failed ${MAX_EVENT_ATTEMPTS} times: ${e.type}`,
          subjectType: "stripe_event",
          subjectId: e.eventId,
          priority: 90,
          payload: {
            eventId: e.eventId,
            type: e.type,
            objectId: e.objectId,
            error: String(error).slice(0, 300),
          },
          dedupeKey: `stripe_event:${e.eventId}`,
        });
    }
  }
  return { processed, failed };
}

async function handle(db: Db, type: string, objectId: string, ctx: EventContext): Promise<void> {
  const { stripe, settings, now } = ctx;
  switch (type) {
    case "checkout.session.completed": {
      const s = await stripe.retrieveCheckoutSession(objectId);
      if (s.mode === "subscription") {
        if (s.subscription)
          await syncSubscription(
            db,
            stripe,
            s.subscription,
            {
              advertiserId: s.metadata.advertiser_id ?? null,
              userId: s.metadata.user_id ?? null,
            },
            now,
          );
        return;
      }
      const order =
        (await orderBySession(db, s.id)) ??
        (s.metadata.order_id ? await getOrder(db, s.metadata.order_id) : null);
      if (!order) throw new Error(`no order for session ${s.id}`);
      if (s.payment_status === "paid" || s.payment_status === "no_payment_required")
        await confirmPaidOrder(db, order.id, { paymentIntent: s.payment_intent, settings, now, stripe });
      return;
    }
    case "checkout.session.expired": {
      const order = await orderBySession(db, objectId);
      if (order) await expireOrder(db, order.id, now);
      return;
    }
    case "charge.refunded": {
      // Refunds we made are already recorded; one made in the Stripe dashboard is caught here.
      const charge = await stripe.retrieveCharge(objectId);
      const order = charge.payment_intent ? await orderByPaymentIntent(db, charge.payment_intent) : null;
      if (!order) return;
      const done = await refundedSoFar(db, order.id);
      const extra = charge.amount_refunded - done.card;
      if (extra <= 0) return;
      await db.insert(refunds).values({
        id: ulid(),
        orderId: order.id,
        amountCents: extra,
        toCredits: false,
        reasonCode: "external",
        note: "Refunded in the Stripe dashboard",
        initiatedBy: "stripe",
        status: "succeeded",
      });
      const total = done.card + extra + done.credits;
      await transitionOrder(
        db,
        order.id,
        total >= order.chargedCents + order.creditsCents ? "refunded" : "partially_refunded",
        { refundedCents: total },
        now,
      );
      return;
    }
    case "charge.dispute.created": {
      const dispute = await stripe.retrieveDispute(objectId);
      const order = dispute.payment_intent ? await orderByPaymentIntent(db, dispute.payment_intent) : null;
      if (!order) throw new Error(`no order for dispute ${dispute.id}`);
      await transitionOrder(db, order.id, "disputed", {}, now);
      await onChargeback(db, order.advertiserId, order.id, dispute.amount, now);
      return;
    }
    case "charge.dispute.closed": {
      const dispute = await stripe.retrieveDispute(objectId);
      const order = dispute.payment_intent ? await orderByPaymentIntent(db, dispute.payment_intent) : null;
      if (!order) return;
      if (dispute.status === "won") await transitionOrder(db, order.id, "paid", {}, now);
      else if (dispute.status === "lost") {
        await db.insert(refunds).values({
          id: ulid(),
          orderId: order.id,
          amountCents: dispute.amount,
          toCredits: false,
          reasonCode: "dispute_lost",
          initiatedBy: "stripe",
          status: "succeeded",
        });
        await transitionOrder(
          db,
          order.id,
          "refunded",
          { refundedCents: order.refundedCents + dispute.amount },
          now,
        );
      }
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscription(db, stripe, objectId, {}, now);
      return;
    case "invoice.paid": {
      const invoice = await stripe.retrieveInvoice(objectId);
      if (!invoice.subscription) return;
      const sub = await syncSubscription(db, stripe, invoice.subscription, {}, now);
      await db
        .insert(orders)
        .values({
          id: ulid(),
          advertiserId: sub.advertiserId,
          userId: sub.userId,
          kind: "subscription",
          status: "paid",
          amountCents: invoice.amount_paid,
          chargedCents: invoice.amount_paid,
          stripeInvoiceId: invoice.id,
          stripePaymentIntentId: invoice.payment_intent,
          stripeSubscriptionId: sub.stripeSubscriptionId,
          paidAt: nowIso(now),
          createdBy: "stripe",
        })
        .onConflictDoNothing();
      if (sub.plan === "author_pro" && ["active", "trialing"].includes(sub.status))
        await grantQuarterlyCredit(db, sub, settings["billing.author_pro_quarterly_credit_cents"], now);
      return;
    }
    case "invoice.payment_failed":
      // Stripe retries and emails the customer itself; the subscription update tells us the state.
      return;
  }
}

async function syncSubscription(
  db: Db,
  stripe: StripeApi,
  subscriptionId: string,
  link: { advertiserId?: string | null; userId?: string | null },
  now: Date,
) {
  const [before] = await db
    .select({ id: subscriptions.id, status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, subscriptionId));
  const s = await stripe.retrieveSubscription(subscriptionId);
  const row = await upsertSubscription(db, s, link, now);
  const nowActive = ["active", "trialing"].includes(row.status);
  if (
    nowActive &&
    (!before || !["active", "trialing", "past_due"].includes(before.status)) &&
    row.advertiserId
  ) {
    const [adv] = await db.select().from(advertisers).where(eq(advertisers.id, row.advertiserId));
    if (adv?.ownerType === "author" && adv.ownerId)
      await notifyAuthor(db, { authorId: adv.ownerId, userId: row.userId, kind: "pro_welcome" });
  }
  return row;
}

/**
 * A chargeback (§12.6): the author drops to T-1 (they can't buy more), their upcoming campaigns
 * pause, and the owner is alerted at once. Audited, with an undo for the trust change.
 */
export async function onChargeback(
  db: Db,
  advertiserId: string | null,
  orderId: string,
  amountCents: number,
  now = new Date(),
): Promise<void> {
  const [adv] = advertiserId
    ? await db.select().from(advertisers).where(eq(advertisers.id, advertiserId))
    : [];
  if (adv?.ownerType === "author" && adv.ownerId) {
    const [a] = await db
      .select({ trust: authors.trustLevel })
      .from(authors)
      .where(eq(authors.id, adv.ownerId));
    if (a && a.trust !== "T-1") {
      await db
        .update(authors)
        .set({ trustLevel: "T-1", updatedAt: nowIso(now) })
        .where(eq(authors.id, adv.ownerId));
      await appendAudit(db, {
        actor: { type: "system", id: "stripe" },
        action: "author.trust",
        subjectType: "author",
        subjectId: adv.ownerId,
        diff: {
          from: a.trust,
          to: "T-1",
          via: "chargeback",
          orderId,
          undo: { kind: "author_trust", authorId: adv.ownerId, to: a.trust },
        },
      });
    }
  }
  if (advertiserId)
    await db
      .update(campaigns)
      .set({ status: "paused", updatedAt: nowIso(now) })
      .where(
        and(
          eq(campaigns.advertiserId, advertiserId),
          inArray(campaigns.status, ["in_review", "approved", "scheduled", "live"]),
          sql`${campaigns.endAt} > ${nowIso(now)}`,
        ),
      );
  await openInboxItem(db, {
    type: "dispute",
    title: `Chargeback on order ${orderId.slice(-6)} ($${(amountCents / 100).toFixed(2)})`,
    subjectType: "order",
    subjectId: orderId,
    priority: 100,
    aiSummary:
      "The advertiser is now restricted (T-1) and their upcoming campaigns are paused. Respond in the Stripe dashboard with the booking record.",
    payload: { orderId, advertiserId, amountCents },
    dedupeKey: `dispute:${orderId}`,
  });
}
