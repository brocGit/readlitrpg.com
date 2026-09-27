// Sponsored Match (DESIGN §11.2, §11.3): a prepaid budget spent per qualified impression. On a
// match results page, at most one live campaign whose book fits *this* reader (score at or above
// `ads.sponsored_match_min_score`, and past their hard no's) is chosen, weighted by how much budget
// it has left per remaining day, so spend spreads over the flight. Each impression is counted on
// our server with one conditional UPDATE, so a campaign can never spend past its budget.

import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { addCredit } from "../billing/credits";
import type { StripeApi } from "../billing/stripe";
import type { Db } from "../db";
import { adProducts, campaigns, creatives } from "../db/schema";
import { ulid } from "../ids";
import {
  combine,
  components,
  type FeatureMatrix,
  hardFilter,
  indexOfBook,
  type MatchOptions,
} from "../match";
import type { TasteProfile } from "../match/profile";
import type { Settings } from "../settings";
import { nowIso } from "../time";
import { checkBook } from "./campaigns";
import {
  type CreativeInput,
  checkCreativeForSale,
  checkDailyCap,
  creativeRisk,
  type PayState,
  PromotionError,
  payForCampaign,
  prepareBuyer,
  rollbackCampaign,
  type StartResult,
} from "./paid";

export const SPONSORED_MATCH = "sponsored_match";
const DAY_MS = 86_400_000;
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export interface SponsoredInput extends CreativeInput {
  budgetCents: number;
  startDate: string;
  days: number;
  promoCode?: string | null;
}

export async function startSponsoredMatch(
  db: Db,
  stripe: StripeApi | null,
  req: {
    authorId: string;
    userId: string;
    email: string;
    input: SponsoredInput;
    settings: Settings;
    siteOrigin: string;
    now?: Date;
  },
): Promise<StartResult> {
  const now = req.now ?? new Date();
  const { settings, input } = req;
  const budget = Math.round(input.budgetCents);
  if (!(budget >= settings["ads.sponsored_match_min_budget_cents"] && budget <= 500_000))
    throw new PromotionError(
      `the budget is $${settings["ads.sponsored_match_min_budget_cents"] / 100} to $5,000`,
    );
  const days = Math.round(input.days);
  if (!(days >= 1 && days <= settings["ads.sponsored_match_max_days"]))
    throw new PromotionError(`run it 1–${settings["ads.sponsored_match_max_days"]} days`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) throw new PromotionError("pick a start date");
  if (input.startDate < addDays(now.toISOString().slice(0, 10), settings["ads.min_lead_days"]))
    throw new PromotionError(`start at least ${settings["ads.min_lead_days"]} days from today`);
  const { trust, advertiser } = await prepareBuyer(db, req.authorId, settings, now);
  await checkDailyCap(db, advertiser.id, trust, budget, settings, now);
  try {
    await checkBook(db, input.bookId, SPONSORED_MATCH, null);
  } catch (error) {
    throw new PromotionError(error instanceof Error ? error.message : "that book can't be promoted");
  }
  await checkCreativeForSale(db, input);
  const [product] = await db
    .select({ id: adProducts.id, name: adProducts.name })
    .from(adProducts)
    .where(eq(adProducts.key, SPONSORED_MATCH));
  if (!product) throw new PromotionError("the ad catalog isn't set up yet");
  const end = addDays(input.startDate, days - 1);
  const campaignId = ulid();
  const risk = creativeRisk(`${input.headline} ${input.body ?? ""}`, trust);
  await db.insert(campaigns).values({
    id: campaignId,
    advertiserId: advertiser.id,
    productId: product.id,
    name: `${product.name}: ${input.headline.trim()}`.slice(0, 120),
    bookId: input.bookId,
    status: "held",
    // No inventory: it only ever shows in its own place in match results.
    mode: "backfill",
    targeting: {},
    budgetCents: budget,
    // The price is fixed when bought, like an inventory snapshot.
    cpmCents: settings["ads.sponsored_match_cpm_cents"],
    startAt: `${input.startDate}T00:00:00.000Z`,
    endAt: `${end}T23:59:59.999Z`,
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
  const state: PayState = { bookingIds: [], promoId: null, creditsUsed: 0, order: null };
  try {
    return await payForCampaign(
      db,
      stripe,
      {
        advertiser,
        campaignId,
        productKey: SPONSORED_MATCH,
        amountCents: budget,
        lines: [
          {
            name: `Sponsored Match budget, ${input.startDate} to ${end}`,
            description: `Sponsored Match · ${input.startDate} to ${end}`,
            amountCents: budget,
            bookingId: null,
          },
        ],
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

export interface SponsoredPick {
  campaignId: string;
  bookId: string;
  i: number;
  score: number;
  headline: string;
  body: string | null;
  cta: string;
}

/**
 * Choose and count one Sponsored Match for this reader, or null. `exclude` holds the matrix rows
 * already on the page: a book the reader sees anyway isn't charged for.
 */
export async function pickSponsoredMatch(
  db: Db,
  m: FeatureMatrix,
  profile: TasteProfile,
  opts: MatchOptions,
  settings: Settings,
  ctx: { exclude?: ReadonlySet<number>; now?: Date; random?: () => number } = {},
): Promise<SponsoredPick | null> {
  const now = ctx.now ?? new Date();
  const iso = nowIso(now);
  const rows = await db
    .select({ campaign: campaigns, creative: creatives })
    .from(campaigns)
    .innerJoin(adProducts, eq(adProducts.id, campaigns.productId))
    .innerJoin(creatives, eq(creatives.campaignId, campaigns.id))
    .where(
      and(
        eq(adProducts.key, SPONSORED_MATCH),
        eq(campaigns.status, "live"),
        eq(creatives.reviewStatus, "approved"),
        isNotNull(campaigns.budgetCents),
        isNotNull(campaigns.bookId),
        lte(campaigns.startAt, iso),
        or(isNull(campaigns.endAt), gt(campaigns.endAt, iso)),
        sql`${campaigns.spentMillicents} + ${campaigns.cpmCents} <= ${campaigns.budgetCents} * 1000`,
      ),
    )
    .limit(50);
  if (!rows.length) return null;
  const index = indexOfBook(m);
  const minScore = settings["ads.sponsored_match_min_score"];
  const eligible: { pick: SponsoredPick; weight: number; cpm: number }[] = [];
  for (const { campaign: c, creative } of rows) {
    const i = index.get(c.bookId ?? "");
    if (i === undefined || ctx.exclude?.has(i) || hardFilter(m, i, profile, opts)) continue;
    const score = combine(components(m, i, profile, opts), opts.weights);
    if (score < minScore) continue;
    // Pacing: skip a campaign running ahead of an even spend, weight the rest by budget left a day.
    const start = Date.parse(c.startAt);
    const end = Date.parse(c.endAt ?? c.startAt) + 1;
    const elapsed = Math.min(1, Math.max(0, (now.getTime() - start) / (end - start)));
    const budget = (c.budgetCents ?? 0) * 1000;
    if (c.spentMillicents / budget > elapsed + 0.1) continue;
    const daysLeft = Math.max(1, (end - now.getTime()) / DAY_MS);
    eligible.push({
      pick: {
        campaignId: c.id,
        bookId: c.bookId ?? "",
        i,
        score,
        headline: creative.headline,
        body: creative.body,
        cta: creative.ctaLabel,
      },
      weight: (budget - c.spentMillicents) / daysLeft,
      cpm: c.cpmCents ?? 0,
    });
  }
  const random = ctx.random ?? Math.random;
  while (eligible.length) {
    const total = eligible.reduce((n, e) => n + e.weight, 0);
    let r = random() * total;
    let k = 0;
    while (k < eligible.length - 1 && r >= (eligible[k]?.weight ?? 0)) {
      r -= eligible[k]?.weight ?? 0;
      k++;
    }
    const [chosen] = eligible.splice(k, 1);
    if (!chosen) break;
    // The count is the charge: only when the budget still covers one more impression.
    const counted = await db
      .update(campaigns)
      .set({
        spentMillicents: sql`${campaigns.spentMillicents} + ${chosen.cpm}`,
        qualifiedImpressions: sql`${campaigns.qualifiedImpressions} + 1`,
      })
      .where(
        and(
          eq(campaigns.id, chosen.pick.campaignId),
          eq(campaigns.status, "live"),
          sql`${campaigns.spentMillicents} + ${chosen.cpm} <= ${campaigns.budgetCents} * 1000`,
        ),
      )
      .returning({ spent: campaigns.spentMillicents, budget: campaigns.budgetCents });
    const row = counted[0];
    if (!row) continue;
    // Spent out: finish now rather than wait for the end date.
    if (row.spent + chosen.cpm > (row.budget ?? 0) * 1000)
      await db
        .update(campaigns)
        .set({ status: "completed", endAt: iso, updatedAt: iso })
        .where(and(eq(campaigns.id, chosen.pick.campaignId), eq(campaigns.status, "live")));
    return chosen.pick;
  }
  return null;
}

/** The advertiser stops a running Sponsored Match; what's left becomes credit at settlement. */
export async function stopSponsoredMatch(db: Db, campaignId: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(campaigns)
    .set({ status: "completed", endAt: nowIso(now), updatedAt: nowIso(now) })
    .where(and(eq(campaigns.id, campaignId), inArray(campaigns.status, ["scheduled", "live", "paused"])))
    .returning({ id: campaigns.id });
  return rows.length === 1;
}

/** Unspent budget of a finished campaign, in whole cents (spend rounds up, in our favor by < 1¢). */
export function leftoverCents(c: { budgetCents: number | null; spentMillicents: number }): number {
  if (!c.budgetCents) return 0;
  return Math.max(0, c.budgetCents - Math.ceil(c.spentMillicents / 1000));
}

/** Credit a finished Sponsored Match's unspent budget (§11.3). Returns the amount. */
export async function creditLeftover(
  db: Db,
  c: { id: string; advertiserId: string; budgetCents: number | null; spentMillicents: number },
  now = new Date(),
): Promise<number> {
  const left = leftoverCents(c);
  if (left > 0)
    await addCredit(
      db,
      {
        advertiserId: c.advertiserId,
        amountCents: left,
        reason: "leftover_budget",
        ref: c.id,
        note: "Unspent Sponsored Match budget",
        createdBy: "system",
      },
      now,
    );
  return left;
}
