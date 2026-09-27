// Requesting a sign-in link: validation, bot check, rate limits, then Better Auth.
// The response never says whether an account exists (DESIGN §15.9: identical responses).

import { hashIp } from "@rlr/core";
import type { WebAuth } from "@rlr/core/auth";
import type { Db } from "@rlr/core/db";
import { hitAll, type RateLimitBinding, SIGNIN_LIMITS } from "@rlr/core/ratelimit";
import { verifyTurnstile } from "@rlr/core/security";
import type { Settings } from "@rlr/core/settings";
import { z } from "zod";

export type SigninOutcome =
  | { ok: true }
  | { ok: false; code: "invalid_email" | "bot_check" | "slow_down" | "read_only" | "unavailable" };

export interface SigninDeps {
  auth: Pick<WebAuth, "api">;
  db: Db;
  settings: () => Promise<Settings>;
  burstLimiter: RateLimitBinding;
  ipSaltSeed: string;
  /** Unset only in local development, where the check is skipped. */
  turnstileSecret?: string;
  fetch?: typeof fetch;
}

const emailSchema = z.email().max(320);

export async function requestMagicLink(
  deps: SigninDeps,
  input: { email: unknown; turnstileToken: unknown; ip: string; headers: Headers },
): Promise<SigninOutcome> {
  const settings = await deps.settings();
  if (settings["flags.read_only_mode"]) return { ok: false, code: "read_only" };

  const parsed = emailSchema.safeParse(
    typeof input.email === "string" ? input.email.trim().toLowerCase() : "",
  );
  if (!parsed.success) return { ok: false, code: "invalid_email" };
  const email = parsed.data;

  if (deps.turnstileSecret !== undefined) {
    const token = typeof input.turnstileToken === "string" ? input.turnstileToken : "";
    const bot = await verifyTurnstile(token, {
      secret: deps.turnstileSecret,
      ip: input.ip,
      expectedAction: "signin",
      fetch: deps.fetch,
    });
    if (!bot.ok) return { ok: false, code: "bot_check" };
  }

  const ipHash = await hashIp(input.ip, deps.ipSaltSeed);
  const burst = await deps.burstLimiter.limit({ key: `signin:${ipHash}` });
  if (!burst.success) return { ok: false, code: "slow_down" };

  const windows = await hitAll(deps.db, [
    { rule: SIGNIN_LIMITS.perIp, subject: ipHash },
    { rule: SIGNIN_LIMITS.perEmail, subject: email },
  ]);
  if (!windows.ok) {
    // Too many links for one address: answer as if we sent it, so the limit reveals nothing.
    if (windows.rule === SIGNIN_LIMITS.perEmail.rule) return { ok: true };
    return { ok: false, code: "slow_down" };
  }

  try {
    await deps.auth.api.signInMagicLink({
      body: {
        email,
        callbackURL: "/account",
        newUserCallbackURL: "/welcome",
        errorCallbackURL: "/signin?error=link",
      },
      headers: input.headers,
    });
  } catch {
    return { ok: false, code: "unavailable" };
  }
  return { ok: true };
}

export const SIGNIN_MESSAGES: Record<Exclude<SigninOutcome, { ok: true }>["code"] | "link", string> = {
  invalid_email: "That doesn't look like an email address. Check it and try again.",
  bot_check: "We couldn't confirm you're human. Refresh the page and try again.",
  slow_down: "Too many attempts from here. Wait a few minutes, then try again.",
  read_only: "Sign-in is paused for maintenance. Please try again soon.",
  unavailable: "Something went wrong on our side. Please try again in a minute.",
  link: "That sign-in link has expired or was already used. Request a new one below.",
};
