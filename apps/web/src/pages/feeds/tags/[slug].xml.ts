import {
  newAndUpcoming,
  publishedItem,
  recentlyPublished,
  releaseItem,
  rss,
  tagLookup,
} from "@rlr/core/site";
import type { APIRoute } from "astro";
import { getDb } from "../../../lib/runtime";
import { origin } from "../../../lib/site";

/** One tag: books newly added with it, and its releases. */
export const GET: APIRoute = async ({ params }) => {
  const db = getDb();
  const found = await tagLookup(db, params.slug ?? "");
  if (found.kind !== "found") return new Response("Not found", { status: 404 });
  const t = found.data;
  const [{ recent, upcoming }, added] = await Promise.all([
    newAndUpcoming(db, { tagSlug: t.slug, pastDays: 30, aheadDays: 365, limit: 40 }),
    recentlyPublished(db, { tagSlug: t.slug, limit: 30 }),
  ]);
  const o = origin();
  const items = [...upcoming, ...recent]
    .map((r) => releaseItem(r, o))
    .concat(added.map((b) => publishedItem(b, o, t.name)))
    .sort((a, b) => b.pubDate.localeCompare(a.pubDate));
  const body = rss(
    {
      title: `ReadLitRPG: ${t.name}`,
      link: `${o}/tags/${t.slug}`,
      self: `${o}/feeds/tags/${t.slug}.xml`,
      description: `New ${t.name} books and releases on ReadLitRPG.`,
    },
    items.slice(0, 60),
  );
  return new Response(body, { headers: { "content-type": "application/rss+xml; charset=utf-8" } });
};
