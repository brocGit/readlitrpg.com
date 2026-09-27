import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  adPairs,
  advanceCampaigns,
  CampaignError,
  createHouseCampaign,
  ensureAdCatalog,
  generateInventory,
  inventoryCalendar,
  placementsFor,
  resolveGo,
  setCampaignState,
} from "../src/ads";
import { addConfirmation, ingestBook, setVisibility } from "../src/catalog";
import { createDb, type Db } from "../src/db";
import { bookings, campaigns, inventoryUnits } from "../src/db/schema";
import { parseLinkKeys, signLink } from "../src/readers";
import { syncTaxonomy } from "../src/taxonomy";
import { createTestD1 } from "../src/testing";

let db: Db;
const keys = parseLinkKeys('{"k1":"test-link-key-that-is-at-least-32-chars"}');
const now = new Date("2026-10-05T12:00:00Z");
const today = "2026-10-05";

beforeEach(async () => {
  db = createDb(createTestD1().asD1());
  await syncTaxonomy(db);
  await ensureAdCatalog(db);
});

async function book(title: string, extra: Partial<Parameters<typeof ingestBook>[1]> = {}) {
  const { bookId } = await ingestBook(
    db,
    { title, authors: [{ name: "Ann Writer" }], primaryGenre: "litrpg", ...extra },
    { source: "admin", origin: "admin", fuzzyMin: 0.6, crowdMinVotes: 8 },
  );
  await addConfirmation(db, { subjectType: "book", subjectId: bookId, source: "owner_check" });
  await setVisibility(db, bookId, "published");
  return bookId;
}

const base = { name: "Test", headline: "Read the tower", cta: "Read now", createdBy: "owner" };

describe("inventory", () => {
  it("makes one unit per slot and period 120 days ahead, once", async () => {
    const made = await generateInventory(db, now);
    // Three daily spotlight slots × 121 days, plus three weekly newsletter slots × 18 weeks.
    expect(made).toBe(3 * 121 + 3 * 18);
    expect(await generateInventory(db, now)).toBe(0);
    const cal = await inventoryCalendar(db, today, 7);
    expect(cal.filter((u) => u.slot === "home_spotlight_1")).toHaveLength(8);
    expect(cal.find((u) => u.slot === "newsletter_top")).toMatchObject({
      periodStart: today,
      periodEnd: "2026-10-11",
    });
  });
});

describe("house campaigns", () => {
  it("books reserved places all-or-nothing and refuses a taken slot", async () => {
    const id = await book("Iron Tower");
    const r = await createHouseCampaign(db, {
      ...base,
      productKey: "home_spotlight",
      mode: "reserved",
      slots: ["home_spotlight_1"],
      bookId: id,
      startDate: today,
      endDate: "2026-10-07",
    });
    expect(r.booked).toBe(3);
    await expect(
      createHouseCampaign(db, {
        ...base,
        productKey: "home_spotlight",
        mode: "reserved",
        slots: ["home_spotlight_1"],
        bookId: id,
        startDate: "2026-10-07",
        endDate: "2026-10-09",
      }),
    ).rejects.toThrow("home_spotlight_1 is already booked for 2026-10-07");
    // The failed campaign gave back what it took.
    const sold = await db
      .select({ start: inventoryUnits.periodStart, sold: inventoryUnits.sold })
      .from(inventoryUnits);
    expect(
      sold
        .filter((u) => u.sold > 0)
        .map((u) => u.start)
        .sort(),
    ).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);

    await setCampaignState(db, r.campaignId, "completed", new Date("2026-10-05T18:00:00Z"));
    const left = await db
      .select({ status: bookings.status })
      .from(bookings)
      .where(eq(bookings.campaignId, r.campaignId));
    expect(left.map((b) => b.status).sort()).toEqual(["confirmed", "released", "released"]);
  });

  it("checks the creative and the book", async () => {
    const id = await book("Iron Tower");
    await expect(
      createHouseCampaign(db, {
        ...base,
        productKey: "tag_sponsor",
        mode: "reserved",
        slots: ["tag_sponsor"],
        target: "dungeon-core",
        bookId: id,
        startDate: today,
        endDate: today,
      }),
    ).rejects.toThrow("carry the dungeon-core tag");
    await expect(
      createHouseCampaign(db, {
        ...base,
        headline: "x".repeat(61),
        productKey: "home_spotlight",
        mode: "backfill",
        bookId: id,
        startDate: today,
      }),
    ).rejects.toThrow(CampaignError);
    await expect(
      createHouseCampaign(db, {
        ...base,
        productKey: "home_spotlight",
        mode: "backfill",
        customUrl: "http://insecure.example",
        startDate: today,
      }),
    ).rejects.toThrow("https");
  });
});

describe("serving", () => {
  it("fills slots with the booking, then weighted backfill, then built-in house ads", async () => {
    const a = await book("Iron Tower");
    const b = await book("Deep Delve");
    await createHouseCampaign(db, {
      ...base,
      name: "Reserved",
      productKey: "home_spotlight",
      mode: "reserved",
      slots: ["home_spotlight_1"],
      bookId: a,
      startDate: today,
      endDate: today,
    });
    await createHouseCampaign(db, {
      ...base,
      name: "Own book",
      headline: "My own book",
      productKey: "home_spotlight",
      mode: "backfill",
      bookId: b,
      ownBook: true,
      startDate: today,
    });
    const req = { slots: ["home_spotlight_1", "home_spotlight_2", "home_spotlight_3"], date: today, now };
    const p = await placementsFor(db, keys, req);
    expect(p.map((x) => [x.slot, x.book?.title ?? x.campaignKey])).toEqual([
      ["home_spotlight_1", "Iron Tower"],
      ["home_spotlight_2", "Deep Delve"],
      ["home_spotlight_3", expect.stringMatching(/^house:/)],
    ]);
    expect(p[0]).toMatchObject({ label: "From ReadLitRPG", sponsored: false });
    // The owner's own book is labeled like any sponsored placement (§11.9).
    expect(p[1]).toMatchObject({ label: "Sponsored", sponsored: true });
    // Same period, same choice.
    expect((await placementsFor(db, keys, req)).map((x) => x.campaignKey)).toEqual(
      p.map((x) => x.campaignKey),
    );
    // Guards and exclusions skip a book.
    const guarded = await placementsFor(db, keys, { ...req, guard: (id) => id !== b });
    expect(guarded[1]?.campaignKey).toMatch(/^house:/);
    // No built-ins in email.
    expect(
      await placementsFor(db, keys, { slots: ["newsletter_top"], date: today, now, builtins: false }),
    ).toEqual([]);
  });

  it("resolves clicks from the database, never from the URL", async () => {
    const a = await book("Iron Tower");
    const { campaignId } = await createHouseCampaign(db, {
      ...base,
      productKey: "home_spotlight",
      mode: "backfill",
      customUrl: "https://publisher.example/tower",
      bookId: a,
      startDate: today,
    });
    const [p] = await placementsFor(db, keys, { slots: ["home_spotlight_1"], date: today, now });
    const token = p?.href.replace("/go/", "") ?? "";
    expect(await resolveGo(db, keys, token, "https://readlitrpg.com")).toEqual({
      url: "https://publisher.example/tower",
      campaignKey: campaignId,
      slot: "home_spotlight_1",
    });
    const house = await signLink(keys, "go", ["house:today", "home_spotlight_2"]);
    expect((await resolveGo(db, keys, house, "https://readlitrpg.com"))?.url).toBe(
      "https://readlitrpg.com/news/today",
    );
    expect(await resolveGo(db, keys, `${token.slice(0, -2)}00`, "https://readlitrpg.com")).toBeNull();
    const other = await signLink(keys, "unsub", [campaignId, "home_spotlight_1"]);
    expect(await resolveGo(db, keys, other, "https://readlitrpg.com")).toBeNull();
  });

  it("moves campaigns through their dates and validates beacon pairs", async () => {
    const a = await book("Iron Tower");
    const { campaignId } = await createHouseCampaign(db, {
      ...base,
      productKey: "home_spotlight",
      mode: "backfill",
      bookId: a,
      startDate: today,
      endDate: "2026-10-06",
    });
    await advanceCampaigns(db, now);
    expect((await db.select().from(campaigns).where(eq(campaigns.id, campaignId)))[0]?.status).toBe("live");
    await advanceCampaigns(db, new Date("2026-10-07T00:00:00Z"));
    expect((await db.select().from(campaigns).where(eq(campaigns.id, campaignId)))[0]?.status).toBe(
      "completed",
    );
    expect(
      adPairs([["house:today", "home_spotlight_1"], ["<script>", "x"], [campaignId, "tag_sponsor"], "junk"]),
    ).toEqual([
      ["house:today", "home_spotlight_1"],
      [campaignId, "tag_sponsor"],
    ]);
  });
});
