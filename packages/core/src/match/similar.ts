// "Books like X" (DESIGN §7.8 precomputed outputs, §9.2): each book's closest neighbors by dials,
// tags and embedding. Other volumes of the same series are left out (they're obviously alike), and
// no author appears more than twice.

import { getTag } from "../taxonomy";
import { authorsOf, dial, type FeatureMatrix, tagsOf } from "./matrix";
import { bookSim } from "./score";

export interface SimilarBook {
  i: number;
  score: number;
  /** Dials within a point of each other, and tags both books carry strongly. */
  dials: string[];
  tags: string[];
}

export function similarTo(m: FeatureMatrix, i: number, limit = 30): SimilarBook[] {
  const series = m.seriesIdx[i] ?? -1;
  const candidates: { j: number; score: number }[] = [];
  for (let j = 0; j < m.n; j++) {
    if (j === i || (series >= 0 && m.seriesIdx[j] === series)) continue;
    const score = bookSim(m, i, j);
    if (score > 0) candidates.push({ j, score });
  }
  candidates.sort((a, b) => b.score - a.score || a.j - b.j);
  const out: SimilarBook[] = [];
  const perAuthor = new Map<number, number>();
  const seenSeries = new Set<number>();
  const mine = tagsOf(m, i);
  for (const c of candidates) {
    if (out.length >= limit) break;
    const s = m.seriesIdx[c.j] ?? -1;
    if (s >= 0 && seenSeries.has(s)) continue;
    const authors = authorsOf(m, c.j);
    if (authors.some((a) => (perAuthor.get(a) ?? 0) >= 2)) continue;
    if (s >= 0) seenSeries.add(s);
    for (const a of authors) perAuthor.set(a, (perAuthor.get(a) ?? 0) + 1);
    const theirs = tagsOf(m, c.j);
    const tags = [...mine]
      .filter(
        ([t, score]) =>
          score >= 0.6 && (theirs.get(t) ?? 0) >= 0.6 && getTag(m.tags[t] ?? "")?.facet !== "genre",
      )
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => m.tags[t] ?? "")
      .slice(0, 4);
    const dials = m.dials
      .map((key, d) => ({ key, x: dial(m, i, d), y: dial(m, c.j, d) }))
      .filter(
        (r) =>
          r.x.value !== null &&
          r.y.value !== null &&
          Math.abs((r.x.value ?? 0) - (r.y.value ?? 0)) <= 1 &&
          r.x.conf >= 0.6,
      )
      .map((r) => r.key)
      .slice(0, 4);
    out.push({ i: c.j, score: Math.round(c.score * 1000) / 1000, dials, tags });
  }
  return out;
}
