// Rate limits (DESIGN §15.9). Short bursts use the Workers Rate Limiting binding (10 s or 60 s
// periods). Longer windows use atomic fixed-window counters in D1.

import { sql } from "drizzle-orm";
import { sha256Hex } from "../crypto";
import type { Db } from "../db";
import { rateCounters } from "../db/schema";

export interface WindowLimit {
  /** A short name for the rule, e.g. "signin.email". Part of the counter key. */
  rule: string;
  limit: number;
  windowSeconds: number;
}

export interface LimitResult {
  ok: boolean;
  count: number;
  limit: number;
  /** Seconds until the window resets. */
  retryAfter: number;
}

/** Count one hit against `rule` for `subject` and say whether it is within the limit. */
export async function hitWindow(
  db: Db,
  rule: WindowLimit,
  subject: string,
  now = new Date(),
): Promise<LimitResult> {
  const windowMs = rule.windowSeconds * 1000;
  const start = Math.floor(now.getTime() / windowMs) * windowMs;
  const windowStart = new Date(start).toISOString();
  const expiresAt = new Date(start + windowMs).toISOString();
  // Hash the subject so raw emails and IPs never land in the table.
  const key = `${rule.rule}:${(await sha256Hex(`${rule.rule}:${subject}`)).slice(0, 32)}`;
  const [row] = await db
    .insert(rateCounters)
    .values({ key, windowStart, count: 1, expiresAt })
    .onConflictDoUpdate({
      target: [rateCounters.key, rateCounters.windowStart],
      set: { count: sql`${rateCounters.count} + 1` },
    })
    .returning({ count: rateCounters.count });
  const count = row?.count ?? 1;
  return {
    ok: count <= rule.limit,
    count,
    limit: rule.limit,
    retryAfter: Math.max(1, Math.ceil((start + windowMs - now.getTime()) / 1000)),
  };
}

/** Check several rules; every rule is counted, and the result fails if any rule is over. */
export async function hitAll(
  db: Db,
  checks: { rule: WindowLimit; subject: string }[],
  now = new Date(),
): Promise<LimitResult & { rule?: string }> {
  let worst: LimitResult & { rule?: string } = { ok: true, count: 0, limit: 0, retryAfter: 0 };
  for (const { rule, subject } of checks) {
    const result = await hitWindow(db, rule, subject, now);
    if (!result.ok && (worst.ok || result.retryAfter > worst.retryAfter))
      worst = { ...result, rule: rule.rule };
  }
  return worst;
}

/** The Workers Rate Limiting binding, typed structurally so tests can fake it. */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export const SIGNIN_LIMITS = {
  perEmail: { rule: "signin.email", limit: 3, windowSeconds: 15 * 60 },
  perIp: { rule: "signin.ip", limit: 10, windowSeconds: 60 * 60 },
} as const satisfies Record<string, WindowLimit>;

/** Subscription confirmations: a few per address a day, so nobody can flood an inbox (§15.9). */
export const SUBSCRIBE_LIMITS = {
  perEmail: { rule: "subscribe.email", limit: 3, windowSeconds: 24 * 60 * 60 },
  perIp: { rule: "subscribe.ip", limit: 20, windowSeconds: 60 * 60 },
} as const satisfies Record<string, WindowLimit>;
