// Open Library and Google Books lookups (DESIGN §7.3 step 3). One book at a time with a pause
// between them, so we stay a polite API client.

import { booksToEnrich, enrichBook } from "@rlr/core/catalog";
import { loadSettings } from "@rlr/core/settings";
import type { JobContext } from "./types";

export const ENRICH_PAUSE_MS = 500;

export async function enrichCatalog(ctx: JobContext): Promise<number> {
  const { env, db, log } = ctx;
  const settings = await loadSettings({ db, kv: env.CONFIG, log });
  const ids = await booksToEnrich(db, settings["enrich.batch_size"], settings["enrich.retry_days"], ctx.now);
  const pause = ctx.pause ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let matched = 0;
  for (const [i, id] of ids.entries()) {
    if (i > 0) await pause(ENRICH_PAUSE_MS);
    const outcome = await enrichBook(db, id, { googleBooksKey: env.GOOGLE_BOOKS_API_KEY, log });
    if (outcome.status === "matched") matched++;
  }
  if (ids.length) log.info("enrich.batch", { looked_up: ids.length, matched });
  return ids.length;
}
