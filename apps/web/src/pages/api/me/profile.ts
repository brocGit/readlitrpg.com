import { decodeInputs, matchInputsSchema } from "@rlr/core/match";
import { levelUp } from "@rlr/core/readers";
import type { APIRoute } from "astro";
import { z } from "zod";
import { fail, formBody, readerId, slowDown, unauthorized, writeAllowed } from "../../../lib/api";
import { saveTastes } from "../../../lib/readers";
import { getDb } from "../../../lib/runtime";

// "Save as my tastes" from match results (JSON with a share-link value), and the preferences page's
// "clear my tastes" and format choices (form posts). DESIGN §9.7.
export const POST: APIRoute = async (ctx) => {
  const userId = await readerId(ctx);
  if (!userId) return unauthorized();
  if (!(await writeAllowed(ctx, "profile"))) return slowDown();
  const db = getDb();
  const settings = await ctx.locals.settings();
  if ((ctx.request.headers.get("content-type") ?? "").includes("application/json")) {
    const body = z
      .object({ inputs: z.string().max(4000) })
      .safeParse(await ctx.request.json().catch(() => null));
    const inputs = body.success ? decodeInputs(body.data.inputs) : null;
    if (!inputs) return fail("invalid");
    const profile = await saveTastes(db, userId, inputs, settings, { replace: true, onboarded: true });
    return Response.json({
      level: profile.level,
      readerClass: profile.readerClass,
      levelUp: levelUp(profile.level, profile.previousLevel),
    });
  }
  const form = await formBody(ctx.request);
  if (form.get("action") === "clear") {
    await saveTastes(db, userId, {}, settings, { replace: true });
    return ctx.redirect("/account/preferences?cleared=1", 303);
  }
  if (form.get("action") === "formats") {
    const formats = matchInputsSchema.shape.formats.safeParse(form.getAll("formats"));
    if (!formats.success) return fail("invalid");
    await saveTastes(db, userId, { formats: formats.data?.length ? formats.data : undefined }, settings);
    return ctx.redirect("/account/preferences?saved=1", 303);
  }
  if (form.get("action") === "onboarded") {
    await saveTastes(db, userId, {}, settings, { onboarded: true });
    return ctx.redirect(String(form.get("next") ?? "") === "match" ? "/match/quiz" : "/account", 303);
  }
  return fail("invalid");
};
