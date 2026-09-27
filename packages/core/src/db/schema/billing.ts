// Money (DESIGN §5.5, §12): orders, refunds, the credits ledger, subscriptions, promotion codes and
// the Stripe event log. We store Stripe IDs only: no card or bank data ever reaches us (PCI SAQ-A).
// Amounts are integer cents, in USD.

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const createdAt = () => text("created_at").notNull().default(isoNow);
const updatedAt = () => text("updated_at").notNull().default(isoNow);

export const ORDER_STATUSES = [
  "open",
  "paid",
  "refunded",
  "partially_refunded",
  "disputed",
  "expired",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_KINDS = ["promo", "subscription", "comp"] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

/** One purchase: a Checkout session, a subscription invoice, or a comp at $0 (§12.2). */
export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    advertiserId: text("advertiser_id"),
    userId: text("user_id"),
    kind: text("kind", { enum: ORDER_KINDS }).notNull(),
    status: text("status", { enum: ORDER_STATUSES }).notNull().default("open"),
    currency: text("currency").notNull().default("usd"),
    // List price from our inventory snapshots, never from the client.
    amountCents: integer("amount_cents").notNull(),
    // A promotion code's discount, then credits, then what the card pays (§12.5).
    discountCents: integer("discount_cents").notNull().default(0),
    creditsCents: integer("credits_cents").notNull().default(0),
    chargedCents: integer("charged_cents").notNull().default(0),
    refundedCents: integer("refunded_cents").notNull().default(0),
    promoCodeId: text("promo_code_id"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeInvoiceId: text("stripe_invoice_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    expiresAt: text("expires_at"),
    paidAt: text("paid_at"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("orders_session_uq").on(t.stripeCheckoutSessionId),
    uniqueIndex("orders_invoice_uq").on(t.stripeInvoiceId),
    index("orders_payment_intent_idx").on(t.stripePaymentIntentId),
    index("orders_advertiser_idx").on(t.advertiserId, t.createdAt),
    index("orders_status_idx").on(t.status, t.createdAt),
  ],
);

export const orderItems = sqliteTable(
  "order_items",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    campaignId: text("campaign_id"),
    bookingId: text("booking_id"),
    description: text("description").notNull(),
    amountCents: integer("amount_cents").notNull(),
  },
  (t) => [index("order_items_order_idx").on(t.orderId), index("order_items_campaign_idx").on(t.campaignId)],
);

/** Refunds issued, to the card or as credits (§12.5). */
export const refunds = sqliteTable(
  "refunds",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    stripeRefundId: text("stripe_refund_id"),
    amountCents: integer("amount_cents").notNull(),
    toCredits: integer("to_credits", { mode: "boolean" }).notNull().default(false),
    reasonCode: text("reason_code").notNull(),
    note: text("note"),
    // "system" for deterministic rules, or the admin's user id.
    initiatedBy: text("initiated_by").notNull(),
    status: text("status", { enum: ["pending", "succeeded", "failed"] })
      .notNull()
      .default("pending"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("refunds_stripe_uq").on(t.stripeRefundId), index("refunds_order_idx").on(t.orderId)],
);

export const CREDIT_REASONS = [
  "comp",
  "makegood",
  "cancellation",
  "rejection",
  "author_pro",
  "leftover_budget",
  "checkout",
  "checkout_expired",
  "refund",
  "admin",
] as const;
export type CreditReason = (typeof CREDIT_REASONS)[number];

/** Promo credits: append-only, the balance is the sum (§12.5). The database refuses changes. */
export const creditsLedger = sqliteTable(
  "credits_ledger",
  {
    id: text("id").primaryKey(),
    advertiserId: text("advertiser_id").notNull(),
    deltaCents: integer("delta_cents").notNull(),
    reason: text("reason", { enum: CREDIT_REASONS }).notNull(),
    // An order, campaign or subscription id.
    ref: text("ref"),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("credits_ledger_advertiser_idx").on(t.advertiserId, t.createdAt)],
);

export const SUBSCRIPTION_STATUSES = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const;

/** Author Pro (and later Reader Supporter), mirrored from Stripe Billing. */
export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    advertiserId: text("advertiser_id"),
    userId: text("user_id"),
    plan: text("plan", { enum: ["author_pro"] }).notNull(),
    interval: text("interval", { enum: ["month", "year"] }).notNull(),
    status: text("status", { enum: SUBSCRIPTION_STATUSES }).notNull(),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    currentPeriodEnd: text("current_period_end"),
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" }).notNull().default(false),
    // The quarterly promo credit (§11.2) is granted at most once a quarter.
    lastCreditAt: text("last_credit_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("subscriptions_stripe_uq").on(t.stripeSubscriptionId),
    index("subscriptions_advertiser_idx").on(t.advertiserId),
  ],
);

/** Giveaways and launch partners (§11.9): percent or amount off, limited uses. */
export const promoCodes = sqliteTable(
  "promo_codes",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    percentOff: integer("percent_off"),
    amountOffCents: integer("amount_off_cents"),
    // Product keys it applies to; empty for any.
    products: text("products", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    maxRedemptions: integer("max_redemptions").notNull().default(1),
    redemptions: integer("redemptions").notNull().default(0),
    expiresAt: text("expires_at"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("promo_codes_code_uq").on(t.code)],
);

/** Every Stripe webhook event once: idempotency and a replay log (§12.3). */
export const stripeEvents = sqliteTable(
  "stripe_events",
  {
    eventId: text("event_id").primaryKey(),
    type: text("type").notNull(),
    objectId: text("object_id"),
    livemode: integer("livemode", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: ["queued", "processed", "ignored", "failed"] })
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    receivedAt: text("received_at").notNull().default(isoNow),
    processedAt: text("processed_at"),
  },
  (t) => [index("stripe_events_status_idx").on(t.status, t.receivedAt)],
);
