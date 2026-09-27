// Advertising (DESIGN §5.5, §11). Phase 1 serves house campaigns only (§3: "the ad engine ships
// with house campaigns only"), so the inventory and serving code meets real traffic before money is
// involved. Orders, refunds, credits and subscriptions arrive with paid products (M8).

import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const createdAt = () => text("created_at").notNull().default(isoNow);
const updatedAt = () => text("updated_at").notNull().default(isoNow);

/** A billing identity: an author or publisher profile, or HOUSE (the owner, free, §11.9). */
export const advertisers = sqliteTable(
  "advertisers",
  {
    id: text("id").primaryKey(),
    ownerType: text("owner_type", { enum: ["house", "author", "publisher"] }).notNull(),
    ownerId: text("owner_id"),
    name: text("name").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    trustLevel: text("trust_level").notNull().default("T0"),
    isHouse: integer("is_house", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("advertisers_owner_uq").on(t.ownerType, t.ownerId)],
);

export const AD_PERIODS = ["day", "week", "issue"] as const;
export type AdPeriod = (typeof AD_PERIODS)[number];

export const adProducts = sqliteTable(
  "ad_products",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    surface: text("surface").notNull(),
    specs: text("specs", { mode: "json" }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
    basePriceCents: integer("base_price_cents").notNull(),
    pricingRule: text("pricing_rule", { mode: "json" }).$type<Record<string, unknown>>(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    phase: text("phase").notNull().default("1.5"),
  },
  (t) => [uniqueIndex("ad_products_key_uq").on(t.key)],
);

/** A physical position a product occupies, e.g. home_spotlight_1. */
export const adSlots = sqliteTable(
  "ad_slots",
  {
    id: text("id").primaryKey(),
    productId: text("product_id").notNull(),
    key: text("key").notNull(),
    capacityPerPeriod: integer("capacity_per_period").notNull().default(1),
    period: text("period", { enum: AD_PERIODS }).notNull(),
    surface: text("surface").notNull(),
    // Slots sold per tag or per book (a Tag Page Sponsor, a Books-Like Sponsor): units are made on
    // demand for each target instead of 120 days ahead.
    targeting: text("targeting", { enum: ["none", "tag", "book"] })
      .notNull()
      .default("none"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [uniqueIndex("ad_slots_key_uq").on(t.key)],
);

/** One row per slot, period (and target) with a price snapshot (§11.3). */
export const inventoryUnits = sqliteTable(
  "inventory_units",
  {
    id: text("id").primaryKey(),
    slotId: text("slot_id").notNull(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    // "" for untargeted slots; a tag or book slug otherwise.
    target: text("target").notNull().default(""),
    capacity: integer("capacity").notNull(),
    sold: integer("sold").notNull().default(0),
    held: integer("held").notNull().default(0),
    priceCents: integer("price_cents").notNull(),
    // Kept for house campaigns (e.g. Christmas week), not sold (§11.3).
    blackout: integer("blackout", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("inventory_units_uq").on(t.slotId, t.periodStart, t.target),
    index("inventory_units_period_idx").on(t.periodStart, t.periodEnd),
  ],
);

export const CAMPAIGN_STATUSES = [
  "draft",
  "held",
  "paid",
  "in_review",
  "approved",
  "scheduled",
  "live",
  "paused",
  "completed",
  "rejected",
  "refunded",
  "cancelled",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export interface CampaignTargeting {
  /** The slots a backfill campaign may fill (all of its product's when empty). */
  slots?: string[];
  tag?: string;
  book?: string;
}

export const campaigns = sqliteTable(
  "campaigns",
  {
    id: text("id").primaryKey(),
    advertiserId: text("advertiser_id").notNull(),
    productId: text("product_id").notNull(),
    name: text("name").notNull(),
    bookId: text("book_id"),
    status: text("status", { enum: CAMPAIGN_STATUSES }).notNull().default("draft"),
    // reserved: books inventory like a paid booking (a comp at $0); backfill: shows only where a
    // position went unsold, rotating by weight (§11.9).
    mode: text("mode", { enum: ["reserved", "backfill"] }).notNull(),
    targeting: text("targeting", { mode: "json" }).$type<CampaignTargeting>().notNull().default(sql`'{}'`),
    weight: integer("weight").notNull().default(1),
    // The owner promoting their own book as an author is labeled "Sponsored" (§11.9, FTC).
    ownBook: integer("own_book", { mode: "boolean" }).notNull().default(false),
    startAt: text("start_at").notNull(),
    // Null: ongoing.
    endAt: text("end_at"),
    // Budget-paced products (Sponsored Match, §11.3): a prepaid budget spent per qualified
    // impression. Spend is kept in thousandths of a cent so a CPM price divides exactly.
    budgetCents: integer("budget_cents"),
    cpmCents: integer("cpm_cents"),
    spentMillicents: integer("spent_millicents").notNull().default(0),
    qualifiedImpressions: integer("qualified_impressions").notNull().default(0),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("campaigns_status_idx").on(t.status, t.startAt),
    index("campaigns_advertiser_idx").on(t.advertiserId),
  ],
);

export const creatives = sqliteTable(
  "creatives",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id").notNull(),
    headline: text("headline").notNull(),
    body: text("body"),
    ctaLabel: text("cta_label").notNull(),
    // One of the book's own links (§11.7), looked up by id at click time: never from the URL.
    destinationLinkId: text("destination_link_id"),
    // House only (§11.9): any https destination, validated and stored.
    customUrl: text("custom_url"),
    imageMediaId: text("image_media_id"),
    reviewStatus: text("review_status", { enum: ["pending", "approved", "rejected"] })
      .notNull()
      .default("approved"),
    reviewNotes: text("review_notes"),
    riskScore: integer("risk_score"),
    createdAt: createdAt(),
  },
  (t) => [index("creatives_campaign_idx").on(t.campaignId)],
);

export const bookings = sqliteTable(
  "bookings",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id").notNull(),
    inventoryUnitId: text("inventory_unit_id").notNull(),
    status: text("status", { enum: ["held", "confirmed", "released", "delivered", "makegood"] }).notNull(),
    holdExpiresAt: text("hold_expires_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("bookings_unit_idx").on(t.inventoryUnitId, t.status),
    index("bookings_campaign_idx").on(t.campaignId),
    index("bookings_hold_idx").on(t.status, t.holdExpiresAt),
  ],
);

/** Daily delivery per campaign and surface, rolled up from Analytics Engine (§11.6). */
export const campaignStatsDaily = sqliteTable(
  "campaign_stats_daily",
  {
    // A campaign id, or "house:<key>" for the built-in house ads.
    campaignKey: text("campaign_key").notNull(),
    date: text("date").notNull(),
    surface: text("surface").notNull(),
    impressions: integer("impressions").notNull().default(0),
    viewable: integer("viewable").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    emailSends: integer("email_sends").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.campaignKey, t.date, t.surface] })],
);
