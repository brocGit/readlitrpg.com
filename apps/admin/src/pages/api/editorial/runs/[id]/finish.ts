import type { APIRoute } from "astro";
import {
  ApiError,
  finishRunSchema,
  handleFinish,
  json,
  readJson,
  respond,
} from "../../../../../lib/editorial-api";
import { getDb } from "../../../../../lib/runtime";

/** Close a run and return its unanswered items to the queue: `pnpm editorial finish`. */
export const POST: APIRoute = ({ request, params }) =>
  respond(async () => {
    if (!params.id || !/^[0-9A-Z]{26}$/.test(params.id)) throw new ApiError(404, "run_not_found");
    return json(await handleFinish(getDb(), params.id, await readJson(request, finishRunSchema)));
  });
