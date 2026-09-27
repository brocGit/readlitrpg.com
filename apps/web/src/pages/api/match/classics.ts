import type { APIRoute } from "astro";
import { classicsFor, withinLimit } from "../../../lib/match";
import { env } from "../../../lib/runtime";

/** The next books for the Match Quiz's "rate the classics" step. */
export const GET: APIRoute = async ({ url, request, locals, clientAddress }) => {
  if (!(await withinLimit(env.RL_READ, "classics", request, clientAddress))) {
    return Response.json({ error: "slow_down" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  const rated = (url.searchParams.get("rated") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[a-z0-9-]{1,120}$/.test(s))
    .slice(0, 20);
  return Response.json({ books: await classicsFor(await locals.settings(), rated) });
};
