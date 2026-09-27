// Subscriptions (DESIGN §13.3, QUIZZES §3.3): double opt-in for every list, consent recorded per list
// with its source and a daily-salted IP hash, one-click unsubscribe, and suppression by email hash.
// Nothing here says whether an address already has an account: callers answer the same either way.

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { randomToken, sha256Hex } from "../crypto";
import type { Db } from "../db";
import { type EmailList, emailConsents, type SUPPRESSION_REASONS, suppressions, users } from "../db/schema";
import { ulid } from "../ids";
import { nowIso } from "../time";

export const CONFIRM_TTL_DAYS = 7;

/** Suppressions hold only this hash of the normalized address (DESIGN §16.2). */
export const emailHash = (email: string) => sha256Hex(`email:${email.trim().toLowerCase()}`);

type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** Reasons that stop marketing mail; a hard bounce stops everything (the address doesn't work). */
export async function isSuppressed(
  db: Db,
  email: string,
  stream: "marketing" | "transactional",
): Promise<boolean> {
  const [row] = await db
    .select({ reason: suppressions.reason })
    .from(suppressions)
    .where(eq(suppressions.emailHash, await emailHash(email)));
  if (!row) return false;
  return stream === "marketing" || row.reason === "bounce_hard";
}

export async function suppress(db: Db, email: string, reason: SuppressionReason): Promise<void> {
  const insert = db
    .insert(suppressions)
    .values({ emailHash: await emailHash(email), reason, createdAt: nowIso() });
  // A complaint or bounce outranks an unsubscribe: it replaces a weaker reason, never the reverse.
  if (reason === "complaint" || reason === "bounce_hard")
    await insert.onConflictDoUpdate({ target: suppressions.emailHash, set: { reason } });
  else await insert.onConflictDoNothing();
}

export interface SubscribeInput {
  email: string;
  lists: EmailList[];
  source: string;
  ipHash?: string | null;
}

export type SubscribeResult =
  | { status: "confirm"; userId: string; token: string }
  | { status: "already"; userId: string }
  | { status: "blocked" };

/**
 * Record pending consent and return a confirmation token to email. A complaint or hard bounce on
 * this address means we never mail it (blocked); an earlier "unsubscribe from everything" is lifted
 * only when the reader confirms this new request.
 */
export async function requestSubscription(db: Db, input: SubscribeInput): Promise<SubscribeResult> {
  const email = input.email.trim().toLowerCase();
  const [suppressed] = await db
    .select({ reason: suppressions.reason })
    .from(suppressions)
    .where(eq(suppressions.emailHash, await emailHash(email)));
  if (
    suppressed &&
    (suppressed.reason === "complaint" ||
      suppressed.reason === "bounce_hard" ||
      suppressed.reason === "manual")
  )
    return { status: "blocked" };
  let [user] = await db
    .select({ id: users.id, state: users.state })
    .from(users)
    .where(eq(users.email, email));
  if (user && (user.state === "deleted" || user.state === "restricted")) return { status: "blocked" };
  if (!user) {
    const id = ulid();
    await db.insert(users).values({ id, email, name: "", emailVerified: false, state: "subscriber" });
    user = { id, state: "subscriber" };
  }
  const existing = await db
    .select({ list: emailConsents.list, status: emailConsents.status })
    .from(emailConsents)
    .where(and(eq(emailConsents.userId, user.id), inArray(emailConsents.list, input.lists)));
  const wanted = input.lists.filter((l) => existing.find((e) => e.list === l)?.status !== "active");
  if (wanted.length === 0) return { status: "already", userId: user.id };
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = nowIso();
  for (const list of wanted) {
    await db
      .insert(emailConsents)
      .values({
        id: ulid(),
        userId: user.id,
        list,
        status: "pending",
        source: input.source.slice(0, 120),
        ipHash: input.ipHash ?? null,
        confirmTokenHash: tokenHash,
        consentedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [emailConsents.userId, emailConsents.list],
        set: {
          status: "pending",
          source: input.source.slice(0, 120),
          ipHash: input.ipHash ?? null,
          confirmTokenHash: tokenHash,
          consentedAt: now,
          updatedAt: now,
        },
      });
  }
  return { status: "confirm", userId: user.id, token };
}

export interface Confirmed {
  userId: string;
  email: string;
  lists: EmailList[];
  source: string;
}

/** The reader clicked the link: consent becomes active, and the address counts as verified. */
export async function confirmSubscription(
  db: Db,
  token: string,
  now = new Date(),
): Promise<Confirmed | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  const oldest = new Date(now.getTime() - CONFIRM_TTL_DAYS * 86_400_000).toISOString();
  const pending = await db
    .select()
    .from(emailConsents)
    .where(and(eq(emailConsents.confirmTokenHash, hash), eq(emailConsents.status, "pending")));
  const fresh = pending.filter((p) => p.consentedAt >= oldest);
  const first = fresh[0];
  if (!first) return null;
  const stamp = nowIso(now);
  await db
    .update(emailConsents)
    .set({ status: "active", confirmedAt: stamp, confirmTokenHash: null, updatedAt: stamp })
    .where(and(eq(emailConsents.confirmTokenHash, hash), eq(emailConsents.status, "pending")));
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, first.userId));
  if (!user) return null;
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, first.userId));
  // A new, confirmed request outweighs an old "unsubscribe from everything".
  await db
    .delete(suppressions)
    .where(
      and(
        eq(suppressions.emailHash, await emailHash(user.email)),
        inArray(suppressions.reason, ["unsub_all", "account_deleted"]),
      ),
    );
  return { userId: first.userId, email: user.email, lists: fresh.map((f) => f.list), source: first.source };
}

/**
 * Signed-in readers have proved their address, so a list they switch on is active at once
 * (DESIGN §13.3's double opt-in is satisfied by the sign-in link).
 */
export async function setConsent(
  db: Db,
  userId: string,
  list: EmailList,
  on: boolean,
  source = "account",
): Promise<void> {
  const now = nowIso();
  await db
    .insert(emailConsents)
    .values({
      id: ulid(),
      userId,
      list,
      status: on ? "active" : "unsubscribed",
      source,
      consentedAt: now,
      confirmedAt: on ? now : null,
      unsubscribedAt: on ? null : now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [emailConsents.userId, emailConsents.list],
      set: on
        ? {
            status: "active",
            source,
            confirmedAt: now,
            unsubscribedAt: null,
            confirmTokenHash: null,
            updatedAt: now,
          }
        : { status: "unsubscribed", unsubscribedAt: now, confirmTokenHash: null, updatedAt: now },
    });
  if (on) {
    // Switching a list on while signed in is a fresh, verified request: it lifts an old
    // "unsubscribe from everything", as a confirmed subscription does. Complaints and bounces stay.
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    if (user)
      await db
        .delete(suppressions)
        .where(
          and(
            eq(suppressions.emailHash, await emailHash(user.email)),
            inArray(suppressions.reason, ["unsub_all", "account_deleted"]),
          ),
        );
  }
}

/** One click, from any email (RFC 8058) or the account page. "all" also suppresses the address. */
export async function unsubscribe(db: Db, userId: string, list: EmailList | "all"): Promise<boolean> {
  const now = nowIso();
  const where =
    list === "all"
      ? eq(emailConsents.userId, userId)
      : and(eq(emailConsents.userId, userId), eq(emailConsents.list, list));
  await db
    .update(emailConsents)
    .set({ status: "unsubscribed", unsubscribedAt: now, confirmTokenHash: null, updatedAt: now })
    .where(where);
  if (list === "all") {
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    if (!user) return false;
    await suppress(db, user.email, "unsub_all");
  }
  return true;
}

export async function consentsFor(db: Db, userId: string) {
  return db
    .select({
      list: emailConsents.list,
      status: emailConsents.status,
      source: emailConsents.source,
      confirmedAt: emailConsents.confirmedAt,
    })
    .from(emailConsents)
    .where(eq(emailConsents.userId, userId));
}

/**
 * Pending consents that were never confirmed are dropped after the confirmation window, and so is
 * a subscriber-only address left with no consent at all: we keep no email we may not use.
 */
export async function purgeUnconfirmed(db: Db, now = new Date()): Promise<number> {
  const oldest = new Date(now.getTime() - CONFIRM_TTL_DAYS * 86_400_000).toISOString();
  const rows = await db
    .delete(emailConsents)
    .where(and(eq(emailConsents.status, "pending"), lt(emailConsents.consentedAt, oldest)))
    .returning({ id: emailConsents.id });
  const orphans = await db
    .delete(users)
    .where(
      and(
        eq(users.state, "subscriber"),
        eq(users.emailVerified, false),
        lt(users.createdAt, new Date(now.getTime() - CONFIRM_TTL_DAYS * 86_400_000)),
        sql`not exists (select 1 from email_consents c where c.user_id = "users"."id")`,
      ),
    )
    .returning({ id: users.id });
  return rows.length + orphans.length;
}
