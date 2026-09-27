// Per-isolate singletons built from the Worker's bindings. Bindings and secrets don't change
// within an isolate, so the database handle and auth instance are created once.

import { env } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import { createWebAuth, type WebAuth } from "@rlr/core/auth";
import { createDb, type Db } from "@rlr/core/db";
import { type LinkKeys, parseLinkKeys } from "@rlr/core/readers";
import { loadSettings } from "@rlr/core/settings";
import { log } from "./log";
import { deliverMagicLink } from "./magic-link";

let db: Db | undefined;
let auth: WebAuth | undefined;
let linkKeys: LinkKeys | undefined;
// Set while directSignInUrl runs: the magic link is handed back instead of being emailed.
const captured = new AsyncLocalStorage<{ url?: string }>();

export function getDb(): Db {
  db ??= createDb(env.DB);
  return db;
}

export const isLocal = () => env.ENVIRONMENT === "local";
export const isProduction = () => env.ENVIRONMENT === "production";
/** Turnstile's site key for islands; none locally, where the server skips the check. */
export const turnstileSiteKey = (): string | null => (isLocal() ? null : env.TURNSTILE_SITE_KEY);

export function getAuth(): WebAuth {
  if (auth) return auth;
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) {
    throw new Error("AUTH_SECRET must be set to at least 32 characters");
  }
  auth = createWebAuth({
    d1: env.DB,
    secret: env.AUTH_SECRET,
    baseURL: env.PUBLIC_ORIGIN,
    rpID: env.RP_ID,
    log,
    sendMagicLink: async (message) => {
      const slot = captured.getStore();
      if (slot) slot.url = message.url;
      else await deliverMagicLink(env, message);
    },
    signupsOpen: async () => (await loadSettings({ db: getDb(), kv: env.CONFIG, log }))["flags.signups"],
  });
  return auth;
}

/**
 * A one-time sign-in URL for a reader who has just proved their address another way (they clicked
 * a subscription confirmation and pressed its button). It is never emailed: the browser is sent
 * straight to it, so the reader lands signed in.
 */
export async function directSignInUrl(email: string, next: string, headers: Headers): Promise<string | null> {
  const slot: { url?: string } = {};
  await captured.run(slot, () =>
    getAuth().api.signInMagicLink({
      body: { email, callbackURL: next, newUserCallbackURL: next, errorCallbackURL: "/signin?error=link" },
      headers,
    }),
  );
  return slot.url ?? null;
}

/** Keys for unsubscribe and one-click links in emails (shared with the jobs Worker). */
export function getLinkKeys(): LinkKeys {
  linkKeys ??= parseLinkKeys(env.LINK_SIGNING_KEYS);
  return linkKeys;
}

export { env };
