// The editorial watchdog (DESIGN §7.13). Hourly: put expired claims back in the queue, close runs
// that died without finishing, and tell the owner when work is piling up with no successful run.
// The site keeps working without runs; AI results just wait.

import type { Db } from "../db";
import { openInboxItem } from "../inbox";
import { hoursBetween } from "../time";
import { expireStaleClaims, oldestQueued } from "./queue";
import { abandonStaleRuns, lastSucceededRun } from "./runs";

export interface WatchdogResult {
  released: number;
  expired: number;
  abandoned: number;
  alerted: boolean;
}

export async function editorialWatchdog(
  db: Db,
  staleHours: number,
  now = new Date(),
): Promise<WatchdogResult> {
  const { released, expired } = await expireStaleClaims(db, now);
  const abandoned = await abandonStaleRuns(db, now);
  const nowText = now.toISOString();
  const last = await lastSucceededRun(db);
  const lastAt = last?.finishedAt ?? null;
  const stale = !lastAt || hoursBetween(lastAt, nowText) > staleHours;
  const oldest = await oldestQueued(db);
  // Alert only when there is work waiting longer than the stale window, or when runs used to
  // succeed and stopped: before the first run is set up there's nothing to be late for.
  const waiting = oldest !== null && hoursBetween(oldest, nowText) > staleHours;
  let alerted = false;
  if (stale && (waiting || last)) {
    const item = await openInboxItem(db, {
      type: "editorial_stale",
      title: last
        ? `No editorial run has succeeded in ${Math.floor(hoursBetween(lastAt ?? nowText, nowText))} hours`
        : "Editorial work is waiting and no run has succeeded yet",
      subjectType: "editorial",
      priority: 90,
      aiRecommendation: "escalate",
      payload: { lastSucceededRunId: last?.id ?? null, lastSucceededAt: lastAt, oldestQueued: oldest },
      // One alert per silent stretch: it reopens only after another run has succeeded.
      dedupeKey: `editorial_stale:${last?.id ?? "never"}`,
    });
    alerted = item !== null;
  }
  return { released, expired, abandoned, alerted };
}
