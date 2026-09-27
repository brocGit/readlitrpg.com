// Every admin page and endpoint, with its access rule (DESIGN §15.4). Cloudflare Access applies
// to all of them first; PUBLIC here means "Access only, no admin session yet" (the sign-in page).
// EDITORIAL routes take an Access service token plus the editorial token, never an admin session.

import { ADMIN, PUBLIC, type RouteRegistry, requires } from "@rlr/core/policy";

const EDITORIAL = requires("editorial.run");

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
  "/editorial": ADMIN,
  "/editorial/runs/[id]": ADMIN,
  "/quizzes": ADMIN,
  "/traffic": ADMIN,
  "/match": ADMIN,
  "/api/editorial/runs": EDITORIAL,
  "/api/editorial/runs/[id]/finish": EDITORIAL,
  "/api/editorial/pull": EDITORIAL,
  "/api/editorial/push": EDITORIAL,
  "/api/editorial/status": EDITORIAL,
} satisfies RouteRegistry;
