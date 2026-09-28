// Match rarity tiers for the islands (DESIGN §9.10). The thresholds live in @rlr/ui so the site and
// the emails agree.

export {
  MATCH_TIER_NAMES as TIER_NAMES,
  type MatchTier as Tier,
  matchTier as tierOf,
} from "@rlr/ui/tokens";
