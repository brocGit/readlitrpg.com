// The products and slots the ad engine knows (DESIGN §11.2), kept in code and seeded into D1 so
// inventory, bookings and reports can point at them. Phase 1 runs house campaigns on these same
// slots; prices matter from Phase 1.5 (paid) and are settings-driven from then (§11.8).

import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { type AdPeriod, adProducts, adSlots, advertisers } from "../db/schema";
import { ulid } from "../ids";

export interface ProductDef {
  key: string;
  name: string;
  description: string;
  surface: string;
  basePriceCents: number;
  period: AdPeriod;
  targeting: "none" | "tag" | "book";
  slots: string[];
}

export const AD_PRODUCTS: ProductDef[] = [
  {
    key: "home_spotlight",
    name: "Homepage Spotlight",
    description: "The Spotlight row on the home page, positions 1–3, for a day.",
    surface: "home",
    basePriceCents: 1_000,
    period: "day",
    targeting: "none",
    slots: ["home_spotlight_1", "home_spotlight_2", "home_spotlight_3"],
  },
  {
    key: "tag_sponsor",
    name: "Tag Page Sponsor",
    description: "The top of one tag's page for a week. The book must carry the tag.",
    surface: "tag",
    basePriceCents: 1_000,
    period: "week",
    targeting: "tag",
    slots: ["tag_sponsor"],
  },
  {
    key: "books_like_sponsor",
    name: "Books-Like Sponsor",
    description:
      "A labeled slot on one book's “Books like X” page for a week, for a book among its top matches.",
    surface: "books_like",
    basePriceCents: 1_000,
    period: "week",
    targeting: "book",
    slots: ["books_like_sponsor"],
  },
  {
    key: "newsletter_top",
    name: "Newsletter Featured Book (top)",
    description: "The top featured slot in one Patch Notes issue.",
    surface: "newsletter",
    basePriceCents: 2_500,
    period: "issue",
    targeting: "none",
    slots: ["newsletter_top"],
  },
  {
    // Budget-paced (§11.3): no slots or inventory; one labeled place in match results, chosen per
    // reader and counted on our server. The price is per 1,000 qualified impressions.
    key: "sponsored_match",
    name: "Sponsored Match",
    description: "One labeled place in match results, shown only to readers the book matches well.",
    surface: "match",
    basePriceCents: 800,
    period: "day",
    targeting: "none",
    slots: [],
  },
  {
    key: "newsletter_standard",
    name: "Newsletter Featured Book",
    description: "A standard featured slot in one Patch Notes issue.",
    surface: "newsletter",
    basePriceCents: 1_500,
    period: "issue",
    targeting: "none",
    slots: ["newsletter_standard_1", "newsletter_standard_2"],
  },
];

export const SLOT_PRODUCT = new Map(AD_PRODUCTS.flatMap((p) => p.slots.map((s) => [s, p] as const)));

export const HOUSE_ADVERTISER = { ownerType: "house" as const, ownerId: "house", name: "ReadLitRPG (house)" };

/** Seed the house advertiser, products and slots. Safe to run any time; existing rows are kept. */
export async function ensureAdCatalog(db: Db): Promise<void> {
  await db
    .insert(advertisers)
    .values({ id: ulid(), ...HOUSE_ADVERTISER, trustLevel: "T2", isHouse: true })
    .onConflictDoNothing();
  for (const p of AD_PRODUCTS) {
    await db
      .insert(adProducts)
      .values({
        id: ulid(),
        key: p.key,
        name: p.name,
        description: p.description,
        surface: p.surface,
        basePriceCents: p.basePriceCents,
        specs: { period: p.period, targeting: p.targeting },
      })
      .onConflictDoNothing();
    const [product] = await db
      .select({ id: adProducts.id })
      .from(adProducts)
      .where(eq(adProducts.key, p.key));
    if (!product) continue;
    for (const key of p.slots)
      await db
        .insert(adSlots)
        .values({
          id: ulid(),
          productId: product.id,
          key,
          period: p.period,
          surface: p.surface,
          targeting: p.targeting,
        })
        .onConflictDoNothing();
  }
}

export async function houseAdvertiserId(db: Db): Promise<string> {
  const [row] = await db
    .select({ id: advertisers.id })
    .from(advertisers)
    .where(eq(advertisers.isHouse, true))
    .limit(1);
  if (row) return row.id;
  await ensureAdCatalog(db);
  return houseAdvertiserId(db);
}
