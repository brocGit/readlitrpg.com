import type { APIRoute } from "astro";
import { env, getAuth, getDb } from "../../../lib/runtime";
import { requestMagicLink } from "../../../lib/signin";

// Works without JavaScript: a plain form post, answered with a redirect.
export const POST: APIRoute = async (ctx) => {
  const form = await ctx.request.formData().catch(() => null);
  const outcome = await requestMagicLink(
    {
      auth: getAuth(),
      db: getDb(),
      settings: ctx.locals.settings,
      burstLimiter: env.RL_AUTH,
      ipSaltSeed: env.IP_HASH_SALT_SEED,
      turnstileSecret: env.ENVIRONMENT === "local" ? undefined : (env.TURNSTILE_SECRET ?? ""),
    },
    {
      email: form?.get("email"),
      turnstileToken: form?.get("cf-turnstile-response"),
      ip: ctx.clientAddress,
      headers: ctx.request.headers,
    },
  );
  return ctx.redirect(outcome.ok ? "/signin?sent=1" : `/signin?error=${outcome.code}`, 303);
};
