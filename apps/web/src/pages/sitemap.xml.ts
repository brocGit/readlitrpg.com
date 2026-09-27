import { sitemapCounts, sitemapIndexXml, sitemapNames } from "@rlr/core/site";
import type { APIRoute } from "astro";
import { getDb } from "../lib/runtime";
import { origin } from "../lib/site";

/** The sitemap index (DESIGN §17.2). Cached for a day, which is the "nightly" regeneration. */
export const GET: APIRoute = async () => {
  const names = sitemapNames(await sitemapCounts(getDb()));
  return new Response(sitemapIndexXml(names, origin(), new Date().toISOString()), {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
};
