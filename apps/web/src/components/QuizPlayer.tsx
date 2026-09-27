// Playing a quiz (QUIZZES.md §3.2): one question at a time, the server scores it, and the result
// comes with three books, a share card, Party up and "Sharpen my matches". No email gate.

import { useState } from "preact/hooks";
import type { ResultCard } from "../lib/match";
import type { PlayableQuiz } from "../lib/quiz";

interface Outcome {
  key: string;
  name: string;
  tagline: string;
  description: string;
  loves: string[];
  watchOut: string | null;
  shareText: string;
}
interface TakeResponse {
  take: string;
  outcome: Outcome;
  score: number | null;
  total: number | null;
  review: { id: string; yours: string; correct: string | null; explain: string | null }[] | null;
  resultUrl: string;
  books: ResultCard[];
  party: { with: Outcome; composition: string; books: ResultCard[] } | null;
}

/** Take ids stay in this browser so they can attach to an account later (QUIZZES §4.3). */
function remember(take: string) {
  try {
    const list = JSON.parse(localStorage.getItem("rlr.takes") ?? "[]") as string[];
    localStorage.setItem("rlr.takes", JSON.stringify([...list, take].slice(-20)));
  } catch {
    // Storage may be off; the result still works.
  }
}

function Books({ books }: { books: ResultCard[] }) {
  if (books.length === 0) return <p class="muted">Book picks appear once the catalog opens.</p>;
  return (
    <ol class="quiz-books">
      {books.map((b) => (
        <li key={b.slug}>
          <a href={`/books/${b.slug}`}>
            <strong>{b.title}</strong>
          </a>{" "}
          <span class="muted">{b.authors.join(", ")}</span>
          {b.hook && <div>{b.hook}</div>}
        </li>
      ))}
    </ol>
  );
}

export default function QuizPlayer({
  quiz,
  party,
  source,
}: {
  quiz: PlayableQuiz;
  party: string | null;
  source: string | null;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<string[]>([]);
  const [result, setResult] = useState<TakeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function answer(optionId: string) {
    const next = [...answers.slice(0, index), optionId];
    setAnswers(next);
    if (index < quiz.questions.length - 1) {
      setIndex(index + 1);
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/quiz/${quiz.slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: next, ...(party ? { party } : {}), ...(source ? { source } : {}) }),
    });
    setBusy(false);
    if (!res.ok) {
      setError("That didn't go through. Try again in a moment.");
      return;
    }
    const data = (await res.json()) as TakeResponse;
    remember(data.take);
    setResult(data);
    window.scrollTo({ top: 0 });
  }

  if (result) {
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    const partyUrl = `${origin}/quiz/${quiz.slug}?party=${result.take}`;
    const sharpen = `/match/quiz?quiz=${quiz.slug}&outcome=${result.outcome.key}`;
    return (
      <div class="quiz-result">
        <section class="status-screen">
          <p class="label">
            {quiz.kind === "trivia" ? `[Score: ${result.score}/${result.total}]` : "[Result]"}
          </p>
          <h2>{result.outcome.name}</h2>
          <p>
            <strong>{result.outcome.tagline}</strong>
          </p>
          <p>{result.outcome.description}</p>
          {result.outcome.loves.length > 0 && (
            <ul>
              {result.outcome.loves.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
          {result.outcome.watchOut && <p class="muted">Watch out for: {result.outcome.watchOut}</p>}
        </section>

        {result.review && (
          <details>
            <summary>Answers</summary>
            <ol>
              {result.review.map((r) => (
                <li key={r.id}>
                  {r.yours === r.correct ? "✓" : "✗"} {r.explain}
                </li>
              ))}
            </ol>
          </details>
        )}

        {result.party && (
          <section class="party">
            <h2>Your party</h2>
            <p>
              You and your friend ({result.party.with.name}): {result.party.composition}
            </p>
            <h3>Books you'd both enjoy</h3>
            <Books books={result.party.books} />
          </section>
        )}

        <h2>3 books for you</h2>
        <Books books={result.books} />

        <div class="quiz-actions">
          <a class="button" href={sharpen}>
            Sharpen my matches (2 min)
          </a>
          <a class="button secondary" href={result.resultUrl}>
            Share my result
          </a>
          <button
            type="button"
            class="button secondary"
            onClick={() => navigator.clipboard?.writeText(partyUrl)}
          >
            Copy a Party up link
          </button>
          <a class="button secondary" href="/quiz">
            Take another quiz
          </a>
        </div>
      </div>
    );
  }

  const q = quiz.questions[index];
  if (!q) return null;
  return (
    <div class="quiz-player">
      {quiz.disclaimer && <p class="muted">{quiz.disclaimer}</p>}
      <p class="label">
        {q.flavor ?? `[Question ${index + 1}]`}{" "}
        <span class="muted">
          {index + 1} / {quiz.questions.length}
        </span>
      </p>
      <progress max={quiz.questions.length} value={index} aria-label="Progress" />
      <h2>{q.prompt}</h2>
      <div class="options">
        {q.options.map((o) => (
          <button key={o.id} type="button" class="option" disabled={busy} onClick={() => answer(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
      {index > 0 && (
        <button type="button" class="link-button" onClick={() => setIndex(index - 1)}>
          Back
        </button>
      )}
      {error && (
        <p class="notice error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
