// Brand tokens (DESIGN D11). The same values as tokens.css, for places CSS can't reach:
// email templates, OG images and share cards.
//
// The look: a well-kept guild ledger. Warm paper, ink, a deep guild green for actions, and a
// monospace "status screen" voice for anything the System says. Rarity colors grade book stats.

export const color = {
  paper: "#f6f4ef",
  surface: "#ffffff",
  ink: "#1b1a17",
  muted: "#6f6a60",
  line: "#e4dfd3",
  primary: "#1f5f4a",
  primaryInk: "#ffffff",
  accent: "#b7832a",
  danger: "#a33a2c",
  focus: "#2f6fb3",
  dark: {
    paper: "#14130f",
    surface: "#1d1c17",
    ink: "#ece8df",
    muted: "#a59f93",
    line: "#35332c",
    primary: "#5fb394",
    primaryInk: "#0d1f18",
    accent: "#e0b35a",
  },
} as const;

/** Stat grades on book status screens: a D–S scale mapped to rarity colors. */
export const rarity = {
  common: "#8a8578",
  uncommon: "#3f8f4f",
  rare: "#2f6fb3",
  epic: "#7b4bb7",
  legendary: "#b7832a",
} as const;

/**
 * Match percentages wear loot rarity (DESIGN §9.10), on the site and in email. Calibrated matches
 * start at `match.min_display_score`, so the lowest shown tier is uncommon.
 */
export type MatchTier = "legendary" | "epic" | "rare" | "uncommon";

export function matchTier(percent: number): MatchTier {
  return percent >= 90 ? "legendary" : percent >= 80 ? "epic" : percent >= 70 ? "rare" : "uncommon";
}

export const MATCH_TIER_NAMES: Record<MatchTier, string> = {
  legendary: "Legendary",
  epic: "Epic",
  rare: "Rare",
  uncommon: "Uncommon",
};

export const font = {
  body: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  system: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
} as const;
