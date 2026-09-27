// Running paid promotions (DESIGN §11.6, §11.8): settle finished campaigns (unspent budget to
// credit, bookings delivered, the report emailed), make good newsletter placements that didn't go
// out, and suggest next month's prices from audience and sell-through, for the owner to approve.

import { and, count, countDistinct, desc, eq, gte, inArray, isNull, lt, sum } from "drizzle-orm";
import { notifyAuthor } from "../authors/notices";
import { addCredit } from "../billing/credits";
import type { Db } from "../db";
import {
  adProducts,
  adSlots,
  advertisers,
  bookings,
  campaigns,
  emailSends,
  follows,
  inventoryUnits,
  newsletterIssues,
  pageViewsDaily,
} from "../db/schema";
import { openInboxItem } from "../inbox";
import type { Settings } from "../settings";
import { isoWeek, nowIso } from "../time";
import { campaignReport } from "./advertiser";
import { AD_PRODUCTS } from "./catalog";
import { creditLeftover } from "./sponsored";

const DAY_MS = 86_400_000;
const today = (now: Date) => now.toISOString().slice(0, 10);

/**
 * Finished paid campaigns, once each: unspent Sponsored Match budget becomes credit, past bookings
 * count as delivered, and the author gets the report (§11.6). Returns how many were settled.
 */
export async function settleFinishedCampaigns(db: Db, now = new Date()): Promise<number> {
  const due = await db
    .select({ campaign: campaigns, authorId: advertisers.ownerId, ownerType: advertisers.ownerType })
    .from(campaigns)
    .innerJoin(advertisers, eq(advertisers.id, campaigns.advertiserId))
    .where(
      and(eq(campaigns.status, "completed"), isNull(campaigns.settledAt), eq(advertisers.isHouse, false)),
    )
    .limit(25);
  let settled = 0;
  for (const { campaign: c, authorId, ownerType } of due) {
    // Claim it first, so two runs can't settle the same campaign twice.
    const claimed = await db
      .update(campaigns)
      .set({ settledAt: nowIso(now) })
      .where(and(eq(campaigns.id, c.id), isNull(campaigns.settledAt)))
      .returning({ id: campaigns.id });
    if (!claimed.length) continue;
    const left = c.budgetCents ? await creditLeftover(db, c, now) : 0;
    await db
      .update(bookings)
      .set({ status: "delivered", updatedAt: nowIso(now) })
      .where(and(eq(bookings.campaignId, c.id), eq(bookings.status, "confirmed")));
    const report = await campaignReport(db, c.id);
    if (report && ownerType === "author" && authorId)
      await notifyAuthor(db, {
        authorId,
        kind: "ad_report",
        payload: {
          campaignId: c.id,
          title: c.name,
          impressions: report.totals.impressions,
          viewable: report.totals.viewable,
          clicks: report.totals.clicks,
          emailSends: report.totals.emailSends,
          followsGained: report.followsGained,
          leftoverCents: left,
        },
      });
    settled++;
  }
  return settled;
}

/**
 * A paid newsletter placement whose issue never went out (§11.6 makegoods): the booking becomes a
 * make-good, the price comes back as credit, and the author hears why. Checked once the week is over.
 */
export async function newsletterMakegoods(db: Db, now = new Date()): Promise<number> {
  const weekOver = new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10);
  const rows = await db
    .select({
      bookingId: bookings.id,
      campaignId: campaigns.id,
      name: campaigns.name,
      advertiserId: campaigns.advertiserId,
      authorId: advertisers.ownerId,
      ownerType: advertisers.ownerType,
      periodStart: inventoryUnits.periodStart,
      price: inventoryUnits.priceCents,
    })
    .from(bookings)
    .innerJoin(inventoryUnits, eq(inventoryUnits.id, bookings.inventoryUnitId))
    .innerJoin(adSlots, eq(adSlots.id, inventoryUnits.slotId))
    .innerJoin(campaigns, eq(campaigns.id, bookings.campaignId))
    .innerJoin(advertisers, eq(advertisers.id, campaigns.advertiserId))
    .where(
      and(
        eq(bookings.status, "confirmed"),
        eq(adSlots.surface, "newsletter"),
        lt(inventoryUnits.periodEnd, weekOver),
        eq(advertisers.isHouse, false),
      ),
    )
    .limit(50);
  let made = 0;
  for (const r of rows) {
    const week = isoWeek(new Date(`${r.periodStart}T12:00:00Z`));
    const [issue] = await db
      .select({ status: newsletterIssues.status })
      .from(newsletterIssues)
      .where(and(eq(newsletterIssues.kind, "weekly"), eq(newsletterIssues.week, week)));
    const sent = issue?.status === "sent";
    const moved = await db
      .update(bookings)
      .set({ status: sent ? "delivered" : "makegood", updatedAt: nowIso(now) })
      .where(and(eq(bookings.id, r.bookingId), eq(bookings.status, "confirmed")))
      .returning({ id: bookings.id });
    if (!moved.length || sent) continue;
    await addCredit(
      db,
      {
        advertiserId: r.advertiserId,
        amountCents: r.price,
        reason: "makegood",
        ref: r.bookingId,
        note: `Patch Notes ${week} didn't go out`,
        createdBy: "system",
      },
      now,
    );
    if (r.ownerType === "author" && r.authorId)
      await notifyAuthor(db, {
        authorId: r.authorId,
        kind: "makegood",
        payload: {
          campaignId: r.campaignId,
          title: r.name,
          amount: `$${(r.price / 100).toFixed(2)}`,
          reason: `Patch Notes didn't go out in the week of ${r.periodStart}`,
        },
      });
    made++;
  }
  return made;
}

export interface PriceSuggestion {
  product: string;
  name: string;
  currentCents: number;
  suggestedCents: number;
  /** What the price is based on: readers per period. */
  audience: number;
  /** Share of places sold over the last 4 weeks (untargeted products). */
  sellThrough: number | null;
  multiplier: number;
}

const round50 = (cents: number) => Math.round(cents / 50) * 50;

/**
 * §11.8: suggested = clamp(floor, audience × target CPM / 1000 × demand, 2 × current). Audience is
 * readers per period; demand is 1.15 above 80% sell-through, 0.9 below 30%. Nothing changes until
 * the owner approves the inbox item, and bookings keep the price they were bought at.
 */
export async function suggestPrices(
  db: Db,
  settings: Settings,
  now = new Date(),
): Promise<PriceSuggestion[]> {
  const since28 = new Date(now.getTime() - 28 * DAY_MS).toISOString().slice(0, 10);
  const viewsOf = async (kind: string) => {
    const [row] = await db
      .select({ n: sum(pageViewsDaily.views), keys: countDistinct(pageViewsDaily.key) })
      .from(pageViewsDaily)
      .where(and(eq(pageViewsDaily.kind, kind), gte(pageViewsDaily.day, since28)));
    return { total: Number(row?.n ?? 0), keys: Math.max(1, Number(row?.keys ?? 0)) };
  };
  // Newsletter: delivered per issue over the last four weekly issues.
  const issues = await db
    .select({ id: newsletterIssues.id })
    .from(newsletterIssues)
    .where(and(eq(newsletterIssues.kind, "weekly"), eq(newsletterIssues.status, "sent")))
    .orderBy(desc(newsletterIssues.createdAt))
    .limit(4);
  const [delivered] = issues.length
    ? await db
        .select({ n: count() })
        .from(emailSends)
        .where(
          and(
            inArray(
              emailSends.issueId,
              issues.map((i) => i.id),
            ),
            inArray(emailSends.status, ["sent", "delivered"]),
          ),
        )
    : [];
  const perIssue = issues.length ? Number(delivered?.n ?? 0) / issues.length : 0;
  const home = await viewsOf("home");
  const tag = await viewsOf("tag");
  const like = await viewsOf("books_like");
  const [tagFollows] = await db
    .select({ n: count(), tags: countDistinct(follows.targetId) })
    .from(follows)
    .where(eq(follows.targetType, "tag"));
  const audience: Record<string, number> = {
    newsletter_top: perIssue,
    newsletter_standard: perIssue,
    home_spotlight: home.total / 28,
    tag_sponsor:
      tag.total / 4 / tag.keys +
      (0.5 * Number(tagFollows?.n ?? 0)) / Math.max(1, Number(tagFollows?.tags ?? 0)),
    books_like_sponsor: like.total / 4 / like.keys,
  };
  const out: PriceSuggestion[] = [];
  for (const key of Object.keys(audience)) {
    const def = AD_PRODUCTS.find((p) => p.key === key);
    if (!def) continue;
    const current = settings["ads.prices"][key] ?? def.basePriceCents;
    let sellThrough: number | null = null;
    if (def.targeting === "none") {
      const [st] = await db
        .select({ sold: sum(inventoryUnits.sold), cap: sum(inventoryUnits.capacity) })
        .from(inventoryUnits)
        .innerJoin(adSlots, eq(adSlots.id, inventoryUnits.slotId))
        .innerJoin(adProducts, eq(adProducts.id, adSlots.productId))
        .where(
          and(
            eq(adProducts.key, key),
            gte(inventoryUnits.periodStart, since28),
            lt(inventoryUnits.periodStart, today(now)),
          ),
        );
      const cap = Number(st?.cap ?? 0);
      sellThrough = cap ? Number(st?.sold ?? 0) / cap : null;
    }
    const multiplier = sellThrough === null ? 1 : sellThrough > 0.8 ? 1.15 : sellThrough < 0.3 ? 0.9 : 1;
    const cpm =
      def.surface === "newsletter"
        ? settings["ads.target_cpm_cents"].newsletter
        : settings["ads.target_cpm_cents"].web;
    const raw = ((audience[key] ?? 0) * cpm * multiplier) / 1000;
    const suggested = round50(Math.min(current * 2, Math.max(settings["ads.price_floor_cents"], raw)));
    out.push({
      product: key,
      name: def.name,
      currentCents: current,
      suggestedCents: suggested,
      audience: Math.round(audience[key] ?? 0),
      sellThrough,
      multiplier,
    });
  }
  return out;
}

/** Monthly: one inbox item listing old and new prices, when any moves by 10% or more (§11.8). */
export async function openPriceSuggestions(db: Db, settings: Settings, now = new Date()): Promise<boolean> {
  const list = await suggestPrices(db, settings, now);
  const moved = list.filter((s) => Math.abs(s.suggestedCents - s.currentCents) >= s.currentCents * 0.1);
  if (!moved.length) return false;
  const prices = {
    ...settings["ads.prices"],
    ...Object.fromEntries(moved.map((s) => [s.product, s.suggestedCents])),
  };
  const item = await openInboxItem(db, {
    type: "price_suggestions",
    title: `Price suggestions for ${now.toISOString().slice(0, 7)}: ${moved.length} change${moved.length === 1 ? "" : "s"}`,
    priority: 40,
    aiSummary: moved
      .map(
        (s) => `${s.name}: $${(s.currentCents / 100).toFixed(2)} → $${(s.suggestedCents / 100).toFixed(2)}`,
      )
      .join("; "),
    payload: { suggestions: list, prices },
    defaultAction: "expire",
    defaultActionAt: new Date(now.getTime() + 14 * DAY_MS).toISOString(),
    dedupeKey: `price_suggestions:${now.toISOString().slice(0, 7)}`,
  });
  return item !== null;
}
