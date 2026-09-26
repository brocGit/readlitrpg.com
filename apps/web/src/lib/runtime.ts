// Per-isolate singletons built from the Worker's bindings. Bindings and secrets don't change
// within an isolate, so the database handle and auth instance are created once.

import { env } from "cloudflare:workers";
import { createWebAuth, type WebAuth } from "@rlr/core/auth";
import { createDb, type Db } from "@rlr/core/db";
import { loadSettings } from "@rlr/core/settings";
import { log } from "./log";
import { deliverMagicLink } from "./magic-link";

let db: Db | undefined;
let auth: WebAuth | undefined;

export function getDb(): Db {
  db ??= createDb(env.DB);
  return db;
}

export const isLocal = () => env.ENVIRONMENT === "local";
export const isProduction = () => env.ENVIRONMENT === "production";

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
    sendMagicLink: (message) => deliverMagicLink(env, message),
    signupsOpen: async () => (await loadSettings({ db: getDb(), kv: env.CONFIG, log }))["flags.signups"],
  });
  return auth;
}

export { env };
