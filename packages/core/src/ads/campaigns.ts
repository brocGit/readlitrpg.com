// House campaigns (DESIGN §11.9): the owner advertises anything for free through the same engine.
// Reserved mode books inventory like a paid booking (a comp at $0, no Stripe); backfill mode takes
// no inventory and shows only where a position went unsold, rotating by weight.

import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../db";
import {
  adProducts,
  bookings,
  bookLinks,
  books,
  bookTags,
  campaigns,
  creatives,
  inventoryUnits,
  tags,
} from "../db/schema";
import { ulid } from "../ids";
import { nowIso } from "../time";
import { AD_PRODUCTS, houseAdvertiserId } from "./catalog";
import { ensureUnit, giveBack, periodFor, sellUnit } from "./inventory";

export const CTA_LABELS = [
  "Read now",
  "Preorder",
  "Listen now",
  "Start the series",
  "Read free on Royal Road",
  "Learn more",
  "Take the quiz",
  "Subscribe",
] as const;

export class CampaignError extends Error {}

export interface HouseCampaignInput {
  name: string;
  productKey: string;
  mode: "reserved" | "backfill";
  /** Reserved: exactly one. Backfill: any of the product's (all when empty). */
  slots?: string[];
  bookId?: string | null;
  headline: string;
  body?: string | null;
  cta: string;
  customUrl?: string | null;
  destinationLinkId?: string | null;
  /** A tag slug (Tag Page Sponsor) or book slug (Books-Like Sponsor). */
  target?: string | null;
  startDate: string;
  endDate?: string | null;
  weight?: number;
  ownBook?: boolean;
  createdBy: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) => day(new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000));

/** Deterministic creative checks (§11.7): lengths, characters, the book's own links. */
async function checkCreative(db: Db, input: HouseCampaignInput): Promise<void> {
  const headline = input.headline.trim();
  if (!headline || headline.length > 60) throw new CampaignError("the headline is 1–60 characters");
  if ((input.body ?? "").length > 200) throw new CampaignError("the body is at most 200 characters");
  const text = headline + (input.body ?? "");
  if (/[<>{}]/.test(text) || [...text].some((ch) => ch.charCodeAt(0) < 32 && ch !== "\n"))
    throw new CampaignError("no markup in the text");
  if (!(CTA_LABELS as readonly string[]).includes(input.cta))
    throw new CampaignError("pick a call to action");
  if (input.customUrl) {
    let url: URL;
    try {
      url = new URL(input.customUrl);
    } catch {
      throw new CampaignError("the destination isn't a valid address");
    }
    if (url.protocol !== "https:") throw new CampaignError("the destination must be https");
  }
  if (!input.bookId && !input.customUrl) throw new CampaignError("choose a book or a destination");
  if (input.destinationLinkId) {
    const [link] = await db
      .select({ id: bookLinks.id })
      .from(bookLinks)
      .where(and(eq(bookLinks.id, input.destinationLinkId), eq(bookLinks.bookId, input.bookId ?? "")));
    if (!link) throw new CampaignError("the destination must be one of the book's own links");
  }
}

/** Where a book may be shown: published, in scope, carrying the tag for a Tag Page Sponsor. */
export async function checkBook(
  db: Db,
  bookId: string,
  productKey: string,
  target: string | null,
): Promise<void> {
  const [b] = await db
    .select({ visibility: books.visibility, flags: books.contentFlags, inScope: books.inScope })
    .from(books)
    .where(eq(books.id, bookId));
  if (b?.visibility !== "published") throw new CampaignError("the book must be published");
  if (b.inScope === "no") throw new CampaignError("out-of-scope books can't be promoted");
  if (productKey === "home_spotlight" && b.flags.some((f) => /explicit|sexual/.test(f)))
    throw new CampaignError("books flagged explicit can't use the Homepage Spotlight");
  if (productKey === "tag_sponsor" && target) {
    const [t] = await db
      .select({ score: bookTags.score })
      .from(bookTags)
      .innerJoin(tags, eq(tags.id, bookTags.tagId))
      .where(and(eq(bookTags.bookId, bookId), eq(tags.slug, target)));
    if (!t || t.score < 0.6) throw new CampaignError(`the book must carry the ${target} tag`);
  }
}

export async function createHouseCampaign(
  db: Db,
  input: HouseCampaignInput,
): Promise<{ campaignId: string; booked: number }> {
  const def = AD_PRODUCTS.find((p) => p.key === input.productKey);
  if (!def) throw new CampaignError("unknown product");
  const [product] = await db
    .select({ id: adProducts.id })
    .from(adProducts)
    .where(eq(adProducts.key, def.key));
  if (!product) throw new CampaignError("the ad catalog isn't set up yet");
  const slots = (input.slots ?? []).filter((s) => def.slots.includes(s));
  if (input.mode === "reserved" && slots.length !== 1)
    throw new CampaignError("a reserved campaign takes one slot");
  const target = input.target?.trim() || null;
  if (def.targeting !== "none" && input.mode === "reserved" && !target)
    throw new CampaignError(`a reserved ${def.name} needs a ${def.targeting}`);
  if (!DATE.test(input.startDate)) throw new CampaignError("pick a start date");
  const end = input.endDate?.trim() || null;
  if (end && (!DATE.test(end) || end < input.startDate))
    throw new CampaignError("the end date is before the start");
  if (input.mode === "reserved" && (!end || end > addDays(input.startDate, 365)))
    throw new CampaignError("a reserved campaign needs an end date within a year");
  if (input.bookId) await checkBook(db, input.bookId, def.key, target);
  await checkCreative(db, input);

  const id = ulid();
  const advertiserId = await houseAdvertiserId(db);
  // Reserved: take one place in each period, all or nothing.
  const taken: string[] = [];
  if (input.mode === "reserved" && end) {
    const slot = slots[0] as string;
    const seen = new Set<string>();
    for (let date = input.startDate; date <= end; date = addDays(date, 1)) {
      const p = periodFor(def.period, date);
      if (seen.has(p.start)) continue;
      seen.add(p.start);
      const unit = await ensureUnit(db, slot, date, target ?? "");
      if (!unit || !(await sellUnit(db, unit.id, { allowBlackout: true }))) {
        for (const u of taken) await giveBack(db, u, "sold");
        throw new CampaignError(`${slot} is already booked for ${p.start}`);
      }
      taken.push(unit.id);
    }
  }
  await db.insert(campaigns).values({
    id,
    advertiserId,
    productId: product.id,
    name: input.name.trim().slice(0, 120) || input.headline.slice(0, 60),
    bookId: input.bookId ?? null,
    status: "scheduled",
    mode: input.mode,
    targeting: { slots, ...(target ? { [def.targeting]: target } : {}) },
    weight: Math.max(1, Math.min(100, Math.round(input.weight ?? 1))),
    ownBook: Boolean(input.ownBook),
    startAt: `${input.startDate}T00:00:00.000Z`,
    endAt: end ? `${end}T23:59:59.999Z` : null,
    createdBy: input.createdBy,
  });
  await db.insert(creatives).values({
    id: ulid(),
    campaignId: id,
    headline: input.headline.trim(),
    body: input.body?.trim() || null,
    ctaLabel: input.cta,
    customUrl: input.customUrl ?? null,
    destinationLinkId: input.destinationLinkId ?? null,
    reviewStatus: "approved",
  });
  for (let i = 0; i < taken.length; i += 12)
    await db.insert(bookings).values(
      taken.slice(i, i + 12).map((unitId) => ({
        id: ulid(),
        campaignId: id,
        inventoryUnitId: unitId,
        status: "confirmed" as const,
      })),
    );
  return { campaignId: id, booked: taken.length };
}

/** Pause or resume a campaign; ending one gives its future places back. */
export async function setCampaignState(
  db: Db,
  id: string,
  to: "paused" | "scheduled" | "completed",
  now = new Date(),
): Promise<void> {
  await db
    .update(campaigns)
    .set({ status: to, ...(to === "completed" ? { endAt: nowIso(now) } : {}), updatedAt: nowIso(now) })
    .where(eq(campaigns.id, id));
  if (to !== "completed") return;
  const future = await db
    .select({ id: bookings.id, unitId: bookings.inventoryUnitId })
    .from(bookings)
    .innerJoin(inventoryUnits, eq(inventoryUnits.id, bookings.inventoryUnitId))
    .where(
      and(
        eq(bookings.campaignId, id),
        eq(bookings.status, "confirmed"),
        gt(inventoryUnits.periodStart, day(now)),
      ),
    );
  for (const b of future) {
    await db
      .update(bookings)
      .set({ status: "released", updatedAt: nowIso(now) })
      .where(eq(bookings.id, b.id));
    await giveBack(db, b.unitId, "sold");
  }
}

/** Scheduled campaigns go live on their start, and end on their end date (every heartbeat). */
export async function advanceCampaigns(db: Db, now = new Date()): Promise<void> {
  const iso = nowIso(now);
  await db
    .update(campaigns)
    .set({ status: "live", updatedAt: iso })
    .where(
      and(
        eq(campaigns.status, "scheduled"),
        lte(campaigns.startAt, iso),
        or(isNull(campaigns.endAt), gt(campaigns.endAt, iso)),
      ),
    );
  await db
    .update(campaigns)
    .set({ status: "completed", updatedAt: iso })
    .where(
      and(
        inArray(campaigns.status, ["scheduled", "live"]),
        isNotNull(campaigns.endAt),
        lte(campaigns.endAt, iso),
      ),
    );
}

export async function listCampaigns(db: Db, limit = 100) {
  return db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      status: campaigns.status,
      mode: campaigns.mode,
      product: adProducts.key,
      startAt: campaigns.startAt,
      endAt: campaigns.endAt,
      weight: campaigns.weight,
      targeting: campaigns.targeting,
    })
    .from(campaigns)
    .innerJoin(adProducts, eq(adProducts.id, campaigns.productId))
    .orderBy(desc(campaigns.createdAt))
    .limit(limit);
}
