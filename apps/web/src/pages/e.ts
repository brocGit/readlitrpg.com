import { classifyPath, isAutomated, referrerHost, toDataPoint } from "@rlr/core/analytics";
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
  if (text.length > 1_000) return noContent();
  let body: { p?: unknown; r?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return noContent();
  }
  const page = typeof body.p === "string" ? classifyPath(body.p) : null;
  if (!page) return noContent();
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  env.EVENTS.writeDataPoint(
    toDataPoint({
      ...page,
      referrer: referrerHost(body.r, new URL(env.PUBLIC_ORIGIN).host),
      country: typeof cf?.country === "string" ? cf.country.slice(0, 2) : "",
    }),
  );
  return noContent();
};
