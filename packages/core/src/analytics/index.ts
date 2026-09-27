// First-party analytics (DESIGN §4.5 EVENTS, §11.6, §16): the beacon reports a page view; the web
// Worker drops bots and prefetches and writes one Analytics Engine data point with the page's kind
// and subject, the referring site and the country. No cookies, no IPs, no user agents are kept.
// The stats.rollup job copies daily totals into D1 for the console.

import { and, desc, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../db";
import { pageViewsDaily, referrersDaily } from "../db/schema";
import { type SafeFetchOptions, safeFetch } from "../net/safe-fetch";

export const PAGE_KINDS = [
  "home",
  "book",
  "series",
  "author",
  "narrator",
  "tag",
  "books_like",
  "list",
  "quiz",
  "quiz_result",
  "match",
  "find",
  "new",
  "other",
] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

const ROUTES: [RegExp, PageKind][] = [
  [/^\/$/, "home"],
  [/^\/books\/([a-z0-9-]{1,200})$/, "book"],
  [/^\/series\/([a-z0-9-]{1,200})$/, "series"],
  [/^\/authors\/([a-z0-9-]{1,200})$/, "author"],
  [/^\/narrators\/([a-z0-9-]{1,200})$/, "narrator"],
  [/^\/tags\/([a-z0-9-]{1,80})$/, "tag"],
  [/^\/books-like\/([a-z0-9-]{1,200})$/, "books_like"],
  [/^\/lists\/([a-z0-9-]{1,120})$/, "list"],
  [/^\/quiz\/([a-z0-9-]{1,120})\/r\/[a-z0-9-]{1,80}$/, "quiz_result"],
  [/^\/quiz\/([a-z0-9-]{1,120})$/, "quiz"],
  [/^\/match(\/quiz|\/r)?$/, "match"],
  [/^\/find$/, "find"],
  [/^\/new$/, "new"],
];

/** Private pages are never counted, and a path we don't know is counted only as "other". */
export function classifyPath(path: string): { kind: PageKind; key: string } | null {
  if (!path.startsWith("/") || path.length > 300) return null;
  if (/^\/(api|account|signin|media|feeds|sitemaps?)(\/|$|\.)/.test(path)) return null;
  for (const [re, kind] of ROUTES) {
    const m = re.exec(path);
    if (m)
      return {
        kind,
        key: kind === "match" ? (m[1] ?? "/match").replace(/^\//, "") || "match" : (m[1] ?? ""),
      };
  }
  return { kind: "other", key: "" };
}

const BOTS =
  /bot|crawl|spider|slurp|preview|fetch|monitor|headless|lighthouse|python|curl|wget|httpclient|java\/|go-http/i;

/** Known bots, link previewers and prefetches aren't readers (DESIGN §11.6 invalid traffic). */
export function isAutomated(headers: Headers): boolean {
  const ua = headers.get("user-agent") ?? "";
  if (!ua || BOTS.test(ua)) return true;
  const purpose = headers.get("sec-purpose") ?? headers.get("purpose") ?? "";
  return /prefetch|prerender/i.test(purpose);
}

/** Only the referring site's host, and only when it's another site. */
export function referrerHost(ref: unknown, ownHost: string): string {
  if (typeof ref !== "string" || !ref) return "";
  const host = ref
    .toLowerCase()
    .replace(/^www\./, "")
    .slice(0, 100);
  if (!/^[a-z0-9.-]+$/.test(host) || host === ownHost.replace(/^www\./, "")) return "";
  return host;
}

export interface ViewPoint {
  kind: PageKind;
  key: string;
  referrer: string;
  country: string;
}

/**
 * Events that aren't page views, counted the same way. A match appearance is a book shown on a
 * reader's match results (DESIGN §10.5 author stats): the results page reports the slugs it showed.
 */
export const EVENT_KINDS = ["match_appearance"] as const;
const COUNTED_KINDS: ReadonlySet<string> = new Set([...PAGE_KINDS, ...EVENT_KINDS]);

/** Up to 15 well-formed book slugs from a beacon body; anything else is dropped. */
export function appearanceSlugs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(raw.filter((s): s is string => typeof s === "string" && /^[a-z0-9-]{1,200}$/.test(s))),
  ].slice(0, 15);
}

export const toAppearancePoint = (slug: string, country: string): AnalyticsEngineDataPoint => ({
  indexes: ["match_appearance"],
  blobs: ["match_appearance", slug, "", country],
  doubles: [1],
});

export const toDataPoint = (v: ViewPoint): AnalyticsEngineDataPoint => ({
  indexes: [v.kind],
  blobs: [v.kind, v.key, v.referrer, v.country],
  doubles: [1],
});

// ---------------------------------------------------------------------------------------------
// Rollup: Analytics Engine keeps 90 days; D1 keeps the daily totals.

export interface RollupDeps {
  accountId: string;
  apiToken: string;
  dataset: string;
  fetch?: typeof fetch;
}

async function aeQuery<T>(sqlText: string, deps: RollupDeps): Promise<T[]> {
  const opts: SafeFetchOptions = {
    allowHosts: ["api.cloudflare.com"],
    method: "POST",
    body: sqlText,
    headers: { authorization: `Bearer ${deps.apiToken}`, "content-type": "text/plain" },
    timeoutMs: 15_000,
    maxBytes: 5_000_000,
    fetch: deps.fetch,
  };
  const res = await safeFetch(
    `https://api.cloudflare.com/client/v4/accounts/${deps.accountId}/analytics_engine/sql`,
    opts,
  );
  if (res.status !== 200)
    throw new Error(`Analytics Engine answered ${res.status}: ${res.text.slice(0, 200)}`);
  return (JSON.parse(res.text) as { data?: T[] }).data ?? [];
}

/** Recompute the last `days` whole days (today included) from Analytics Engine. Idempotent. */
export async function rollupViews(db: Db, deps: RollupDeps, days = 2, now = new Date()): Promise<number> {
  if (!/^[a-z0-9_]+$/.test(deps.dataset)) throw new Error("bad dataset name");
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
  const from = since.toISOString().slice(0, 19).replace("T", " ");
  const views = await aeQuery<{ day: string; kind: string; key: string; views: number | string }>(
    `SELECT toDate(timestamp) AS day, blob1 AS kind, blob2 AS key, SUM(_sample_interval) AS views
     FROM ${deps.dataset} WHERE timestamp >= toDateTime('${from}')
     GROUP BY day, kind, key ORDER BY views DESC LIMIT 20000 FORMAT JSON`,
    deps,
  );
  const refs = await aeQuery<{ day: string; host: string; views: number | string }>(
    `SELECT toDate(timestamp) AS day, blob3 AS host, SUM(_sample_interval) AS views
     FROM ${deps.dataset} WHERE timestamp >= toDateTime('${from}') AND blob3 != ''
     GROUP BY day, host ORDER BY views DESC LIMIT 5000 FORMAT JSON`,
    deps,
  );
  const cleanDay = (d: string) => String(d).slice(0, 10);
  const viewRows = views
    .filter((v) => COUNTED_KINDS.has(v.kind))
    .map((v) => ({
      day: cleanDay(v.day),
      kind: v.kind,
      key: String(v.key ?? "").slice(0, 200),
      views: Math.round(Number(v.views)),
    }));
  const refRows = refs.map((r) => ({
    day: cleanDay(r.day),
    host: String(r.host).slice(0, 100),
    views: Math.round(Number(r.views)),
  }));
  // Four columns a row: 20 rows keep a statement under D1's 100 bound parameters.
  for (let i = 0; i < viewRows.length; i += 20) {
    await db
      .insert(pageViewsDaily)
      .values(viewRows.slice(i, i + 20))
      .onConflictDoUpdate({
        target: [pageViewsDaily.day, pageViewsDaily.kind, pageViewsDaily.key],
        set: { views: sql`excluded.views` },
      });
  }
  for (let i = 0; i < refRows.length; i += 30) {
    await db
      .insert(referrersDaily)
      .values(refRows.slice(i, i + 30))
      .onConflictDoUpdate({
        target: [referrersDaily.day, referrersDaily.host],
        set: { views: sql`excluded.views` },
      });
  }
  return viewRows.length;
}

// ---------------------------------------------------------------------------------------------
// The console's traffic panel

export async function trafficSummary(db: Db, days = 7, now = new Date()) {
  const since = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const [byDay, topPages, topReferrers] = await Promise.all([
    db
      .select({ day: pageViewsDaily.day, views: sql<number>`sum(${pageViewsDaily.views})` })
      .from(pageViewsDaily)
      .where(and(gte(pageViewsDaily.day, since), inArray(pageViewsDaily.kind, [...PAGE_KINDS])))
      .groupBy(pageViewsDaily.day)
      .orderBy(pageViewsDaily.day),
    db
      .select({
        kind: pageViewsDaily.kind,
        key: pageViewsDaily.key,
        views: sql<number>`sum(${pageViewsDaily.views})`,
      })
      .from(pageViewsDaily)
      .where(
        and(
          gte(pageViewsDaily.day, since),
          sql`${pageViewsDaily.key} != ''`,
          inArray(pageViewsDaily.kind, [...PAGE_KINDS]),
        ),
      )
      .groupBy(pageViewsDaily.kind, pageViewsDaily.key)
      .orderBy(desc(sql`sum(${pageViewsDaily.views})`))
      .limit(20),
    db
      .select({ host: referrersDaily.host, views: sql<number>`sum(${referrersDaily.views})` })
      .from(referrersDaily)
      .where(gte(referrersDaily.day, since))
      .groupBy(referrersDaily.host)
      .orderBy(desc(sql`sum(${referrersDaily.views})`))
      .limit(15),
  ]);
  return { byDay, topPages, topReferrers };
}
