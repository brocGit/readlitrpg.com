// Every page and endpoint in src/pages must be listed here with its access rule (DESIGN §15.4).
// The middleware refuses any route that is missing, and test/routes.test.ts fails the build if a
// page file has no entry or an entry has no page file. Keys are Astro route patterns.

import { PUBLIC, type RouteRegistry, SIGNED_IN } from "@rlr/core/policy";

export const ROUTES = {
  "/": PUBLIC,
  "/404": PUBLIC,
  "/500": PUBLIC,
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
  // The page-view beacon: counts only (DESIGN §11.6).
  "/e": PUBLIC,
  "/media/[...key]": PUBLIC,
  "/sitemap.xml": PUBLIC,
  "/sitemaps/[name].xml": PUBLIC,
  "/feeds/releases.xml": PUBLIC,
  "/feeds/releases.ics": PUBLIC,
  "/feeds/tags/[slug].xml": PUBLIC,
  "/feeds/tags/[slug].ics": PUBLIC,
  // Blog and news (M7).
  "/blog": PUBLIC,
  "/blog/[slug]": PUBLIC,
  "/blog/type/[type]": PUBLIC,
  "/news": PUBLIC,
  "/news/today": PUBLIC,
  "/news/[slug]": PUBLIC,
  "/news/[yyyy]/[mm]/[dd]": PUBLIC,
  "/feeds/blog.xml": PUBLIC,
  "/feeds/news.xml": PUBLIC,
  // Ad clicks: a signed token, the destination from the database (M7).
  "/go/[token]": PUBLIC,
  // Readers and email (M5). The webhook checks SNS signatures itself; /u and /m links carry
  // signed tokens; the subscribe endpoints have Turnstile and rate limits.
  "/api/webhooks/ses": PUBLIC,
  "/subscribe": PUBLIC,
  "/subscribe/confirm": PUBLIC,
  "/api/subscribe": PUBLIC,
  "/api/subscribe/confirm": PUBLIC,
  "/u/[token]": PUBLIC,
  "/m/[token]": PUBLIC,
  "/goodbye": PUBLIC,
  "/feeds/[token].ics": PUBLIC,
  "/welcome": SIGNED_IN,
  "/account/preferences": SIGNED_IN,
  "/account/follows": SIGNED_IN,
  "/account/books": SIGNED_IN,
  "/account/email": SIGNED_IN,
  "/account/import": SIGNED_IN,
  "/account/privacy": SIGNED_IN,
  "/account/export/[id]": SIGNED_IN,
  "/api/me/follow": SIGNED_IN,
  "/api/me/marks": SIGNED_IN,
  "/api/me/saved": SIGNED_IN,
  "/api/me/profile": SIGNED_IN,
  "/api/me/email": SIGNED_IN,
  "/api/me/feed": SIGNED_IN,
  "/api/me/import": SIGNED_IN,
  "/api/me/export": SIGNED_IN,
  "/api/me/delete": SIGNED_IN,
  "/api/me/takes": SIGNED_IN,
  // Authors (M6). Pages check the member's access to each profile and book themselves; the release
  // link authenticates with its signed token.
  "/for-authors": PUBLIC,
  "/dashboard": SIGNED_IN,
  "/dashboard/start": SIGNED_IN,
  "/dashboard/profile/[id]": SIGNED_IN,
  "/dashboard/verify/[id]": SIGNED_IN,
  "/dashboard/team/[id]": SIGNED_IN,
  "/dashboard/invite/[token]": SIGNED_IN,
  "/dashboard/books/new": SIGNED_IN,
  "/dashboard/paste": SIGNED_IN,
  "/dashboard/write": SIGNED_IN,
  "/dashboard/write/[id]": SIGNED_IN,
  "/dashboard/interview/[id]": SIGNED_IN,
  "/dashboard/news": SIGNED_IN,
  "/dashboard/books/[id]": SIGNED_IN,
  "/dashboard/release/[token]": PUBLIC,
  // Money (M8). Stripe's webhook checks its signature itself. The dashboard pages check the
  // member's access to each profile and campaign. The /dev/stripe pages are the local fake's
  // checkout and portal: they 404 unless the fake Stripe is on, which only local development allows.
  "/api/webhooks/stripe": PUBLIC,
  // Sponsored Match: same-origin only (the POST origin check), with the results page's token.
  "/api/sponsored": PUBLIC,
  "/dashboard/promote": SIGNED_IN,
  "/dashboard/promote/new": SIGNED_IN,
  "/dashboard/promote/[id]": SIGNED_IN,
  "/dashboard/billing": SIGNED_IN,
  "/advertise": PUBLIC,
  "/legal/advertising": PUBLIC,
  "/dev/stripe/checkout/[id]": PUBLIC,
  "/dev/stripe/portal/[customer]": PUBLIC,
} satisfies RouteRegistry;

/**
 * Routes that accept cross-site POSTs. They never act on cookies: each request carries its own
 * proof (an SNS signature, or a signed link for RFC 8058 one-click unsubscribes from mail apps).
 * Every other POST must come from our own origin (see middleware.ts).
 */
export const CROSS_SITE_POSTS: ReadonlySet<string> = new Set([
  "/api/webhooks/ses",
  "/api/webhooks/stripe",
  "/u/[token]",
]);

/** Routes whose responses are personal and must never be cached anywhere. */
export const PRIVATE_PREFIXES = [
  "/account",
  "/dev/",
  "/api/",
  "/welcome",
  "/subscribe/confirm",
  "/u/",
  "/m/",
  "/dashboard",
];
