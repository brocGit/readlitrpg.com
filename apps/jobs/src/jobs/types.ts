import type { Logger } from "@rlr/core";
import type { Db } from "@rlr/core/db";

export interface JobContext {
  env: Env;
  db: Db;
  log: Logger;
  now: Date;
}

/** Returns the number of items processed, for job_runs. */
export type JobHandler = (ctx: JobContext) => Promise<number>;
