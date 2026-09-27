// The ad review inbox item (DESIGN §8.2 `ad_review`): approving schedules the campaign, rejecting
// releases its places and refunds in full. Its default approves 48 hours before the start when the
// automatic checks passed, and rejects 24 hours before when the creative screen blocked it.

import type { InboxHandler } from "../inbox";
import { updateSetting } from "../settings";
import { approveCampaign, rejectCampaign, syncPrices } from "./paid";

const campaignOf = (item: { subjectId: string | null; payload: unknown }) =>
  (item.payload as { campaignId?: string } | null)?.campaignId ?? item.subjectId;

export const adReviewHandler: InboxHandler = {
  async approve(db, item, ctx) {
    const id = campaignOf(item);
    if (id) await approveCampaign(db, id, ctx.now);
  },
  async reject(db, item, ctx) {
    const id = campaignOf(item);
    if (!id) return;
    await rejectCampaign(db, ctx.stripe ?? null, id, {
      reason: ctx.note?.trim() || "It didn't meet our ad policy.",
      initiatedBy: ctx.decidedBy,
      now: ctx.now,
    });
  },
};

/**
 * Monthly price suggestions (§11.8): approving sets `ads.prices` (audited, with an undo) and new
 * inventory takes the new prices; existing bookings keep theirs. The default is to keep prices.
 */
export const priceSuggestionsHandler: InboxHandler = {
  async approve(db, item, ctx) {
    const prices = (item.payload as { prices?: Record<string, number> } | null)?.prices;
    if (!prices || !ctx.kv) throw new Error("price suggestions are approved from the console");
    const value = await updateSetting(
      { db, kv: ctx.kv, actor: { type: "admin", id: ctx.decidedBy } },
      "ads.prices",
      prices,
    );
    await syncPrices(db, { ...ctx.settings, "ads.prices": value });
  },
};

export const ADS_INBOX_HANDLERS: Record<string, InboxHandler> = {
  ad_review: adReviewHandler,
  price_suggestions: priceSuggestionsHandler,
};
