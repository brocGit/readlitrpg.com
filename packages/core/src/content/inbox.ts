// What approving or rejecting a post in the Owner Inbox does (DESIGN §8.2, §14.2). Roundups and
// AI drafts publish (or take their slot); guest posts and interviews take the next guest slot and
// their author hears about it. Handlers are idempotent.

import { notifyAuthor } from "../authors/notices";
import type { InboxHandler } from "../inbox";
import { newsBriefHandler } from "./briefs";
import { claimNextSlot, releaseSlots, slotKindFor } from "./calendar";
import { guestPitchHandler } from "./guest";
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
    if (post.bylineAuthorId && (post.type === "guest" || post.type === "interview"))
      await notifyAuthor(db, {
        authorId: post.bylineAuthorId,
        kind: post.type === "guest" ? "guest_scheduled" : "interview_scheduled",
        payload: { postId: post.id, title: post.title, publishAt: at },
      });
  },
  async reject(db, item, ctx) {
    const id = postId(item.payload) ?? item.subjectId;
    const post = id ? await getPost(db, id) : null;
    if (!post) return;
    await releaseSlots(db, post.id);
    const changed = await setPostStatus(db, post.id, "rejected", {
      from: ["in_review", "approved", "changes_requested", "scheduled"],
      now: ctx.now,
    });
    if (changed && post.bylineAuthorId && (post.type === "guest" || post.type === "interview"))
      await notifyAuthor(db, {
        authorId: post.bylineAuthorId,
        kind: "guest_declined",
        payload: { postId: post.id, title: post.title, note: ctx.note ?? null },
      });
  },
};

export const CONTENT_INBOX_HANDLERS: Record<string, InboxHandler> = {
  post_review: postReviewHandler,
  guest_pitch: guestPitchHandler,
  news_brief: newsBriefHandler,
};
