// The phrase bank for match explanations and heads-ups (DESIGN §7.8). Text is assembled from
// structured clauses, so every word traces to a dial, a tag or a field. No model writes it.

import { getTag, STATS } from "../taxonomy";
import type { Explanation, HeadsUp } from "./score";

type Level = "low" | "mid" | "high";

const DIAL_PHRASES: Record<string, Record<Level, string>> = {
  pacing: { low: "slow-burn pacing", mid: "balanced pacing", high: "breakneck pacing" },
  tone: { low: "grim tone", mid: "mix of light and dark", high: "warm, hopeful tone" },
  humor: { low: "straight-faced storytelling", mid: "regular banter", high: "comedy-first writing" },
  crunch: { low: "barely-there system", mid: "regular status screens", high: "heavy stat crunch" },
  progression_speed: {
    low: "slow, hard-won progression",
    mid: "steady progression",
    high: "fast, visible power gains",
  },
  power_fantasy: {
    low: "underdog struggle",
    mid: "strong-but-challenged MC",
    high: "power-fantasy dominance",
  },
  rigour: { low: "rule-of-cool magic", mid: "rules that mostly hold", high: "hard, exact system rules" },
  combat: { low: "low-combat focus", mid: "mix of fights and downtime", high: "fight-after-fight action" },
  scope: { low: "personal stakes", mid: "kingdom-sized stakes", high: "world-ending stakes" },
  ensemble: { low: "lone-wolf MC", mid: "solid supporting cast", high: "found-family party" },
  lore: { low: "light worldbuilding", mid: "solid worldbuilding", high: "deep lore and mysteries" },
  morality: { low: "big-hearted hero", mid: "pragmatic, gray MC", high: "ruthless MC" },
  strategy: { low: "instinct over planning", mid: "clever tricks", high: "min-maxing and exploits" },
  prose: { low: "lean prose", mid: "clear prose", high: "rich, descriptive prose" },
  danger: { low: "cozy safety", mid: "real danger", high: "anyone-can-die stakes" },
  plot_structure: { low: "episodic adventures", mid: "arcs with side quests", high: "tightly plotted arcs" },
  romance: { low: "no-romance focus", mid: "romance subplot", high: "romance at the center" },
};

const DIFFERS: Record<string, { more: string; less: string }> = {
  pacing: { more: "faster-paced", less: "slower-paced" },
  tone: { more: "lighter in tone", less: "darker" },
  humor: { more: "funnier", less: "more serious" },
  crunch: { more: "crunchier", less: "lighter on stats" },
  progression_speed: { more: "faster progression", less: "slower progression" },
  power_fantasy: { more: "more of a power fantasy", less: "more of an underdog story" },
  rigour: { more: "harder system rules", less: "looser system rules" },
  combat: { more: "more fighting", less: "less fighting" },
  scope: { more: "bigger stakes", less: "more personal stakes" },
  ensemble: { more: "more party-focused", less: "more of a solo story" },
  lore: { more: "deeper lore", less: "lighter worldbuilding" },
  morality: { more: "a more ruthless MC", less: "a more heroic MC" },
  strategy: { more: "more planning and min-maxing", less: "less planning" },
  prose: { more: "wordier prose", less: "leaner prose" },
  danger: { more: "more dangerous", less: "safer and cozier" },
  plot_structure: { more: "more tightly plotted", less: "more episodic" },
  romance: { more: "more romance", less: "less romance" },
};

const STAT_NAMES = new Map(STATS.map((s) => [s.key, s.name]));
const STAT_HEADS_UP: Record<string, string> = {
  competent_mc: "Readers rate the MC's decisions lower than you usually like",
  low_drama: "More interpersonal drama than you usually like",
  earned_power: "Some gains feel handed out rather than earned",
  party_chemistry: "The party dynamics land less well than in your favorites",
  rootable_mc: "A harder MC to root for than you usually like",
};

export const dialPhrase = (dial: string, level: Level) =>
  DIAL_PHRASES[dial]?.[level] ?? dial.replace(/_/g, " ");
export const differsPhrase = (dial: string, direction: "more" | "less") =>
  DIFFERS[dial]?.[direction] ?? `${direction} ${dial.replace(/_/g, " ")}`;
export const tagName = (slug: string) => getTag(slug)?.name ?? slug;
export const statName = (key: string) => STAT_NAMES.get(key) ?? key;

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export interface RenderedExplanation {
  why: string;
  differs: string | null;
  notes: string[];
}

/** Titles are looked up by the caller (matrix index → title). */
export function renderExplanation(
  e: Explanation,
  titleOf: (i: number) => string | undefined,
): RenderedExplanation {
  const clauses = [
    ...e.sameDials.map((d) => dialPhrase(d.dial, d.level)),
    ...e.sharedTags.slice(0, Math.max(0, 3 - e.sameDials.length)).map((t) => tagName(t).toLowerCase()),
  ].slice(0, 3);
  const likeTitle = e.like !== null ? titleOf(e.like) : undefined;
  let why: string;
  if (clauses.length && likeTitle) why = `Same ${list(clauses)} as ${likeTitle}.`;
  else if (clauses.length) why = `Matches your taste for ${list(clauses)}.`;
  else if (likeTitle) why = `Readers who love ${likeTitle} tend to like it.`;
  else why = "A strong fit for the profile you built.";
  const differs = e.differs.length
    ? `Where it differs: ${list(e.differs.map((d) => differsPhrase(d.dial, d.direction)))}.`
    : null;
  const notes = e.notes.map((n) =>
    n === "no_harem"
      ? "No harem."
      : n === "complete_series"
        ? "Complete series."
        : n === "audio"
          ? "Audiobook available."
          : "In Kindle Unlimited.",
  );
  return { why, differs, notes };
}

export function renderHeadsUp(h: HeadsUp): string {
  switch (h.kind) {
    case "stat_below":
      return STAT_HEADS_UP[h.stat] ?? `${statName(h.stat)} is lower than you usually like`;
    case "dial_far": {
      const phrase = differsPhrase(h.dial, h.direction === "higher" ? "more" : "less");
      return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)} than you usually read`;
    }
    case "slow_start":
      return "Slow start: the system arrives late";
    case "split_tag":
      return `Possible ${tagName(h.tag).toLowerCase()}; readers are split`;
    case "stalled":
      return "No new book in 18 months";
  }
}
