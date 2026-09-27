import { adPairs, toAdPoint } from "@rlr/core/ads";
import {
  appearanceSlugs,
  classifyPath,
  isAutomated,
  referrerHost,
  toAppearancePoint,
  toDataPoint,
} from "@rlr/core/analytics";
import type { APIRoute } from "astro";
import { env } from "../lib/runtime";

const noContent = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

/**
 * The page-view beacon (DESIGN §11.6). Cached HTML means the server can't count renders, so the
 * page reports itself. Bots and prefetches are dropped here; nothing identifying is stored.
 */
export const POST: APIRoute = async ({ request }) => {
  if (isAutomated(request.headers)) return noContent();
  const text = await request.text().catch(() => "");
  if (text.length > 2_000) return noContent();
  let body: { p?: unknown; r?: unknown; m?: unknown; a?: unknown; v?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return noContent();
  }
  const page = typeof body.p === "string" ? classifyPath(body.p) : null;
  if (!page) return noContent();
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  const country = typeof cf?.country === "string" ? cf.country.slice(0, 2) : "";
  // Ads seen for at least a second (DESIGN §11.6 viewable impressions). Not a page view.
  if (body.v !== undefined) {
    for (const [c, s] of adPairs(body.v)) env.EVENTS.writeDataPoint(toAdPoint("ad_viewable", c, s, country));
    return noContent();
  }
  // Match results report the books they showed (author stats, DESIGN §10.5). Not a page view.
  if (body.m !== undefined) {
    if (page.kind === "match")
      for (const slug of appearanceSlugs(body.m)) env.EVENTS.writeDataPoint(toAppearancePoint(slug, country));
    return noContent();
  }
  // The ads the page rendered (served impressions): cached HTML means the server can't count them.
  for (const [c, s] of adPairs(body.a)) env.EVENTS.writeDataPoint(toAdPoint("ad_served", c, s, country));
  env.EVENTS.writeDataPoint(
    toDataPoint({
      ...page,
      referrer: referrerHost(body.r, new URL(env.PUBLIC_ORIGIN).host),
      country,
    }),
  );
  return noContent();
};
