import { matchInputsSchema } from "@rlr/core/match";
import type { APIRoute } from "astro";
import { runMatch, withinLimit } from "../../lib/match";
import { env } from "../../lib/runtime";

const MAX_BODY = 20_000;

/** Score the catalog for a set of inputs (DESIGN §9.1). No account, nothing stored. */
export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  if (!(await withinLimit(env.RL_READ, "match", request, clientAddress))) {
    return Response.json({ error: "slow_down" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  const text = await request.text();
  if (text.length > MAX_BODY) return Response.json({ error: "too_large" }, { status: 413 });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = matchInputsSchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "invalid_inputs" }, { status: 400 });
  return Response.json(await runMatch(parsed.data, await locals.settings()));
};
