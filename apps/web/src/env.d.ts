/// <reference types="astro/client" />

// Secrets set with `wrangler secret put`; not visible to `wrangler types` (DESIGN Appendix D).
declare namespace Cloudflare {
  interface Env {
    TURNSTILE_SECRET?: string;
    /** The SNS topic SES publishes bounces and complaints to (docs/runbooks/email-setup.md). */
    SNS_TOPIC_ARN?: string;
    /** A restricted Stripe key: Checkout Sessions, Customers, Coupons, Portal sessions (M8). */
    STRIPE_SECRET_KEY?: string;
  }
}

declare namespace App {
  interface Locals {
    requestId: string;
    /** The signed-in person, resolved lazily and at most once per request. */
    actor: () => Promise<import("@rlr/core/policy").Actor>;
    session: () => Promise<import("./lib/session").SessionInfo | null>;
    settings: () => Promise<import("@rlr/core/settings").Settings>;
  }
}
