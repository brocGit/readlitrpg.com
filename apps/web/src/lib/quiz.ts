// Quizzes on the site (DESIGN §9.3, QUIZZES.md §3.2): the player gets prompts and labels only;
// points, effects and correct answers stay on the server, which scores every take.

import { buildProfile, match } from "@rlr/core/match";
import { type Outcome, outcomeSignal, partyComposition, partySignal, type Quiz } from "@rlr/core/quiz";
import type { Settings } from "@rlr/core/settings";
import { buildCards, getMatrix, matchOptions, type ResultCard } from "./match";

export interface PlayableQuiz {
  slug: string;
  kind: "fun" | "trivia";
  title: string;
  dek: string;
  disclaimer: string | null;
  questions: {
    id: string;
    flavor: string | null;
    prompt: string;
    options: { id: string; label: string }[];
  }[];
}

export function playable(quiz: Quiz): PlayableQuiz {
  return {
    slug: quiz.slug,
    kind: quiz.kind,
    title: quiz.title,
    dek: quiz.dek,
    // Series quizzes are unofficial fan quizzes unless the author took part (DESIGN §16.5).
    disclaimer:
      quiz.disclaimer ??
      (quiz.series && !quiz.is_official
        ? "An unofficial fan quiz. Not affiliated with the author or publisher."
        : null),
    questions: quiz.questions.map((q) => ({
      id: q.id,
      flavor: q.flavor ?? null,
      prompt: q.prompt,
      options: q.options.map((o) => ({ id: o.id, label: o.label })),
    })),
  };
}

export function publicOutcome(o: Outcome) {
  return {
    key: o.key,
    name: o.name,
    tagline: o.tagline,
    description: o.description,
    loves: o.loves ?? [],
    watchOut: o.watch_out ?? null,
    shareText: o.share_text,
  };
}

/** "3 books for your class" from a result's starting profile (QUIZZES §3.2). */
export async function booksForOutcome(
  outcome: Outcome,
  settings: Settings,
  count = 3,
): Promise<ResultCard[]> {
  const m = await getMatrix();
  if (!m || m.n === 0) return [];
  const profile = buildProfile(m, {}, outcomeSignal(outcome, settings["quiz.fun_effect_importance"]));
  const opts = matchOptions(settings);
  const r = match(m, profile, opts);
  return buildCards(m, profile, [...r.bestBets, ...r.more].slice(0, count), opts);
}

/** Party up: both results, what the pair is like, and books both would enjoy. */
export async function partyFor(mine: Outcome, theirs: Outcome, settings: Settings) {
  const m = await getMatrix();
  const scale = settings["quiz.fun_effect_importance"];
  let books: ResultCard[] = [];
  if (m && m.n > 0) {
    const profile = buildProfile(
      m,
      {},
      partySignal(outcomeSignal(mine, scale), outcomeSignal(theirs, scale)),
    );
    const opts = matchOptions(settings);
    const r = match(m, profile, opts);
    books = await buildCards(m, profile, [...r.bestBets, ...r.more].slice(0, 3), opts);
  }
  return { with: publicOutcome(theirs), composition: partyComposition(mine, theirs), books };
}
