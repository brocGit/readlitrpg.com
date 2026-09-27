import { listPosts, NEWS_SECTION_TYPES, postPath } from "@rlr/core/content";
import { rss } from "@rlr/core/site";
import type { APIRoute } from "astro";
import { getDb } from "../../lib/runtime";
import { origin } from "../../lib/site";

/** The news feed (DESIGN §14.2 distribution). */
export const GET: APIRoute = async () => {
  const o = origin();
  const posts = await listPosts(getDb(), { types: NEWS_SECTION_TYPES, limit: 40 });
  const body = rss(
    {
      title: "Patch Notes: LitRPG news",
      link: `${o}/news`,
      self: `${o}/feeds/news.xml`,
      description: "Today in LitRPG, news briefs and release roundups.",
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
