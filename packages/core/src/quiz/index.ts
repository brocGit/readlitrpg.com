// The quiz engine (DESIGN §9.3, QUIZZES.md §2). Content lives in data/quizzes/ and is compiled
// into quizzes.gen.ts; scoring here mirrors scripts/quiz-tool.mjs so the checker's balance numbers
// hold on the site. Which quizzes are live is the owner's call (the quiz_status table).

import type { DialPref, FunQuizSignal, StatFloor } from "../match/profile";
import { QUIZ_DATA, QUIZ_HASH } from "./quizzes.gen";

export { QUIZ_HASH };

export interface Effects {
  dials?: Record<string, number>;
  stats?: Record<string, number>;
  tags?: Record<string, number>;
}

export interface QuizOption {
  id: string;
  label: string;
  points?: Record<string, number>;
  effects?: Effects;
  correct?: boolean;
}

export interface QuizQuestion {
  id: string;
  flavor?: string;
  prompt: string;
  options: QuizOption[];
  explain?: string;
}

export interface ProfileSeed {
  dials?: Record<string, { target: number; importance: number }>;
  stats?: Record<string, number>;
  tags?: Record<string, number>;
}

export interface Outcome {
  key: string;
  name: string;
  tagline: string;
  description: string;
  share_text: string;
  loves?: string[];
  watch_out?: string;
  min_score?: number;
  profile_seed?: ProfileSeed;
}

export interface Quiz {
  slug: string;
  kind: "fun" | "trivia";
  status: string;
  title: string;
  dek: string;
  estimated_seconds?: number;
  is_official?: boolean;
  spoiler_boundary?: string;
  series?: string;
  disclaimer?: string;
  questions: QuizQuestion[];
  outcomes: Outcome[];
}

export type ReaderClass = Outcome & { calibration_books?: string[] };

export const READER_CLASSES: readonly ReaderClass[] = QUIZ_DATA.classes as unknown as ReaderClass[];

export const QUIZZES: readonly Quiz[] = (
  QUIZ_DATA.quizzes as unknown as (Omit<Quiz, "outcomes"> & {
    outcomes?: Outcome[];
    outcomes_from?: string;
  })[]
).map((q) => ({
  ...q,
  outcomes: q.outcomes_from === "reader-classes" ? [...READER_CLASSES] : (q.outcomes ?? []),
}));

export function getQuiz(slug: string): Quiz | undefined {
  return QUIZZES.find((q) => q.slug === slug);
}

export function getOutcome(quiz: Quiz, key: string): Outcome | undefined {
  return quiz.outcomes.find((o) => o.key === key);
}

export class QuizAnswerError extends Error {}

/** Answers are option ids in question order. Unknown ids are refused; a quiz must be answered in full. */
export function chosenOptions(quiz: Quiz, answers: string[]): QuizOption[] {
  if (answers.length !== quiz.questions.length) throw new QuizAnswerError("answer every question");
  return quiz.questions.map((q, i) => {
    const opt = q.options.find((o) => o.id === answers[i]);
    if (!opt) throw new QuizAnswerError(`question ${q.id}: no option "${answers[i]}"`);
    return opt;
  });
}

function topOutcome(opt: QuizOption): string | null {
  let best: string | null = null;
  for (const [k, v] of Object.entries(opt.points ?? {}))
    if (best === null || v > (opt.points?.[best] ?? 0)) best = k;
  return best;
}

/**
 * The result with the most points wins. Ties break on how many chosen answers had it as their
 * primary, then on the latest question pointing at a tied result, then list order (QUIZZES §2.1).
 */
export function scoreFun(quiz: Quiz, chosen: QuizOption[]): string {
  const totals = new Map(quiz.outcomes.map((o) => [o.key, { points: 0, primaries: 0 }]));
  for (const opt of chosen) {
    for (const [k, v] of Object.entries(opt.points ?? {})) {
      const t = totals.get(k);
      if (t) t.points += v;
    }
    const primary = topOutcome(opt);
    const t = primary ? totals.get(primary) : undefined;
    if (t) t.primaries += 1;
  }
  let tied = [...totals.keys()];
  const best = (field: "points" | "primaries") => Math.max(...tied.map((k) => totals.get(k)?.[field] ?? 0));
  const topPoints = best("points");
  tied = tied.filter((k) => totals.get(k)?.points === topPoints);
  const topPrimaries = best("primaries");
  tied = tied.filter((k) => totals.get(k)?.primaries === topPrimaries);
  if (tied.length > 1) {
    for (let i = chosen.length - 1; i >= 0; i--) {
      const p = topOutcome(chosen[i] as QuizOption);
      if (p && tied.includes(p)) return p;
    }
  }
  return tied[0] ?? quiz.outcomes[0]?.key ?? "";
}

export function scoreTrivia(quiz: Quiz, chosen: QuizOption[]): { score: number; tier: string } {
  const score = chosen.filter((o) => o.correct === true).length;
  const tier = [...quiz.outcomes].reverse().find((o) => score >= (o.min_score ?? 0)) ?? quiz.outcomes[0];
  return { score, tier: tier?.key ?? "" };
}

export interface TakeResult {
  outcome: Outcome;
  score?: number;
  total?: number;
  signal: FunQuizSignal;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Taste signal from a quiz (QUIZZES §2.3): answer effects plus the result's starting profile,
 * at low importance (people answer in character).
 */
export function funSignal(
  chosen: QuizOption[],
  seed: ProfileSeed | undefined,
  importanceScale = 0.3,
): FunQuizSignal {
  const dialSums = new Map<string, number>();
  const statSums = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const opt of chosen) {
    for (const [k, v] of Object.entries(opt.effects?.dials ?? {}))
      dialSums.set(k, (dialSums.get(k) ?? 0) + v);
    for (const [k, v] of Object.entries(opt.effects?.stats ?? {}))
      statSums.set(k, (statSums.get(k) ?? 0) + v);
    for (const [k, v] of Object.entries(opt.effects?.tags ?? {})) tags.set(k, (tags.get(k) ?? 0) + v);
  }
  const dials: Record<string, DialPref> = {};
  for (const [k, s] of dialSums) {
    if (s === 0) continue;
    dials[k] = {
      target: clamp(5 + 1.25 * s, 0, 10),
      importance: Math.min(1, Math.abs(s) / 4) * importanceScale,
    };
  }
  const stats: Record<string, StatFloor> = {};
  for (const [k, s] of statSums) {
    if (s <= 0) continue;
    stats[k] = { floor: Math.min(8, 5 + 1.5 * s), importance: Math.min(1, s / 3) * importanceScale };
  }
  for (const [k, seedDial] of Object.entries(seed?.dials ?? {})) {
    const mine = dials[k];
    dials[k] = mine
      ? {
          target: (mine.target + seedDial.target) / 2,
          importance: Math.max(mine.importance, 0.3 * seedDial.importance),
        }
      : { target: seedDial.target, importance: 0.3 * seedDial.importance };
  }
  for (const [k, floor] of Object.entries(seed?.stats ?? {})) {
    const mine = stats[k];
    stats[k] = mine
      ? { floor: (mine.floor + floor) / 2, importance: Math.max(mine.importance, 0.3 * 0.5) }
      : { floor, importance: 0.3 * 0.5 };
  }
  for (const [k, v] of Object.entries(seed?.tags ?? {})) tags.set(k, (tags.get(k) ?? 0) + v);
  return { dials, stats, tags: Object.fromEntries(tags) };
}

export function takeQuiz(quiz: Quiz, answers: string[], importanceScale = 0.3): TakeResult {
  const chosen = chosenOptions(quiz, answers);
  if (quiz.kind === "trivia") {
    const { score, tier } = scoreTrivia(quiz, chosen);
    const outcome = getOutcome(quiz, tier) ?? (quiz.outcomes[0] as Outcome);
    return {
      outcome,
      score,
      total: quiz.questions.length,
      signal: funSignal(chosen, outcome.profile_seed, importanceScale),
    };
  }
  const key = scoreFun(quiz, chosen);
  const outcome = getOutcome(quiz, key) ?? (quiz.outcomes[0] as Outcome);
  return { outcome, signal: funSignal(chosen, outcome.profile_seed, importanceScale) };
}

/** A result page's starting signal when there are no answers (someone arriving from a share). */
export function outcomeSignal(outcome: Outcome, importanceScale = 0.3): FunQuizSignal {
  return funSignal([], outcome.profile_seed, importanceScale);
}

/** Party up (QUIZZES §3.1): two results side by side and what the pair is like. Only results are compared. */
export function partyComposition(a: Outcome, b: Outcome): string {
  if (a.key === b.key)
    return `Two ${a.name.replace(/^The /, "")}s: double the strengths, and no one covering the weak spots.`;
  const role = (o: Outcome) => o.loves?.[0]?.toLowerCase() ?? o.tagline.toLowerCase();
  return `${a.name} + ${b.name}: one brings ${role(a)}, the other ${role(b)}.`;
}

/** Merge two quiz signals for a party reading list: books both profiles score highly. */
export function partySignal(a: FunQuizSignal, b: FunQuizSignal): FunQuizSignal {
  const dials: Record<string, DialPref> = {};
  for (const k of new Set([...Object.keys(a.dials), ...Object.keys(b.dials)])) {
    const x = a.dials[k];
    const y = b.dials[k];
    dials[k] =
      x && y
        ? { target: (x.target + y.target) / 2, importance: Math.min(x.importance, y.importance) }
        : ((x ?? y) as DialPref);
  }
  const stats: Record<string, StatFloor> = { ...a.stats };
  for (const [k, v] of Object.entries(b.stats))
    stats[k] = stats[k]
      ? { floor: Math.max(stats[k].floor, v.floor), importance: Math.max(stats[k].importance, v.importance) }
      : v;
  const tags: Record<string, number> = { ...a.tags };
  for (const [k, v] of Object.entries(b.tags)) tags[k] = (tags[k] ?? 0) + v;
  return { dials, stats, tags };
}
