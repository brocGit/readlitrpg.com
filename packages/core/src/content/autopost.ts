// Saving a templated post (DESIGN §14.1): "Today in LitRPG" publishes every morning; roundups
// publish when `blog.auto_publish_roundups` is on, and otherwise wait in the Owner Inbox, where
// they publish themselves after a day unless the owner rejects them (a veto window, not a queue).

import { eq } from "drizzle-orm";
import { posts } from "../db/schema";
import { openInboxItem } from "../inbox";
import type { Settings } from "../settings";
import type { AutoBuilt } from "./news";
import { markTipsUsed } from "./news";
import { createPost, type Post, publishPost, type RenderEnv } from "./posts";

export const ROUNDUP_VETO_HOURS = 24;

export async function saveAutoPost(
  db: Parameters<typeof createPost>[0],
  built: AutoBuilt,
  env: RenderEnv,
  settings: Pick<Settings, "blog.auto_publish_roundups" | "news.daily_min_items">,
  now = new Date(),
): Promise<{ post: Post; outcome: "published" | "in_review" | "exists" }> {
  const [existing] = await db.select().from(posts).where(eq(posts.genKey, built.genKey));
  // Already built (a retried job): nothing more to do.
  if (existing) return { post: existing, outcome: "exists" };
  const thin = built.type === "daily" && built.items < settings["news.daily_min_items"];
  const review = built.type === "roundup" && !settings["blog.auto_publish_roundups"];
  const post = await createPost(
    db,
    {
      type: built.type,
      title: built.title,
      slug: built.slug,
      dek: built.dek,
      bodyMd: built.bodyMd,
      genKey: built.genKey,
      data: built.data,
      noindex: built.noindex || thin,
      status: review ? "in_review" : "drafting",
      bylineName: null,
      createdBy: "system",
    },
    env,
  );
  await markTipsUsed(db, built.tipIds, post.id);
  if (review) {
    await openInboxItem(db, {
      type: "post_review",
      title: `Roundup ready: "${built.title}"`,
      subjectType: "post",
      subjectId: post.id,
      priority: 40,
      payload: { postId: post.id, title: built.title, items: built.items },
      aiRecommendation: "approve",
      aiSummary: `Built from our release database: ${built.items} books. It publishes itself unless you reject it.`,
      defaultAction: "approve",
      defaultActionAt: new Date(now.getTime() + ROUNDUP_VETO_HOURS * 3_600_000).toISOString(),
      dedupeKey: `post_review:${post.id}`,
    });
    return { post, outcome: "in_review" };
  }
  await publishPost(db, post.id, now);
  return { post, outcome: "published" };
}
