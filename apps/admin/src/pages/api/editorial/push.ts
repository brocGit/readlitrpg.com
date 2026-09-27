import type { APIRoute } from "astro";
import { handlePush, json, pushRequestSchema, readJson, respond } from "../../../lib/editorial-api";
import { getDb } from "../../../lib/runtime";

/** Send proposals back: `pnpm editorial push`. The policy engine decides what is applied. */
export const POST: APIRoute = ({ request, locals }) =>
  respond(async () =>
    json(await handlePush(getDb(), await locals.settings(), await readJson(request, pushRequestSchema))),
  );
