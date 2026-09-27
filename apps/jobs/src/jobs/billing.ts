// Money jobs (DESIGN §12): process recorded Stripe webhook events, and expire checkouts whose
// "expired" event never arrived. Without a Stripe key nothing here runs.

import { expireStaleOrders } from "@rlr/core/ads";
import { processStripeEvents, type StripeApi, StripeNotConfigured, stripeFor } from "@rlr/core/billing";
import { loadSettings } from "@rlr/core/settings";
import type { JobContext } from "./types";

export function stripeClient(ctx: Pick<JobContext, "env" | "fetch">): StripeApi | null {
  try {
    return stripeFor({
      environment: ctx.env.ENVIRONMENT,
      provider: ctx.env.STRIPE_PROVIDER,
      secretKey: ctx.env.STRIPE_SECRET_KEY,
      kv: ctx.env.CONFIG,
      siteOrigin: ctx.env.PUBLIC_ORIGIN,
      fetch: ctx.fetch,
    });
  } catch (error) {
    if (error instanceof StripeNotConfigured) return null;
    throw error;
  }
}

export async function processStripe(ctx: JobContext): Promise<number> {
  const stripe = stripeClient(ctx);
  const expired = await expireStaleOrders(ctx.db, ctx.now);
  if (!stripe) return expired;
  const settings = await loadSettings({ db: ctx.db, kv: ctx.env.CONFIG, log: ctx.log });
  const r = await processStripeEvents(ctx.db, { stripe, settings, now: ctx.now });
  if (r.failed) ctx.log.warn("stripe.events_failed", r);
  return r.processed + expired;
}
