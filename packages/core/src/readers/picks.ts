// Book picks for a reader's emails (QUIZZES §3.4, DESIGN §13.5): the same match engine the site uses,
// run from their saved profile, optionally limited to a set of books (this week's new ones). Emails
// are string assembly over these picks; no model is called.

import type { Db } from "../db";
import {
  bookCards,
  buildProfile,
  decodeInputs,
  explain,
  type FeatureMatrix,
  type FunQuizSignal,
  findBooks,
  type MatchInputs,
  type MatchOptions,
  match,
  parseFindParams,
  renderExplanation,
  type Scored,
  scoreAll,
  type TasteProfile,
} from "../match";
import { getOutcome, getQuiz, outcomeSignal, QuizAnswerError, takeQuiz } from "../quiz";

export interface Pick {
  id: string;
  slug: string;
  title: string;
  authors: string;
  series: string | null;
  hook: string | null;
  percent: number;
  why: string | null;
}

/** A fun quiz's partial profile, from its answers or just its result (QUIZZES §2.3). */
export function quizSignalFor(inputs: MatchInputs, scale: number): FunQuizSignal | null {
  if (!inputs.quiz) return null;
  const quiz = getQuiz(inputs.quiz.slug);
  if (!quiz) return null;
  try {
    if (inputs.quiz.answers?.length) return takeQuiz(quiz, inputs.quiz.answers, scale).signal;
  } catch (error) {
    if (!(error instanceof QuizAnswerError)) throw error;
  }
  const outcome = inputs.quiz.outcome ? getOutcome(quiz, inputs.quiz.outcome) : undefined;
  return outcome ? outcomeSignal(outcome, scale) : null;
}

export interface PickOptions {
  options: MatchOptions;
  /** settings["quiz.fun_effect_importance"] */
  quizScale: number;
  limit: number;
  /** Only these book ids (e.g. published this week), best first; matches only. */
  only?: ReadonlySet<string>;
}

export function profileFor(m: FeatureMatrix, inputs: MatchInputs, quizScale: number): TasteProfile {
  return buildProfile(m, inputs, quizSignalFor(inputs, quizScale));
}

/** Score, pick and describe. An empty profile still gets the model's best general picks. */
export async function picksFor(
  db: Db,
  m: FeatureMatrix,
  p: TasteProfile,
  opts: PickOptions,
): Promise<Pick[]> {
  let chosen: Scored[];
  if (opts.only) {
    const only = opts.only;
    chosen = scoreAll(m, p, opts.options)
      .scored.filter((s) => s.isMatch && only.has(m.ids[s.i] ?? ""))
      .slice(0, opts.limit);
  } else {
    const r = match(m, p, opts.options);
    const all = [...r.bestBets, ...r.more];
    // Real matches only; with none (a thin profile or catalog), the three best rather than nothing.
    const matches = all.filter((s) => s.isMatch);
    chosen = (matches.length ? matches : all.slice(0, 3)).slice(0, opts.limit);
  }
  if (chosen.length === 0) return [];
  const cards = await bookCards(db, [
    ...chosen.map((s) => m.ids[s.i] ?? ""),
    ...p.loved.map((i) => m.ids[i] ?? ""),
  ]);
  const titleOf = (i: number) => cards.get(m.ids[i] ?? "")?.title;
  const out: Pick[] = [];
  for (const s of chosen) {
    const card = cards.get(m.ids[s.i] ?? "");
    if (!card) continue; // unpublished since the model was built
    out.push({
      id: card.id,
      slug: card.slug,
      title: card.title,
      authors: card.authors.map((a) => a.name).join(", "),
      series: card.series
        ? `${card.series.name}${card.series.position ? ` #${card.series.position}` : ""}`
        : null,
      hook: card.hook,
      percent: s.percent,
      why: renderExplanation(explain(m, s.i, p), titleOf).why || null,
    });
  }
  return out;
}

/**
 * New books for a saved match or search (DESIGN §9.6): its own inputs or filters, limited to
 * `only` (book ids added since it last alerted). Searches have no match percentage; the note says
 * which search they came from instead.
 */
export async function savedQueryPicks(
  db: Db,
  m: FeatureMatrix,
  saved: { kind: "match" | "find"; params: string },
  only: ReadonlySet<string>,
  opts: Omit<PickOptions, "only">,
): Promise<Pick[]> {
  if (only.size === 0) return [];
  const params = new URLSearchParams(saved.params);
  if (saved.kind === "match") {
    const inputs = decodeInputs(params.get("p") ?? "");
    if (!inputs) return [];
    return picksFor(db, m, profileFor(m, inputs, opts.quizScale), { ...opts, only });
  }
  const rows = new Set<number>();
  m.ids.forEach((id, i) => {
    if (only.has(id)) rows.add(i);
  });
  const { hits } = findBooks(m, { ...parseFindParams(params), page: 1 }, null, opts.options, rows);
  const ids = hits.slice(0, opts.limit).map((h) => m.ids[h.i] ?? "");
  const cards = await bookCards(db, ids);
  return ids
    .map((id) => cards.get(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map((card) => ({
      id: card.id,
      slug: card.slug,
      title: card.title,
      authors: card.authors.map((a) => a.name).join(", "),
      series: card.series
        ? `${card.series.name}${card.series.position ? ` #${card.series.position}` : ""}`
        : null,
      hook: card.hook,
      percent: 0,
      why: null,
    }));
}
