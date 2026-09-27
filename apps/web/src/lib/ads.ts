// Ad placements for the public pages (DESIGN §11.5). Pages are cached and the same for everyone,
// so the choice depends only on the slot, the day and the page's subject.

import { type Placement, type PlacementRequest, placementsFor } from "@rlr/core/ads";
import type { Settings } from "@rlr/core/settings";
import { getDb, getLinkKeys } from "./runtime";

export async function placements(
  settings: Settings,
  req: Omit<PlacementRequest, "date">,
): Promise<Placement[]> {
  if (!settings["flags.ads_serving"]) return [];
  try {
    return await placementsFor(getDb(), getLinkKeys(), {
      ...req,
      date: new Date().toISOString().slice(0, 10),
    });
  } catch {
    // An ad must never take a page down.
    return [];
  }
}
