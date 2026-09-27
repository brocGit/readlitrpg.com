import { issueFeedToken, revokeFeedTokens } from "@rlr/core/readers";
import type { APIRoute } from "astro";
import { formBody, readerId, slowDown, unauthorized, writeAllowed } from "../../../lib/api";
import { getDb } from "../../../lib/runtime";

// The private calendar feed (DESIGN §9.6). A new token replaces the old one; the token is shown
// once, on the page this redirects to, and only its hash is stored.
export const POST: APIRoute = async (ctx) => {
  const userId = await readerId(ctx);
  if (!userId) return unauthorized();
  if (!(await writeAllowed(ctx, "feed"))) return slowDown();
  const form = await formBody(ctx.request);
  const db = getDb();
  if (form.get("action") === "revoke") {
    await revokeFeedTokens(db, userId);
    return ctx.redirect("/account/follows?feed=revoked", 303);
  }
  const token = await issueFeedToken(db, userId);
  return ctx.redirect(`/account/follows?feed=${token}`, 303);
};
