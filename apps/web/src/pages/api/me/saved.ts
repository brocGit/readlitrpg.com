import { ActivityError, saveQuery, setConsent, updateSaved } from "@rlr/core/readers";
import { QUERY_ALERTS, QUERY_KINDS } from "@rlr/core/schema";
import type { APIRoute } from "astro";
import { z } from "zod";
import { fail, formBody, readerId, slowDown, unauthorized, writeAllowed } from "../../../lib/api";
import { getDb } from "../../../lib/runtime";

const create = z.object({
  kind: z.enum(QUERY_KINDS),
  name: z.string().max(80),
  // The query string that reproduces the results; only our own parameters are kept.
  params: z
    .string()
    .max(4000)
    .regex(/^[A-Za-z0-9_\-=&%.+,]*$/),
  alert: z.enum(QUERY_ALERTS).optional(),
});
const change = z.object({
  id: z.string().max(40),
  alert: z.enum(QUERY_ALERTS).optional(),
  remove: z.string().optional(),
});

// JSON from the results islands creates; form posts from /account/books change or remove.
export const POST: APIRoute = async (ctx) => {
  const userId = await readerId(ctx);
  if (!userId) return unauthorized();
  if (!(await writeAllowed(ctx, "saved"))) return slowDown();
  const db = getDb();
  if ((ctx.request.headers.get("content-type") ?? "").includes("application/json")) {
    const parsed = create.safeParse(await ctx.request.json().catch(() => null));
    if (!parsed.success) return fail("invalid");
    try {
      return Response.json({ id: await saveQuery(db, userId, parsed.data) });
    } catch (error) {
      if (error instanceof ActivityError) return fail(error.message);
      throw error;
    }
  }
  const parsed = change.safeParse(Object.fromEntries((await formBody(ctx.request)).entries()));
  if (!parsed.success) return fail("invalid");
  await updateSaved(db, userId, parsed.data.id, {
    alert: parsed.data.alert,
    remove: Boolean(parsed.data.remove),
  });
  // Asking for instant alerts is the opt-in to the release-alerts list.
  if (parsed.data.alert === "instant" && !parsed.data.remove)
    await setConsent(db, userId, "release_alerts", true, "saved_search");
  return ctx.redirect("/account/books?saved=1", 303);
};
