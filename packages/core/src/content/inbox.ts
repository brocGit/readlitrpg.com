// What approving or rejecting a post in the Owner Inbox does (DESIGN §8.2, §14.2). Roundups and
// AI drafts publish; guest posts and interviews take their calendar slot. Handlers are idempotent.

import type { InboxHandler } from "../inbox";
import { claimNextSlot, releaseSlots, slotKindFor } from "./calendar";
import { getPost, publishPost, setPostStatus } from "./posts";

const postId = (p: unknown) =>
  typeof p === "object" && p !== null && typeof (p as { postId?: unknown }).postId === "string"
    ? (p as { postId: string }).postId
    : null;

export const postReviewHandler: InboxHandler = {
  async approve(db, item, ctx) {
    const id = postId(item.payload) ?? item.subjectId;
    const post = id ? await getPost(db, id) : null;
    if (!post || !["in_review", "approved", "changes_requested"].includes(post.status)) return;
    const kind = slotKindFor(post.type);
    if (!kind) {
      await publishPost(db, post.id, ctx.now);
      return;
    }
    const at = await claimNextSlot(db, post.id, kind, ctx.settings, ctx.now);
    await setPostStatus(db, post.id, "scheduled", { publishAt: at, now: ctx.now });
  },
  async reject(db, item, ctx) {
    const id = postId(item.payload) ?? item.subjectId;
    if (!id) return;
    await releaseSlots(db, id);
    await setPostStatus(db, id, "rejected", {
      from: ["in_review", "approved", "changes_requested", "scheduled"],
      now: ctx.now,
    });
  },
};

export const CONTENT_INBOX_HANDLERS: Record<string, InboxHandler> = {
  post_review: postReviewHandler,
};
