// Clicks (DESIGN §11.6): /go/{token}. The token is HMAC-signed [campaign, slot]; the destination is
// looked up in the database (the book's own link, the house creative's stored URL, or our book
// page), never taken from the URL, so there is no open redirect. Click events go to Analytics
// Engine and are rolled up per campaign.

import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { bookLinks, books, campaigns, creatives } from "../db/schema";
import { type LinkKeys, verifyLink } from "../readers/links";
import { BUILTIN_HOUSE_ADS } from "./serve";

export interface GoTarget {
  url: string;
  campaignKey: string;
  slot: string;
}

export async function resolveGo(
  db: Db,
  keys: LinkKeys,
  token: string,
  origin: string,
): Promise<GoTarget | null> {
  const data = await verifyLink(keys, token, "go");
  if (!data) return null;
  const [campaignKey = "", slot = ""] = data;
  const site = origin.replace(/\/$/, "");
  if (campaignKey.startsWith("house:")) {
    const ad = BUILTIN_HOUSE_ADS.find((b) => `house:${b.key}` === campaignKey);
    return ad ? { url: `${site}${ad.path}`, campaignKey, slot } : null;
  }
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaignKey));
  if (!c) return null;
  const [creative] = await db.select().from(creatives).where(eq(creatives.campaignId, c.id)).limit(1);
  let url: string | null = null;
  if (creative?.destinationLinkId && c.bookId) {
    const [link] = await db
      .select({ url: bookLinks.url })
      .from(bookLinks)
      .where(and(eq(bookLinks.id, creative.destinationLinkId), eq(bookLinks.bookId, c.bookId)));
    url = link?.url ?? null;
  }
  if (!url && creative?.customUrl) url = creative.customUrl;
  if (!url && c.bookId) {
    const [b] = await db.select({ slug: books.slug }).from(books).where(eq(books.id, c.bookId));
    if (b) url = `${site}/books/${b.slug}`;
  }
  if (!url) url = site;
  // Stored destinations were checked at booking; check again before sending anyone there.
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && !url.startsWith(site)) return null;
  } catch {
    return null;
  }
  return { url, campaignKey, slot };
}

export type AdEvent = "ad_served" | "ad_viewable" | "ad_click";
export const AD_EVENTS: readonly AdEvent[] = ["ad_served", "ad_viewable", "ad_click"];

/** An ad event for Analytics Engine. Blob 3 stays empty so it never counts as a referrer. */
export const toAdPoint = (
  kind: AdEvent,
  campaignKey: string,
  slot: string,
  country: string,
): AnalyticsEngineDataPoint => ({
  indexes: [kind],
  blobs: [kind, campaignKey, "", country, slot],
  doubles: [1],
});

const CAMPAIGN_KEY = /^(house:[a-z_]{1,40}|[0-9A-HJKMNP-TV-Z]{26})$/;
const SLOT_KEY = /^[a-z0-9_]{1,40}$/;

/** Up to 6 well-formed [campaignKey, slot] pairs from a beacon body; anything else is dropped. */
export function adPairs(raw: unknown): [string, string][] {
  if (!Array.isArray(raw)) return [];
  const out: [string, string][] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || typeof p[0] !== "string" || typeof p[1] !== "string") continue;
    if (CAMPAIGN_KEY.test(p[0]) && SLOT_KEY.test(p[1])) out.push([p[0], p[1]]);
    if (out.length >= 6) break;
  }
  return out;
}
