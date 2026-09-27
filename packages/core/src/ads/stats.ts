// Delivery numbers (DESIGN §11.6): served and viewable impressions from the page beacon, clicks
// from /go/, rolled up from Analytics Engine into campaign_stats_daily by the stats.rollup job.

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { aeQuery, type RollupDeps } from "../analytics";
import type { Db } from "../db";
import { campaignStatsDaily } from "../db/schema";

/** Recompute the last `days` days of ad delivery. Idempotent: each day's totals are replaced. */
export async function rollupAds(db: Db, deps: RollupDeps, days = 2, now = new Date()): Promise<number> {
  if (!/^[a-z0-9_]+$/.test(deps.dataset)) throw new Error("bad dataset name");
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
  const from = since.toISOString().slice(0, 19).replace("T", " ");
  const rows = await aeQuery<{ day: string; kind: string; ck: string; slot: string; n: number | string }>(
    `SELECT toDate(timestamp) AS day, blob1 AS kind, blob2 AS ck, blob5 AS slot, SUM(_sample_interval) AS n
     FROM ${deps.dataset} WHERE timestamp >= toDateTime('${from}') AND blob1 IN ('ad_served', 'ad_viewable', 'ad_click')
     GROUP BY day, kind, ck, slot LIMIT 20000 FORMAT JSON`,
    deps,
  );
  const merged = new Map<string, typeof campaignStatsDaily.$inferInsert>();
  for (const r of rows) {
    const date = String(r.day).slice(0, 10);
    const k = `${r.ck}|${date}|${r.slot}`;
    const row = merged.get(k) ?? {
      campaignKey: String(r.ck).slice(0, 60),
      date,
      surface: String(r.slot).slice(0, 40),
      impressions: 0,
      viewable: 0,
      clicks: 0,
    };
    const n = Math.round(Number(r.n));
    if (r.kind === "ad_served") row.impressions = n;
    else if (r.kind === "ad_viewable") row.viewable = n;
    else row.clicks = n;
    merged.set(k, row);
  }
  const values = [...merged.values()];
  // Seven columns a row: 14 rows keep a statement under D1's 100 bound parameters.
  for (let i = 0; i < values.length; i += 14)
    await db
      .insert(campaignStatsDaily)
      .values(values.slice(i, i + 14))
      .onConflictDoUpdate({
        target: [campaignStatsDaily.campaignKey, campaignStatsDaily.date, campaignStatsDaily.surface],
        set: {
          impressions: sql`excluded.impressions`,
          viewable: sql`excluded.viewable`,
          clicks: sql`excluded.clicks`,
        },
      });
  return values.length;
}

/** Totals per campaign over the last `days`, for the console. */
export async function deliveryReport(db: Db, days = 30, now = new Date()) {
  const from = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .select({
      campaignKey: campaignStatsDaily.campaignKey,
      impressions: sql<number>`sum(${campaignStatsDaily.impressions})`.as("impressions"),
      viewable: sql<number>`sum(${campaignStatsDaily.viewable})`.as("viewable"),
      clicks: sql<number>`sum(${campaignStatsDaily.clicks})`.as("clicks"),
    })
    .from(campaignStatsDaily)
    .where(gte(campaignStatsDaily.date, from))
    .groupBy(campaignStatsDaily.campaignKey)
    .orderBy(desc(sql`impressions`))
    .limit(200);
}

export async function campaignDays(db: Db, campaignKey: string, limit = 60) {
  return db
    .select()
    .from(campaignStatsDaily)
    .where(and(eq(campaignStatsDaily.campaignKey, campaignKey)))
    .orderBy(desc(campaignStatsDaily.date))
    .limit(limit);
}

/** Newsletter placements are counted as they're queued: email has no beacon (§11.6). */
export async function countEmailSends(
  db: Db,
  date: string,
  sends: ReadonlyMap<string, { campaignKey: string; slot: string; n: number }>,
): Promise<void> {
  const values = [...sends.values()].map((s) => ({
    campaignKey: s.campaignKey.slice(0, 60),
    date,
    surface: s.slot.slice(0, 40),
    emailSends: s.n,
  }));
  for (let i = 0; i < values.length; i += 14)
    await db
      .insert(campaignStatsDaily)
      .values(values.slice(i, i + 14))
      .onConflictDoUpdate({
        target: [campaignStatsDaily.campaignKey, campaignStatsDaily.date, campaignStatsDaily.surface],
        set: { emailSends: sql`${campaignStatsDaily.emailSends} + excluded.email_sends` },
      });
}
