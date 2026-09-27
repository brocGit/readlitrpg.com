import { setConsent, unsubscribe } from "@rlr/core/readers";
import { EMAIL_LISTS } from "@rlr/core/schema";
import type { APIRoute } from "astro";
import { formBody, readerId, slowDown, unauthorized, writeAllowed } from "../../../lib/api";
import { getDb } from "../../../lib/runtime";

// The email preferences form (DESIGN §9.8): each list on or off, or everything off in one click.
// Signed in means the address is proven, so switching a list on needs no confirmation email.
export const POST: APIRoute = async (ctx) => {
  const userId = await readerId(ctx);
  if (!userId) return unauthorized();
  if (!(await writeAllowed(ctx, "email"))) return slowDown();
  const form = await formBody(ctx.request);
  const db = getDb();
  if (form.get("action") === "unsubscribe_all") {
    await unsubscribe(db, userId, "all");
    return ctx.redirect("/account/email?saved=all", 303);
  }
  const current = new Set(form.getAll("current").map(String));
  for (const list of EMAIL_LISTS) {
    const on = form.get(list) === "on";
    // Only lists the reader changed: an untouched "off" must not turn into an unsubscribe record.
    if (on !== current.has(list)) await setConsent(db, userId, list, on, "account");
  }
  return ctx.redirect("/account/email?saved=1", 303);
};
