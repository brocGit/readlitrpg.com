// Book embeddings (DESIGN §7.2, §7.4). Needs CF_ACCOUNT_ID and CF_API_TOKEN (a token scoped to
// Workers AI); without them the job does nothing, which is how local development runs.

import { booksToEmbed, embedBooks, embeddingDuplicates, workersAiEmbedder } from "@rlr/core/catalog";
import { loadSettings } from "@rlr/core/settings";
import type { JobContext } from "./types";

export async function updateVectors(ctx: JobContext): Promise<number> {
  const { env, db, log } = ctx;
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    log.info("vectors.skipped", { reason: "Workers AI credentials not set" });
    return 0;
  }
  const settings = await loadSettings({ db, kv: env.CONFIG, log });
  const ids = await booksToEmbed(db, settings["embed.batch_size"]);
  if (ids.length === 0) return 0;
  const embedder = workersAiEmbedder({
    accountId: env.CF_ACCOUNT_ID,
    token: env.CF_API_TOKEN,
    fetch: ctx.fetch,
  });
  const changed = await embedBooks(db, ids, embedder);
  const duplicates = await embeddingDuplicates(db, changed, settings["catalog.embedding_dup_min"]);
  log.info("vectors.updated", { checked: ids.length, embedded: changed.length, duplicates });
  return ids.length;
}
