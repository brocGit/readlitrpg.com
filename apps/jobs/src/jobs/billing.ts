// Money jobs (DESIGN §12): process recorded Stripe webhook events, and expire checkouts whose
// "expired" event never arrived. Without a Stripe key nothing here runs.

import {
  expireStaleOrders,
  newsletterMakegoods,
  openPriceSuggestions,
  settleFinishedCampaigns,
} from "@rlr/core/ads";
import { promoteTrusted } from "@rlr/core/authors";
import {
  processStripeEvents,
  reconcileStripe,
  type StripeApi,
  StripeNotConfigured,
  stripeFor,
} from "@rlr/core/billing";
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

export async function reconcile(ctx: JobContext): Promise<number> {
  const stripe = stripeClient(ctx);
  if (!stripe) {
    ctx.log.info("stripe.reconcile_skipped", { reason: "Stripe isn't configured" });
    return 0;
  }
  const settings = await loadSettings({ db: ctx.db, kv: ctx.env.CONFIG, log: ctx.log });
  const r = await reconcileStripe(ctx.db, stripe, settings, ctx.now);
  if (r.mismatches) ctx.log.warn("stripe.reconcile_mismatches", { ...r });
  return r.checked;
}

export async function settleAds(ctx: JobContext): Promise<number> {
  const settled = await settleFinishedCampaigns(ctx.db, ctx.now);
  const made = await newsletterMakegoods(ctx.db, ctx.now);
  if (made) ctx.log.info("ads.makegoods", { made });
  return settled + made;
}

export async function priceSuggestions(ctx: JobContext): Promise<number> {
  const settings = await loadSettings({ db: ctx.db, kv: ctx.env.CONFIG, log: ctx.log });
  return (await openPriceSuggestions(ctx.db, settings, ctx.now)) ? 1 : 0;
}

export async function recomputeTrust(ctx: JobContext): Promise<number> {
  const promoted = await promoteTrusted(ctx.db, ctx.now);
  if (promoted.length) ctx.log.info("trust.promoted", { authors: promoted.length });
  return promoted.length;
}
