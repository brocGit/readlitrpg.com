import { searchPublished } from "@rlr/core/match";
import type { APIRoute } from "astro";
import { withinLimit } from "../../lib/match";
import { env, getDb } from "../../lib/runtime";

/** Typeahead for "books you loved": published books by title, series or author. */
export const GET: APIRoute = async ({ url, request, clientAddress }) => {
  if (!(await withinLimit(env.RL_READ, "search", request, clientAddress))) {
    return Response.json({ error: "slow_down" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  return Response.json({ books: await searchPublished(getDb(), url.searchParams.get("q") ?? "") });
};
