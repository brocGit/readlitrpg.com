// Public reads for the blog and news pages (DESIGN §14). Only published posts; the page renders
// the body through renderBody so book cards are live.

import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "../db";
import { authors, NEWS_TYPES, POST_TYPES, type PostType, postBooks, posts } from "../db/schema";

/** Where a post lives: "Today in LitRPG" at its date, news under /news, the rest under /blog. */
export function postPath(p: { type: PostType; slug: string; genKey?: string | null }): string {
  const day = p.type === "daily" ? /^daily:(\d{4})-(\d{2})-(\d{2})$/.exec(p.genKey ?? "") : null;
  if (day) return `/news/${day[1]}/${day[2]}/${day[3]}`;
  return `${NEWS_SECTION_TYPES.includes(p.type) ? "/news" : "/blog"}/${p.slug}`;
}

/** Published, indexable posts for the sitemap. */
export async function sitemapPosts(db: Db, limit = 10_000): Promise<{ path: string; lastmod: string }[]> {
  const rows = await db
    .select({ type: posts.type, slug: posts.slug, genKey: posts.genKey, updatedAt: posts.updatedAt })
    .from(posts)
    .where(and(eq(posts.status, "published"), eq(posts.noindex, false)))
    .orderBy(desc(posts.publishedAt))
    .limit(limit);
  return rows.map((r) => ({ path: postPath(r), lastmod: r.updatedAt }));
}

export const BLOG_TYPES: PostType[] = POST_TYPES.filter((t) => !NEWS_TYPES.has(t) && t !== "roundup");
export const NEWS_SECTION_TYPES: PostType[] = ["daily", "news", "data_story", "roundup"];

export interface PostSummary {
  id: string;
  slug: string;
  type: PostType;
  title: string;
  dek: string | null;
  publishedAt: string;
  genKey: string | null;
  bylineName: string | null;
  byline: { slug: string; name: string } | null;
  noindex: boolean;
}

const summaryFields = {
  id: posts.id,
  slug: posts.slug,
  type: posts.type,
  title: posts.title,
  dek: posts.dek,
  publishedAt: posts.publishedAt,
  genKey: posts.genKey,
  bylineName: posts.bylineName,
  noindex: posts.noindex,
  authorSlug: authors.slug,
  authorName: authors.name,
};

type SummaryRow = {
  id: string;
  slug: string;
  type: PostType;
  title: string;
  dek: string | null;
  publishedAt: string | null;
  genKey: string | null;
  bylineName: string | null;
  noindex: boolean;
  authorSlug: string | null;
  authorName: string | null;
};

const toSummary = (r: SummaryRow): PostSummary => ({
  id: r.id,
  slug: r.slug,
  type: r.type,
  title: r.title,
  dek: r.dek,
  publishedAt: r.publishedAt ?? "",
  genKey: r.genKey,
  bylineName: r.bylineName,
  byline: r.authorSlug && r.authorName ? { slug: r.authorSlug, name: r.authorName } : null,
  noindex: r.noindex,
});

/** Newest first; `before` is the last item's publishedAt, for the next page. */
export async function listPosts(
  db: Db,
  opts: { types: PostType[]; limit?: number; before?: string | null },
): Promise<PostSummary[]> {
  const rows = await db
    .select(summaryFields)
    .from(posts)
    .leftJoin(authors, eq(authors.id, posts.bylineAuthorId))
    .where(
      and(
        eq(posts.status, "published"),
        inArray(posts.type, opts.types),
        opts.before ? lt(posts.publishedAt, opts.before) : undefined,
      ),
    )
    .orderBy(desc(posts.publishedAt))
    .limit(opts.limit ?? 20);
  return rows.map(toSummary);
}

export type PublishedPost = typeof posts.$inferSelect & { byline: { slug: string; name: string } | null };

export async function publishedPost(db: Db, slug: string): Promise<PublishedPost | null> {
  const [row] = await db
    .select({ post: posts, authorSlug: authors.slug, authorName: authors.name })
    .from(posts)
    .leftJoin(authors, eq(authors.id, posts.bylineAuthorId))
    .where(and(eq(posts.slug, slug), eq(posts.status, "published")));
  if (!row) return null;
  return {
    ...row.post,
    byline: row.authorSlug && row.authorName ? { slug: row.authorSlug, name: row.authorName } : null,
  };
}

/** "Today in LitRPG" for a date (YYYY-MM-DD), published or not yet. */
export async function dailyPost(db: Db, date: string): Promise<{ slug: string; status: string } | null> {
  const [row] = await db
    .select({ slug: posts.slug, status: posts.status })
    .from(posts)
    .where(eq(posts.genKey, `daily:${date}`));
  return row ?? null;
}

/** Published posts that show a book (book pages: "On the blog"). */
export async function postsForBook(db: Db, bookId: string, limit = 5): Promise<PostSummary[]> {
  const rows = await db
    .select(summaryFields)
    .from(postBooks)
    .innerJoin(posts, eq(posts.id, postBooks.postId))
    .leftJoin(authors, eq(authors.id, posts.bylineAuthorId))
    .where(
      and(
        eq(postBooks.bookId, bookId),
        eq(posts.status, "published"),
        inArray(posts.type, [...BLOG_TYPES, "roundup"]),
      ),
    )
    .orderBy(desc(posts.publishedAt))
    .limit(limit);
  return rows.map(toSummary);
}

/** Guest posts and interviews by an author ("Writing on ReadLitRPG", §14.3). */
export async function postsByAuthor(db: Db, authorId: string, limit = 10): Promise<PostSummary[]> {
  const rows = await db
    .select(summaryFields)
    .from(posts)
    .leftJoin(authors, eq(authors.id, posts.bylineAuthorId))
    .where(and(eq(posts.bylineAuthorId, authorId), eq(posts.status, "published")))
    .orderBy(desc(posts.publishedAt))
    .limit(limit);
  return rows.map(toSummary);
}

/** Structured data for a post page (schema.org NewsArticle or BlogPosting). */
export function postJsonLd(p: PublishedPost, origin: string): Record<string, unknown> {
  const url = `${origin}${postPath(p)}`;
  const org = { "@type": "Organization", name: "ReadLitRPG", url: origin };
  return {
    "@context": "https://schema.org",
    "@type": NEWS_SECTION_TYPES.includes(p.type) ? "NewsArticle" : "BlogPosting",
    headline: p.title.slice(0, 110),
    ...(p.dek ? { description: p.dek } : {}),
    url,
    mainEntityOfPage: url,
    datePublished: p.publishedAt,
    dateModified: p.updatedAt,
    author: p.byline
      ? { "@type": "Person", name: p.byline.name, url: `${origin}/authors/${p.byline.slug}` }
      : p.bylineName
        ? { "@type": "Person", name: p.bylineName }
        : org,
    publisher: org,
  };
}
