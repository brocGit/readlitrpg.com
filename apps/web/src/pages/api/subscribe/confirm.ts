import { decodeInputs } from "@rlr/core/match";
import { attachTakes } from "@rlr/core/quiz";
import { confirmSubscription, startSequence } from "@rlr/core/readers";
import type { APIRoute } from "astro";
import { adoptInputs } from "../../../lib/readers";
import { directSignInUrl, getDb } from "../../../lib/runtime";

// The button on /subscribe/confirm (never the emailed link itself, so scanners can't confirm).
// Consent turns active, this browser's quiz takes attach, the quiz or match result seeds the
// profile, the welcome emails start, and the reader lands signed in on onboarding (DESIGN §9.7).
export const POST: APIRoute = async (ctx) => {
  const form = await ctx.request.formData().catch(() => new FormData());
  const token = String(form.get("t") ?? "");
  const db = getDb();
  const confirmed = await confirmSubscription(db, token);
  if (!confirmed) return ctx.redirect("/subscribe/confirm?error=link", 303);

  const takes = String(form.get("takes") ?? "")
    .split(",")
    .filter(Boolean);
  await attachTakes(db, confirmed.userId, takes);
  const p = String(form.get("p") ?? "");
  await adoptInputs(
    db,
    confirmed.userId,
    p ? decodeInputs(p) : null,
    confirmed.source,
    await ctx.locals.settings(),
  );
  await startSequence(
    db,
    confirmed.userId,
    confirmed.lists.includes("weekly_digest") ? "welcome" : "list_only",
    {
      source: confirmed.source,
    },
  );

  // Someone else is signed in on this browser: confirm, but don't switch accounts.
  const session = await ctx.locals.session();
  if (session && session.userId !== confirmed.userId) return ctx.redirect("/subscribe?done=1", 303);
  if (session) return ctx.redirect("/welcome?confirmed=1", 303);
  const url = await directSignInUrl(confirmed.email, "/welcome?confirmed=1", ctx.request.headers).catch(
    () => null,
  );
  return ctx.redirect(url ?? "/subscribe?done=1", 303);
};
