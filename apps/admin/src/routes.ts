// Every admin page and endpoint, with its access rule (DESIGN §15.4). Cloudflare Access applies
// to all of them first; PUBLIC here means "Access only, no admin session yet" (the sign-in page).

import { ADMIN, PUBLIC, type RouteRegistry } from "@rlr/core/policy";

export const ROUTES = {
  "/": ADMIN,
  "/404": PUBLIC,
  "/healthz": PUBLIC,
  "/signin": PUBLIC,
  "/api/auth/[...all]": PUBLIC,
  "/inbox": ADMIN,
  "/automation": ADMIN,
  "/settings": ADMIN,
  "/audit": ADMIN,
  "/catalog": ADMIN,
  "/catalog/new": ADMIN,
  "/catalog/books/[id]": ADMIN,
  "/catalog/import": ADMIN,
  "/catalog/import/[id]": ADMIN,
  "/taxonomy": ADMIN,
} satisfies RouteRegistry;
