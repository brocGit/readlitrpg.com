// Scoring every candidate against a taste profile (DESIGN §7.8 "Scoring every candidate book").
// Pure and deterministic: the same profile and matrix always give the same list, and every
// explanation clause traces back to data.

import { getTag } from "../taxonomy";
import {
  aiUse,
  authorsOf,
  cosineI8,
  dial,
  EMB_DIMS,
  embeddingOf,
  type FeatureMatrix,
  harem,
  hasFlag,
  hasFormat,
  isKu,
  romanceLevel,
  seriesStatus,
  stat,
  tagsOf,
} from "./matrix";
import type { TasteProfile } from "./profile";

export interface MatchWeights {
  dial: number;
  stat: number;
  tag: number;
  semantic: number;
  quality: number;
}

export interface MatchOptions {
  weights: MatchWeights;
  /** Tag scores at or above this count for an exclusion (DESIGN §6.2, default 0.3). */
  excludeMin: number;
  /** Tag scores at or above this count for an include filter (0.5). */
  includeMin: number;
  /** Below this a book isn't called a match (0.60). */
  minDisplayScore: number;
  maxHeadsUps: number;
  /** How hard similarity to a bounced-off book pushes a candidate down. */
  bouncedPenalty: number;
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  weights: { dial: 0.35, stat: 0.2, tag: 0.2, semantic: 0.15, quality: 0.1 },
  excludeMin: 0.3,
  includeMin: 0.5,
  minDisplayScore: 0.6,
  maxHeadsUps: 3,
  bouncedPenalty: 0.3,
};

// ---------------------------------------------------------------------------------------------
// Hard filters

export type FilterReason =
  | "read"
  | "tag"
  | "harem"
  | "romance"
  | "flag"
  | "ai_generated"
  | "unfinished"
  | "format"
  | "gender";

export function hardFilter(
  m: FeatureMatrix,
  i: number,
  p: TasteProfile,
  opts: MatchOptions,
): FilterReason | null {
  if (p.loved.includes(i) || p.bounced.includes(i) || p.read.includes(i)) return "read";
  if (p.skipSeries.length && p.skipSeries.includes(m.seriesIdx[i] ?? -1)) return "read";
  const tags = tagsOf(m, i);
  for (const slug of p.exclude.tags) {
    const t = m.tags.indexOf(slug);
    if (t >= 0 && (tags.get(t) ?? 0) >= opts.excludeMin) return "tag";
  }
  // Exclusions are conservative: a harem the classifier couldn't rule out is excluded too.
  if (p.exclude.harem && harem(m, i) !== "none") return "harem";
  if (p.exclude.romanceMax !== null) {
    const r = romanceLevel(m, i);
    if (r !== null && r > p.exclude.romanceMax) return "romance";
  }
  for (const f of p.exclude.flags) if (hasFlag(m, i, f)) return "flag";
  if (p.exclude.aiGenerated && aiUse(m, i) === "ai_generated") return "ai_generated";
  if (p.exclude.unfinished && m.seriesIdx[i] !== -1) {
    const s = seriesStatus(m, i);
    if (s === "ongoing" || s === "hiatus" || s === "no_recent_releases") return "unfinished";
  }
  if (p.require.formats.length) {
    const ok = p.require.formats.some((f) => (f === "ku" ? isKu(m, i) : hasFormat(m, i, f)));
    if (!ok) return "format";
  }
  if (p.require.gender && p.require.genderOnly) {
    const t = m.tags.indexOf(`${p.require.gender}-mc`);
    if (t < 0 || (tags.get(t) ?? 0) < opts.includeMin) return "gender";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Components

export interface Components {
  dial: number;
  stat: number;
  tag: number;
  semantic: number;
  quality: number;
  penalty: number;
}

/** Two-sided dial similarity, weighted by importance and the book's confidence. */
export function dialSim(m: FeatureMatrix, i: number, p: TasteProfile): number {
  let num = 0;
  let den = 0;
  m.dials.forEach((key, d) => {
    const pref = p.dials[key];
    if (!pref || pref.importance <= 0) return;
    const x = dial(m, i, d);
    if (x.value === null) return;
    const w = pref.importance * x.conf;
    num += w * Math.abs(pref.target - x.value);
    den += w;
  });
  return den === 0 ? 0.5 : 1 - num / (10 * den);
}

/** One-sided: falling short of a must-have hurts; exceeding it never does. */
export function statFit(m: FeatureMatrix, i: number, p: TasteProfile): number {
  let num = 0;
  let den = 0;
  let any = false;
  m.stats.forEach((key, s) => {
    const floor = p.stats[key];
    if (!floor || floor.importance <= 0) return;
    any = true;
    const x = stat(m, i, s);
    if (x.value === null) return;
    const w = floor.importance * x.conf;
    num += w * Math.max(0, floor.floor - x.value);
    den += w;
  });
  if (!any) return 1;
  // Nothing known about the book's must-have stats: neither rewarded nor ruled out.
  return den === 0 ? 0.75 : 1 - num / (10 * den);
}

export function tagAffinity(m: FeatureMatrix, i: number, p: TasteProfile): number {
  const entries = Object.entries(p.tags);
  if (entries.length === 0) return 0.5;
  const tags = tagsOf(m, i);
  let num = 0;
  let den = 0;
  for (const [slug, aff] of entries) {
    const t = m.tags.indexOf(slug);
    const score = t >= 0 ? (tags.get(t) ?? 0) : 0;
    num += aff * score;
    den += Math.abs(aff);
  }
  return den === 0 ? 0.5 : (num / den + 1) / 2;
}

export function semantic(m: FeatureMatrix, i: number, p: TasteProfile): number {
  const e = embeddingOf(m, i);
  if (!p.centroid || !e) return 0.5;
  let dot = 0;
  for (let k = 0; k < EMB_DIMS; k++) dot += (p.centroid[k] ?? 0) * ((e[k] ?? 0) / 127);
  return (dot + 1) / 2;
}

/** Similarity of two books: dials, tags and embeddings (used for "books like X" and bounced penalties). */
export function bookSim(m: FeatureMatrix, a: number, b: number): number {
  let num = 0;
  let den = 0;
  for (let d = 0; d < m.dials.length; d++) {
    const x = dial(m, a, d);
    const y = dial(m, b, d);
    if (x.value === null || y.value === null) continue;
    const w = x.conf * y.conf;
    num += w * Math.abs(x.value - y.value);
    den += w;
  }
  const dialPart = den === 0 ? null : 1 - num / (10 * den);
  const ta = tagsOf(m, a);
  const tb = tagsOf(m, b);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [t, s] of ta) {
    na += s * s;
    dot += s * (tb.get(t) ?? 0);
  }
  for (const s of tb.values()) nb += s * s;
  const tagPart = na && nb ? dot / Math.sqrt(na * nb) : null;
  const ea = embeddingOf(m, a);
  const eb = embeddingOf(m, b);
  const semPart = ea && eb ? (cosineI8(ea, eb) + 1) / 2 : null;
  const parts: [number | null, number][] = [
    [dialPart, 0.5],
    [tagPart, 0.3],
    [semPart, 0.2],
  ];
  let total = 0;
  let weight = 0;
  for (const [v, w] of parts) {
    if (v === null) continue;
    total += v * w;
    weight += w;
  }
  return weight === 0 ? 0 : total / weight;
}

export function components(m: FeatureMatrix, i: number, p: TasteProfile, opts: MatchOptions): Components {
  let penalty = 0;
  for (const b of p.bounced) penalty = Math.max(penalty, bookSim(m, i, b));
  return {
    dial: dialSim(m, i, p),
    stat: statFit(m, i, p),
    tag: tagAffinity(m, i, p),
    semantic: semantic(m, i, p),
    quality: (m.quality[i] ?? 0) / 100,
    penalty: opts.bouncedPenalty * penalty,
  };
}

export function combine(c: Components, w: MatchWeights): number {
  return (
    w.dial * c.dial +
    w.stat * c.stat +
    w.tag * c.tag +
    w.semantic * c.semantic +
    w.quality * c.quality -
    c.penalty
  );
}

/** Match % shown to readers: the score itself, kept to 50–99. Calibrated against feedback later (§7.8). */
export const matchPercent = (score: number) => Math.max(50, Math.min(99, Math.round(score * 100)));

// ---------------------------------------------------------------------------------------------
// Heads-ups: honest DNF warnings, computed from this reader's profile (§7.8)

export type HeadsUp =
  | { key: string; kind: "stat_below"; stat: string }
  | { key: string; kind: "dial_far"; dial: string; direction: "higher" | "lower" }
  | { key: string; kind: "slow_start" }
  | { key: string; kind: "split_tag"; tag: string }
  | { key: string; kind: "stalled" };

export function headsUps(m: FeatureMatrix, i: number, p: TasteProfile, opts: MatchOptions): HeadsUp[] {
  const out: HeadsUp[] = [];
  const relaxed = new Set(p.relaxed);
  const push = (h: HeadsUp) => {
    if (!relaxed.has(h.key) && !out.some((x) => x.key === h.key)) out.push(h);
  };
  m.stats.forEach((key, s) => {
    const floor = p.stats[key];
    if (!floor) return;
    const x = stat(m, i, s);
    // Only stats readers can see (or confident estimates) may warn about a book.
    if (x.value !== null && x.conf >= 0.6 && x.value < floor.floor - 0.5)
      push({ key: `stat:${key}`, kind: "stat_below", stat: key });
  });
  const far = m.dials
    .map((key, d) => ({ key, pref: p.dials[key], x: dial(m, i, d) }))
    .filter(
      (r) =>
        r.pref &&
        r.pref.importance >= 0.6 &&
        r.x.value !== null &&
        Math.abs((r.x.value ?? 0) - (r.pref?.target ?? 0)) >= 4,
    )
    .sort((a, b) => (b.pref?.importance ?? 0) - (a.pref?.importance ?? 0));
  for (const r of far) {
    push({
      key: `dial:${r.key}`,
      kind: "dial_far",
      dial: r.key,
      direction: (r.x.value ?? 0) > (r.pref?.target ?? 0) ? "higher" : "lower",
    });
  }
  const fs = m.stats.indexOf("fast_start");
  const fast = fs >= 0 ? stat(m, i, fs) : null;
  if (fast && fast.value !== null && fast.value <= 3 && fast.conf >= 0.6)
    push({ key: "stat:fast_start", kind: "slow_start" });
  const tags = tagsOf(m, i);
  for (const [slug, aff] of Object.entries(p.tags)) {
    if (aff >= 0) continue;
    const t = m.tags.indexOf(slug);
    const score = t >= 0 ? (tags.get(t) ?? 0) : 0;
    if (score >= 0.2 && score < opts.excludeMin) push({ key: `tag:${slug}`, kind: "split_tag", tag: slug });
  }
  for (const slug of p.exclude.tags) {
    const t = m.tags.indexOf(slug);
    const score = t >= 0 ? (tags.get(t) ?? 0) : 0;
    if (score >= 0.2 && score < opts.excludeMin) push({ key: `tag:${slug}`, kind: "split_tag", tag: slug });
  }
  if (seriesStatus(m, i) === "no_recent_releases") push({ key: "series:stalled", kind: "stalled" });
  return out.slice(0, opts.maxHeadsUps);
}

// ---------------------------------------------------------------------------------------------
// Explanations: structured clauses; wording lives in phrases.ts

export interface Explanation {
  /** Dials this book shares with the reader's targets, strongest first. */
  sameDials: { dial: string; level: "low" | "mid" | "high" }[];
  sharedTags: string[];
  /** The loved book this one is closest to. */
  like: number | null;
  differs: { dial: string; direction: "more" | "less" }[];
  notes: ("no_harem" | "complete_series" | "audio" | "ku")[];
}

const levelOf = (v: number): "low" | "mid" | "high" => (v <= 3 ? "low" : v >= 7 ? "high" : "mid");

export function explain(m: FeatureMatrix, i: number, p: TasteProfile): Explanation {
  const contributions: { dial: string; value: number; weight: number }[] = [];
  const differs: { dial: string; direction: "more" | "less"; gap: number }[] = [];
  m.dials.forEach((key, d) => {
    const pref = p.dials[key];
    const x = dial(m, i, d);
    if (!pref || x.value === null) return;
    const gap = Math.abs(pref.target - x.value);
    if (gap <= 1.5)
      contributions.push({ dial: key, value: x.value, weight: pref.importance * x.conf * (2 - gap) });
    else if (gap >= 3 && pref.importance >= 0.3)
      differs.push({
        dial: key,
        direction: x.value > pref.target ? "more" : "less",
        gap: gap * pref.importance,
      });
  });
  contributions.sort((a, b) => b.weight - a.weight);
  differs.sort((a, b) => b.gap - a.gap);
  const tags = tagsOf(m, i);
  const shared = Object.entries(p.tags)
    .filter(([slug, aff]) => {
      const t = m.tags.indexOf(slug);
      return aff > 0 && t >= 0 && (tags.get(t) ?? 0) >= 0.6 && getTag(slug)?.facet !== "genre";
    })
    .sort((a, b) => b[1] - a[1])
    .map(([slug]) => slug);
  let like: number | null = null;
  let best = 0;
  for (const l of p.loved) {
    const s = bookSim(m, i, l);
    if (s > best) {
      best = s;
      like = l;
    }
  }
  const notes: Explanation["notes"] = [];
  if (harem(m, i) === "none" && (p.exclude.harem || (p.tags.harem ?? 0) < 0)) notes.push("no_harem");
  if (seriesStatus(m, i) === "complete") notes.push("complete_series");
  if (hasFormat(m, i, "audiobook")) notes.push("audio");
  if (isKu(m, i)) notes.push("ku");
  return {
    sameDials: contributions.slice(0, 2).map((c) => ({ dial: c.dial, level: levelOf(c.value) })),
    sharedTags: shared.slice(0, 3),
    like: best >= 0.6 ? like : null,
    differs: differs.slice(0, 2).map(({ dial: d, direction }) => ({ dial: d, direction })),
    notes,
  };
}

// ---------------------------------------------------------------------------------------------
// The full ranking

export interface Scored {
  i: number;
  score: number;
  percent: number;
  isMatch: boolean;
  components: Components;
}

export interface MatchResult {
  bestBets: Scored[];
  more: Scored[];
  wildcard: Scored | null;
  considered: number;
  filtered: Partial<Record<FilterReason, number>>;
}

function seriesKey(m: FeatureMatrix, i: number): string {
  const s = m.seriesIdx[i] ?? -1;
  return s >= 0 ? `s${s}` : `b${i}`;
}

/** Score every book that passes the hard filters. Returns them best first. */
export function scoreAll(
  m: FeatureMatrix,
  p: TasteProfile,
  opts: MatchOptions,
): { scored: Scored[]; filtered: MatchResult["filtered"] } {
  const scored: Scored[] = [];
  const filtered: MatchResult["filtered"] = {};
  for (let i = 0; i < m.n; i++) {
    const reason = hardFilter(m, i, p, opts);
    if (reason) {
      filtered[reason] = (filtered[reason] ?? 0) + 1;
      continue;
    }
    const c = components(m, i, p, opts);
    const score = combine(c, opts.weights);
    scored.push({
      i,
      score,
      percent: matchPercent(score),
      isMatch: score >= opts.minDisplayScore,
      components: c,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return { scored, filtered };
}

/**
 * Diversity re-rank (§7.8 step 3): one book per series and two per author in the list. A series
 * is represented by its earliest volume the reader hasn't read, if that volume passes the filters.
 */
export function diversify(m: FeatureMatrix, scored: Scored[], limit: number): Scored[] {
  const bySeries = new Map<string, Scored[]>();
  for (const s of scored) {
    const key = seriesKey(m, s.i);
    bySeries.set(key, [...(bySeries.get(key) ?? []), s]);
  }
  const representative = (s: Scored): Scored => {
    const vols = bySeries.get(seriesKey(m, s.i)) ?? [s];
    if ((m.seriesIdx[s.i] ?? -1) < 0 || vols.length === 1) return s;
    const earliest = [...vols].sort((a, b) => (m.seriesPos[a.i] || 999) - (m.seriesPos[b.i] || 999))[0] ?? s;
    // The series ranks by its best volume; the reader is pointed at where to start.
    return earliest.i === s.i ? s : { ...earliest, score: s.score, percent: s.percent, isMatch: s.isMatch };
  };
  const out: Scored[] = [];
  const seenSeries = new Set<string>();
  const perAuthor = new Map<number, number>();
  for (const s of scored) {
    if (out.length >= limit) break;
    const key = seriesKey(m, s.i);
    if (seenSeries.has(key)) continue;
    const rep = representative(s);
    const authors = authorsOf(m, rep.i);
    if (authors.some((a) => (perAuthor.get(a) ?? 0) >= 2)) continue;
    seenSeries.add(key);
    for (const a of authors) perAuthor.set(a, (perAuthor.get(a) ?? 0) + 1);
    out.push(rep);
  }
  return out;
}

const PREMISE_FACETS = new Set(["premise", "genre"]);

/** The best book from a premise or subgenre the reader hasn't tried that still meets every floor. */
export function pickWildcard(
  m: FeatureMatrix,
  scored: Scored[],
  p: TasteProfile,
  taken: Set<number>,
): Scored | null {
  const tried = new Set<number>();
  for (const i of p.loved)
    for (const [t, s] of tagsOf(m, i))
      if (s >= 0.5 && PREMISE_FACETS.has(getTag(m.tags[t] ?? "")?.facet ?? "")) tried.add(t);
  for (const [slug, aff] of Object.entries(p.tags)) {
    const t = m.tags.indexOf(slug);
    if (aff > 0 && t >= 0 && PREMISE_FACETS.has(getTag(slug)?.facet ?? "")) tried.add(t);
  }
  const takenSeries = new Set([...taken].map((i) => seriesKey(m, i)));
  for (const s of scored) {
    if (taken.has(s.i) || takenSeries.has(seriesKey(m, s.i)) || !s.isMatch) continue;
    const premises = [...tagsOf(m, s.i)].filter(
      ([t, score]) => score >= 0.5 && PREMISE_FACETS.has(getTag(m.tags[t] ?? "")?.facet ?? ""),
    );
    if (premises.length === 0 || premises.some(([t]) => tried.has(t))) continue;
    const meetsFloors = Object.entries(p.stats).every(([key, floor]) => {
      const k = m.stats.indexOf(key);
      const x = k >= 0 ? stat(m, s.i, k) : null;
      return x !== null && x.value !== null && x.value >= floor.floor;
    });
    if (meetsFloors) return s;
  }
  return null;
}

export function match(
  m: FeatureMatrix,
  p: TasteProfile,
  opts: MatchOptions = DEFAULT_MATCH_OPTIONS,
): MatchResult {
  const { scored, filtered } = scoreAll(m, p, opts);
  const top = diversify(m, scored, 10);
  const wildcard = pickWildcard(m, scored, p, new Set(top.map((s) => s.i)));
  return { bestBets: top.slice(0, 3), more: top.slice(3), wildcard, considered: scored.length, filtered };
}
