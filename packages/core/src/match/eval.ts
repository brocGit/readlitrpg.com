// Offline match eval (DESIGN §7.8 "Getting better over time", §7.14): for readers with at least
// four loved books, hide one, build a profile from the rest, and count how often the hidden book
// lands in the top K. A weight change ships only if recall@10 doesn't drop.

import type { FeatureMatrix } from "./matrix";
import { indexOfBook } from "./matrix";
import { buildProfile } from "./profile";
import { DEFAULT_MATCH_OPTIONS, diversify, type MatchOptions, scoreAll } from "./score";

export interface RecallReport {
  readers: number;
  trials: number;
  hits: number;
  recall: number;
}

/** `readers` are lists of loved book ids or slugs. */
export function recallAtK(
  m: FeatureMatrix,
  readers: string[][],
  k = 10,
  opts: MatchOptions = DEFAULT_MATCH_OPTIONS,
): RecallReport {
  const index = indexOfBook(m);
  let trials = 0;
  let hits = 0;
  let used = 0;
  for (const loved of readers) {
    const known = loved.filter((ref) => index.has(ref));
    if (known.length < 4) continue;
    used++;
    for (const held of known) {
      const rest = known.filter((ref) => ref !== held).slice(0, 5);
      const profile = buildProfile(m, { loved: rest });
      const top = diversify(m, scoreAll(m, profile, opts).scored, k).map((s) => s.i);
      const target = index.get(held);
      trials++;
      if (target !== undefined && top.includes(target)) hits++;
    }
  }
  return { readers: used, trials, hits, recall: trials ? Math.round((hits / trials) * 1000) / 1000 : 0 };
}
