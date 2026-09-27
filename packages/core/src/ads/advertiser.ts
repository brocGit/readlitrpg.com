// What an advertiser sees (DESIGN §10.5 Promote, §11.6 reports): the books they can promote, their
// campaigns, and each campaign's delivery with a benchmark. Aggregates only, never readers.

import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "../db";
import {
  adProducts,
  advertisers,
  bookAuthors,
  bookLinks,
  books,
  campaignStatsDaily,
  campaigns,
  creatives,
  follows,
  orderItems,
  orders,
} from "../db/schema";

export interface PromotableBook {
  id: string;
  slug: string;
  title: string;
  links: { id: string; kind: string; url: string }[];
}

/** Published books credited to the profile, with the links a creative may point at (§11.7). */
export async function promotableBooks(db: Db, authorId: string): Promise<PromotableBook[]> {
  const rows = await db
    .selectDistinct({ id: books.id, slug: books.slug, title: books.title })
    .from(books)
    .innerJoin(bookAuthors, eq(bookAuthors.bookId, books.id))
    .where(
      and(eq(bookAuthors.authorId, authorId), eq(books.visibility, "published"), isNull(books.redirectTo)),
    )
    .orderBy(asc(books.title))
    .limit(200);
  const links = rows.length
    ? await db
        .select({ id: bookLinks.id, bookId: bookLinks.bookId, kind: bookLinks.kind, url: bookLinks.url })
        .from(bookLinks)
        .where(inArray(bookLinks.bookId, rows.map((r) => r.id).slice(0, 90)))
    : [];
  return rows.map((r) => ({
    ...r,
    links: links.filter((l) => l.bookId === r.id && l.url.startsWith("https://")),
  }));
}

export async function advertiserOf(db: Db, authorId: string) {
  const [row] = await db
    .select()
    .from(advertisers)
    .where(and(eq(advertisers.ownerType, "author"), eq(advertisers.ownerId, authorId)));
  return row ?? null;
}

export async function campaignsOf(db: Db, advertiserIds: string[], limit = 100) {
  if (!advertiserIds.length) return [];
  return db
    .select({
      id: campaigns.id,
      advertiserId: campaigns.advertiserId,
      name: campaigns.name,
      status: campaigns.status,
      product: adProducts.key,
      productName: adProducts.name,
      startAt: campaigns.startAt,
      endAt: campaigns.endAt,
      budgetCents: campaigns.budgetCents,
      spentMillicents: campaigns.spentMillicents,
      createdAt: campaigns.createdAt,
    })
    .from(campaigns)
    .innerJoin(adProducts, eq(adProducts.id, campaigns.productId))
    .where(inArray(campaigns.advertiserId, advertiserIds.slice(0, 90)))
    .orderBy(desc(campaigns.createdAt))
    .limit(limit);
}

export async function campaignDetail(db: Db, campaignId: string) {
  const [row] = await db
    .select({ campaign: campaigns, product: adProducts, advertiser: advertisers })
    .from(campaigns)
    .innerJoin(adProducts, eq(adProducts.id, campaigns.productId))
    .innerJoin(advertisers, eq(advertisers.id, campaigns.advertiserId))
    .where(eq(campaigns.id, campaignId));
  if (!row) return null;
  const [creative] = await db.select().from(creatives).where(eq(creatives.campaignId, campaignId)).limit(1);
  const [book] = row.campaign.bookId
    ? await db
        .select({ slug: books.slug, title: books.title })
        .from(books)
        .where(eq(books.id, row.campaign.bookId))
    : [];
  const orderIds = (
    await db
      .selectDistinct({ id: orderItems.orderId })
      .from(orderItems)
      .where(eq(orderItems.campaignId, campaignId))
  ).map((o) => o.id);
  const campaignOrders = orderIds.length
    ? await db.select().from(orders).where(inArray(orders.id, orderIds)).orderBy(desc(orders.createdAt))
    : [];
  return { ...row, creative: creative ?? null, book: book ?? null, orders: campaignOrders };
}

export interface CampaignReport {
  days: { date: string; impressions: number; viewable: number; clicks: number; emailSends: number }[];
  totals: { impressions: number; viewable: number; clicks: number; emailSends: number; ctr: number | null };
  /** New follows of the promoted book during the campaign. */
  followsGained: number;
  /** The median click rate of this product's finished campaigns, for comparison. */
  benchmarkCtr: number | null;
}

const ctrOf = (clicks: number, shown: number) => (shown > 0 ? clicks / shown : null);

export async function campaignReport(db: Db, campaignId: string): Promise<CampaignReport | null> {
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!c) return null;
  const rows = await db
    .select({
      date: campaignStatsDaily.date,
      impressions: sql<number>`sum(${campaignStatsDaily.impressions})`,
      viewable: sql<number>`sum(${campaignStatsDaily.viewable})`,
      clicks: sql<number>`sum(${campaignStatsDaily.clicks})`,
      emailSends: sql<number>`sum(${campaignStatsDaily.emailSends})`,
    })
    .from(campaignStatsDaily)
    .where(eq(campaignStatsDaily.campaignKey, campaignId))
    .groupBy(campaignStatsDaily.date)
    .orderBy(asc(campaignStatsDaily.date));
  const days = rows.map((r) => ({
    date: r.date,
    impressions: Number(r.impressions),
    viewable: Number(r.viewable),
    clicks: Number(r.clicks),
    emailSends: Number(r.emailSends),
  }));
  const sum = (k: keyof (typeof days)[number]) => days.reduce((n, d) => n + Number(d[k]), 0);
  const impressions = sum("impressions") + c.qualifiedImpressions;
  const emailSends = sum("emailSends");
  const clicks = sum("clicks");
  const [gained] = c.bookId
    ? await db
        .select({ n: sql<number>`count(*)` })
        .from(follows)
        .where(
          and(
            eq(follows.targetType, "book"),
            eq(follows.targetId, c.bookId),
            gte(follows.createdAt, c.startAt),
            lte(follows.createdAt, c.endAt ?? new Date().toISOString()),
          ),
        )
    : [];
  return {
    days,
    totals: {
      impressions,
      viewable: sum("viewable"),
      clicks,
      emailSends,
      ctr: ctrOf(clicks, impressions + emailSends),
    },
    followsGained: Number(gained?.n ?? 0),
    benchmarkCtr: await benchmarkCtr(db, c.productId),
  };
}

/** Median click rate over the product's last 50 finished campaigns (house ones included). */
async function benchmarkCtr(db: Db, productId: string): Promise<number | null> {
  const done = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.productId, productId), eq(campaigns.status, "completed")))
    .orderBy(desc(campaigns.endAt))
    .limit(50);
  if (done.length < 3) return null;
  const totals = await db
    .select({
      key: campaignStatsDaily.campaignKey,
      shown: sql<number>`sum(${campaignStatsDaily.impressions}) + sum(${campaignStatsDaily.emailSends})`,
      clicks: sql<number>`sum(${campaignStatsDaily.clicks})`,
    })
    .from(campaignStatsDaily)
    .where(
      inArray(
        campaignStatsDaily.campaignKey,
        done.map((d) => d.id),
      ),
    )
    .groupBy(campaignStatsDaily.campaignKey);
  const rates = totals
    .map((t) => ctrOf(Number(t.clicks), Number(t.shown)))
    .filter((r): r is number => r !== null)
    .sort((a, b) => a - b);
  if (rates.length < 3) return null;
  const mid = Math.floor(rates.length / 2);
  return rates.length % 2
    ? (rates[mid] as number)
    : ((rates[mid - 1] as number) + (rates[mid] as number)) / 2;
}
