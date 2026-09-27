// The ad review inbox item (DESIGN §8.2 `ad_review`): approving schedules the campaign, rejecting
// releases its places and refunds in full. Its default approves 48 hours before the start when the
// automatic checks passed, and rejects 24 hours before when the creative screen blocked it.

import type { InboxHandler } from "../inbox";
import { approveCampaign, rejectCampaign } from "./paid";

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

export const ADS_INBOX_HANDLERS: Record<string, InboxHandler> = { ad_review: adReviewHandler };
