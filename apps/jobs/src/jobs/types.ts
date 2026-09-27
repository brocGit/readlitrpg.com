import type { Logger } from "@rlr/core";
import type { Db } from "@rlr/core/db";

export interface JobContext {
  env: Env;
  db: Db;
  log: Logger;
  now: Date;
  /** Waits between polite API calls; tests pass a no-op. */
  pause?: (ms: number) => Promise<void>;
  /** Outbound fetch, replaced in tests. Every call still goes through safeFetch. */
  fetch?: typeof fetch;
}

/** Returns the number of items processed, for job_runs. */
export type JobHandler = (ctx: JobContext) => Promise<number>;
