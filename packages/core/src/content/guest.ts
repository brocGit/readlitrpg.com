// Guest posts (DESIGN §14.3): a verified author pitches (title and three sentences), the owner
// accepts, the author writes in markdown with book shortcodes, acknowledges the guidelines and the
// license, and submits. An editorial run pre-reviews each stage; the post takes the next guest slot.

import { and, desc, eq, inArray } from "drizzle-orm";
import { notifyAuthor } from "../authors/notices";
import type { Db } from "../db";
import { guestSubmissions, inboxItems, posts } from "../db/schema";
import { enqueue } from "../editorial/queue";
import { ulid } from "../ids";
import { decideInboxItem, type InboxHandler, openInboxItem } from "../inbox";
import type { TrustLevel } from "../policy";
import type { Settings } from "../settings";
import { nowIso } from "../time";
import { wordCount } from "./markdown";
import { createPost, getPost, type RenderEnv, setPostStatus, updatePost } from "./posts";

export const GUEST_WORDS = { min: 800, max: 2_500 } as const;

export const GUEST_GUIDELINES = [
  "800 to 2,500 words.",
  "Topics: the craft of LitRPG (system design, progression pacing, power scaling), genre history, recommendations of other authors' books, behind the scenes.",
  "At most one promotional mention of your own book. It renders as a book card; your bio carries your links.",
  "No affiliate links.",
  "Say if you used AI, and how.",
  "Original work, or give the address where it was first published.",
  "No attacks on other authors or reviewers.",
];

export const GUEST_LICENSE =
  "You keep the copyright. You give ReadLitRPG a non-exclusive, worldwide, royalty-free license to publish, excerpt and promote the post. Ask us to take it down and we will within 14 days.";

export class GuestError extends Error {}

export async function pitchGuestPost(
  db: Db,
  a: { authorId: string; userId: string; trust: TrustLevel; title: string; pitch: string },
  env: RenderEnv,
  settings: Pick<Settings, "flags.guest_posts" | "editorial.priorities">,
): Promise<string> {
  if (!settings["flags.guest_posts"]) throw new GuestError("guest posts are paused right now");
  if (a.trust !== "T1" && a.trust !== "T2") throw new GuestError("verify your profile before pitching");
  const pitch = a.pitch.replace(/\s+/g, " ").trim().slice(0, 1_200);
  if (pitch.length < 40) throw new GuestError("tell us a little more: about three sentences");
  const post = await createPost(
    db,
    {
      type: "guest",
      title: a.title,
      bylineAuthorId: a.authorId,
      authorUserId: a.userId,
      status: "idea",
      createdBy: a.userId,
      disclosure: null,
    },
    env,
  );
  await db
    .insert(guestSubmissions)
    .values({ postId: post.id, authorId: a.authorId, userId: a.userId, pitch });
  await enqueue(db, [
    {
      kind: "guest_review",
      subjectType: "guest_pitch",
      subjectId: post.id,
      priority: settings["editorial.priorities"].guest_review,
    },
  ]);
  await openInboxItem(db, {
    type: "guest_pitch",
    title: `Guest post pitch: "${post.title}"`,
    subjectType: "post",
    subjectId: post.id,
    priority: 35,
    payload: { postId: post.id, authorId: a.authorId, title: post.title, pitch },
    dedupeKey: `guest_pitch:${post.id}`,
  });
  return post.id;
}

async function submission(db: Db, postId: string) {
  const [s] = await db.select().from(guestSubmissions).where(eq(guestSubmissions.postId, postId));
  return s ?? null;
}

export async function acceptPitch(db: Db, postId: string): Promise<boolean> {
  const s = await submission(db, postId);
  if (s?.pitchStatus !== "pending") return false;
  await db
    .update(guestSubmissions)
    .set({ pitchStatus: "accepted", updatedAt: nowIso() })
    .where(eq(guestSubmissions.postId, postId));
  await setPostStatus(db, postId, "drafting", { from: ["idea"] });
  const post = await getPost(db, postId);
  await notifyAuthor(db, {
    authorId: s.authorId,
    userId: s.userId,
    kind: "pitch_accepted",
    payload: { postId, title: post?.title ?? "" },
  });
  return true;
}

export async function declinePitch(db: Db, postId: string, note: string | null): Promise<boolean> {
  const s = await submission(db, postId);
  if (s?.pitchStatus !== "pending") return false;
  await db
    .update(guestSubmissions)
    .set({ pitchStatus: "declined", note, updatedAt: nowIso() })
    .where(eq(guestSubmissions.postId, postId));
  await setPostStatus(db, postId, "rejected", { from: ["idea"] });
  const post = await getPost(db, postId);
  await notifyAuthor(db, {
    authorId: s.authorId,
    userId: s.userId,
    kind: "pitch_declined",
    payload: { postId, title: post?.title ?? "", note },
  });
  return true;
}

export async function saveGuestDraft(
  db: Db,
  postId: string,
  userId: string,
  draft: { title: string; dek: string; bodyMd: string },
  env: RenderEnv,
): Promise<void> {
  const post = await getPost(db, postId);
  if (post?.type !== "guest" || !["drafting", "changes_requested"].includes(post.status))
    throw new GuestError("this post can't be edited now");
  await updatePost(
    db,
    postId,
    { title: draft.title, dek: draft.dek, bodyMd: draft.bodyMd.slice(0, 40_000) },
    env,
    userId,
  );
}

export async function submitGuestPost(
  db: Db,
  postId: string,
  acks: { guidelines: boolean; license: boolean },
  settings: Pick<Settings, "editorial.priorities">,
  now = new Date(),
): Promise<void> {
  const post = await getPost(db, postId);
  if (post?.type !== "guest" || !["drafting", "changes_requested"].includes(post.status))
    throw new GuestError("this post can't be submitted now");
  if (!acks.guidelines || !acks.license) throw new GuestError("please accept the guidelines and the license");
  const words = wordCount(post.bodyMd);
  if (words < GUEST_WORDS.min || words > GUEST_WORDS.max)
    throw new GuestError(
      `guest posts are ${GUEST_WORDS.min}–${GUEST_WORDS.max} words (this one is ${words})`,
    );
  await db
    .update(guestSubmissions)
    .set({ guidelineAckAt: nowIso(now), licenseAckAt: nowIso(now), note: null, updatedAt: nowIso(now) })
    .where(eq(guestSubmissions.postId, postId));
  await setPostStatus(db, postId, "in_review", { now });
  await enqueue(db, [
    {
      kind: "guest_review",
      subjectType: "guest_post",
      subjectId: postId,
      priority: settings["editorial.priorities"].guest_review,
    },
  ]);
  // Waits for the pre-review; a clean review from a verified author sets the default (§8.2).
  const item = await openInboxItem(db, {
    type: "post_review",
    title: `Guest post: "${post.title}"`,
    subjectType: "post",
    subjectId: postId,
    priority: 45,
    payload: { postId, title: post.title, authorId: post.bylineAuthorId, words },
    dedupeKey: `post_review:${postId}:${ulid()}`,
  });
  if (item) await db.update(posts).set({ inboxItemId: item.id }).where(eq(posts.id, postId));
}

/** The owner asks for changes: the author can edit and submit again. */
export async function requestGuestChanges(
  db: Db,
  postId: string,
  note: string,
  decidedBy: string,
): Promise<void> {
  const post = await getPost(db, postId);
  const s = await submission(db, postId);
  if (!post || !s || post.status !== "in_review") throw new GuestError("only a post in review can go back");
  await setPostStatus(db, postId, "changes_requested");
  await db
    .update(guestSubmissions)
    .set({ note: note.slice(0, 1_000), updatedAt: nowIso() })
    .where(eq(guestSubmissions.postId, postId));
  if (post.inboxItemId) await decideInboxItem(db, post.inboxItemId, { status: "resolved", decidedBy, note });
  await notifyAuthor(db, {
    authorId: s.authorId,
    userId: s.userId,
    kind: "guest_changes",
    payload: { postId, title: post.title, note },
  });
}

/** An author's guest posts and pitches, newest first (the dashboard). */
export async function guestPostsFor(db: Db, authorIds: string[]) {
  if (authorIds.length === 0) return [];
  return db
    .select({
      postId: posts.id,
      title: posts.title,
      status: posts.status,
      slug: posts.slug,
      publishAt: posts.publishAt,
      authorId: guestSubmissions.authorId,
      pitchStatus: guestSubmissions.pitchStatus,
      note: guestSubmissions.note,
    })
    .from(guestSubmissions)
    .innerJoin(posts, eq(posts.id, guestSubmissions.postId))
    .where(inArray(guestSubmissions.authorId, authorIds))
    .orderBy(desc(guestSubmissions.createdAt))
    .limit(30);
}

export const guestPitchHandler: InboxHandler = {
  async approve(db, item) {
    const postId = (item.payload as { postId?: string } | null)?.postId ?? item.subjectId;
    if (postId) await acceptPitch(db, postId);
  },
  async reject(db, item, ctx) {
    const postId = (item.payload as { postId?: string } | null)?.postId ?? item.subjectId;
    if (postId) await declinePitch(db, postId, ctx.note ?? null);
  },
};

/** The open review item for a guest post, if any (the pre-review writes its findings there). */
export async function openReviewItem(db: Db, postId: string) {
  const [item] = await db
    .select()
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.subjectType, "post"),
        eq(inboxItems.subjectId, postId),
        eq(inboxItems.status, "open"),
      ),
    )
    .orderBy(desc(inboxItems.createdAt))
    .limit(1);
  return item ?? null;
}
