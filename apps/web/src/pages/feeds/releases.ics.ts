import { ics, newAndUpcoming } from "@rlr/core/site";
import type { APIRoute } from "astro";
import { getDb } from "../../lib/runtime";
import { origin } from "../../lib/site";

/** Release days as a subscribable calendar. Only releases with a known day appear. */
export const GET: APIRoute = async () => {
  const { recent, upcoming } = await newAndUpcoming(getDb(), { pastDays: 30, aheadDays: 365, limit: 200 });
  return new Response(ics("LitRPG releases (ReadLitRPG)", [...recent, ...upcoming], origin()), {
    headers: { "content-type": "text/calendar; charset=utf-8" },
  });
};
