// stats.rollup (DESIGN Appendix B): copy the last two days of page views from Analytics Engine into
// D1's daily tables. Does nothing until CF_ACCOUNT_ID and CF_API_TOKEN are set; the token needs the
// Account Analytics read permission as well as Workers AI.

import { rollupViews } from "@rlr/core/analytics";
import type { JobContext } from "./types";

export async function rollupStats(ctx: JobContext): Promise<number> {
  const { env, db, log } = ctx;
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    log.info("stats.rollup_skipped", { reason: "CF_ACCOUNT_ID or CF_API_TOKEN not set" });
    return 0;
  }
  return rollupViews(
    db,
    {
      accountId: env.CF_ACCOUNT_ID,
      apiToken: env.CF_API_TOKEN,
      dataset: env.EVENTS_DATASET,
      fetch: ctx.fetch,
    },
    2,
    ctx.now,
  );
}
