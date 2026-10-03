import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ensureAdCatalog,
  generateInventory,
  newsletterMakegoods,
  openPriceSuggestions,
  priceSuggestionsHandler,
  settleFinishedCampaigns,
  startPromotion,
  suggestPrices,
} from "../src/ads";
import { promoteTrusted } from "../src/authors";
import {
  creditBalance,
  type FakeStripe,
  fakeStripe,
  monthCsv,
  processStripeEvents,
  reconcileStripe,
  recordStripeEvent,
} from "../src/billing";
import { addConfirmation, ingestBook, setVisibility } from "../src/catalog";
import { createDb, type Db } from "../src/db";
import {
  auditLog,
  authorNotices,
  authors,
  bookings,
  bookLinks,
  campaigns,
  inboxItems,
  newsletterIssues,
  orders,
  pageViewsDaily,
} from "../src/db/schema";
import { getInboxItem } from "../src/inbox";
import { defaultSettings, loadSettings, type Settings } from "../src/settings";
import { syncTaxonomy } from "../src/taxonomy";
import { createTestD1, TestKV } from "../src/testing";

let db: Db;
let kv: TestKV;
let stripe: FakeStripe;
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

async function authorBook(n = 1) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { bookId } = await ingestBook(
      db,
      {
        title: ["Iron Tower", "Deep Delve", "Ash Road"][i] ?? `Book ${i}`,
        authors: [{ name: "Ann Writer" }],
        primaryGenre: "litrpg",
        links: [`https://www.royalroad.com/fiction/${1000 + i}/x`],
      },
      { source: "admin", origin: "admin", fuzzyMin: 0.6, crowdMinVotes: 8 },
    );
    await addConfirmation(db, { subjectType: "book", subjectId: bookId, source: "owner_check" });
    await setVisibility(db, bookId, "published");
    ids.push(bookId);
  }
  const [a] = await db.select().from(authors);
  await db
    .update(authors)
    .set({ trustLevel: "T1" })
    .where(eq(authors.id, a?.id ?? ""));
  const [link] = await db
    .select()
    .from(bookLinks)
    .where(eq(bookLinks.bookId, ids[0] ?? ""));
  return { bookId: ids[0] ?? "", authorId: a?.id ?? "", linkId: link?.id ?? "" };
}

async function buy(productKey: string, startDate: string) {
  const { bookId, authorId, linkId } = await authorBook();
  const r = await startPromotion(db, stripe, {
    authorId,
    userId: "u1",
    email: "ann@example.com",
    input: {
      productKey,
      bookId,
      startDate,
      periods: 1,
      headline: "Climb",
      cta: "Read now",
      destinationLinkId: linkId,
    },
    settings,
    siteOrigin: "https://readlitrpg.com",
    now,
  });
  const events = await stripe.completeCheckout(r.redirect.split("/").pop() ?? "");
  for (const e of events) await recordStripeEvent(db, e, now);
  await processStripeEvents(db, { stripe, settings, now });
  return { ...r, authorId };
}

describe("settling and make-goods", () => {
  it("settles a finished campaign once and emails its report", async () => {
    const r = await buy("home_spotlight", "2026-10-10");
    await db.update(campaigns).set({ status: "completed" }).where(eq(campaigns.id, r.campaignId));
    expect(await settleFinishedCampaigns(db, now)).toBe(1);
    expect(await settleFinishedCampaigns(db, now)).toBe(0);
    expect((await db.select().from(bookings)).map((b) => b.status)).toEqual(["delivered"]);
    const kinds = (await db.select().from(authorNotices)).map((n) => n.kind);
    expect(kinds).toContain("ad_report");
  });

  it("makes good a newsletter slot whose issue never went out", async () => {
    const r = await buy("newsletter_top", "2026-10-12");
    const later = new Date("2026-10-21T12:00:00Z");
    expect(await newsletterMakegoods(db, later)).toBe(1);
    expect((await db.select().from(bookings))[0]?.status).toBe("makegood");
    const [order] = await db.select().from(orders);
    expect(await creditBalance(db, order?.advertiserId ?? "")).toBe(2500);
    expect((await db.select().from(authorNotices)).map((n) => n.kind)).toContain("makegood");
    expect(await newsletterMakegoods(db, later)).toBe(0);
    expect(r.campaignId).toBeTruthy();
  });

  it("counts a sent issue's slot as delivered", async () => {
    await buy("newsletter_top", "2026-10-12");
    await db.insert(newsletterIssues).values({ id: "i1", kind: "weekly", week: "2026-W42", status: "sent" });
    expect(await newsletterMakegoods(db, new Date("2026-10-21T12:00:00Z"))).toBe(0);
    expect((await db.select().from(bookings))[0]?.status).toBe("delivered");
  });
});

describe("reconciliation", () => {
  it("confirms a payment whose webhook never came, and reports what doesn't add up", async () => {
    const { bookId, authorId, linkId } = await authorBook();
    const r = await startPromotion(db, stripe, {
      authorId,
      userId: "u1",
      email: "ann@example.com",
      input: {
        productKey: "home_spotlight",
        bookId,
        startDate: "2026-10-10",
        periods: 1,
        headline: "Climb",
        cta: "Read now",
        destinationLinkId: linkId,
      },
      settings,
      siteOrigin: "https://readlitrpg.com",
      now,
    });
    await stripe.completeCheckout(r.redirect.split("/").pop() ?? "");
    // No events delivered: reconciliation finds the paid session and confirms the order.
    const result = await reconcileStripe(db, stripe, settings, now);
    expect(result).toMatchObject({ repaired: 1, mismatches: 0 });
    expect((await db.select().from(orders))[0]?.status).toBe("paid");
    // A paid session with no order of ours.
    const orphan = await stripe.createCheckoutSession(
      {
        mode: "payment",
        customer: "cus_x",
        lineItems: [{ name: "x", amountCents: 500 }],
        successUrl: "https://x",
        cancelUrl: "https://x",
        clientReferenceId: "none",
        metadata: {},
      },
      "orphan",
    );
    await stripe.completeCheckout(orphan.id);
    expect((await reconcileStripe(db, stripe, settings, now)).mismatches).toBe(1);
    expect((await db.select().from(inboxItems).where(eq(inboxItems.type, "billing_mismatch"))).length).toBe(
      1,
    );
    const csv = await monthCsv(db, "2026-10");
    expect(csv.split("\n")[0]).toMatch(/^type,date,id,order_id/);
    expect(csv.split("\n").filter((l) => l.startsWith("order,"))).toHaveLength(1);
  });
});

describe("prices and trust", () => {
  it("suggests prices from audience and sell-through, and approving sets them", async () => {
    const rows = Array.from({ length: 28 }, (_, i) => ({
      day: new Date(now.getTime() - (i + 1) * 86_400_000).toISOString().slice(0, 10),
      kind: "home",
      key: "/",
      views: 10_000,
    }));
    for (let i = 0; i < rows.length; i += 20) await db.insert(pageViewsDaily).values(rows.slice(i, i + 20));
    const list = await suggestPrices(db, settings, now);
    // 10,000 home views a day × $4 CPM = $40, capped at twice today's $10.
    expect(list.find((s) => s.product === "home_spotlight")).toMatchObject({
      audience: 10_000,
      suggestedCents: 2000,
    });
    expect(await openPriceSuggestions(db, settings, now)).toBe(true);
    expect(await openPriceSuggestions(db, settings, now)).toBe(false);
    const [item] = await db.select().from(inboxItems).where(eq(inboxItems.type, "price_suggestions"));
    await priceSuggestionsHandler.approve?.(
      db,
      (await getInboxItem(db, item?.id ?? "")) as NonNullable<typeof item>,
      {
        decidedBy: "owner",
        now,
        settings,
        kv: kv.asKV(),
      },
    );
    expect((await loadSettings({ db, kv: kv.asKV() }))["ads.prices"].home_spotlight).toBe(2000);
    expect((await db.select().from(auditLog).where(eq(auditLog.action, "settings.update"))).length).toBe(1);
  });

  it("promotes a verified author who has earned it to Trusted", async () => {
    const r = await buy("home_spotlight", "2026-10-10");
    await authorBook(0);
    // Two more published books for the same author.
    for (const title of ["Deep Delve", "Ash Road"]) {
      const { bookId } = await ingestBook(
        db,
        { title, authors: [{ name: "Ann Writer" }], primaryGenre: "litrpg" },
        { source: "admin", origin: "admin", fuzzyMin: 0.6, crowdMinVotes: 8 },
      );
      await addConfirmation(db, { subjectType: "book", subjectId: bookId, source: "owner_check" });
      await setVisibility(db, bookId, "published");
    }
    await db
      .update(authors)
      .set({ verifiedAt: "2026-06-01T00:00:00.000Z" })
      .where(eq(authors.id, r.authorId));
    expect(await promoteTrusted(db, now)).toEqual([]);
    await db.update(campaigns).set({ status: "completed" }).where(eq(campaigns.id, r.campaignId));
    await settleFinishedCampaigns(db, now);
    expect(await promoteTrusted(db, now)).toEqual([r.authorId]);
    expect((await db.select().from(authors).where(eq(authors.id, r.authorId)))[0]?.trustLevel).toBe("T2");
  });
});
