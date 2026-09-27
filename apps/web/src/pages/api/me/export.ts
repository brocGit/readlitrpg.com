import { requestExport } from "@rlr/core/readers";
import type { APIRoute } from "astro";
import { readerId, slowDown, unauthorized, writeAllowed } from "../../../lib/api";
import { getDb } from "../../../lib/runtime";

// "Export my data" (DESIGN §9.8): the exports.build job writes the file and emails a link.
export const POST: APIRoute = async (ctx) => {
  const userId = await readerId(ctx);
  if (!userId) return unauthorized();
  if (!(await writeAllowed(ctx, "export"))) return slowDown();
  await requestExport(getDb(), userId);
  return ctx.redirect("/account/privacy?export=queued", 303);
};
