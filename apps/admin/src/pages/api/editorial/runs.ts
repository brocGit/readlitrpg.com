import type { APIRoute } from "astro";
import { handleStart, json, readJson, respond, startRunSchema } from "../../../lib/editorial-api";
import { getDb } from "../../../lib/runtime";

/** Start a run: `pnpm editorial start`. */
export const POST: APIRoute = ({ request }) =>
  respond(async () => json(await handleStart(getDb(), await readJson(request, startRunSchema)), 201));
