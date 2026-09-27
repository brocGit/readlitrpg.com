import type { APIRoute } from "astro";
import { handlePull, json, pullRequestSchema, readJson, respond } from "../../../lib/editorial-api";
import { getDb } from "../../../lib/runtime";

/** Claim work in priority order: `pnpm editorial pull`. */
export const POST: APIRoute = ({ request, locals }) =>
  respond(async () =>
    json(await handlePull(getDb(), await locals.settings(), await readJson(request, pullRequestSchema))),
  );
