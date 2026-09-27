// Editorial queue upkeep (DESIGN §7.1, §7.13, §7.15). Runs themselves happen in Claude sessions;
// these jobs keep their queue full, tidy up after them, and check what they cite.

import { buildEditorialQueue, checkPendingCitations, editorialWatchdog } from "@rlr/core/editorial";
import { loadSettings } from "@rlr/core/settings";
import type { JobContext } from "./types";

/** Queue classification, dedupe and research work that no run has picked up yet. */
export async function buildQueue(ctx: JobContext): Promise<number> {
  const { env, db, log } = ctx;
  const settings = await loadSettings({ db, kv: env.CONFIG, log });
  const added = await buildEditorialQueue(db, settings, ctx.now);
  const total = added.classify + added.dedupe + added.research;
  if (total) log.info("editorial.queued", { ...added });
  return total;
}

/** Release expired claims, close dead runs, and alert when work waits with no successful run. */
export async function watchdog(ctx: JobContext): Promise<number> {
  const { env, db, log } = ctx;
  const settings = await loadSettings({ db, kv: env.CONFIG, log });
  const result = await editorialWatchdog(db, settings["editorial.stale_hours"], ctx.now);
  if (result.released || result.expired || result.abandoned || result.alerted)
    log.info("editorial.watchdog", { ...result });
  return result.released + result.expired + result.abandoned;
}

/** Fetch the pages research runs cite; a page naming the book and its author confirms it. */
export async function checkCitations(ctx: JobContext): Promise<number> {
  return checkPendingCitations(ctx.db, { limit: 10, log: ctx.log, fetch: ctx.fetch });
}
