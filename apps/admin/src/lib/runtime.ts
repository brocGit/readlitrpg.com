import { env } from "cloudflare:workers";
import { createLogger } from "@rlr/core";
import { type AdminAuth, createAdminAuth } from "@rlr/core/auth";
import { type StripeApi, StripeNotConfigured, stripeFor } from "@rlr/core/billing";
import { createDb, type Db } from "@rlr/core/db";

export const log = createLogger({ worker: "admin" });

let db: Db | undefined;
let auth: AdminAuth | undefined;

export function getDb(): Db {
  db ??= createDb(env.DB);
  return db;
}

export const isProduction = () => env.ENVIRONMENT === "production";

export function getAuth(): AdminAuth {
  if (auth) return auth;
  if (!env.ADMIN_AUTH_SECRET || env.ADMIN_AUTH_SECRET.length < 32) {
    throw new Error("ADMIN_AUTH_SECRET must be set to at least 32 characters");
  }
  auth = createAdminAuth({
    d1: env.DB,
    secret: env.ADMIN_AUTH_SECRET,
    baseURL: env.PUBLIC_ORIGIN,
    rpID: env.RP_ID,
    log,
  });
  return auth;
}

export { env };

/** Where links and images in rendered posts point: the public site, not the console. */
export const renderEnv = () => ({
  origin: (env.SITE_ORIGIN || "https://readlitrpg.com").replace(/\/$/, ""),
  mediaOrigin: env.PUBLIC_MEDIA_ORIGIN.replace(/\/$/, ""),
});

let stripe: StripeApi | null | undefined;

/** Stripe for refunds, or null until a key is set (money actions then say so plainly). */
export function getStripe(): StripeApi | null {
  if (stripe !== undefined) return stripe;
  try {
    stripe = stripeFor({
      environment: env.ENVIRONMENT,
      provider: env.STRIPE_PROVIDER,
      secretKey: env.STRIPE_SECRET_KEY,
      kv: env.CONFIG,
      siteOrigin: env.SITE_ORIGIN,
    });
  } catch (error) {
    if (!(error instanceof StripeNotConfigured)) throw error;
    stripe = null;
  }
  return stripe;
}
