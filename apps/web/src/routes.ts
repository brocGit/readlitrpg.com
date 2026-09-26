// Every page and endpoint in src/pages must be listed here with its access rule (DESIGN §15.4).
// The middleware refuses any route that is missing, and test/routes.test.ts fails the build if a
// page file has no entry or an entry has no page file. Keys are Astro route patterns.

import { PUBLIC, type RouteRegistry, SIGNED_IN } from "@rlr/core/policy";

export const ROUTES = {
  "/": PUBLIC,
  "/404": PUBLIC,
  "/healthz": PUBLIC,
  "/signin": PUBLIC,
  "/signin/confirm": PUBLIC,
  "/account": SIGNED_IN,
  // Better Auth's own endpoints check their own sessions; direct magic-link requests are refused
  // so every link request goes through /api/signin/magic-link (bot check and rate limits).
  "/api/auth/[...all]": PUBLIC,
  "/api/signin/magic-link": PUBLIC,
  "/api/me": PUBLIC,
} satisfies RouteRegistry;

/** Routes whose responses are personal and must never be cached anywhere. */
export const PRIVATE_PREFIXES = ["/account", "/api/"];
