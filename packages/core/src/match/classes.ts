// Reader classes (DESIGN §7.8, QUIZZES §2.2): any taste profile maps deterministically to the
// nearest of the 12 archetypes, for the shareable class card.

import { READER_CLASSES, type ReaderClass } from "../quiz";
import type { TasteProfile } from "./profile";

export function classAffinity(p: TasteProfile, c: ReaderClass): number {
  const seed = c.profile_seed ?? {};
  // Dials: how close the reader's targets are to the class's, weighted by the class's importance.
  let dialNum = 0;
  let dialDen = 0;
  for (const [k, s] of Object.entries(seed.dials ?? {})) {
    const mine = p.dials[k];
    const target = mine?.target ?? 5;
    // A dial the reader hasn't expressed says little either way.
    const weight = s.importance * (mine ? 0.4 + 0.6 * mine.importance : 0.2);
    dialNum += weight * (1 - Math.abs(target - s.target) / 10);
    dialDen += weight;
  }
  const dialPart = dialDen ? dialNum / dialDen : 0.5;
  // Tags: overlap between the class's signature tags and the reader's affinities.
  let tagNum = 0;
  let tagDen = 0;
  for (const [slug, aff] of Object.entries(seed.tags ?? {})) {
    tagNum += (aff * Math.max(0, Math.min(3, p.tags[slug] ?? 0))) / 3;
    tagDen += aff;
  }
  const tagPart = tagDen ? tagNum / tagDen : 0;
  // Stats: the class's must-haves the reader also asked for.
  const seedStats = Object.keys(seed.stats ?? {});
  const statPart = seedStats.length ? seedStats.filter((s) => p.stats[s]).length / seedStats.length : 0;
  return 0.5 * dialPart + 0.35 * tagPart + 0.15 * statPart;
}

export function readerClass(p: TasteProfile): { cls: ReaderClass; affinity: number } {
  let best = READER_CLASSES[0] as ReaderClass;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const c of READER_CLASSES) {
    const score = classAffinity(p, c);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return { cls: best, affinity: Math.round(bestScore * 100) / 100 };
}
