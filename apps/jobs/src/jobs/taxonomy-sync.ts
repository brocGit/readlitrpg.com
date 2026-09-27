// Keeps the tags table in step with data/taxonomy.yaml (DESIGN §6.5). Cheap when nothing changed.

import { syncTaxonomy, TAXONOMY_HASH } from "@rlr/core/taxonomy";
import type { JobContext } from "./types";

export const TAXONOMY_KV_KEY = "taxonomy:hash";

export async function syncTaxonomyJob({ env, db, log }: JobContext): Promise<number> {
  if ((await env.CONFIG.get(TAXONOMY_KV_KEY)) === TAXONOMY_HASH) return 0;
  const result = await syncTaxonomy(db);
  await env.CONFIG.put(TAXONOMY_KV_KEY, TAXONOMY_HASH);
  log.info("taxonomy.synced", { ...result, hash: TAXONOMY_HASH });
  return result.inserted + result.updated;
}
