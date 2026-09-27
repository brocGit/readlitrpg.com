import { ics, newAndUpcoming, tagLookup } from "@rlr/core/site";
import type { APIRoute } from "astro";
import { getDb } from "../../../lib/runtime";
import { origin } from "../../../lib/site";

/** One tag's release days as a subscribable calendar. */
export const GET: APIRoute = async ({ params }) => {
  const db = getDb();
  const found = await tagLookup(db, params.slug ?? "");
  if (found.kind !== "found") return new Response("Not found", { status: 404 });
  const { recent, upcoming } = await newAndUpcoming(db, {
    tagSlug: found.data.slug,
    pastDays: 30,
    aheadDays: 365,
    limit: 200,
  });
  return new Response(ics(`${found.data.name} releases (ReadLitRPG)`, [...recent, ...upcoming], origin()), {
    headers: { "content-type": "text/calendar; charset=utf-8" },
  });
};
