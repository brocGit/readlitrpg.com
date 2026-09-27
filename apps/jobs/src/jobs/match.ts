// The match model (DESIGN §7.8): rebuild the feature matrix from published books and store it in
// KV. The version is derived from the content, so an unchanged catalog writes nothing.

import { buildMatrix, storeMatrix } from "@rlr/core/match";
import type { JobContext } from "./types";

export async function buildMatchModel(ctx: JobContext): Promise<number> {
  const { env, db, log } = ctx;
  const matrix = await buildMatrix(db, { now: ctx.now });
  const { stored, pointer } = await storeMatrix(env.CONFIG, matrix);
  if (stored)
    log.info("match.model_stored", { version: pointer.version, books: pointer.n, bytes: pointer.bytes });
  return matrix.n;
}
