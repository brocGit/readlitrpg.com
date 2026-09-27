import { newAndUpcoming, publishedItem, recentlyPublished, releaseItem, rss } from "@rlr/core/site";
import type { APIRoute } from "astro";
import { getDb } from "../../lib/runtime";
import { origin } from "../../lib/site";

/** New and upcoming releases, plus books newly added to the catalog. */
export const GET: APIRoute = async () => {
  const db = getDb();
  const [{ recent, upcoming }, added] = await Promise.all([
    newAndUpcoming(db, { pastDays: 30, aheadDays: 365, limit: 60 }),
    recentlyPublished(db, { limit: 30 }),
  ]);
  const o = origin();
  const items = [...upcoming, ...recent]
    .map((r) => releaseItem(r, o))
    .concat(added.map((b) => publishedItem(b, o)));
  items.sort((a, b) => b.pubDate.localeCompare(a.pubDate));
  const body = rss(
    {
      title: "ReadLitRPG: new and upcoming",
      link: `${o}/new`,
      self: `${o}/feeds/releases.xml`,
      description: "Notable new and upcoming LitRPG, progression fantasy and cultivation releases.",
    },
    items.slice(0, 80),
  );
  return new Response(body, { headers: { "content-type": "application/rss+xml; charset=utf-8" } });
};
