import { setConsent, startSequence } from "@rlr/core/readers";
import type { APIRoute } from "astro";
import { adoptInputs } from "../../../lib/readers";
import { env, getDb } from "../../../lib/runtime";
import { deliverConfirm, parseSource, requestSubscribe } from "../../../lib/subscribe";

// Email capture from the quiz result, the Match Quiz results and /subscribe (QUIZZES §3.3). Works as
// a JSON call from an island or a plain form post (answered with a redirect).
export const POST: APIRoute = async (ctx) => {
  const json = (ctx.request.headers.get("content-type") ?? "").includes("application/json");
  const body: Record<string, unknown> = json
    ? (((await ctx.request.json().catch(() => null)) as Record<string, unknown> | null) ?? {})
    : Object.fromEntries((await ctx.request.formData().catch(() => new FormData())).entries());
  const db = getDb();

  // Signed in as this very address: it's proven already, so the lists switch on now.
  const session = await ctx.locals.session();
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (session && email && session.email === email) {
    const source = parseSource(body.source, body.plan, body.inputs);
    for (const list of source.lists) await setConsent(db, session.userId, list, true, source.source);
    await adoptInputs(db, session.userId, source.inputs, source.source, await ctx.locals.settings());
    await startSequence(
      db,
      session.userId,
      source.lists.includes("weekly_digest") ? "welcome" : "list_only",
      {
        source: source.source,
      },
    );
    return json ? Response.json({ ok: true, subscribed: true }) : ctx.redirect("/subscribe?done=1", 303);
  }

  const outcome = await requestSubscribe(
    {
      db,
      settings: ctx.locals.settings,
      burstLimiter: env.RL_AUTH,
      ipSaltSeed: env.IP_HASH_SALT_SEED,
      turnstileSecret: env.ENVIRONMENT === "local" ? undefined : (env.TURNSTILE_SECRET ?? ""),
      origin: env.PUBLIC_ORIGIN,
      deliver: (message) => deliverConfirm(env, message),
    },
    {
      email: body.email,
      turnstileToken: body["cf-turnstile-response"],
      ip: ctx.clientAddress,
      plan: body.plan,
      source: body.source,
      inputs: body.inputs,
    },
  );
  if (json)
    return Response.json(outcome, { status: outcome.ok ? 200 : outcome.code === "slow_down" ? 429 : 400 });
  return ctx.redirect(outcome.ok ? "/subscribe?sent=1" : `/subscribe?error=${outcome.code}`, 303);
};
