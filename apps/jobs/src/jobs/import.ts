// Bulk imports, a chunk at a time (DESIGN §7.15). While rows remain, each run queues the next one
// straight away instead of waiting for the heartbeat.

import { processImportChunk } from "@rlr/core/catalog";
import { enqueueJob } from "@rlr/core/scheduler";
import { loadSettings } from "@rlr/core/settings";
import type { JobContext } from "./types";

export async function importCatalog({ env, db, log }: JobContext): Promise<number> {
  const settings = await loadSettings({ db, kv: env.CONFIG, log });
  const result = await processImportChunk(db, {
    chunkSize: settings["import.chunk_size"],
    fuzzyMin: settings["catalog.fuzzy_title_min"],
    crowdMinVotes: settings["tags.crowd_min_votes"],
  });
  if (result.importId) log.info("import.chunk", { ...result });
  if (result.remaining > 0) await enqueueJob(db, env.Q_JOBS, "catalog.import");
  return result.processed;
}
