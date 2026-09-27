import { resolveGo, toAdPoint } from "@rlr/core/ads";
import { isAutomated } from "@rlr/core/analytics";
import type { APIRoute } from "astro";
import { env, getDb, getLinkKeys } from "../../lib/runtime";
import { origin } from "../../lib/site";

/**
 * Ad clicks (DESIGN §11.6): the signed token names the campaign and slot; the destination comes
 * from the database. Bots and prefetches are sent on but not counted.
 */
export const GET: APIRoute = async ({ params, request }) => {
  const target = await resolveGo(getDb(), getLinkKeys(), params.token ?? "", origin());
  if (!target)
    return new Response("That link has expired.", { status: 404, headers: { "cache-control": "no-store" } });
  if (!isAutomated(request.headers)) {
    const cf = (request as Request & { cf?: { country?: string } }).cf;
    env.EVENTS.writeDataPoint(
      toAdPoint("ad_click", target.campaignKey, target.slot, (cf?.country ?? "").slice(0, 2)),
    );
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: target.url,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer-when-downgrade",
    },
  });
};
