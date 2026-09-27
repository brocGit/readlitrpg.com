import { feedOwner, followedReleases } from "@rlr/core/readers";
import { ics } from "@rlr/core/site";
import type { APIRoute } from "astro";
import { getDb } from "../../lib/runtime";
import { origin } from "../../lib/site";

// A reader's private calendar of everything they follow (DESIGN §9.6). The token is the only key,
// so it is revocable; the feed itself holds public release data only.
export const GET: APIRoute = async ({ params }) => {
  const db = getDb();
  const userId = await feedOwner(db, params.token ?? "");
  if (!userId) return new Response("Not found", { status: 404 });
  const today = new Date();
  const from = new Date(today.getTime() - 60 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(today.getTime() + 400 * 86_400_000).toISOString().slice(0, 10);
  const rows = await followedReleases(db, userId, { from, to, notify: ["digest", "instant", "none"] });
  const releases = rows.map((r) => ({
    ...r,
    date: r.date ?? "",
    series: r.seriesName ? { slug: "", name: r.seriesName, position: r.position } : null,
  }));
  return new Response(ics("My LitRPG releases (ReadLitRPG)", releases, origin()), {
    headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, no-store" },
  });
};
