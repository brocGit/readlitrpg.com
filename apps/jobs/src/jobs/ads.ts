// inventory.generate (DESIGN §11.3): keep the ad catalog in step with the code and make inventory
// 120 days ahead. Targeted slots (per tag, per book) get their units on demand instead.

import { ensureAdCatalog, generateInventory } from "@rlr/core/ads";
import type { JobContext } from "./types";

export async function generateAdInventory(ctx: JobContext): Promise<number> {
  await ensureAdCatalog(ctx.db);
  const made = await generateInventory(ctx.db, ctx.now);
  if (made) ctx.log.info("ads.inventory_generated", { units: made });
  return made;
}
