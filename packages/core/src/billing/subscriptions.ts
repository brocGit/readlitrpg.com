// Author Pro (DESIGN §11.2): a Stripe Billing subscription per author profile, mirrored here from
// the subscription object itself (never from the event body). The perks read this table: priority
// review, a quarterly promo credit and the richer stats.

import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { Db } from "../db";
import { advertisers, SUBSCRIPTION_STATUSES, subscriptions } from "../db/schema";
import { ulid } from "../ids";
import { nowIso } from "../time";
import { addCredit } from "./credits";
import type { StripeSubscription } from "./stripe";

export type Subscription = typeof subscriptions.$inferSelect;

/** Statuses in which the perks apply: past_due keeps them while Stripe retries the card. */
export const ACTIVE_STATUSES = ["active", "trialing", "past_due"] as const;

export async function upsertSubscription(
  db: Db,
  s: StripeSubscription,
  link: { advertiserId?: string | null; userId?: string | null },
  now = new Date(),
): Promise<Subscription> {
  const status = (SUBSCRIPTION_STATUSES as readonly string[]).includes(s.status)
    ? (s.status as Subscription["status"])
    : "incomplete";
  const interval = s.items.data[0]?.price.recurring?.interval === "year" ? "year" : "month";
  const values = {
    status,
    interval: interval as "month" | "year",
    currentPeriodEnd: s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null,
    cancelAtPeriodEnd: Boolean(s.cancel_at_period_end),
    updatedAt: nowIso(now),
  };
  const [row] = await db
    .insert(subscriptions)
    .values({
      id: ulid(),
      advertiserId: link.advertiserId ?? s.metadata.advertiser_id ?? null,
      userId: link.userId ?? s.metadata.user_id ?? null,
      plan: "author_pro",
      stripeSubscriptionId: s.id,
      stripeCustomerId: s.customer,
      createdAt: nowIso(now),
      ...values,
    })
    .onConflictDoUpdate({ target: subscriptions.stripeSubscriptionId, set: values })
    .returning();
  if (!row) throw new Error("subscription upsert failed");
  return row;
}

export async function activePro(db: Db, advertiserId: string): Promise<Subscription | null> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.advertiserId, advertiserId),
        eq(subscriptions.plan, "author_pro"),
        inArray(subscriptions.status, [...ACTIVE_STATUSES]),
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  return row ?? null;
}

export async function subscriptionsOf(db: Db, advertiserId: string): Promise<Subscription[]> {
  return db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.advertiserId, advertiserId))
    .orderBy(desc(subscriptions.createdAt));
}

/**
 * The quarterly promo credit (§11.2): granted when an invoice is paid and none was given in the
 * last 89 days, so monthly and yearly plans get the same once a quarter. Returns the amount given.
 */
export async function grantQuarterlyCredit(
  db: Db,
  sub: Subscription,
  amountCents: number,
  now = new Date(),
): Promise<number> {
  if (!sub.advertiserId || amountCents <= 0) return 0;
  const cutoff = new Date(now.getTime() - 89 * 86_400_000).toISOString();
  // Claim the grant with one conditional update, so two invoices at once grant once.
  const claimed = await db
    .update(subscriptions)
    .set({ lastCreditAt: nowIso(now) })
    .where(
      and(
        eq(subscriptions.id, sub.id),
        or(isNull(subscriptions.lastCreditAt), lt(subscriptions.lastCreditAt, cutoff)),
      ),
    )
    .returning({ id: subscriptions.id });
  if (!claimed.length) return 0;
  await addCredit(
    db,
    {
      advertiserId: sub.advertiserId,
      amountCents,
      reason: "author_pro",
      ref: sub.id,
      note: "Author Pro quarterly credit",
      createdBy: "system",
    },
    now,
  );
  return amountCents;
}

/** Whether an author profile has Author Pro now (priority review, the Pro stats). */
export async function isProAuthor(db: Db, authorId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .innerJoin(advertisers, eq(advertisers.id, subscriptions.advertiserId))
    .where(
      and(
        eq(advertisers.ownerType, "author"),
        eq(advertisers.ownerId, authorId),
        eq(subscriptions.plan, "author_pro"),
        inArray(subscriptions.status, [...ACTIVE_STATUSES]),
      ),
    )
    .limit(1);
  return Boolean(row);
}
