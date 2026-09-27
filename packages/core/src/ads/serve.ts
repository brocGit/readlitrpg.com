// Choosing what fills each ad position (DESIGN §11.5). For a fixed slot and period: the confirmed
// booking, if any; otherwise house backfill campaigns, rotated by hash(slot, period) so they change
// per period, not per request; otherwise a built-in house ad. Placements render into the page's
// cached HTML, so the choice is the same for everyone on that page and period.

import { and, eq, gt, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../db";
import { adSlots, advertisers, bookings, campaigns, creatives, inventoryUnits } from "../db/schema";
import { type LinkKeys, signLink } from "../readers/links";
import { type BookListItem, bookItems } from "../site/pages";
import { nowIso } from "../time";
import { SLOT_PRODUCT } from "./catalog";
import { periodFor } from "./inventory";

export interface BuiltinAd {
  key: string;
  surfaces: string[];
  headline: string;
  body: string;
  cta: string;
  path: string;
}

/** Last-resort backfill (§11.9), from templates: zero owner effort. */
export const BUILTIN_HOUSE_ADS: BuiltinAd[] = [
  {
    key: "patch_notes",
    surfaces: ["home", "tag", "books_like"],
    headline: "Patch Notes, every Friday",
    body: "New LitRPG matched to your taste, and what's out from what you follow. Free.",
    cta: "Subscribe",
    path: "/subscribe",
  },
  {
    key: "quizzes",
    surfaces: ["home", "books_like"],
    headline: "What's your LitRPG class?",
    body: "A few questions, one reader class, and a reading list to match.",
    cta: "Take the quiz",
    path: "/quiz",
  },
  {
    key: "today",
    surfaces: ["home", "tag"],
    headline: "Today in LitRPG",
    body: "Books out today, new announcements and date changes, every morning.",
    cta: "Learn more",
    path: "/news/today",
  },
  {
    key: "authors",
    surfaces: ["home", "tag", "books_like"],
    headline: "Write LitRPG? List your books free",
    body: "Claim your profile, fix what we got wrong, and see how often readers are matched to your books.",
    cta: "Learn more",
    path: "/for-authors",
  },
  {
    key: "match",
    surfaces: ["tag", "books_like"],
    headline: "Tell it three books you loved",
    body: "The match engine finds your next read, with the reasons it fits.",
    cta: "Learn more",
    path: "/match",
  },
];

export interface Placement {
  slot: string;
  /** A campaign id, or house:<key> for a built-in. Reported by the beacon. */
  campaignKey: string;
  label: "Sponsored" | "From ReadLitRPG";
  headline: string;
  body: string | null;
  cta: string;
  /** /go/<signed token>: the destination is looked up at click time, never taken from the URL. */
  href: string;
  /** rel="sponsored" on paid placements and the owner's own books (§11.5). */
  sponsored: boolean;
  book: BookListItem | null;
}

/** FNV-1a: a stable pick per slot and period. */
export function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Order by weight, deterministically: a weighted draw seeded by the slot and period, then the rest. */
function weightedOrder<T extends { id: string; weight: number }>(items: T[], seed: string): T[] {
  const left = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const out: T[] = [];
  let h = stableHash(seed);
  while (left.length) {
    const total = left.reduce((n, x) => n + x.weight, 0);
    let pick = h % total;
    let i = 0;
    while (i < left.length - 1 && pick >= (left[i]?.weight ?? 0)) {
      pick -= left[i]?.weight ?? 0;
      i++;
    }
    out.push(...left.splice(i, 1));
    h = stableHash(`${h}`);
  }
  return out;
}

export interface PlacementRequest {
  slots: string[];
  /** The day being served (YYYY-MM-DD). */
  date: string;
  /** A tag or book slug, for targeted slots. */
  target?: string;
  /** Context guards (§11.5): e.g. a Books-Like Sponsor must be among the page book's matches. */
  guard?: (bookId: string) => boolean;
  /** Books already on the page. */
  exclude?: ReadonlySet<string>;
  /** Built-in house ads as the last resort (not in email). */
  builtins?: boolean;
  now?: Date;
}

export async function placementsFor(db: Db, keys: LinkKeys, req: PlacementRequest): Promise<Placement[]> {
  const now = req.now ?? new Date();
  const nowS = nowIso(now);
  const target = req.target ?? "";
  const slotRows = await db
    .select({
      id: adSlots.id,
      key: adSlots.key,
      productId: adSlots.productId,
      surface: adSlots.surface,
      period: adSlots.period,
    })
    .from(adSlots)
    .where(and(inArray(adSlots.key, req.slots), eq(adSlots.active, true)));
  const used = new Set<string>();
  const usedBooks = new Set(req.exclude ?? []);
  const out: Placement[] = [];
  const href = async (campaignKey: string, slot: string) =>
    `/go/${await signLink(keys, "go", [campaignKey, slot])}`;

  for (const key of req.slots) {
    const slot = slotRows.find((s) => s.key === key);
    if (!slot) continue;
    const period = periodFor(slot.period, req.date);
    const seed = `${key}|${period.start}|${target}`;
    const live = and(
      inArray(campaigns.status, ["scheduled", "live"]),
      lte(campaigns.startAt, nowS),
      or(isNull(campaigns.endAt), gt(campaigns.endAt, nowS)),
    );
    const booked = await db
      .select({ campaign: campaigns, isHouse: advertisers.isHouse })
      .from(bookings)
      .innerJoin(inventoryUnits, eq(inventoryUnits.id, bookings.inventoryUnitId))
      .innerJoin(campaigns, eq(campaigns.id, bookings.campaignId))
      .innerJoin(advertisers, eq(advertisers.id, campaigns.advertiserId))
      .where(
        and(
          eq(inventoryUnits.slotId, slot.id),
          lte(inventoryUnits.periodStart, req.date),
          gte(inventoryUnits.periodEnd, req.date),
          eq(inventoryUnits.target, target),
          eq(bookings.status, "confirmed"),
          live,
        ),
      );
    const backfill = (
      await db
        .select({ campaign: campaigns, isHouse: advertisers.isHouse })
        .from(campaigns)
        .innerJoin(advertisers, eq(advertisers.id, campaigns.advertiserId))
        .where(and(eq(campaigns.productId, slot.productId), eq(campaigns.mode, "backfill"), live))
        .limit(50)
    ).filter(({ campaign: c }) => {
      const t = c.targeting ?? {};
      if (t.slots?.length && !t.slots.includes(key)) return false;
      const def = SLOT_PRODUCT.get(key);
      const want = def?.targeting === "tag" ? t.tag : def?.targeting === "book" ? t.book : undefined;
      return !want || want === target;
    });
    const candidates = [
      ...booked,
      ...weightedOrder(
        backfill.map((b) => ({ ...b, id: b.campaign.id, weight: b.campaign.weight })),
        seed,
      ),
    ];
    let placed = false;
    for (const { campaign: c, isHouse } of candidates) {
      if (used.has(c.id)) continue;
      const [creative] = await db
        .select()
        .from(creatives)
        .where(and(eq(creatives.campaignId, c.id), eq(creatives.reviewStatus, "approved")))
        .limit(1);
      if (!creative) continue;
      let book: BookListItem | null = null;
      if (c.bookId) {
        if (usedBooks.has(c.bookId) || (req.guard && !req.guard(c.bookId))) continue;
        [book = null] = await bookItems(db, [c.bookId], { now: nowS });
        if (!book) continue;
        usedBooks.add(c.bookId);
      }
      used.add(c.id);
      const sponsored = !isHouse || c.ownBook;
      out.push({
        slot: key,
        campaignKey: c.id,
        label: sponsored ? "Sponsored" : "From ReadLitRPG",
        headline: creative.headline,
        body: creative.body,
        cta: creative.ctaLabel,
        href: await href(c.id, key),
        sponsored,
        book,
      });
      placed = true;
      break;
    }
    if (placed || req.builtins === false) continue;
    const builtins = BUILTIN_HOUSE_ADS.filter(
      (b) => b.surfaces.includes(slot.surface) && !used.has(`house:${b.key}`),
    );
    if (!builtins.length) continue;
    const pick = builtins[stableHash(seed) % builtins.length] as BuiltinAd;
    used.add(`house:${pick.key}`);
    out.push({
      slot: key,
      campaignKey: `house:${pick.key}`,
      label: "From ReadLitRPG",
      headline: pick.headline,
      body: pick.body,
      cta: pick.cta,
      href: await href(`house:${pick.key}`, key),
      sponsored: false,
      book: null,
    });
  }
  return out;
}
