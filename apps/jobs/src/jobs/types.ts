import type { Logger } from "@rlr/core";
import type { Db } from "@rlr/core/db";
import type { Rasterizer } from "../og/rasterizer";

export interface JobContext {
  env: Env;
  db: Db;
  log: Logger;
  now: Date;
  /** Waits between polite API calls; tests pass a no-op. */
  pause?: (ms: number) => Promise<void>;
  /** Outbound fetch, replaced in tests. Every call still goes through safeFetch. */
  fetch?: typeof fetch;
  /** SVG → PNG. Tests pass one built from the same code without the Worker's bundled binaries. */
  rasterize?: Rasterizer;
}

/** Returns the number of items processed, for job_runs. */
export type JobHandler = (ctx: JobContext) => Promise<number>;
