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
  // Discovery (M3). Match results are computed from inputs in the URL, never the session.
  "/match": PUBLIC,
  "/match/quiz": PUBLIC,
  "/match/r": PUBLIC,
  "/match/card.svg": PUBLIC,
  "/find": PUBLIC,
  "/books-like/[slug]": PUBLIC,
  "/lists": PUBLIC,
  "/lists/[slug]": PUBLIC,
  "/quiz": PUBLIC,
  "/quiz/[slug]": PUBLIC,
  "/quiz/[slug]/r/[outcome]": PUBLIC,
  "/quiz/[slug]/r/[outcome]/card.svg": PUBLIC,
  "/api/match": PUBLIC,
  "/api/match/classics": PUBLIC,
  "/api/search": PUBLIC,
  "/api/quiz/[slug]": PUBLIC,
  // GET is public; POST checks for a signed-in reader itself (appraisals are account actions).
  "/api/appraise/[slug]": PUBLIC,
  // The public site (M4).
  "/books/[slug]": PUBLIC,
  "/series/[slug]": PUBLIC,
  "/authors/[slug]": PUBLIC,
  "/narrators/[slug]": PUBLIC,
  "/tags": PUBLIC,
  "/tags/[slug]": PUBLIC,
  "/new": PUBLIC,
  "/search": PUBLIC,
  "/robots.txt": PUBLIC,
  "/sitemap.xml": PUBLIC,
  "/sitemaps/[name].xml": PUBLIC,
  "/feeds/releases.xml": PUBLIC,
  "/feeds/releases.ics": PUBLIC,
  "/feeds/tags/[slug].xml": PUBLIC,
  "/feeds/tags/[slug].ics": PUBLIC,
} satisfies RouteRegistry;

/** Routes whose responses are personal and must never be cached anywhere. */
export const PRIVATE_PREFIXES = ["/account", "/api/"];
