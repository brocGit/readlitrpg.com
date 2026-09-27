// Which Stripe to talk to. Production and staging use the REST API with the Worker's restricted
// key; local development and the browser tests use the fake, which is refused anywhere else.

import { type FakeStripe, fakeStripe } from "./fake";
import { httpStripe, type StripeApi } from "./stripe";

export interface StripeConfig {
  environment: string;
  /** "stripe" (default) or "fake" (local only). */
  provider?: string;
  secretKey?: string;
  kv: KVNamespace;
  /** Where the fake's checkout and portal pages live (the web Worker's origin). */
  siteOrigin: string;
  fetch?: typeof fetch;
}

export class StripeNotConfigured extends Error {}

/** A Stripe client, or StripeNotConfigured when there's no key (money features stay off). */
export function stripeFor(c: StripeConfig): StripeApi {
  if (c.provider === "fake") {
    if (c.environment !== "local") throw new Error("the fake Stripe is for local development only");
    return fakeStripe(c.kv, c.siteOrigin.replace(/\/$/, ""));
  }
  if (!c.secretKey) throw new StripeNotConfigured("STRIPE_SECRET_KEY is not set");
  return httpStripe(c.secretKey, c.fetch);
}

export function isFake(api: StripeApi): api is FakeStripe {
  return api.mode === "fake";
}
