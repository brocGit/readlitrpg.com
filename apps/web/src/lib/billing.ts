// Payments on the web Worker (DESIGN §12): which Stripe to use, and accepting its webhooks. The
// same acceptance path serves the local fake's events, so verification runs in the browser tests.

import {
  isFake,
  recordStripeEvent,
  type StripeApi,
  type StripeEvent,
  StripeNotConfigured,
  signStripePayload,
  stripeFor,
  verifyStripeWebhook,
} from "@rlr/core/billing";
import { openInboxItem } from "@rlr/core/inbox";
import { enqueueJob } from "@rlr/core/scheduler";
import { log } from "./log";
import { env, getDb } from "./runtime";

let stripe: StripeApi | null | undefined;

/** Stripe, or null while no key is set (payments then stay unavailable, with a plain message). */
export function getStripe(): StripeApi | null {
  if (stripe !== undefined) return stripe;
  try {
    stripe = stripeFor({
      environment: env.ENVIRONMENT,
      provider: env.STRIPE_PROVIDER,
      secretKey: env.STRIPE_SECRET_KEY,
      kv: env.CONFIG,
      siteOrigin: env.PUBLIC_ORIGIN,
    });
  } catch (error) {
    if (!(error instanceof StripeNotConfigured)) throw error;
    stripe = null;
  }
  return stripe;
}

export const fakeStripeOn = () => {
  const s = getStripe();
  return s !== null && isFake(s);
};

/**
 * Verify, record once, and queue processing. A bad signature is refused with a 400 and becomes a
 * security event for the owner (one an hour at most).
 */
export async function acceptStripeWebhook(body: string, signature: string | null): Promise<Response> {
  const db = getDb();
  const event = await verifyStripeWebhook(body, signature, env.STRIPE_WEBHOOK_SECRET ?? "");
  if (!event) {
    log.warn("stripe_webhook.refused");
    await openInboxItem(db, {
      type: "security_event",
      title: "A Stripe webhook arrived with a bad signature",
      priority: 70,
      aiSummary:
        "Someone posted to /api/webhooks/stripe without a valid signature, or the webhook secret changed. Check the endpoint's secret in Stripe.",
      dedupeKey: `stripe_webhook_bad:${new Date().toISOString().slice(0, 13)}`,
    });
    return new Response("Bad signature", { status: 400 });
  }
  if (await recordStripeEvent(db, event)) await enqueueJob(db, env.Q_JOBS, "stripe.events");
  return new Response("OK", { headers: { "cache-control": "no-store" } });
}

/** The fake's events, delivered the way Stripe would: signed, then through the real handler. */
export async function deliverFakeEvents(events: StripeEvent[]): Promise<void> {
  for (const e of events) {
    const body = JSON.stringify(e);
    const signature = await signStripePayload(
      body,
      env.STRIPE_WEBHOOK_SECRET ?? "",
      Math.floor(Date.now() / 1000),
    );
    const res = await acceptStripeWebhook(body, signature);
    if (!res.ok) throw new Error(`fake webhook refused: ${res.status}`);
  }
}
