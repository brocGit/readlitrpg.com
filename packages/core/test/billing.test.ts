import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  adReviewHandler,
  cancellationTerms,
  cancelPromotion,
  creativeRisk,
  ensureAdCatalog,
  generateInventory,
  placementsFor,
  startPromotion,
} from "../src/ads";
import { expireOrder } from "../src/ads/paid";
import { appearancesByClass } from "../src/authors";
import {
  addCredit,
  checkoutBody,
  createOrder,
  createPromoCode,
  creditBalance,
  type FakeStripe,
  fakeStripe,
  findPromo,
  formEncode,
  isProAuthor,
  processStripeEvents,
  recordStripeEvent,
  redeemPromo,
  type StripeEvent,
  settle,
  signStripePayload,
  spendCredits,
  transitionOrder,
  verifyStripeWebhook,
} from "../src/billing";
import { addConfirmation, ingestBook, setVisibility } from "../src/catalog";
import { createDb, type Db } from "../src/db";
import {
  advertisers,
  authorNotices,
  authors,
  bookings,
  bookLinks,
  books,
  campaigns,
  creditsLedger,
  inboxItems,
  inventoryUnits,
  orders,
  pageViewsDaily,
  subscriptions,
} from "../src/db/schema";
import { getInboxItem, openInboxItem } from "../src/inbox";
import { parseLinkKeys } from "../src/readers";
import { defaultSettings, type Settings } from "../src/settings";
import { syncTaxonomy } from "../src/taxonomy";
import { createTestD1, TestKV } from "../src/testing";

let db: Db;
let kv: TestKV;
let stripe: FakeStripe;
const SECRET = "whsec_test_secret";
const keys = parseLinkKeys('{"k1":"test-link-key-that-is-at-least-32-chars"}');
const now = new Date("2026-10-01T12:00:00Z");
const settings: Settings = { ...defaultSettings(), "flags.ads_paid": true };

beforeEach(async () => {
  db = createDb(createTestD1().asD1());
  kv = new TestKV();
  stripe = fakeStripe(kv.asKV(), "https://readlitrpg.com", { clock: () => now });
  await syncTaxonomy(db);
  await ensureAdCatalog(db);
  await generateInventory(db, now);
});

async function authorBook(trust: "T0" | "T1" | "T2" = "T1") {
  const { bookId } = await ingestBook(
    db,
    {
      title: "Iron Tower",
      authors: [{ name: "Ann Writer" }],
      primaryGenre: "litrpg",
      links: ["https://www.royalroad.com/fiction/12345/iron-tower"],
    },
    { source: "admin", origin: "admin", fuzzyMin: 0.6, crowdMinVotes: 8 },
  );
  await addConfirmation(db, { subjectType: "book", subjectId: bookId, source: "owner_check" });
  await setVisibility(db, bookId, "published");
  const [a] = await db.select().from(authors);
  await db
    .update(authors)
    .set({ trustLevel: trust })
    .where(eq(authors.id, a?.id ?? ""));
  const [link] = await db.select().from(bookLinks).where(eq(bookLinks.bookId, bookId));
  return { bookId, authorId: a?.id ?? "", linkId: link?.id ?? "" };
}

/** Deliver the fake's events as Stripe would: signed, verified, recorded, processed. */
async function deliver(events: StripeEvent[], at = now) {
  for (const e of events) {
    const body = JSON.stringify(e);
    const header = await signStripePayload(body, SECRET, Math.floor(Date.now() / 1000));
    const verified = await verifyStripeWebhook(body, header, SECRET);
    expect(verified?.id).toBe(e.id);
    await recordStripeEvent(db, verified as StripeEvent, at);
  }
  return processStripeEvents(db, { stripe, settings, now: at });
}

const input = (bookId: string, linkId: string, extra: Record<string, unknown> = {}) => ({
  productKey: "home_spotlight",
  bookId,
  startDate: "2026-10-10",
  periods: 2,
  headline: "Climb the Iron Tower",
  body: "A tower that fights back.",
  cta: "Read now",
  destinationLinkId: linkId,
  ...extra,
});

const start = (authorId: string, inp: ReturnType<typeof input>, s = settings) =>
  startPromotion(db, stripe, {
    authorId,
    userId: "u1",
    email: "ann@example.com",
    input: inp,
    settings: s,
    siteOrigin: "https://readlitrpg.com",
    now,
  });

describe("stripe plumbing", () => {
  it("encodes forms and checkout sessions the way Stripe reads them", () => {
    expect(formEncode({ a: { b: [{ c: 1 }] }, d: "x", e: undefined }).toString()).toBe(
      "a%5Bb%5D%5B0%5D%5Bc%5D=1&d=x",
    );
    const body = checkoutBody({
      mode: "payment",
      customer: "cus_1",
      lineItems: [{ name: "Spotlight", amountCents: 1000 }],
      successUrl: "https://x/s",
      cancelUrl: "https://x/c",
      couponId: "co_1",
      clientReferenceId: "o1",
      metadata: { order_id: "o1" },
    });
    expect(body).toMatchObject({
      discounts: [{ coupon: "co_1" }],
      invoice_creation: { enabled: true },
      line_items: [{ price_data: { unit_amount: 1000, currency: "usd" } }],
    });
  });

  it("verifies webhook signatures, with rotation and a replay window", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: { id: "in_1" } } });
    const t = Math.floor(now.getTime() / 1000);
    const header = await signStripePayload(body, SECRET, t);
    expect((await verifyStripeWebhook(body, header, SECRET, now))?.id).toBe("evt_1");
    expect(await verifyStripeWebhook(body, header, `whsec_new,${SECRET}`, now)).not.toBeNull();
    expect(await verifyStripeWebhook(body, header, "whsec_other", now)).toBeNull();
    expect(await verifyStripeWebhook(`${body} `, header, SECRET, now)).toBeNull();
    expect(await verifyStripeWebhook(body, header, SECRET, new Date(now.getTime() + 600_000))).toBeNull();
    expect(await verifyStripeWebhook(body, null, SECRET, now)).toBeNull();
  });

  it("records each event once and ignores types we don't handle", async () => {
    const e = {
      id: "evt_1",
      type: "invoice.paid",
      created: 0,
      livemode: false,
      data: { object: { id: "in_1", object: "invoice" } },
    };
    expect(await recordStripeEvent(db, e)).toBe(true);
    expect(await recordStripeEvent(db, e)).toBe(false);
    expect(await recordStripeEvent(db, { ...e, id: "evt_2", type: "customer.created" })).toBe(false);
  });
});

describe("money rules", () => {
  it("settles discount, then credits, then the card, never under Stripe's minimum", () => {
    expect(settle(2000, 500, 300)).toEqual({ discountCents: 500, creditsCents: 300, chargeCents: 1200 });
    expect(settle(2000, 0, 5000)).toEqual({ discountCents: 0, creditsCents: 2000, chargeCents: 0 });
    // 20 cents left would be under $0.50: use less credit instead.
    expect(settle(1000, 0, 980)).toEqual({ discountCents: 0, creditsCents: 950, chargeCents: 50 });
    expect(settle(1000, 990, 0)).toEqual({ discountCents: 950, creditsCents: 0, chargeCents: 50 });
  });

  it("keeps an append-only credits ledger that can't be overdrawn", async () => {
    await addCredit(db, { advertiserId: "a1", amountCents: 1000, reason: "comp", createdBy: "owner" });
    expect(
      await spendCredits(db, { advertiserId: "a1", amountCents: 700, reason: "checkout", createdBy: "u1" }),
    ).toBe(true);
    expect(
      await spendCredits(db, { advertiserId: "a1", amountCents: 400, reason: "checkout", createdBy: "u1" }),
    ).toBe(false);
    expect(await creditBalance(db, "a1")).toBe(300);
    await expect(db.update(creditsLedger).set({ deltaCents: 99999 })).rejects.toThrow();
    await expect(db.delete(creditsLedger)).rejects.toThrow();
  });

  it("limits promotion codes by product and uses", async () => {
    const promo = await createPromoCode(db, {
      code: "launch-50",
      percentOff: 50,
      products: ["home_spotlight"],
      maxRedemptions: 1,
      createdBy: "owner",
    });
    expect(promo.code).toBe("LAUNCH-50");
    expect(await findPromo(db, "launch-50", "tag_sponsor")).toMatchObject({ ok: false });
    expect(await findPromo(db, " Launch-50 ", "home_spotlight")).toMatchObject({ ok: true });
    expect(await redeemPromo(db, promo.id)).toBe(true);
    expect(await redeemPromo(db, promo.id)).toBe(false);
    await expect(
      createPromoCode(db, { code: "LAUNCH-50", percentOff: 10, createdBy: "o" }),
    ).rejects.toThrow();
  });

  it("moves orders only along the state machine", async () => {
    const o = await createOrder(db, { kind: "promo", amountCents: 100, createdBy: "u", items: [] });
    expect(await transitionOrder(db, o.id, "refunded")).toBe(false);
    expect(await transitionOrder(db, o.id, "paid")).toBe(true);
    expect(await transitionOrder(db, o.id, "paid")).toBe(false);
    expect(await transitionOrder(db, o.id, "expired")).toBe(false);
    expect(await transitionOrder(db, o.id, "disputed")).toBe(true);
    expect(await transitionOrder(db, o.id, "paid")).toBe(true);
  });

  it("flags risky creatives and applies the cancellation windows", () => {
    expect(creativeRisk("Climb the tower", "T1").score).toBe(0);
    expect(creativeRisk("The #1 BESTSELLER EVER!!", "T1").reasons).toEqual([
      "a ranking claim",
      "shouting",
      "repeated punctuation",
    ]);
    expect(cancellationTerms("2026-10-10T00:00:00Z", now)).toMatchObject({ share: 1, creditOnly: false });
    expect(cancellationTerms("2026-10-05T00:00:00Z", now)).toMatchObject({ share: 0.5, creditOnly: true });
    expect(cancellationTerms("2026-10-02T06:00:00Z", now)).toMatchObject({ allowed: false });
  });
});

describe("buying a promotion", () => {
  it("holds, pays through Checkout, confirms, approves and serves a labeled paid ad", async () => {
    const { bookId, authorId, linkId } = await authorBook("T1");
    const r = await start(authorId, input(bookId, linkId));
    expect(r.redirect).toMatch(/^https:\/\/readlitrpg\.com\/dev\/stripe\/checkout\/cs_fake_/);
    const held = await db.select().from(bookings).where(eq(bookings.campaignId, r.campaignId));
    expect(held.map((b) => b.status)).toEqual(["held", "held"]);
    const [order] = await db.select().from(orders);
    expect(order).toMatchObject({ status: "open", amountCents: 2000, chargedCents: 2000 });

    const sessionId = r.redirect.split("/").pop() ?? "";
    const paid = await stripe.completeCheckout(sessionId);
    expect(await deliver(paid)).toEqual({ processed: 1, failed: 0 });
    // Stripe retries deliveries: the same event is recorded once and does nothing more.
    expect(await deliver(paid)).toEqual({ processed: 0, failed: 0 });
    expect((await db.select().from(orders))[0]).toMatchObject({ status: "paid" });
    const confirmed = await db.select().from(bookings).where(eq(bookings.campaignId, r.campaignId));
    expect(confirmed.map((b) => b.status)).toEqual(["confirmed", "confirmed"]);
    const units = await db
      .select()
      .from(inventoryUnits)
      .where(eq(inventoryUnits.id, held[0]?.inventoryUnitId ?? ""));
    expect(units[0]).toMatchObject({ sold: 1, held: 0 });
    expect((await db.select().from(campaigns).where(eq(campaigns.id, r.campaignId)))[0]?.status).toBe(
      "scheduled",
    );
    expect((await db.select().from(authorNotices)).map((n) => n.kind)).toEqual(["ad_scheduled"]);

    await db.update(campaigns).set({ status: "live" }).where(eq(campaigns.id, r.campaignId));
    const p = await placementsFor(db, keys, {
      slots: ["home_spotlight_1", "home_spotlight_2", "home_spotlight_3"],
      date: "2026-10-10",
      now: new Date("2026-10-10T12:00:00Z"),
    });
    expect(p[0]).toMatchObject({ campaignKey: r.campaignId, label: "Sponsored", sponsored: true });
  });

  it("sends a risky creative to review; rejecting it refunds the card in full", async () => {
    const { bookId, authorId, linkId } = await authorBook("T0");
    const r = await start(authorId, input(bookId, linkId, { headline: "The #1 tower climb" }));
    await deliver(await stripe.completeCheckout(r.redirect.split("/").pop() ?? ""));
    const [item] = await db.select().from(inboxItems).where(eq(inboxItems.type, "ad_review"));
    expect(item).toMatchObject({ defaultAction: "approve", riskScore: 40 });
    expect((await db.select().from(campaigns).where(eq(campaigns.id, r.campaignId)))[0]?.status).toBe(
      "in_review",
    );

    await adReviewHandler.reject?.(db, (await getInboxItem(db, item?.id ?? "")) as NonNullable<typeof item>, {
      decidedBy: "owner",
      note: "No ranking claims, please.",
      now,
      settings,
      stripe,
    });
    expect((await db.select().from(orders))[0]).toMatchObject({ status: "refunded", refundedCents: 2000 });
    expect((await db.select().from(bookings)).every((b) => b.status === "released")).toBe(true);
    expect((await db.select().from(inventoryUnits)).every((u) => u.sold === 0 && u.held === 0)).toBe(true);
    expect((await db.select().from(authorNotices)).map((n) => n.kind)).toEqual(["ad_rejected"]);
  });

  it("uses credits and codes first; fully covered, it needs no Stripe at all", async () => {
    const { bookId, authorId, linkId } = await authorBook("T1");
    const first = await start(authorId, input(bookId, linkId, { periods: 1 }));
    const advertiserId = (await db.select().from(orders))[0]?.advertiserId ?? "";
    await expireOrder(db, first.orderId, now);
    await addCredit(db, { advertiserId, amountCents: 500, reason: "comp", createdBy: "owner" });
    await createPromoCode(db, { code: "HALF", percentOff: 50, createdBy: "owner" });
    const r = await startPromotion(db, null, {
      authorId,
      userId: "u1",
      email: "ann@example.com",
      input: input(bookId, linkId, { periods: 1, promoCode: "half" }),
      settings,
      siteOrigin: "https://readlitrpg.com",
      now,
    });
    expect(r.redirect).toBe(`https://readlitrpg.com/dashboard/promote/${r.campaignId}?paid=1`);
    const [o] = await db.select().from(orders).where(eq(orders.id, r.orderId));
    expect(o).toMatchObject({ status: "paid", discountCents: 500, creditsCents: 500, chargedCents: 0 });
    expect(await creditBalance(db, advertiserId)).toBe(0);
  });

  it("gives everything back when a checkout expires", async () => {
    const { bookId, authorId, linkId } = await authorBook("T1");
    const advertiser = (await start(authorId, input(bookId, linkId, { periods: 1 }))).orderId;
    const advertiserId =
      (await db.select().from(orders).where(eq(orders.id, advertiser)))[0]?.advertiserId ?? "";
    await expireOrder(db, advertiser, now);
    await addCredit(db, { advertiserId, amountCents: 300, reason: "comp", createdBy: "owner" });
    const r = await start(authorId, input(bookId, linkId, { periods: 1 }));
    expect(await creditBalance(db, advertiserId)).toBe(0);
    const session = await stripe.retrieveCheckoutSession(r.redirect.split("/").pop() ?? "");
    await stripe.expireCheckoutSession(session.id);
    await deliver([
      {
        id: "evt_x",
        type: "checkout.session.expired",
        created: 0,
        livemode: false,
        data: { object: { ...session, id: session.id } },
      },
    ]);
    expect((await db.select().from(orders).where(eq(orders.id, r.orderId)))[0]?.status).toBe("expired");
    expect(await creditBalance(db, advertiserId)).toBe(300);
    expect((await db.select().from(inventoryUnits)).every((u) => u.held === 0)).toBe(true);
  });

  it("refuses bookings too soon, already taken, or with links in the text", async () => {
    const { bookId, authorId, linkId } = await authorBook("T1");
    await expect(start(authorId, input(bookId, linkId, { startDate: "2026-10-02" }))).rejects.toThrow(
      "3 days",
    );
    await expect(start(authorId, input(bookId, linkId, { body: "See www.mytower.com" }))).rejects.toThrow(
      "no links",
    );
    await expect(
      start(authorId, { ...input(bookId, linkId), productKey: "sponsored_match" }),
    ).rejects.toThrow("isn't for sale");
    await expect(
      start(authorId, input(bookId, linkId), { ...settings, "flags.ads_paid": false }),
    ).rejects.toThrow("aren't on sale");
  });

  it("cancels by the §11.10 windows", async () => {
    const { bookId, authorId, linkId } = await authorBook("T1");
    const r = await start(authorId, input(bookId, linkId, { startDate: "2026-10-12", periods: 1 }));
    await deliver(await stripe.completeCheckout(r.redirect.split("/").pop() ?? ""));
    // 11 days out: a full refund to the card.
    expect(
      await cancelPromotion(db, stripe, r.campaignId, { choice: "refund", byUserId: "u1", now }),
    ).toEqual({
      cardCents: 1000,
      creditCents: 0,
    });
    const r2 = await start(authorId, input(bookId, linkId, { startDate: "2026-10-12", periods: 1 }));
    await deliver(await stripe.completeCheckout(r2.redirect.split("/").pop() ?? ""));
    // 4 days out: half, as credit.
    const later = new Date("2026-10-08T00:00:00Z");
    expect(
      await cancelPromotion(db, stripe, r2.campaignId, { choice: "refund", byUserId: "u1", now: later }),
    ).toEqual({ cardCents: 0, creditCents: 500 });
  });

  it("restricts the advertiser and pauses their campaigns on a chargeback", async () => {
    const { bookId, authorId, linkId } = await authorBook("T1");
    const r = await start(authorId, input(bookId, linkId));
    await deliver(await stripe.completeCheckout(r.redirect.split("/").pop() ?? ""));
    const [o] = await db.select().from(orders);
    await deliver(await stripe.openDispute(o?.stripePaymentIntentId ?? ""));
    expect((await db.select().from(orders))[0]?.status).toBe("disputed");
    expect((await db.select().from(authors))[0]?.trustLevel).toBe("T-1");
    expect((await db.select().from(campaigns).where(eq(campaigns.id, r.campaignId)))[0]?.status).toBe(
      "paused",
    );
    const [alert] = await db.select().from(inboxItems).where(eq(inboxItems.type, "dispute"));
    expect(alert?.priority).toBe(100);
    await expect(start(authorId, input(bookId, linkId))).rejects.toThrow("can't buy");
  });
});

describe("Author Pro", () => {
  it("mirrors the subscription, records the invoice and grants the quarterly credit once", async () => {
    const session = await stripe.createCheckoutSession(
      {
        mode: "subscription",
        customer: "cus_fake_x",
        lineItems: [{ price: "price_month" }],
        successUrl: "https://x/s",
        cancelUrl: "https://x/c",
        clientReferenceId: "adv1",
        metadata: {
          advertiser_id: "adv1",
          user_id: "u1",
          plan: "author_pro",
          interval: "month",
          amount_cents: "900",
        },
      },
      "sub:adv1",
    );
    const events = await stripe.completeCheckout(session.id);
    expect(await deliver(events)).toEqual({ processed: 3, failed: 0 });
    const [sub] = await db.select().from(subscriptions);
    expect(sub).toMatchObject({ advertiserId: "adv1", status: "active", interval: "month" });
    expect((await db.select().from(orders))[0]).toMatchObject({ kind: "subscription", amountCents: 900 });
    expect(await creditBalance(db, "adv1")).toBe(2000);
    // Next month's invoice: no second credit within the quarter.
    await deliver([{ ...(events[2] as StripeEvent), id: "evt_next" }]);
    expect(await creditBalance(db, "adv1")).toBe(2000);
    await deliver(await stripe.cancelSubscription(sub?.stripeSubscriptionId ?? "", false));
    expect((await db.select().from(subscriptions))[0]?.status).toBe("canceled");
  });

  it("moves a Pro author's items up the inbox and shows who the match engine sends them", async () => {
    const { authorId, bookId } = await authorBook("T0");
    const before = await openInboxItem(db, { type: "listing_unverified", title: "A", payload: { authorId } });
    expect(before?.priority).toBe(50);
    await db.insert(advertisers).values({ id: "advp", ownerType: "author", ownerId: authorId, name: "Ann" });
    await db.insert(subscriptions).values({
      id: "s1",
      advertiserId: "advp",
      plan: "author_pro",
      interval: "month",
      status: "active",
      stripeSubscriptionId: "sub_1",
      stripeCustomerId: "cus_1",
    });
    expect(await isProAuthor(db, authorId)).toBe(true);
    const after = await openInboxItem(db, { type: "listing_unverified", title: "B", payload: { authorId } });
    expect(after?.priority).toBe(65);
    const [b] = await db.select({ slug: books.slug }).from(books).where(eq(books.id, bookId));
    await db.insert(pageViewsDaily).values([
      { day: "2026-09-30", kind: "match_appearance_class", key: `${b?.slug}:tank`, views: 3 },
      { day: "2026-09-30", kind: "match_appearance_class", key: `${b?.slug}:mage`, views: 9 },
    ]);
    expect(await appearancesByClass(db, b?.slug ?? "", 90, now)).toEqual([
      { classKey: "mage", n: 9 },
      { classKey: "tank", n: 3 },
    ]);
  });
});
