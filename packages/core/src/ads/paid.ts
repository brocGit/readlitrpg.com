// Paid promotions (DESIGN §11.4, §12): an author picks a product, a book and dates; we hold the
// inventory, take payment (credits and promotion codes first, the rest through Stripe Checkout),
// then confirm the booking and review the creative. Rejections refund automatically; cancellations
// follow the §11.10 windows. Prices always come from our inventory snapshots, never the client.

import { and, count, eq, gte, inArray, isNull, lt, sql, sum } from "drizzle-orm";
import { notifyAuthor } from "../authors/notices";
import { addCredit, creditBalance, spendCredits } from "../billing/credits";
import { createOrder, getOrder, itemsOf, type Order, settle, transitionOrder } from "../billing/orders";
import { discountFor, findPromo, redeemPromo, releasePromo } from "../billing/promo";
import { refundOrder } from "../billing/refunds";
import type { StripeApi } from "../billing/stripe";
import type { Db } from "../db";
import {
  adProducts,
  advertisers,
  authors,
  bookings,
  bookLinks,
  books,
  campaigns,
  creatives,
  inboxItems,
  inventoryUnits,
  orderItems,
  orders,
} from "../db/schema";
import { enqueue } from "../editorial/queue";
import { ulid } from "../ids";
import { openInboxItem } from "../inbox";
import type { TrustLevel } from "../policy";
import { hitWindow } from "../ratelimit";
import type { Settings } from "../settings";
import { nowIso } from "../time";
import { CampaignError, checkBook } from "./campaigns";
import { AD_PRODUCTS, type ProductDef } from "./catalog";
import { ensureUnit, giveBack, holdUnit, periodFor } from "./inventory";

/** Products an author can buy in Phase 1.5 (§11.2). Sponsored Match is budget-paced (./sponsored). */
export const PAID_PRODUCTS = [
  "home_spotlight",
  "tag_sponsor",
  "books_like_sponsor",
  "newsletter_top",
  "newsletter_standard",
] as const;

/** Paid creatives point at the book, so only book-shaped calls to action (§11.7). */
export const PAID_CTAS = [
  "Read now",
  "Preorder",
  "Listen now",
  "Start the series",
  "Read free on Royal Road",
] as const;

export class PromotionError extends Error {}

const DAY_MS = 86_400_000;
const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) => day(new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS));

/** The billing identity for an author profile, created on first purchase (§5.5). */
export async function advertiserForAuthor(
  db: Db,
  authorId: string,
): Promise<typeof advertisers.$inferSelect> {
  const find = () =>
    db
      .select()
      .from(advertisers)
      .where(and(eq(advertisers.ownerType, "author"), eq(advertisers.ownerId, authorId)));
  const [found] = await find();
  if (found) return found;
  const [a] = await db.select({ name: authors.name }).from(authors).where(eq(authors.id, authorId));
  if (!a) throw new PromotionError("no such author");
  await db
    .insert(advertisers)
    .values({ id: ulid(), ownerType: "author", ownerId: authorId, name: a.name })
    .onConflictDoNothing();
  const [made] = await find();
  if (!made) throw new PromotionError("couldn't create the advertiser");
  return made;
}

/** The advertiser's Stripe customer, created once (idempotent per advertiser) and stored (§12.2). */
export async function ensureStripeCustomer(
  db: Db,
  stripe: StripeApi,
  advertiser: typeof advertisers.$inferSelect,
  email: string,
): Promise<string> {
  if (advertiser.stripeCustomerId) return advertiser.stripeCustomerId;
  const { id } = await stripe.createCustomer(
    { email, name: advertiser.name, metadata: { advertiser_id: advertiser.id } },
    `customer:${advertiser.id}`,
  );
  await db.update(advertisers).set({ stripeCustomerId: id }).where(eq(advertisers.id, advertiser.id));
  return id;
}

async function trustOf(db: Db, authorId: string): Promise<TrustLevel> {
  const [a] = await db.select({ trust: authors.trustLevel }).from(authors).where(eq(authors.id, authorId));
  return (a?.trust ?? "T0") as TrustLevel;
}

/** Keep the products' prices in step with `ads.prices` (new inventory takes the new price, §11.8). */
export async function syncPrices(db: Db, settings: Settings): Promise<void> {
  for (const [key, cents] of Object.entries(settings["ads.prices"]))
    await db.update(adProducts).set({ basePriceCents: cents }).where(eq(adProducts.key, key));
}

export interface PromotionInput {
  productKey: string;
  bookId: string;
  /** The first period's date (YYYY-MM-DD); weekly products start on that week's Monday. */
  startDate: string;
  /** Consecutive periods (days or weeks). */
  periods: number;
  /** The tag (Tag Page Sponsor) or book slug (Books-Like Sponsor) it runs on. */
  target?: string | null;
  headline: string;
  body?: string | null;
  cta: string;
  /** One of the book's own links (§11.7). */
  destinationLinkId: string;
  promoCode?: string | null;
}

export interface QuoteUnit {
  unitId: string;
  slot: string;
  periodStart: string;
  periodEnd: string;
  priceCents: number;
}

export interface Quote {
  product: ProductDef;
  units: QuoteUnit[];
  amountCents: number;
  startAt: string;
  endAt: string;
  /** Periods with no free place. */
  unavailable: string[];
}

/**
 * What a promotion would cost and whether every period has a free place. Doesn't hold anything.
 * `guard` is the page context check the caller can make (a Books-Like Sponsor's book must be among
 * the target book's matches, which needs the match model).
 */
export async function quotePromotion(
  db: Db,
  input: PromotionInput,
  settings: Settings,
  opts: { now?: Date; guard?: (bookId: string) => boolean } = {},
): Promise<Quote> {
  const now = opts.now ?? new Date();
  if (!(PAID_PRODUCTS as readonly string[]).includes(input.productKey))
    throw new PromotionError("that product isn't for sale");
  const product = AD_PRODUCTS.find((p) => p.key === input.productKey) as ProductDef;
  const periods = Math.round(input.periods);
  if (!(periods >= 1 && periods <= settings["ads.max_periods"]))
    throw new PromotionError(`book 1–${settings["ads.max_periods"]} periods at a time`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) throw new PromotionError("pick a start date");
  const first = periodFor(product.period, input.startDate);
  // Enough lead time for the creative review (§11.4: decided by T-48h).
  if (first.start < addDays(day(now), settings["ads.min_lead_days"]))
    throw new PromotionError(`start at least ${settings["ads.min_lead_days"]} days from today`);
  const target = product.targeting === "none" ? "" : (input.target ?? "").trim();
  if (product.targeting !== "none" && !target)
    throw new PromotionError(product.targeting === "tag" ? "pick the tag" : "pick the book page");
  try {
    await checkBook(db, input.bookId, product.key, target || null);
  } catch (error) {
    if (error instanceof CampaignError) throw new PromotionError(error.message);
    throw error;
  }
  if (product.targeting === "book" && opts.guard && !opts.guard(input.bookId))
    throw new PromotionError("the book isn't among that page's top matches, so it can't sponsor it");

  const step = product.period === "day" ? 1 : 7;
  const units: QuoteUnit[] = [];
  const unavailable: string[] = [];
  for (let i = 0; i < periods; i++) {
    const date = addDays(first.start, i * step);
    let picked: QuoteUnit | null = null;
    for (const slot of product.slots) {
      const unit = await ensureUnit(db, slot, date, target);
      if (unit && !unit.blackout && unit.sold + unit.held < unit.capacity) {
        picked = {
          unitId: unit.id,
          slot,
          periodStart: unit.periodStart,
          periodEnd: unit.periodEnd,
          priceCents: unit.priceCents,
        };
        break;
      }
    }
    if (picked) units.push(picked);
    else unavailable.push(periodFor(product.period, date).start);
  }
  const last = units.at(-1)?.periodEnd ?? first.end;
  return {
    product,
    units,
    amountCents: units.reduce((n, u) => n + u.priceCents, 0),
    startAt: `${first.start}T00:00:00.000Z`,
    endAt: `${last}T23:59:59.999Z`,
    unavailable,
  };
}

/** Soft flags that send a creative to the owner rather than refusing it (§11.7). */
export function creativeRisk(text: string, trust: TrustLevel): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = trust === "T0" ? 15 : 0;
  if (trust === "T0") reasons.push("new advertiser");
  if (/#\s?1\b|number one|best[\s-]?sell/i.test(text)) {
    score += 25;
    reasons.push("a ranking claim");
  }
  if (/award[\s-]?winning|critically acclaimed/i.test(text)) {
    score += 20;
    reasons.push("an award claim");
  }
  if ((text.match(/\b[A-Z]{4,}\b/g) ?? []).length >= 2) {
    score += 15;
    reasons.push("shouting");
  }
  if (/!{2,}|\?{2,}/.test(text)) {
    score += 10;
    reasons.push("repeated punctuation");
  }
  return { score: Math.min(100, score), reasons };
}

/** The creative fields a paid ad carries (§11.7). */
export interface CreativeInput {
  bookId: string;
  headline: string;
  body?: string | null;
  cta: string;
  /** One of the book's own links. */
  destinationLinkId: string;
}

/** Hard checks: refused at once, with the reason (§11.7). */
export async function checkCreativeForSale(db: Db, input: CreativeInput): Promise<void> {
  const headline = input.headline.trim();
  if (!headline || headline.length > 60) throw new PromotionError("the headline is 1–60 characters");
  if ((input.body ?? "").length > 200) throw new PromotionError("the body is at most 200 characters");
  const text = `${headline} ${input.body ?? ""}`;
  if (/[<>{}]/.test(text) || [...text].some((ch) => ch.charCodeAt(0) < 32 && ch !== "\n"))
    throw new PromotionError("no markup in the text");
  if (/https?:\/\/|www\.|\.(com|net|org|io)\b/i.test(text))
    throw new PromotionError("no links in the text: the button goes to the book's link");
  if (!(PAID_CTAS as readonly string[]).includes(input.cta))
    throw new PromotionError("pick a call to action");
  const [link] = await db
    .select({ id: bookLinks.id, url: bookLinks.url })
    .from(bookLinks)
    .where(and(eq(bookLinks.id, input.destinationLinkId), eq(bookLinks.bookId, input.bookId)));
  if (!link?.url.startsWith("https://"))
    throw new PromotionError("the destination must be one of the book's links");
}

/** Who may buy, and the first limits (§12.6): on sale, not restricted, not hammering checkout. */
export async function prepareBuyer(
  db: Db,
  authorId: string,
  settings: Settings,
  now: Date,
): Promise<{ trust: TrustLevel; advertiser: typeof advertisers.$inferSelect }> {
  if (!settings["flags.ads_paid"]) throw new PromotionError("promotions aren't on sale yet");
  const trust = await trustOf(db, authorId);
  if (trust === "T-1") throw new PromotionError("this profile can't buy promotions");
  const advertiser = await advertiserForAuthor(db, authorId);
  const attempts = await hitWindow(
    db,
    { rule: "checkout", limit: settings["ads.checkout_attempts_per_hour"], windowSeconds: 3600 },
    advertiser.id,
    now,
  );
  if (!attempts.ok) throw new PromotionError("too many checkouts in the last hour: try again later");
  return { trust, advertiser };
}

/** New (T0) advertisers can book a limited amount a day (§12.6). */
export async function checkDailyCap(
  db: Db,
  advertiserId: string,
  trust: TrustLevel,
  amountCents: number,
  settings: Settings,
  now: Date,
): Promise<void> {
  if (trust !== "T0") return;
  const [today] = await db
    .select({ n: sum(orders.amountCents) })
    .from(orders)
    .where(
      and(
        eq(orders.advertiserId, advertiserId),
        inArray(orders.status, ["open", "paid"]),
        gte(orders.createdAt, `${day(now)}T00:00:00.000Z`),
      ),
    );
  if (Number(today?.n ?? 0) + amountCents > settings["ads.t0_daily_spend_cap_cents"])
    throw new PromotionError(
      "new advertisers can book a limited amount a day: verify your profile to lift it",
    );
}

export interface StartResult {
  campaignId: string;
  orderId: string;
  /** Stripe Checkout, or our own page when credits or a code covered it all. */
  redirect: string;
}

/**
 * Hold the places, take credits and a code, and send the author to pay (§11.4). Anything that fails
 * after the holds gives everything back.
 */
export async function startPromotion(
  db: Db,
  stripe: StripeApi | null,
  req: {
    authorId: string;
    userId: string;
    email: string;
    input: PromotionInput;
    settings: Settings;
    siteOrigin: string;
    guard?: (bookId: string) => boolean;
    now?: Date;
  },
): Promise<StartResult> {
  const now = req.now ?? new Date();
  const { settings, input } = req;
  const { trust, advertiser } = await prepareBuyer(db, req.authorId, settings, now);
  const quote = await quotePromotion(db, input, settings, { now, guard: req.guard });
  if (quote.unavailable.length) throw new PromotionError(`already booked: ${quote.unavailable.join(", ")}`);
  const [holds] = await db
    .select({ n: count() })
    .from(bookings)
    .innerJoin(campaigns, eq(campaigns.id, bookings.campaignId))
    .where(and(eq(campaigns.advertiserId, advertiser.id), eq(bookings.status, "held")));
  if ((holds?.n ?? 0) + quote.units.length > settings["ads.max_open_holds"])
    throw new PromotionError("finish or cancel your open checkouts first");
  await checkDailyCap(db, advertiser.id, trust, quote.amountCents, settings, now);
  await checkCreativeForSale(db, input);
  const risk = creativeRisk(`${input.headline} ${input.body ?? ""}`, trust);

  const campaignId = ulid();
  const [product] = await db
    .select({ id: adProducts.id })
    .from(adProducts)
    .where(eq(adProducts.key, quote.product.key));
  if (!product) throw new PromotionError("the ad catalog isn't set up yet");
  const target = (input.target ?? "").trim();
  await db.insert(campaigns).values({
    id: campaignId,
    advertiserId: advertiser.id,
    productId: product.id,
    name: `${quote.product.name}: ${input.headline.trim()}`.slice(0, 120),
    bookId: input.bookId,
    status: "held",
    mode: "reserved",
    targeting: {
      slots: [...new Set(quote.units.map((u) => u.slot))],
      ...(target ? { [quote.product.targeting]: target } : {}),
    },
    startAt: quote.startAt,
    endAt: quote.endAt,
    createdBy: req.userId,
  });
  await db.insert(creatives).values({
    id: ulid(),
    campaignId,
    headline: input.headline.trim(),
    body: input.body?.trim() || null,
    ctaLabel: input.cta,
    destinationLinkId: input.destinationLinkId,
    reviewStatus: "pending",
    riskScore: risk.score,
    reviewNotes: risk.reasons.join(", ") || null,
  });

  const holdUntil = new Date(now.getTime() + (settings["ads.hold_minutes"] + 5) * 60_000).toISOString();
  const state: PayState = { bookingIds: [], promoId: null, creditsUsed: 0, order: null };
  try {
    for (const u of quote.units) {
      if (!(await holdUnit(db, u.unitId)))
        throw new PromotionError(`${u.periodStart} was just booked by someone else`);
      const id = ulid();
      await db.insert(bookings).values({
        id,
        campaignId,
        inventoryUnitId: u.unitId,
        status: "held",
        holdExpiresAt: holdUntil,
      });
      state.bookingIds.push(id);
    }
    return await payForCampaign(
      db,
      stripe,
      {
        advertiser,
        campaignId,
        productKey: quote.product.key,
        amountCents: quote.amountCents,
        lines: quote.units.map((u, i) => ({
          name: `${quote.product.name}, ${u.periodStart === u.periodEnd ? u.periodStart : `week of ${u.periodStart}`}`,
          description: `${quote.product.name} · ${u.periodStart}${target ? ` · ${target}` : ""}`,
          amountCents: u.priceCents,
          bookingId: state.bookingIds[i] ?? null,
        })),
        promoCode: input.promoCode ?? null,
        userId: req.userId,
        email: req.email,
        settings,
        siteOrigin: req.siteOrigin,
        now,
      },
      state,
    );
  } catch (error) {
    await rollbackCampaign(db, advertiser.id, campaignId, state, now);
    throw error;
  }
}

/** What a checkout has taken so far, so a failure can give it all back. */
export interface PayState {
  bookingIds: string[];
  promoId: string | null;
  creditsUsed: number;
  order: Order | null;
}

/**
 * Take payment for a campaign that exists (status held): a promotion code, then credits, then the
 * card through Stripe Checkout, or nothing more when those cover it (§12.5). Records what it takes
 * in `state` for `rollbackCampaign`.
 */
export async function payForCampaign(
  db: Db,
  stripe: StripeApi | null,
  p: {
    advertiser: typeof advertisers.$inferSelect;
    campaignId: string;
    productKey: string;
    amountCents: number;
    lines: { name: string; description: string; amountCents: number; bookingId: string | null }[];
    promoCode: string | null;
    userId: string;
    email: string;
    settings: Settings;
    siteOrigin: string;
    now: Date;
  },
  state: PayState,
): Promise<StartResult> {
  const { advertiser, campaignId, settings, now } = p;
  let discount = 0;
  if (p.promoCode?.trim()) {
    const found = await findPromo(db, p.promoCode, p.productKey, now);
    if (!found.ok) throw new PromotionError(found.reason);
    if (!(await redeemPromo(db, found.promo.id))) throw new PromotionError("That code has been used up.");
    state.promoId = found.promo.id;
    discount = discountFor(found.promo, p.amountCents);
  }
  let split = settle(p.amountCents, discount, await creditBalance(db, advertiser.id));
  if (split.creditsCents > 0) {
    const ok = await spendCredits(
      db,
      {
        advertiserId: advertiser.id,
        amountCents: split.creditsCents,
        reason: "checkout",
        ref: campaignId,
        createdBy: p.userId,
      },
      now,
    );
    if (!ok) split = settle(p.amountCents, discount, 0);
    else state.creditsUsed = split.creditsCents;
  }
  const order = await createOrder(
    db,
    {
      advertiserId: advertiser.id,
      userId: p.userId,
      kind: split.chargeCents === 0 && split.creditsCents === 0 ? "comp" : "promo",
      amountCents: p.amountCents,
      discountCents: split.discountCents,
      creditsCents: split.creditsCents,
      chargedCents: split.chargeCents,
      promoCodeId: state.promoId,
      createdBy: p.userId,
      items: p.lines.map((l) => ({
        campaignId,
        bookingId: l.bookingId,
        description: l.description,
        amountCents: l.amountCents,
      })),
    },
    now,
  );
  state.order = order;
  const done = `${p.siteOrigin}/dashboard/promote/${campaignId}`;
  if (split.chargeCents === 0) {
    await confirmPaidOrder(db, order.id, { paymentIntent: null, settings, now });
    return { campaignId, orderId: order.id, redirect: `${done}?paid=1` };
  }
  if (!stripe) throw new PromotionError("card payments aren't set up yet");
  const customer = await ensureStripeCustomer(db, stripe, advertiser, p.email);
  const off = split.discountCents + split.creditsCents;
  const coupon = off
    ? await stripe.createCoupon(
        { amountOffCents: off, name: split.creditsCents ? "Credits and discount" : "Discount" },
        `coupon:${order.id}`,
      )
    : null;
  // Stripe needs at least 30 minutes; the holds last a little longer than the session.
  const expiresAt = Math.floor(now.getTime() / 1000) + settings["ads.hold_minutes"] * 60 + 60;
  const session = await stripe.createCheckoutSession(
    {
      mode: "payment",
      customer,
      lineItems: p.lines.map((l) => ({ name: l.name, amountCents: l.amountCents })),
      couponId: coupon?.id,
      successUrl: `${done}?paid=1`,
      cancelUrl: `${done}?cancelled=1`,
      expiresAt,
      clientReferenceId: order.id,
      metadata: { order_id: order.id, campaign_id: campaignId, kind: "promo" },
      automaticTax: settings["billing.automatic_tax"],
    },
    `checkout:${order.id}`,
  );
  await db
    .update(orders)
    .set({ stripeCheckoutSessionId: session.id, expiresAt: new Date(expiresAt * 1000).toISOString() })
    .where(eq(orders.id, order.id));
  if (!session.url) throw new PromotionError("Stripe didn't return a checkout page");
  return { campaignId, orderId: order.id, redirect: session.url };
}

/** Give back everything a failed checkout took: held places, the code's use, credits, the order. */
export async function rollbackCampaign(
  db: Db,
  advertiserId: string,
  campaignId: string,
  state: PayState,
  now: Date,
): Promise<void> {
  for (const id of state.bookingIds) {
    const [b] = await db
      .update(bookings)
      .set({ status: "released", updatedAt: nowIso(now) })
      .where(and(eq(bookings.id, id), eq(bookings.status, "held")))
      .returning({ unit: bookings.inventoryUnitId });
    if (b) await giveBack(db, b.unit, "held");
  }
  if (state.promoId) await releasePromo(db, state.promoId);
  if (state.creditsUsed)
    await addCredit(
      db,
      {
        advertiserId,
        amountCents: state.creditsUsed,
        reason: "checkout_expired",
        ref: campaignId,
        createdBy: "system",
      },
      now,
    );
  if (state.order) await transitionOrder(db, state.order.id, "cancelled", {}, now);
  await db
    .update(campaigns)
    .set({ status: "cancelled", updatedAt: nowIso(now) })
    .where(eq(campaigns.id, campaignId));
}

/**
 * Payment arrived (a webhook, or credits covered it): the order is paid, the held places become
 * sold, and the creative goes to review. Idempotent: a second call finds the order already paid.
 */
export async function confirmPaidOrder(
  db: Db,
  orderId: string,
  opts: { paymentIntent: string | null; settings: Settings; now?: Date; stripe?: StripeApi | null },
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const moved = await transitionOrder(
    db,
    orderId,
    "paid",
    { paidAt: nowIso(now), ...(opts.paymentIntent ? { stripePaymentIntentId: opts.paymentIntent } : {}) },
    now,
  );
  if (!moved) return false;
  const items = await itemsOf(db, orderId);
  const campaignIds = [...new Set(items.map((i) => i.campaignId).filter((c): c is string => Boolean(c)))];
  let lost = false;
  for (const it of items) {
    if (!it.bookingId) continue;
    const [held] = await db
      .update(bookings)
      .set({ status: "confirmed", holdExpiresAt: null, updatedAt: nowIso(now) })
      .where(and(eq(bookings.id, it.bookingId), eq(bookings.status, "held")))
      .returning({ unit: bookings.inventoryUnitId });
    if (held) {
      await db
        .update(inventoryUnits)
        .set({ held: sql`max(${inventoryUnits.held} - 1, 0)`, sold: sql`${inventoryUnits.sold} + 1` })
        .where(eq(inventoryUnits.id, held.unit));
      continue;
    }
    // The hold lapsed before the payment landed: take the place again if it's still free.
    const [b] = await db.select().from(bookings).where(eq(bookings.id, it.bookingId));
    const again = b
      ? await db
          .update(inventoryUnits)
          .set({ sold: sql`${inventoryUnits.sold} + 1` })
          .where(
            and(
              eq(inventoryUnits.id, b.inventoryUnitId),
              sql`${inventoryUnits.sold} + ${inventoryUnits.held} < ${inventoryUnits.capacity}`,
            ),
          )
          .returning({ id: inventoryUnits.id })
      : [];
    if (again.length && b) {
      await db
        .update(bookings)
        .set({ status: "confirmed", updatedAt: nowIso(now) })
        .where(eq(bookings.id, b.id));
    } else lost = true;
  }
  for (const id of campaignIds) {
    if (lost) {
      await rejectCampaign(db, opts.stripe ?? null, id, {
        reason: "Someone else booked that place while your payment went through. We've refunded you in full.",
        reasonCode: "unavailable",
        initiatedBy: "system",
        now,
      });
      continue;
    }
    await db
      .update(campaigns)
      .set({ status: "in_review", updatedAt: nowIso(now) })
      .where(and(eq(campaigns.id, id), eq(campaigns.status, "held")));
    await reviewPaidCampaign(db, id, opts.settings, now);
  }
  return true;
}

/**
 * The creative review (§11.7): T2 advertisers and low-risk creatives approve at once; the rest go
 * to the owner, approving themselves 48 hours before the start. The editorial run screens the
 * text either way, and can still send an approved one to the owner.
 */
export async function reviewPaidCampaign(db: Db, campaignId: string, settings: Settings, now = new Date()) {
  const [c] = await db
    .select({ campaign: campaigns, creative: creatives, authorId: advertisers.ownerId })
    .from(campaigns)
    .innerJoin(creatives, eq(creatives.campaignId, campaigns.id))
    .innerJoin(advertisers, eq(advertisers.id, campaigns.advertiserId))
    .where(eq(campaigns.id, campaignId));
  if (c?.campaign.status !== "in_review") return;
  const trust = c.authorId ? await trustOf(db, c.authorId) : "T0";
  const [book] = c.campaign.bookId
    ? await db.select({ title: books.title }).from(books).where(eq(books.id, c.campaign.bookId))
    : [];
  await enqueue(db, [
    {
      kind: "moderate",
      subjectType: "creative",
      subjectId: c.creative.id,
      priority: settings["editorial.priorities"].moderate,
      payload: {
        text: [c.creative.headline, c.creative.body].filter(Boolean).join("\n"),
        context: `A paid ad for the book "${book?.title ?? ""}" on a LitRPG site. Flag misleading claims.`,
      },
    },
  ]);
  if (trust === "T2" || (c.creative.riskScore ?? 0) < settings["ads.auto_approve_risk_max"]) {
    await approveCampaign(db, campaignId, now);
    return;
  }
  const start = Date.parse(c.campaign.startAt);
  await openInboxItem(db, {
    type: "ad_review",
    title: `Ad to review: ${c.creative.headline}`,
    subjectType: "campaign",
    subjectId: campaignId,
    priority: 70,
    riskScore: c.creative.riskScore ?? undefined,
    aiSummary: `Flagged: ${c.creative.reviewNotes ?? "risk score"}. It passed the automatic checks.`,
    aiRecommendation: "approve",
    payload: { campaignId, headline: c.creative.headline, body: c.creative.body, bookId: c.campaign.bookId },
    defaultAction: "approve",
    defaultActionAt: new Date(Math.max(now.getTime() + 3_600_000, start - 48 * 3_600_000)).toISOString(),
    dedupeKey: `ad_review:${campaignId}`,
  });
}

async function authorOf(db: Db, campaignId: string) {
  const [row] = await db
    .select({
      authorId: advertisers.ownerId,
      ownerType: advertisers.ownerType,
      name: campaigns.name,
      startAt: campaigns.startAt,
    })
    .from(campaigns)
    .innerJoin(advertisers, eq(advertisers.id, campaigns.advertiserId))
    .where(eq(campaigns.id, campaignId));
  return row ?? null;
}

export async function approveCampaign(db: Db, campaignId: string, now = new Date()): Promise<boolean> {
  const moved = await db
    .update(campaigns)
    .set({ status: "scheduled", updatedAt: nowIso(now) })
    .where(and(eq(campaigns.id, campaignId), inArray(campaigns.status, ["in_review", "approved"])))
    .returning({ id: campaigns.id });
  await db
    .update(creatives)
    .set({ reviewStatus: "approved" })
    .where(and(eq(creatives.campaignId, campaignId), eq(creatives.reviewStatus, "pending")));
  if (!moved.length) return false;
  const who = await authorOf(db, campaignId);
  if (who?.ownerType === "author" && who.authorId)
    await notifyAuthor(db, {
      authorId: who.authorId,
      kind: "ad_scheduled",
      payload: { campaignId, title: who.name, startAt: who.startAt },
    });
  return true;
}

/** Rejected in review, or the place was lost: release it and refund in full (§11.10). */
export async function rejectCampaign(
  db: Db,
  stripe: StripeApi | null,
  campaignId: string,
  opts: { reason: string; reasonCode?: string; initiatedBy: string; now?: Date },
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const moved = await db
    .update(campaigns)
    .set({ status: "rejected", updatedAt: nowIso(now) })
    .where(
      and(
        eq(campaigns.id, campaignId),
        inArray(campaigns.status, ["held", "in_review", "approved", "scheduled", "paused"]),
      ),
    )
    .returning({ id: campaigns.id });
  if (!moved.length) return false;
  await db
    .update(creatives)
    .set({ reviewStatus: "rejected", reviewNotes: opts.reason.slice(0, 500) })
    .where(eq(creatives.campaignId, campaignId));
  await releaseBookings(db, campaignId, now);
  for (const order of await ordersOfCampaign(db, campaignId)) {
    if (!["paid", "partially_refunded"].includes(order.status)) continue;
    await refundOrder(
      db,
      stripe,
      {
        orderId: order.id,
        cardCents: order.chargedCents,
        creditCents: order.creditsCents,
        reasonCode: opts.reasonCode ?? "rejected",
        note: opts.reason,
        initiatedBy: opts.initiatedBy,
      },
      now,
    );
  }
  const who = await authorOf(db, campaignId);
  if (who?.ownerType === "author" && who.authorId)
    await notifyAuthor(db, {
      authorId: who.authorId,
      kind: "ad_rejected",
      payload: { campaignId, title: who.name, note: opts.reason },
    });
  return true;
}

/** Give every place a campaign holds or bought back to the inventory. */
async function releaseBookings(db: Db, campaignId: string, now: Date, onlyFrom?: string): Promise<void> {
  const rows = await db
    .select({
      id: bookings.id,
      unit: bookings.inventoryUnitId,
      status: bookings.status,
      start: inventoryUnits.periodStart,
    })
    .from(bookings)
    .innerJoin(inventoryUnits, eq(inventoryUnits.id, bookings.inventoryUnitId))
    .where(and(eq(bookings.campaignId, campaignId), inArray(bookings.status, ["held", "confirmed"])));
  for (const b of rows) {
    if (onlyFrom && b.start < onlyFrom) continue;
    const [done] = await db
      .update(bookings)
      .set({ status: "released", updatedAt: nowIso(now) })
      .where(and(eq(bookings.id, b.id), eq(bookings.status, b.status)))
      .returning({ id: bookings.id });
    if (done) await giveBack(db, b.unit, b.status === "held" ? "held" : "sold");
  }
}

async function ordersOfCampaign(db: Db, campaignId: string): Promise<Order[]> {
  const ids = await db
    .selectDistinct({ id: orderItems.orderId })
    .from(orderItems)
    .where(eq(orderItems.campaignId, campaignId));
  const out: Order[] = [];
  for (const { id } of ids) {
    const o = await getOrder(db, id);
    if (o) out.push(o);
  }
  return out;
}

/** The §11.10 windows for an advertiser's own cancellation. */
export function cancellationTerms(
  startAt: string,
  now = new Date(),
): { allowed: boolean; share: number; creditOnly: boolean; label: string } {
  const hours = (Date.parse(startAt) - now.getTime()) / 3_600_000;
  if (hours >= 7 * 24)
    return { allowed: true, share: 1, creditOnly: false, label: "a full refund or credit" };
  if (hours >= 48) return { allowed: true, share: 0.5, creditOnly: true, label: "half the price as credit" };
  return { allowed: false, share: 0, creditOnly: true, label: "no refund: it runs as booked" };
}

/** The advertiser cancels before the start (§11.10). */
export async function cancelPromotion(
  db: Db,
  stripe: StripeApi | null,
  campaignId: string,
  opts: { choice: "refund" | "credit"; byUserId: string; now?: Date },
): Promise<{ cardCents: number; creditCents: number }> {
  const now = opts.now ?? new Date();
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!c || !["in_review", "approved", "scheduled", "paused"].includes(c.status))
    throw new PromotionError("that promotion can't be cancelled now");
  const terms = cancellationTerms(c.startAt, now);
  if (!terms.allowed) throw new PromotionError("within 48 hours of the start a promotion runs as booked");
  const moved = await db
    .update(campaigns)
    .set({ status: "cancelled", updatedAt: nowIso(now) })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, c.status)))
    .returning({ id: campaigns.id });
  if (!moved.length) throw new PromotionError("that promotion changed meanwhile: reload and try again");
  await releaseBookings(db, campaignId, now);
  let result = { cardCents: 0, creditCents: 0 };
  for (const order of await ordersOfCampaign(db, campaignId)) {
    if (!["paid", "partially_refunded"].includes(order.status)) continue;
    const paid = order.chargedCents + order.creditsCents;
    const back = Math.floor(paid * terms.share);
    const toCard = terms.creditOnly || opts.choice === "credit" ? 0 : Math.min(order.chargedCents, back);
    const r = await refundOrder(
      db,
      stripe,
      {
        orderId: order.id,
        cardCents: toCard,
        creditCents: back - toCard,
        reasonCode: "cancelled",
        initiatedBy: opts.byUserId,
      },
      now,
    );
    result = { cardCents: result.cardCents + r.cardCents, creditCents: result.creditCents + r.creditCents };
  }
  const who = await authorOf(db, campaignId);
  if (who?.ownerType === "author" && who.authorId)
    await notifyAuthor(db, {
      authorId: who.authorId,
      kind: "ad_cancelled",
      payload: { campaignId, title: who.name, ...result },
    });
  return result;
}

/** Checkout expired or abandoned: release the places, return credits and the code's use. */
export async function expireOrder(db: Db, orderId: string, now = new Date()): Promise<boolean> {
  const order = await getOrder(db, orderId);
  if (!order || !(await transitionOrder(db, orderId, "expired", {}, now))) return false;
  const items = await itemsOf(db, orderId);
  for (const campaignId of new Set(items.map((i) => i.campaignId).filter((c): c is string => Boolean(c)))) {
    await releaseBookings(db, campaignId, now);
    await db
      .update(campaigns)
      .set({ status: "cancelled", updatedAt: nowIso(now) })
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, "held")));
  }
  if (order.creditsCents > 0 && order.advertiserId)
    await addCredit(
      db,
      {
        advertiserId: order.advertiserId,
        amountCents: order.creditsCents,
        reason: "checkout_expired",
        ref: orderId,
        createdBy: "system",
      },
      now,
    );
  if (order.promoCodeId) await releasePromo(db, order.promoCodeId);
  return true;
}

/** Open checkouts past their expiry that Stripe never told us about (heartbeat backstop). */
export async function expireStaleOrders(db: Db, now = new Date()): Promise<number> {
  // Stripe sends checkout.session.expired; this catches a lost webhook an hour later.
  const stale = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, "open"),
        eq(orders.kind, "promo"),
        lt(orders.expiresAt, new Date(now.getTime() - 3_600_000).toISOString()),
      ),
    )
    .limit(50);
  let n = 0;
  for (const o of stale) if (await expireOrder(db, o.id, now)) n++;
  return n;
}

/** The creative screen found something (§11.7): the owner decides; blocked ones reject by default. */
export async function flagCreative(
  db: Db,
  creativeId: string,
  verdict: "review" | "block",
  summary: string,
  now = new Date(),
): Promise<string | null> {
  const [c] = await db
    .select({ campaign: campaigns, creative: creatives })
    .from(creatives)
    .innerJoin(campaigns, eq(campaigns.id, creatives.campaignId))
    .where(eq(creatives.id, creativeId));
  if (!c || !["in_review", "approved", "scheduled", "live"].includes(c.campaign.status)) return null;
  if (verdict === "block" && c.campaign.status === "live")
    await db
      .update(campaigns)
      .set({ status: "paused", updatedAt: nowIso(now) })
      .where(eq(campaigns.id, c.campaign.id));
  const start = Date.parse(c.campaign.startAt);
  const item = await openInboxItem(db, {
    type: "ad_review",
    title: `Ad flagged (${verdict}): ${c.creative.headline}`,
    subjectType: "campaign",
    subjectId: c.campaign.id,
    priority: verdict === "block" ? 85 : 70,
    aiSummary: summary,
    aiRecommendation: verdict === "block" ? "reject" : "escalate",
    payload: {
      campaignId: c.campaign.id,
      headline: c.creative.headline,
      body: c.creative.body,
      bookId: c.campaign.bookId,
      verdict,
    },
    defaultAction: verdict === "block" ? "reject" : "approve",
    defaultActionAt: new Date(
      Math.max(now.getTime() + 3_600_000, start - (verdict === "block" ? 24 : 48) * 3_600_000),
    ).toISOString(),
    dedupeKey: `ad_flag:${creativeId}`,
  });
  return item?.id ?? null;
}

/** Open ad_review items that no longer need deciding (the campaign was cancelled meanwhile). */
export async function staleAdReviews(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: inboxItems.id })
    .from(inboxItems)
    .innerJoin(campaigns, eq(campaigns.id, inboxItems.subjectId))
    .where(
      and(
        eq(inboxItems.type, "ad_review"),
        eq(inboxItems.status, "open"),
        inArray(campaigns.status, ["cancelled", "rejected", "refunded", "completed"]),
        isNull(inboxItems.decidedAt),
      ),
    );
  return rows.map((r) => r.id);
}
