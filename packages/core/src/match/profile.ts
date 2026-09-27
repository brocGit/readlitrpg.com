// Taste profiles (DESIGN §7.8 "Building a taste profile"). Every front door (books you loved, the
// Match Quiz, a fun quiz, slider tweaks) becomes the same shape: dial targets with importance,
// one-sided stat floors, tag affinities, a semantic centroid, and hard filters.

import { z } from "zod";
import { TAGS } from "../taxonomy";
import { dial, EMB_DIMS, embeddingOf, type FeatureMatrix, indexOfBook, stat, tagsOf } from "./matrix";

export interface DialPref {
  target: number;
  /** 0–1: how much this dial should move the ranking. */
  importance: number;
}

export interface StatFloor {
  floor: number;
  importance: number;
}

export interface TasteProfile {
  dials: Record<string, DialPref>;
  stats: Record<string, StatFloor>;
  /** Tag slug → affinity, roughly −3..3. Negative pushes away. */
  tags: Record<string, number>;
  /** Mean reduced embedding of loved books (unit length), or null. */
  centroid: Float32Array | null;
  exclude: {
    tags: string[];
    harem: boolean;
    romanceMax: number | null;
    flags: string[];
    aiGenerated: boolean;
    unfinished: boolean;
  };
  require: {
    formats: ("ebook" | "audiobook" | "print" | "ku")[];
    gender: "female" | "male" | null;
    genderOnly: boolean;
  };
  /** Book indexes in the matrix. */
  loved: number[];
  bounced: number[];
  read: number[];
  /** Series the reader already knows (loved or bounced off): not recommended again. */
  skipSeries: number[];
  /** Heads-up keys the reader said don't bother them. */
  relaxed: string[];
}

// ---------------------------------------------------------------------------------------------
// Inputs: what a reader tells us. The same object is sent to /api/match and encoded in share links.

export const DISLIKE_REASONS = [
  "too_slow",
  "too_crunchy",
  "annoying_mc",
  "too_dark",
  "too_silly",
  "harem_romance",
  "wordy",
] as const;
export type DislikeReason = (typeof DISLIKE_REASONS)[number];

export const HARD_NOS = [
  "harem",
  "heavy_romance",
  "explicit",
  "grimdark",
  "gore",
  "sexual_violence",
  "horror",
  "villain_mc",
  "ai_generated",
  "unfinished",
] as const;
export type HardNo = (typeof HARD_NOS)[number];

export const MC_TYPES = [
  "underdog",
  "planner",
  "op",
  "villain",
  "monster",
  "crafter",
  "gamer",
  "older",
] as const;
export type McType = (typeof MC_TYPES)[number];

/** The stats a reader may pick as must-haves (Match Quiz step 9). */
export const MUST_HAVE_STATS = [
  "competent_mc",
  "rule_of_cool",
  "number_go_up",
  "earned_power",
  "low_drama",
  "party_chemistry",
  "fast_start",
  "satisfying_endings",
  "hype",
] as const;

/** Subgenre chips (Match Quiz step 4): each is a tag or genre slug. */
export const SUBGENRE_CHIPS = [
  "system-apocalypse",
  "dungeon-core",
  "dungeon-crawler",
  "cultivation",
  "isekai",
  "vrmmo",
  "tower-climbing",
  "academy",
  "time-loop",
  "regression",
  "kingdom-building",
  "crafting",
  "monster-mc",
  "superhero-progression",
  "gates-and-hunters",
  "space",
] as const;

const bookRef = z.string().min(1).max(120);
const level = z.number().min(0).max(10);

export const matchInputsSchema = z
  .object({
    loved: z.array(bookRef).max(5).optional(),
    bounced: z
      .array(z.object({ book: bookRef, reasons: z.array(z.enum(DISLIKE_REASONS)).max(4).optional() }))
      .max(5)
      .optional(),
    /** Match Quiz step 1: classics rated loved / liked / disliked. */
    rated: z
      .array(
        z.object({
          book: bookRef,
          rating: z.enum(["loved", "liked", "disliked"]),
          reasons: z.array(z.enum(DISLIKE_REASONS)).max(4).optional(),
        }),
      )
      .max(20)
      .optional(),
    read: z.array(bookRef).max(50).optional(),
    noes: z.array(z.enum(HARD_NOS)).max(HARD_NOS.length).optional(),
    tone: level.optional(),
    humor: level.optional(),
    satire: z.number().int().min(-1).max(1).optional(),
    subgenres: z.array(z.enum(SUBGENRE_CHIPS)).max(SUBGENRE_CHIPS.length).optional(),
    pacing: level.optional(),
    progression: level.optional(),
    mc: z.array(z.enum(MC_TYPES)).max(MC_TYPES.length).optional(),
    crunch: z.number().int().min(0).max(3).optional(),
    hardRules: z.boolean().optional(),
    gender: z.enum(["female", "male"]).optional(),
    genderOnly: z.boolean().optional(),
    musts: z.array(z.enum(MUST_HAVE_STATS)).max(3).optional(),
    formats: z
      .array(z.enum(["ebook", "audiobook", "print", "ku"]))
      .max(4)
      .optional(),
    /** Results-page sliders: dial key → target. They override every other source. */
    tune: z.record(z.string().max(30), level).optional(),
    /** Heads-ups the reader dismissed ("Doesn't bother me"). */
    relax: z.array(z.string().max(60)).max(20).optional(),
    /** A fun quiz taken on the way in. */
    quiz: z.object({ slug: z.string().max(80), answers: z.array(z.string().max(8)).max(30) }).optional(),
  })
  .strict();
export type MatchInputs = z.infer<typeof matchInputsSchema>;

/** Signal from a fun quiz, computed by the quiz engine (QUIZZES.md §2.3). */
export interface FunQuizSignal {
  dials: Record<string, DialPref>;
  stats: Record<string, StatFloor>;
  tags: Record<string, number>;
}

// Share links carry the inputs, never the person (DESIGN §9.1).
export function encodeInputs(inputs: MatchInputs): string {
  const bytes = new TextEncoder().encode(JSON.stringify(inputs));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeInputs(param: string): MatchInputs | null {
  if (!param || param.length > 4000 || !/^[A-Za-z0-9_-]+$/.test(param)) return null;
  try {
    const padded = param.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((param.length + 3) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const parsed = matchInputsSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Building the profile

/** How much each source counts when several set the same dial (the tune sliders win outright). */
const SOURCE_WEIGHT = { tune: 100, quiz: 2, books: 1.5, dislike: 1.2, fun: 0.5 } as const;
type Source = keyof typeof SOURCE_WEIGHT;

interface Contribution {
  target: number;
  importance: number;
  source: Source;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const tagFacet = new Map(TAGS.map((t) => [t.slug, t.facet]));

class Builder {
  private dialParts = new Map<string, Contribution[]>();
  private statParts = new Map<string, Contribution[]>();
  readonly tags = new Map<string, number>();

  dial(key: string, target: number, importance: number, source: Source) {
    const list = this.dialParts.get(key) ?? [];
    list.push({ target: clamp(target, 0, 10), importance: clamp(importance, 0, 1), source });
    this.dialParts.set(key, list);
  }

  floor(key: string, floor: number, importance: number, source: Source) {
    const list = this.statParts.get(key) ?? [];
    list.push({ target: clamp(floor, 0, 10), importance: clamp(importance, 0, 1), source });
    this.statParts.set(key, list);
  }

  tag(slug: string, affinity: number) {
    this.tags.set(slug, clamp((this.tags.get(slug) ?? 0) + affinity, -3, 3));
  }

  private static merge(parts: Contribution[]): DialPref {
    let wSum = 0;
    let tSum = 0;
    let importance = 0;
    for (const p of parts) {
      const w = SOURCE_WEIGHT[p.source] * Math.max(p.importance, 0.05);
      wSum += w;
      tSum += w * p.target;
      importance = Math.max(importance, p.importance);
    }
    return { target: Math.round((tSum / wSum) * 10) / 10, importance: Math.round(importance * 100) / 100 };
  }

  dials(): Record<string, DialPref> {
    return Object.fromEntries([...this.dialParts].map(([k, parts]) => [k, Builder.merge(parts)]));
  }

  stats(): Record<string, StatFloor> {
    return Object.fromEntries(
      [...this.statParts].map(([k, parts]) => {
        const m = Builder.merge(parts);
        // A must-have is a floor: the strongest source sets it.
        const floor = Math.max(...parts.map((p) => p.target));
        return [k, { floor, importance: m.importance }];
      }),
    );
  }
}

/** Where each stop of the crunch gauge lands on the crunch dial (Match Quiz step 7). */
const CRUNCH_STOPS = [1, 3, 6, 9];

function applyReasons(
  b: Builder,
  m: FeatureMatrix,
  i: number | undefined,
  reasons: DislikeReason[],
  p: TasteProfile,
) {
  const dv = (key: string) => {
    const d = m.dials.indexOf(key);
    return i === undefined || d < 0 ? null : dial(m, i, d).value;
  };
  for (const r of reasons) {
    switch (r) {
      case "too_slow":
        b.dial("pacing", Math.max(6, (dv("pacing") ?? 4) + 2), 0.6, "dislike");
        break;
      case "too_crunchy":
        b.dial("crunch", Math.min(4, Math.max(0, (dv("crunch") ?? 7) - 3)), 0.6, "dislike");
        break;
      case "annoying_mc":
        b.floor("competent_mc", 7, 0.5, "dislike");
        b.floor("rootable_mc", 7, 0.5, "dislike");
        break;
      case "too_dark":
        b.dial("tone", Math.min(10, Math.max(5, (dv("tone") ?? 3) + 3)), 0.6, "dislike");
        break;
      case "too_silly":
        b.dial("humor", Math.max(0, Math.min(5, (dv("humor") ?? 8) - 3)), 0.6, "dislike");
        break;
      case "harem_romance":
        p.exclude.harem = true;
        p.exclude.romanceMax = Math.min(p.exclude.romanceMax ?? 4, 2);
        break;
      case "wordy":
        b.dial("prose", Math.max(0, Math.min(5, (dv("prose") ?? 7) - 3)), 0.6, "dislike");
        break;
    }
  }
}

/** Loved books → dial targets weighted by confidence, importance from agreement (§7.8). */
function fromBooks(b: Builder, m: FeatureMatrix, loved: { i: number; w: number }[], bounced: number[]) {
  const total = loved.reduce((a, x) => a + x.w, 0);
  if (total > 0) {
    // Fewer books mean less certainty about what the reader cares about.
    const coverage = Math.min(1, total / 2);
    m.dials.forEach((key, d) => {
      let wSum = 0;
      let vSum = 0;
      const seen: { v: number; w: number }[] = [];
      for (const { i, w } of loved) {
        const x = dial(m, i, d);
        if (x.value === null) continue;
        const weight = w * x.conf;
        wSum += weight;
        vSum += weight * x.value;
        seen.push({ v: x.value, w: weight });
      }
      if (wSum === 0) return;
      const mean = vSum / wSum;
      const variance = seen.reduce((a, s) => a + s.w * (s.v - mean) ** 2, 0) / wSum;
      // Books that agree on a dial reveal a preference; books that disagree reveal indifference.
      b.dial(key, mean, coverage / (1 + variance), "books");
    });
    m.stats.forEach((key, s) => {
      let wSum = 0;
      let vSum = 0;
      const seen: { v: number; w: number }[] = [];
      for (const { i, w } of loved) {
        const x = stat(m, i, s);
        if (x.value === null) continue;
        wSum += w * x.conf;
        vSum += w * x.conf * x.value;
        seen.push({ v: x.value, w: w * x.conf });
      }
      if (wSum === 0) return;
      const mean = vSum / wSum;
      if (mean < 6) return; // A floor is about a payoff the reader clearly enjoys.
      const variance = seen.reduce((a, x) => a + x.w * (x.v - mean) ** 2, 0) / wSum;
      b.floor(key, mean - 1, (0.8 * coverage) / (1 + variance), "books");
    });
    // Tag affinity: common in the loved books, rare in the catalog (TF-IDF style).
    const df = new Map<number, number>();
    for (let i = 0; i < m.n; i++)
      for (const [t, score] of tagsOf(m, i)) if (score >= 0.5) df.set(t, (df.get(t) ?? 0) + 1);
    const lovedTags = new Map<number, number>();
    for (const { i, w } of loved)
      for (const [t, score] of tagsOf(m, i))
        if (score >= 0.5) lovedTags.set(t, (lovedTags.get(t) ?? 0) + w * score);
    let max = 0;
    const raw = new Map<number, number>();
    for (const [t, tf] of lovedTags) {
      const idf = Math.log((m.n + 1) / (1 + (df.get(t) ?? 0))) + 0.1;
      const v = (tf / total) * idf;
      raw.set(t, v);
      max = Math.max(max, v);
    }
    for (const [t, v] of raw) {
      const slug = m.tags[t];
      // Genre tags are broad; they matter, but shouldn't drown out the specific premise tags.
      if (slug) b.tag(slug, ((3 * v) / (max || 1)) * (tagFacet.get(slug) === "genre" ? 0.5 : 1));
    }
    for (const i of bounced) {
      for (const [t, score] of tagsOf(m, i)) {
        const slug = m.tags[t];
        if (slug && score >= 0.6 && !lovedTags.has(t)) b.tag(slug, -0.5 * score);
      }
    }
  }
}

function centroidOf(m: FeatureMatrix, loved: { i: number; w: number }[]): Float32Array | null {
  const c = new Float32Array(EMB_DIMS);
  let any = false;
  for (const { i, w } of loved) {
    const e = embeddingOf(m, i);
    if (!e) continue;
    any = true;
    for (let k = 0; k < EMB_DIMS; k++) c[k] = (c[k] ?? 0) + w * ((e[k] ?? 0) / 127);
  }
  if (!any) return null;
  let norm = 0;
  for (const x of c) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let k = 0; k < EMB_DIMS; k++) c[k] = (c[k] ?? 0) / norm;
  return c;
}

export function emptyProfile(): TasteProfile {
  return {
    dials: {},
    stats: {},
    tags: {},
    centroid: null,
    exclude: { tags: [], harem: false, romanceMax: null, flags: [], aiGenerated: false, unfinished: false },
    require: { formats: [], gender: null, genderOnly: false },
    loved: [],
    bounced: [],
    read: [],
    skipSeries: [],
    relaxed: [],
  };
}

export function buildProfile(
  m: FeatureMatrix,
  inputs: MatchInputs,
  fun?: FunQuizSignal | null,
): TasteProfile {
  const p = emptyProfile();
  const b = new Builder();
  const index = indexOfBook(m);
  const find = (ref: string) => index.get(ref);

  // Books: loved counts fully, liked half; disliked and bounced books push away.
  const loved: { i: number; w: number }[] = [];
  const bouncedSet = new Set<number>();
  const reasonsFor: { i: number | undefined; reasons: DislikeReason[] }[] = [];
  for (const ref of inputs.loved ?? []) {
    const i = find(ref);
    if (i !== undefined) loved.push({ i, w: 1 });
  }
  for (const r of inputs.rated ?? []) {
    const i = find(r.book);
    if (r.rating === "disliked") {
      if (i !== undefined) bouncedSet.add(i);
      if (r.reasons?.length) reasonsFor.push({ i, reasons: r.reasons });
    } else if (i !== undefined) loved.push({ i, w: r.rating === "loved" ? 1 : 0.5 });
  }
  for (const x of inputs.bounced ?? []) {
    const i = find(x.book);
    if (i !== undefined) bouncedSet.add(i);
    if (x.reasons?.length) reasonsFor.push({ i, reasons: x.reasons });
  }
  const bounced = [...bouncedSet];
  fromBooks(b, m, loved, bounced);
  p.centroid = centroidOf(m, loved);
  for (const r of reasonsFor) applyReasons(b, m, r.i, r.reasons, p);
  p.loved = [...new Set(loved.map((x) => x.i))];
  p.bounced = bounced;
  p.read = (inputs.read ?? []).map(find).filter((i): i is number => i !== undefined);
  p.skipSeries = [
    ...new Set([...p.loved, ...p.bounced].map((i) => m.seriesIdx[i] ?? -1).filter((s) => s >= 0)),
  ];

  // Match Quiz answers set targets directly, with high importance.
  for (const no of inputs.noes ?? []) {
    switch (no) {
      case "harem":
        p.exclude.harem = true;
        break;
      case "heavy_romance":
        p.exclude.romanceMax = Math.min(p.exclude.romanceMax ?? 4, 2);
        break;
      case "explicit":
        p.exclude.flags.push("explicit-sex");
        break;
      case "gore":
        p.exclude.flags.push("gore");
        break;
      case "sexual_violence":
        p.exclude.flags.push("sexual-violence");
        break;
      case "grimdark":
        p.exclude.tags.push("grimdark");
        break;
      case "horror":
        p.exclude.tags.push("horror");
        break;
      case "villain_mc":
        p.exclude.tags.push("villain-mc");
        break;
      case "ai_generated":
        p.exclude.aiGenerated = true;
        break;
      case "unfinished":
        p.exclude.unfinished = true;
        break;
    }
  }
  if (inputs.tone !== undefined) b.dial("tone", inputs.tone, 0.9, "quiz");
  if (inputs.humor !== undefined) b.dial("humor", inputs.humor, 0.8, "quiz");
  if (inputs.satire) b.tag("satire", inputs.satire * 2);
  for (const chip of inputs.subgenres ?? []) b.tag(chip, 3);
  if (inputs.pacing !== undefined) b.dial("pacing", inputs.pacing, 0.8, "quiz");
  if (inputs.progression !== undefined) b.dial("progression_speed", inputs.progression, 0.8, "quiz");
  for (const mc of inputs.mc ?? []) {
    switch (mc) {
      case "underdog":
        b.dial("power_fantasy", 2, 0.7, "quiz");
        b.tag("weak-to-strong", 2);
        break;
      case "planner":
        b.dial("strategy", 8, 0.7, "quiz");
        b.tag("clever-mc", 2);
        break;
      case "op":
        b.dial("power_fantasy", 9, 0.7, "quiz");
        b.tag("op-mc", 2);
        break;
      case "villain":
        b.dial("morality", 8, 0.7, "quiz");
        b.tag("villain-mc", 2);
        break;
      case "monster":
        b.tag("monster-mc", 2);
        b.tag("nonhuman-mc", 1);
        break;
      case "crafter":
        b.dial("combat", 3, 0.6, "quiz");
        b.tag("crafting", 2);
        b.tag("support-class-mc", 1);
        break;
      case "gamer":
        b.tag("gamer-mc", 2);
        b.tag("vrmmo", 1);
        break;
      case "older":
        b.tag("older-mc", 2);
        break;
    }
  }
  if (inputs.crunch !== undefined) b.dial("crunch", CRUNCH_STOPS[inputs.crunch] ?? 5, 0.9, "quiz");
  if (inputs.hardRules) b.dial("rigour", 8, 0.7, "quiz");
  if (inputs.gender) {
    p.require.gender = inputs.gender;
    p.require.genderOnly = inputs.genderOnly ?? false;
    b.tag(`${inputs.gender}-mc`, 2);
  }
  for (const s of inputs.musts ?? []) b.floor(s, 7, 1, "quiz");
  p.require.formats = inputs.formats ?? [];

  // Fun-quiz signal counts at low importance: people answer in character (§9.3).
  if (fun) {
    for (const [k, v] of Object.entries(fun.dials)) b.dial(k, v.target, v.importance, "fun");
    for (const [k, v] of Object.entries(fun.stats)) b.floor(k, v.floor, v.importance, "fun");
    for (const [k, v] of Object.entries(fun.tags)) b.tag(k, v * 0.5);
  }

  // Sliders on the results page override everything.
  for (const [k, v] of Object.entries(inputs.tune ?? {})) if (m.dials.includes(k)) b.dial(k, v, 1, "tune");

  p.dials = b.dials();
  p.stats = b.stats();
  p.tags = Object.fromEntries([...b.tags].filter(([, v]) => Math.abs(v) >= 0.1));
  p.relaxed = inputs.relax ?? [];
  applyRelaxed(p);
  p.exclude.flags = [...new Set(p.exclude.flags)];
  p.exclude.tags = [...new Set(p.exclude.tags)];
  return p;
}

/** "Doesn't bother me" on a heads-up relaxes that part of the profile (§7.8). */
export function applyRelaxed(p: TasteProfile) {
  for (const key of p.relaxed) {
    const [kind, name = ""] = key.split(":");
    if (kind === "stat") delete p.stats[name];
    else if (kind === "dial" && p.dials[name])
      p.dials[name] = { ...p.dials[name], importance: p.dials[name].importance * 0.3 };
    else if (kind === "tag" && (p.tags[name] ?? 0) < 0) delete p.tags[name];
  }
}

/** How complete a profile is, for the "match confidence" meter (QUIZZES §4.2). */
export function profileStrength(p: TasteProfile): number {
  const dials = Object.values(p.dials).filter((d) => d.importance >= 0.3).length;
  const signal =
    p.loved.length * 0.15 +
    dials * 0.04 +
    Object.keys(p.stats).length * 0.05 +
    Object.keys(p.tags).length * 0.02;
  return Math.min(1, Math.round(signal * 100) / 100);
}
