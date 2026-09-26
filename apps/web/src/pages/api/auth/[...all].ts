import type { APIRoute } from "astro";
import { getAuth } from "../../../lib/runtime";

// Link requests must go through /api/signin/magic-link, which adds the bot check and rate limits.
const BLOCKED = new Set(["/api/auth/sign-in/magic-link"]);

export const ALL: APIRoute = async ({ request, url }) => {
  if (BLOCKED.has(url.pathname)) return Response.json({ error: "not_found" }, { status: 404 });
  return getAuth().handler(request);
};
