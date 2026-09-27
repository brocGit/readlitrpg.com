import type { APIRoute } from "astro";
import { handleStatus, json, respond } from "../../../lib/editorial-api";
import { getDb } from "../../../lib/runtime";

/** Queue depth and recent runs: `pnpm editorial status`. */
export const GET: APIRoute = () => respond(async () => json(await handleStatus(getDb())));
