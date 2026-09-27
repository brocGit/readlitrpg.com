// The Match Quiz's first step (DESIGN §9.1 step 1): rate the classics. The first books shown are
// the best-known ones; after that, the next books are the ones that best split what's left, so
// every answer tells us something new.

import { authorsOf, dial, type FeatureMatrix, indexOfBook } from "./matrix";

/** Candidate classics: the owner's list if set, else the most complete published books. */
export function classicPool(m: FeatureMatrix, slugs: readonly string[], size = 40): number[] {
  const index = indexOfBook(m);
  const chosen = slugs.map((s) => index.get(s)).filter((i): i is number => i !== undefined);
  if (chosen.length >= 8) return chosen.slice(0, size);
  const bySeries = new Set<number>();
  const ranked = [...Array(m.n).keys()].sort((a, b) => (m.quality[b] ?? 0) - (m.quality[a] ?? 0) || a - b);
  const out = [...chosen];
  for (const i of ranked) {
    if (out.length >= size) break;
    const s = m.seriesIdx[i] ?? -1;
    // One volume per series, the first one, so readers rate books they're likely to know.
    if (s >= 0 && bySeries.has(s)) continue;
    if (s >= 0 && (m.seriesPos[i] || 1) > 1) continue;
    if (s >= 0) bySeries.add(s);
    if (!out.includes(i)) out.push(i);
  }
  return out;
}

function dialDistance(m: FeatureMatrix, a: number, b: number): number {
  let sum = 0;
  let n = 0;
  for (let d = 0; d < m.dials.length; d++) {
    const x = dial(m, a, d);
    const y = dial(m, b, d);
    if (x.value === null || y.value === null) continue;
    sum += Math.abs(x.value - y.value);
    n++;
  }
  return n ? sum / n : 5;
}

/**
 * The next classics to show. With fewer than three answers, the best-known unrated ones; after
 * that, the unrated classic farthest from everything rated so far (max-min distance), which is
 * the one whose answer changes the profile most.
 */
export function nextClassics(m: FeatureMatrix, pool: number[], rated: number[], count = 4): number[] {
  const unrated = pool.filter((i) => !rated.includes(i));
  if (rated.length < 3) return unrated.slice(0, count);
  const out: number[] = [];
  const seen = [...rated];
  while (out.length < count && unrated.length) {
    let best = -1;
    let bestScore = -1;
    for (const i of unrated) {
      if (out.includes(i)) continue;
      const nearest = Math.min(...seen.map((r) => dialDistance(m, i, r)));
      // A different author is a more informative question than another book by the same one.
      const sameAuthor = seen.some((r) => authorsOf(m, r).some((a) => authorsOf(m, i).includes(a)));
      const score = nearest - (sameAuthor ? 1 : 0) + (m.quality[i] ?? 0) / 200;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) break;
    out.push(best);
    seen.push(best);
  }
  return out;
}
