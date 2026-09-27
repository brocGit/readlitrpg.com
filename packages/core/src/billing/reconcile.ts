// Nightly reconciliation (DESIGN §12.3): compare the last 48 hours of Checkout Sessions in Stripe
// with our orders. A payment we missed is confirmed now; an expiry we missed releases its places;
// anything that doesn't add up becomes one inbox item per session for the owner.

import { confirmPaidOrder, expireOrder } from "../ads/paid";
import type { Db } from "../db";
import { openInboxItem } from "../inbox";
import type { Settings } from "../settings";
import { getOrder, orderBySession } from "./orders";
import type { StripeApi, StripeCheckoutSession } from "./stripe";

export interface ReconcileResult {
  checked: number;
  repaired: number;
  mismatches: number;
}

export async function reconcileStripe(
  db: Db,
  stripe: StripeApi,
  settings: Settings,
  now = new Date(),
): Promise<ReconcileResult> {
  const since = Math.floor(now.getTime() / 1000) - 48 * 3600;
  const sessions: StripeCheckoutSession[] = [];
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const res = await stripe.listCheckoutSessions({ createdGte: since, startingAfter: after });
    sessions.push(...res.data);
    if (!res.has_more || !res.data.length) break;
    after = res.data.at(-1)?.id;
  }
  const out: ReconcileResult = { checked: 0, repaired: 0, mismatches: 0 };
  const mismatch = async (s: StripeCheckoutSession, what: string) => {
    out.mismatches++;
    await openInboxItem(db, {
      type: "billing_mismatch",
      title: `Stripe and our orders disagree: ${what}`,
      subjectType: "checkout_session",
      subjectId: s.id,
      priority: 85,
      payload: { sessionId: s.id, orderId: s.metadata.order_id ?? null, what, amountTotal: s.amount_total },
      dedupeKey: `billing_mismatch:${s.id}`,
    });
  };
  for (const s of sessions) {
    if (s.mode !== "payment") continue;
    out.checked++;
    const order =
      (await orderBySession(db, s.id)) ??
      (s.metadata.order_id ? await getOrder(db, s.metadata.order_id) : null);
    const paid = s.status === "complete" && s.payment_status === "paid";
    if (!order) {
      if (paid) await mismatch(s, "a paid checkout with no order");
      continue;
    }
    if (paid && order.status === "open") {
      // The webhook never arrived (or failed): confirm now.
      await confirmPaidOrder(db, order.id, { paymentIntent: s.payment_intent, settings, now, stripe });
      out.repaired++;
    } else if (s.status === "expired" && order.status === "open") {
      await expireOrder(db, order.id, now);
      out.repaired++;
    } else if (!paid && order.status === "paid") {
      await mismatch(s, "an order marked paid that Stripe hasn't charged");
      continue;
    }
    if (paid && s.amount_total !== null && s.amount_total !== order.chargedCents)
      await mismatch(
        s,
        `charged $${(s.amount_total / 100).toFixed(2)} for an order of $${(order.chargedCents / 100).toFixed(2)}`,
      );
  }
  return out;
}
