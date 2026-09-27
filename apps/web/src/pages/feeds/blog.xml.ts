import { BLOG_TYPES, listPosts, postPath } from "@rlr/core/content";
import { rss } from "@rlr/core/site";
import type { APIRoute } from "astro";
import { getDb } from "../../lib/runtime";
import { origin } from "../../lib/site";

/** The blog feed (DESIGN §14.2 distribution). */
export const GET: APIRoute = async () => {
  const o = origin();
  const posts = await listPosts(getDb(), { types: BLOG_TYPES, limit: 40 });
  const body = rss(
    {
      title: "ReadLitRPG blog",
      link: `${o}/blog`,
      self: `${o}/feeds/blog.xml`,
      description: "Guides, author interviews and guest posts about LitRPG and progression fantasy.",
    },
    posts.map((p) => ({
      title: p.title,
      link: `${o}${postPath(p)}`,
      guid: p.id,
      pubDate: p.publishedAt,
      description: p.dek ?? "",
    })),
  );
  return new Response(body, { headers: { "content-type": "application/rss+xml; charset=utf-8" } });
};
