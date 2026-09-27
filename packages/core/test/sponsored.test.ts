import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  advanceCampaigns,
  creditLeftover,
  ensureAdCatalog,
  leftoverCents,
  pickSponsoredMatch,
  startSponsoredMatch,
} from "../src/ads";
import { addCredit, creditBalance } from "../src/billing";
import { addConfirmation, ingestBook, setVisibility, writeAiScores } from "../src/catalog";
import { createDb, type Db } from "../src/db";
import { advertisers, authors, bookLinks, campaigns } from "../src/db/schema";
import { buildMatrix, buildProfile, type FeatureMatrix, indexOfBook, matchOptionsFrom } from "../src/match";
import { defaultSettings, type Settings } from "../src/settings";
import { syncTaxonomy } from "../src/taxonomy";
import { createTestD1 } from "../src/testing";

let db: Db;
const now = new Date("2026-10-01T12:00:00Z");
const settings: Settings = {
  ...defaultSettings(),
  "flags.ads_paid": true,
  // The test catalog is tiny: the eligibility rule is what's under test, not the scorer.
  "ads.sponsored_match_min_score": 0.3,
};
const opts = matchOptionsFrom(settings);

async function published(title: string, author: string, dials: Record<string, number>, tags: string[]) {
  const { bookId } = await ingestBook(
    db,
    {
      title,
      authors: [{ name: author }],
      primaryGenre: "litrpg",
      tags: tags.map((slug) => ({ slug })),
      confidence: 0.85,
      links: [`https://www.royalroad.com/fiction/${Math.floor(Math.random() * 1e6)}/x`],
    },
    { source: "ai", origin: "ai_seed", fuzzyMin: 0.6, crowdMinVotes: 8 },
  );
  await writeAiScores(
    db,
    bookId,
    Object.entries(dials).map(([key, value]) => ({ key, value, confidence: 0.85 })),
    5,
  );
  await addConfirmation(db, { subjectType: "book", subjectId: bookId, source: "owner_check" });
  await setVisibility(db, bookId, "published");
  return bookId;
}

let promoted: string;
let loved: string;
let m: FeatureMatrix;

beforeEach(async () => {
  db = createDb(createTestD1().asD1());
  await syncTaxonomy(db);
  await ensureAdCatalog(db);
  loved = await published("Crunch Tower", "Bea", { crunch: 9, pacing: 8 }, [
    "tower-climbing",
    "build-crafting",
  ]);
  promoted = await published("Crunch Delve", "Ann", { crunch: 9, pacing: 8 }, ["tower-climbing", "grimdark"]);
  await published("Soft Farm", "Cid", { crunch: 1, pacing: 2 }, ["farming", "cozy"]);
  m = await buildMatrix(db);
});

/** A live Sponsored Match for "Crunch Delve", paid with credits (no Stripe needed). */
async function liveCampaign(budgetDollars = 20) {
  const [ann] = await db.select().from(authors).where(eq(authors.name, "Ann"));
  await db
    .update(authors)
    .set({ trustLevel: "T1" })
    .where(eq(authors.id, ann?.id ?? ""));
  const [link] = await db.select().from(bookLinks).where(eq(bookLinks.bookId, promoted));
  // Credits cover it, so the purchase needs no Stripe.
  const [adv] = await db
    .insert(advertisers)
    .values({ id: "adv1", ownerType: "author", ownerId: ann?.id ?? "", name: "Ann" })
    .returning();
  await addCredit(db, {
    advertiserId: adv?.id ?? "",
    amountCents: 100_000,
    reason: "comp",
    createdBy: "owner",
  });
  const r = await startSponsoredMatch(db, null, {
    authorId: ann?.id ?? "",
    userId: "u1",
    email: "ann@example.com",
    input: {
      bookId: promoted,
      budgetCents: budgetDollars * 100,
      startDate: "2026-10-05",
      days: 10,
      headline: "Climb deeper",
      body: null,
      cta: "Read now",
      destinationLinkId: link?.id ?? "",
    },
    settings,
    siteOrigin: "https://readlitrpg.com",
    now,
  });
  await advanceCampaigns(db, new Date("2026-10-05T00:00:01Z"));
  return r.campaignId;
}

const profileFor = (inputs: Parameters<typeof buildProfile>[1]) => buildProfile(m, inputs);

describe("Sponsored Match", () => {
  it("shows a live campaign to a reader it matches, and counts the impression", async () => {
    const id = await liveCampaign();
    expect((await db.select().from(campaigns).where(eq(campaigns.id, id)))[0]?.status).toBe("live");
    const at = new Date("2026-10-06T12:00:00Z");
    const pick = await pickSponsoredMatch(db, m, profileFor({ loved: ["crunch-tower"] }), opts, settings, {
      now: at,
    });
    expect(pick).toMatchObject({ campaignId: id, bookId: promoted, headline: "Climb deeper" });
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, id));
    expect(c).toMatchObject({ spentMillicents: 800, qualifiedImpressions: 1 });

    // Not when the book is already on the page, and never past a hard no.
    const index = indexOfBook(m);
    expect(
      await pickSponsoredMatch(db, m, profileFor({ loved: ["crunch-tower"] }), opts, settings, {
        now: at,
        exclude: new Set([index.get("crunch-delve") ?? -1]),
      }),
    ).toBeNull();
    expect(
      await pickSponsoredMatch(
        db,
        m,
        profileFor({ loved: ["crunch-tower"], noes: ["grimdark"] }),
        opts,
        settings,
        {
          now: at,
        },
      ),
    ).toBeNull();
    // A reader it doesn't fit well isn't shown it.
    expect(
      await pickSponsoredMatch(
        db,
        m,
        profileFor({ loved: ["soft-farm"] }),
        opts,
        { ...settings, "ads.sponsored_match_min_score": 0.9 },
        { now: at },
      ),
    ).toBeNull();
    expect(loved).toBeTruthy();
  });

  it("paces spend over the flight and stops at the budget, crediting what's left", async () => {
    const id = await liveCampaign();
    // Day 1 of 10 with 90% already spent: ahead of an even pace, so it sits out.
    await db.update(campaigns).set({ spentMillicents: 1_800_000 }).where(eq(campaigns.id, id));
    const reader = profileFor({ loved: ["crunch-tower"] });
    expect(
      await pickSponsoredMatch(db, m, reader, opts, settings, { now: new Date("2026-10-05T12:00:00Z") }),
    ).toBeNull();
    // Late in the flight it runs again, until one more impression wouldn't fit the budget.
    const late = new Date("2026-10-14T20:00:00Z");
    await db.update(campaigns).set({ spentMillicents: 1_999_000 }).where(eq(campaigns.id, id));
    expect(await pickSponsoredMatch(db, m, reader, opts, settings, { now: late })).not.toBeNull();
    const [done] = await db.select().from(campaigns).where(eq(campaigns.id, id));
    // 1,999.8¢ spent: another 0.8¢ impression wouldn't fit, so it finishes now.
    expect(done).toMatchObject({ status: "completed", spentMillicents: 1_999_800 });
    expect(await pickSponsoredMatch(db, m, reader, opts, settings, { now: late })).toBeNull();
    // Stopped halfway, the rest comes back as credit.
    const half = { ...(done as NonNullable<typeof done>), spentMillicents: 1_000_400 };
    expect(leftoverCents(half)).toBe(999);
    const before = await creditBalance(db, "adv1");
    expect(await creditLeftover(db, half)).toBe(999);
    expect(await creditBalance(db, "adv1")).toBe(before + 999);
  });

  it("checks the budget and dates", async () => {
    const [ann] = await db.select().from(authors).where(eq(authors.name, "Ann"));
    const base = {
      authorId: ann?.id ?? "",
      userId: "u1",
      email: "a@example.com",
      settings,
      siteOrigin: "https://x",
      now,
    };
    const input = {
      bookId: promoted,
      budgetCents: 500,
      startDate: "2026-10-05",
      days: 10,
      headline: "Climb",
      cta: "Read now",
      destinationLinkId: "x",
    };
    await expect(startSponsoredMatch(db, null, { ...base, input })).rejects.toThrow("budget");
    await expect(
      startSponsoredMatch(db, null, { ...base, input: { ...input, budgetCents: 2000, days: 999 } }),
    ).rejects.toThrow("days");
  });
});
