// Subscribing by email (DESIGN §13.3, QUIZZES §3.3): validation, bot check, rate limits, then a
// pending consent and a confirmation email. The answer is the same whether the address is new,
// already subscribed or blocked, so the form reveals nothing about who is on the list.

import { hashIp, maskEmail } from "@rlr/core";
import type { Db } from "@rlr/core/db";
import { decodeInputs, encodeInputs, type MatchInputs } from "@rlr/core/match";
import { getOutcome, getQuiz } from "@rlr/core/quiz";
import { hitAll, type RateLimitBinding, SUBSCRIBE_LIMITS } from "@rlr/core/ratelimit";
import { requestSubscription } from "@rlr/core/readers";
import type { EmailList } from "@rlr/core/schema";
import { verifyTurnstile } from "@rlr/core/security";
import type { Settings } from "@rlr/core/settings";
import { z } from "zod";

export type SubscribeOutcome =
  | { ok: true }
  | { ok: false; code: "invalid_email" | "bot_check" | "slow_down" | "read_only" | "unavailable" };

export interface ConfirmMessage {
  to: string;
  userId: string;
  url: string;
  className: string | null;
  listOnly: boolean;
  /** Patch Notes Daily only (M7). */
  daily: boolean;
}

export interface SubscribeDeps {
  db: Db;
  settings: () => Promise<Settings>;
  burstLimiter: RateLimitBinding;
  ipSaltSeed: string;
  /** Unset only in local development, where the check is skipped. */
  turnstileSecret?: string;
  origin: string;
  deliver: (message: ConfirmMessage) => Promise<void>;
  fetch?: typeof fetch;
}

export interface SubscribeRequest {
  email: unknown;
  turnstileToken: unknown;
  ip: string;
  /** "list" = just the reading list; anything else = the reading list and the weekly email. */
  plan: unknown;
  /** "newsletter", "match" or "quiz:{slug}:{outcome}". */
  source: unknown;
  /** Match inputs (a share-link value) to seed the reader's profile when they confirm. */
  inputs?: unknown;
}

export interface Source {
  source: string;
  lists: EmailList[];
  className: string | null;
  inputs: MatchInputs | null;
}

/** What the reader signed up from decides the lists, the email's wording and a starting profile. */
export function parseSource(raw: unknown, plan: unknown, inputs: unknown): Source {
  const listOnly = plan === "list";
  const text = typeof raw === "string" ? raw : "";
  const quizMatch = /^quiz:([a-z0-9-]{1,80}):([a-z0-9_-]{1,60})$/.exec(text);
  if (quizMatch) {
    const quiz = getQuiz(quizMatch[1] ?? "");
    const outcome = quiz ? getOutcome(quiz, quizMatch[2] ?? "") : undefined;
    if (quiz && outcome)
      return {
        source: `quiz:${quiz.slug}:${outcome.key}`,
        lists: listOnly ? ["reading_list"] : ["reading_list", "weekly_digest"],
        className: outcome.name,
        inputs: { quiz: { slug: quiz.slug, outcome: outcome.key } },
      };
  }
  if (text === "match") {
    const decoded = typeof inputs === "string" && inputs.length <= 1500 ? decodeInputs(inputs) : null;
    return {
      source: "match",
      lists: listOnly ? ["reading_list"] : ["reading_list", "weekly_digest"],
      className: null,
      inputs: decoded,
    };
  }
  if (text === "daily") return { source: "daily", lists: ["daily_digest"], className: null, inputs: null };
  return { source: "newsletter", lists: ["weekly_digest"], className: null, inputs: null };
}

const emailSchema = z.email().max(320);

export async function requestSubscribe(
  deps: SubscribeDeps,
  input: SubscribeRequest,
): Promise<SubscribeOutcome> {
  const settings = await deps.settings();
  if (settings["flags.read_only_mode"]) return { ok: false, code: "read_only" };
  const parsed = emailSchema.safeParse(
    typeof input.email === "string" ? input.email.trim().toLowerCase() : "",
  );
  if (!parsed.success) return { ok: false, code: "invalid_email" };
  const email = parsed.data;

  if (deps.turnstileSecret !== undefined) {
    const bot = await verifyTurnstile(typeof input.turnstileToken === "string" ? input.turnstileToken : "", {
      secret: deps.turnstileSecret,
      ip: input.ip,
      expectedAction: "subscribe",
      fetch: deps.fetch,
    });
    if (!bot.ok) return { ok: false, code: "bot_check" };
  }

  const ipHash = await hashIp(input.ip, deps.ipSaltSeed);
  if (!(await deps.burstLimiter.limit({ key: `subscribe:${ipHash}` })).success)
    return { ok: false, code: "slow_down" };
  const windows = await hitAll(deps.db, [
    { rule: SUBSCRIBE_LIMITS.perIp, subject: ipHash },
    { rule: SUBSCRIBE_LIMITS.perEmail, subject: email },
  ]);
  if (!windows.ok) {
    // Too many confirmations for one address: answer as if we sent it.
    if (windows.rule === SUBSCRIBE_LIMITS.perEmail.rule) return { ok: true };
    return { ok: false, code: "slow_down" };
  }

  const source = parseSource(input.source, input.plan, input.inputs);
  const result = await requestSubscription(deps.db, {
    email,
    lists: source.lists,
    source: source.source,
    ipHash,
  });
  // Already subscribed or blocked: say the same thing and send nothing.
  if (result.status !== "confirm") return { ok: true };
  const url = new URL("/subscribe/confirm", deps.origin);
  url.searchParams.set("t", result.token);
  if (source.inputs && Object.keys(source.inputs).length)
    url.searchParams.set("p", encodeInputs(source.inputs));
  try {
    await deps.deliver({
      to: email,
      userId: result.userId,
      url: url.toString(),
      className: source.className,
      listOnly: !source.lists.includes("weekly_digest"),
      daily: source.lists.includes("daily_digest"),
    });
  } catch {
    return { ok: false, code: "unavailable" };
  }
  return { ok: true };
}

export interface ConfirmEnv {
  ENVIRONMENT: string;
  EMAIL_DELIVERY: string;
  Q_EMAIL: Queue;
}

export async function deliverConfirm(env: ConfirmEnv, message: ConfirmMessage): Promise<void> {
  if (env.EMAIL_DELIVERY === "console") {
    if (env.ENVIRONMENT !== "local") throw new Error("console email delivery is for local development only");
    console.log(`\n[dev] Subscription confirmation for ${maskEmail(message.to)}:\n${message.url}\n`);
    return;
  }
  await env.Q_EMAIL.send({ kind: "confirm_subscription", ...message, requestedAt: new Date().toISOString() });
}

export const SUBSCRIBE_MESSAGES: Record<Exclude<SubscribeOutcome, { ok: true }>["code"], string> = {
  invalid_email: "That doesn't look like an email address. Check it and try again.",
  bot_check: "We couldn't confirm you're human. Refresh the page and try again.",
  slow_down: "Too many attempts from here. Wait a few minutes, then try again.",
  read_only: "Signups are paused for maintenance. Please try again soon.",
  unavailable: "Something went wrong on our side. Please try again in a minute.",
};
