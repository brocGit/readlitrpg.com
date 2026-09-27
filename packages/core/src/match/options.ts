// Match options from settings, shared by the site and the console so a sample match in the console
// ranks exactly as the site does.

import type { Settings } from "../settings";
import { DEFAULT_MATCH_OPTIONS, type MatchOptions } from "./score";

export function matchOptionsFrom(s: Settings): MatchOptions {
  return {
    ...DEFAULT_MATCH_OPTIONS,
    weights: s["match.weights"],
    excludeMin: s["tags.exclude_min"],
    includeMin: s["tags.include_min"],
    minDisplayScore: s["match.min_display_score"],
    maxHeadsUps: s["match.max_headsups"],
    bouncedPenalty: s["match.bounced_penalty"],
  };
}
