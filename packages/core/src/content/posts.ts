// Posts and their lifecycle (DESIGN §14.2): idea → drafting → in review → approved → scheduled →
// published, with every save kept as a revision. Rendering happens at save (sanitized HTML); the
// shortcodes inside are expanded when the page renders (shortcodes.ts).

import { and, desc, eq, inArray, isNotNull, lte, or } from "drizzle-orm";
import { uniqueSlug } from "../catalog/resolve";
import type { Db } from "../db";
import {
  books,
  type PostSource,
  type PostStatus,
  type PostType,
  postBooks,
  postRevisions,
  posts,
} from "../db/schema";
import { ulid } from "../ids";
import { nowIso } from "../time";
import { type LinkPolicy, renderMarkdown } from "./markdown";
import { bookRefsIn } from "./shortcodes";

export type Post = typeof posts.$inferSelect;

/** Where rendered links and images point. */
export interface RenderEnv {
  origin: string;
  mediaOrigin: string;
}

/** The label readers see about how a post was made (§14.1). */
export const DISCLOSURE: Record<PostType, string | null> = {
  roundup: "Compiled automatically from our release database",
  daily: "Compiled automatically from our release database and the day's news",
  news: null,
  data_story: "From the ReadLitRPG database",
  ai_editorial: "Written with AI assistance and edited by ReadLitRPG",
  guest: null,
  interview: null,
  owner: null,
  sponsored: "Sponsored",
};

export const POST_TYPE_LABEL: Record<PostType, string> = {
  roundup: "Roundup",
  daily: "Today in LitRPG",
  news: "Patch Notes",
  data_story: "By the numbers",
  ai_editorial: "Guide",
  guest: "Guest post",
  interview: "Interview",
  owner: "From ReadLitRPG",
  sponsored: "Sponsored",
};

export function linkPolicy(type: PostType): LinkPolicy {
  return type === "guest" ? "ugc" : type === "sponsored" ? "sponsored" : "normal";
}

export interface PostInput {
  type: PostType;
  title: string;
  slug?: string;
  dek?: string | null;
  bodyMd?: string;
  status?: PostStatus;
  authorUserId?: string | null;
  bylineAuthorId?: string | null;
  bylineName?: string | null;
  aiInvolvement?: "none" | "assisted" | "generated";
  disclosure?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  canonicalUrl?: string | null;
  sources?: PostSource[];
  data?: Record<string, unknown> | null;
  genKey?: string | null;
  noindex?: boolean;
  publishAt?: string | null;
  heroMediaId?: string | null;
  createdBy?: string | null;
}

export class PostError extends Error {}

const clean = (s: string | null | undefined, max: number) =>
  s === undefined ? undefined : s === null ? null : s.replace(/\s+/g, " ").trim().slice(0, max) || null;

/** Keep the books a post mentions in `post_books`, so book pages can link to the post. */
async function syncPostBooks(db: Db, postId: string, md: string): Promise<void> {
  const refs = bookRefsIn(md).slice(0, 200);
  const ids = new Set<string>();
  for (let i = 0; i < refs.length; i += 45) {
    const chunk = refs.slice(i, i + 45);
    for (const b of await db
      .select({ id: books.id })
      .from(books)
      .where(or(inArray(books.id, chunk), inArray(books.slug, chunk))))
      ids.add(b.id);
  }
  await db.delete(postBooks).where(eq(postBooks.postId, postId));
  const rows = [...ids].map((bookId) => ({ postId, bookId }));
  for (let i = 0; i < rows.length; i += 45) await db.insert(postBooks).values(rows.slice(i, i + 45));
}

/** Create a post. An automated post with a `genKey` that already exists returns the existing one. */
export async function createPost(db: Db, input: PostInput, env: RenderEnv): Promise<Post> {
  const title = clean(input.title, 200);
  if (!title) throw new PostError("a post needs a title");
  if (input.genKey) {
    const [existing] = await db.select().from(posts).where(eq(posts.genKey, input.genKey));
    if (existing) return existing;
  }
  const id = ulid();
  const now = nowIso();
  const bodyMd = input.bodyMd ?? "";
  const row = {
    id,
    slug: await uniqueSlug(db, posts, input.slug ?? title),
    type: input.type,
    status: input.status ?? "drafting",
    title,
    dek: clean(input.dek, 300) ?? null,
    bodyMd,
    bodyHtml: renderMarkdown(bodyMd, { ...env, links: linkPolicy(input.type) }),
    heroMediaId: input.heroMediaId ?? null,
    authorUserId: input.authorUserId ?? null,
    bylineAuthorId: input.bylineAuthorId ?? null,
    bylineName: clean(input.bylineName, 120) ?? null,
    aiInvolvement: input.aiInvolvement ?? "none",
    disclosure: input.disclosure === undefined ? DISCLOSURE[input.type] : input.disclosure,
    seoTitle: clean(input.seoTitle, 120) ?? null,
    seoDescription: clean(input.seoDescription, 300) ?? null,
    canonicalUrl: input.canonicalUrl ?? null,
    isSponsored: input.type === "sponsored",
    sources: input.sources ?? [],
    data: input.data ?? null,
    genKey: input.genKey ?? null,
    noindex: input.noindex ?? false,
    publishAt: input.publishAt ?? null,
    publishedAt: input.status === "published" ? now : null,
    createdBy: input.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const inserted = await db
    .insert(posts)
    .values(row)
    .onConflictDoNothing({ target: posts.genKey })
    .returning();
  if (!inserted[0]) {
    const [existing] = await db
      .select()
      .from(posts)
      .where(eq(posts.genKey, input.genKey ?? ""));
    if (existing) return existing;
    throw new PostError("couldn't create the post");
  }
  if (bodyMd) {
    await db
      .insert(postRevisions)
      .values({ id: ulid(), postId: id, title, dek: row.dek, bodyMd, editedBy: input.createdBy ?? null });
    await syncPostBooks(db, id, bodyMd);
  }
  return inserted[0];
}

export type PostPatch = Partial<
  Pick<
    PostInput,
    | "title"
    | "dek"
    | "bodyMd"
    | "bylineName"
    | "bylineAuthorId"
    | "aiInvolvement"
    | "disclosure"
    | "seoTitle"
    | "seoDescription"
    | "canonicalUrl"
    | "sources"
    | "data"
    | "noindex"
    | "heroMediaId"
  >
>;

/** Save changes; a change to the title, dek or text is kept as a revision. */
export async function updatePost(
  db: Db,
  id: string,
  patch: PostPatch,
  env: RenderEnv,
  editedBy: string | null,
): Promise<Post> {
  const [post] = await db.select().from(posts).where(eq(posts.id, id));
  if (!post) throw new PostError("no such post");
  const title = patch.title === undefined ? post.title : (clean(patch.title, 200) ?? post.title);
  const dek = patch.dek === undefined ? post.dek : (clean(patch.dek, 300) ?? null);
  const bodyMd = patch.bodyMd ?? post.bodyMd;
  const textChanged = title !== post.title || dek !== post.dek || bodyMd !== post.bodyMd;
  const [updated] = await db
    .update(posts)
    .set({
      title,
      dek,
      bodyMd,
      bodyHtml: renderMarkdown(bodyMd, { ...env, links: linkPolicy(post.type) }),
      ...(patch.bylineName !== undefined ? { bylineName: clean(patch.bylineName, 120) ?? null } : {}),
      ...(patch.bylineAuthorId !== undefined ? { bylineAuthorId: patch.bylineAuthorId } : {}),
      ...(patch.aiInvolvement ? { aiInvolvement: patch.aiInvolvement } : {}),
      ...(patch.disclosure !== undefined ? { disclosure: clean(patch.disclosure, 200) ?? null } : {}),
      ...(patch.seoTitle !== undefined ? { seoTitle: clean(patch.seoTitle, 120) ?? null } : {}),
      ...(patch.seoDescription !== undefined
        ? { seoDescription: clean(patch.seoDescription, 300) ?? null }
        : {}),
      ...(patch.canonicalUrl !== undefined ? { canonicalUrl: patch.canonicalUrl } : {}),
      ...(patch.sources ? { sources: patch.sources } : {}),
      ...(patch.data !== undefined ? { data: patch.data } : {}),
      ...(patch.noindex !== undefined ? { noindex: patch.noindex } : {}),
      ...(patch.heroMediaId !== undefined ? { heroMediaId: patch.heroMediaId } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(posts.id, id))
    .returning();
  if (textChanged) {
    await db.insert(postRevisions).values({ id: ulid(), postId: id, title, dek, bodyMd, editedBy });
    await syncPostBooks(db, id, bodyMd);
  }
  return updated as Post;
}

/** Move a post to a new status. Returns false when it wasn't in one of `from`. */
export async function setPostStatus(
  db: Db,
  id: string,
  to: PostStatus,
  opts: { from?: PostStatus[]; publishAt?: string | null; now?: Date } = {},
): Promise<boolean> {
  const now = nowIso(opts.now);
  const rows = await db
    .update(posts)
    .set({
      status: to,
      ...(opts.publishAt !== undefined ? { publishAt: opts.publishAt } : {}),
      ...(to === "published" ? { publishedAt: now } : {}),
      updatedAt: now,
    })
    .where(and(eq(posts.id, id), opts.from ? inArray(posts.status, opts.from) : undefined))
    .returning({ id: posts.id });
  return rows.length === 1;
}

/** Publish now. A post published before keeps its first publication date. */
export async function publishPost(db: Db, id: string, now = new Date()): Promise<boolean> {
  const [post] = await db.select().from(posts).where(eq(posts.id, id));
  if (!post || post.status === "published") return false;
  const at = nowIso(now);
  await db
    .update(posts)
    .set({
      status: "published",
      publishedAt: post.publishedAt ?? at,
      publishAt: post.publishAt ?? at,
      updatedAt: at,
    })
    .where(eq(posts.id, id));
  return true;
}

/** The heartbeat publishes scheduled posts whose time has come. Returns the published ids. */
export async function publishDuePosts(db: Db, now = new Date()): Promise<string[]> {
  const due = await db
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(eq(posts.status, "scheduled"), isNotNull(posts.publishAt), lte(posts.publishAt, now.toISOString())),
    )
    .limit(20);
  const out: string[] = [];
  for (const { id } of due) if (await publishPost(db, id, now)) out.push(id);
  return out;
}

export async function getPost(db: Db, id: string): Promise<Post | null> {
  const [post] = await db.select().from(posts).where(eq(posts.id, id));
  return post ?? null;
}

export async function listRevisions(db: Db, postId: string, limit = 50) {
  return db
    .select()
    .from(postRevisions)
    .where(eq(postRevisions.postId, postId))
    .orderBy(desc(postRevisions.createdAt))
    .limit(limit);
}

/** Put an old revision back as the current text (itself saved as a new revision). */
export async function restoreRevision(
  db: Db,
  postId: string,
  revisionId: string,
  env: RenderEnv,
  editedBy: string | null,
): Promise<Post> {
  const [rev] = await db
    .select()
    .from(postRevisions)
    .where(and(eq(postRevisions.id, revisionId), eq(postRevisions.postId, postId)));
  if (!rev) throw new PostError("no such revision");
  return updatePost(db, postId, { title: rev.title, dek: rev.dek, bodyMd: rev.bodyMd }, env, editedBy);
}

/** A line-by-line diff of two texts, for the revision view (small posts; O(n·m) is fine). */
export function lineDiff(a: string, b: string): { op: "same" | "add" | "del"; line: string }[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  if (n * m > 400_000)
    return [
      ...x.map((line) => ({ op: "del" as const, line })),
      ...y.map((line) => ({ op: "add" as const, line })),
    ];
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (lcs[i] as number[])[j] =
        x[i] === y[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
  const out: { op: "same" | "add" | "del"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: "same", line: x[i] as string });
      i++;
      j++;
    } else if (((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number))
      out.push({ op: "del", line: x[i++] as string });
    else out.push({ op: "add", line: y[j++] as string });
  }
  while (i < n) out.push({ op: "del", line: x[i++] as string });
  while (j < m) out.push({ op: "add", line: y[j++] as string });
  return out;
}
