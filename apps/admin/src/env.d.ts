/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    requestId: string;
    access: import("@rlr/core/security").AccessIdentity;
    admin: () => Promise<import("./lib/admin-session").AdminSession | null>;
    settings: () => Promise<import("@rlr/core/settings").Settings>;
    /** Set on editorial API requests that passed both locks. */
    editorial: { tokenSlot: number } | null;
  }
}

// Secrets are set with `wrangler secret put` and never appear in wrangler.jsonc, so `wrangler types`
// can't see them (DESIGN Appendix D, docs/runbooks/editorial-runs.md).
declare namespace Cloudflare {
  interface Env {
    /** Access service-token client IDs allowed to call the editorial API, comma-separated. */
    EDITORIAL_ACCESS_CLIENT_IDS?: string;
    /** A restricted Stripe key: refunds, and reading payments for reconciliation (M8). */
    STRIPE_SECRET_KEY?: string;
  }
}
