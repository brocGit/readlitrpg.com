// Match percentages wear loot rarity (DESIGN §9.10; the rarity tokens in @rlr/ui). Calibrated
// matches start at `match.min_display_score`, so the lowest shown tier is uncommon.

export type Tier = "legendary" | "epic" | "rare" | "uncommon";

export function tierOf(percent: number): Tier {
  return percent >= 90 ? "legendary" : percent >= 80 ? "epic" : percent >= 70 ? "rare" : "uncommon";
}

export const TIER_NAMES: Record<Tier, string> = {
  legendary: "Legendary",
  epic: "Epic",
  rare: "Rare",
  uncommon: "Uncommon",
};
