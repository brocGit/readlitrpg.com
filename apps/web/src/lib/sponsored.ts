// Sponsored Match on the web Worker (DESIGN §11.3): a page token for the results pages, and the
// card shape the results island shows. Results pages are cached, so the placement is fetched per
// reader from /api/sponsored and counted there, never baked into HTML.

import { signLink, verifyLink } from "@rlr/core/readers";
import { getLinkKeys } from "./runtime";

/** Longer than the results pages' cache life (1 h fresh + 24 h stale), so a cached page's token works. */
const TOKEN_HOURS = 26;

/** A token for our own results pages: impressions count only for calls that carry one (§11.3). */
export function sponsoredPageToken(now = Date.now()): Promise<string> {
  return signLink(getLinkKeys(), "pt", ["sm"], now + TOKEN_HOURS * 3_600_000);
}

export async function validPageToken(token: string | null): Promise<boolean> {
  if (!token) return false;
  const data = await verifyLink(getLinkKeys(), token, "pt");
  return data?.[0] === "sm";
}

export interface SponsoredCard {
  campaignKey: string;
  headline: string;
  body: string | null;
  cta: string;
  /** /go/ link: the destination is looked up at click time. */
  href: string;
  percent: number;
  book: { slug: string; title: string; series: string | null; authors: string };
}
