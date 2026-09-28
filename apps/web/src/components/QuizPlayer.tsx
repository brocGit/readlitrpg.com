// Playing a quiz (QUIZZES.md §3.2): one question at a time, the server scores it, and the result
// comes with three books, a share card, Party up and "Sharpen my matches". No email gate.

import { useEffect, useState } from "preact/hooks";
import type { ResultCard } from "../lib/match";
import type { PlayableQuiz } from "../lib/quiz";
import { announce } from "../lib/system";
import SubscribeForm from "./SubscribeForm";

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

/** How long a picked answer stays lit before the next question: long enough to feel, short enough not to wait. */
const CHOSEN_MS = 220;
const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

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
  siteKey,
}: {
  quiz: PlayableQuiz;
  party: string | null;
  source: string | null;
  siteKey: string | null;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<string[]>([]);
  const [result, setResult] = useState<TakeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The answer just picked (lit for a moment), and which way the questions are moving.
  const [chosen, setChosen] = useState<string | null>(null);
  const [back, setBack] = useState(false);
  const [copied, setCopied] = useState(false);

  // Options stay enabled (a disabled button swallows the click without a sound); extra clicks
  // while an answer is lit or the result is on its way are ignored here instead.
  function pick(optionId: string) {
    if (chosen || busy) return;
    setChosen(optionId);
    setBack(false);
    window.setTimeout(
      () => {
        setChosen(null);
        void answer(optionId);
      },
      reducedMotion() ? 0 : CHOSEN_MS,
    );
  }

  // Game-menu keys: 1–9 pick an answer, Backspace or ← goes back. Never while typing in a field.
  useEffect(() => {
    if (result) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable)) return;
      const q = quiz.questions[index];
      if (!q) return;
      const n = Number(e.key);
      const option = Number.isInteger(n) && n >= 1 ? q.options[n - 1] : undefined;
      if (option) {
        e.preventDefault();
        pick(option.id);
      } else if ((e.key === "Backspace" || e.key === "ArrowLeft") && index > 0 && !busy && !chosen) {
        e.preventDefault();
        setBack(true);
        setIndex(index - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, result, busy, chosen]);

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
    window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
  }

  if (result) {
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    const partyUrl = `${origin}/quiz/${quiz.slug}?party=${result.take}`;
    const sharpen = `/match/quiz?quiz=${quiz.slug}&outcome=${result.outcome.key}`;
    return (
      <div class="quiz-result">
        <section class="status-screen reveal">
          <p class="label reveal-label">
            {quiz.kind === "trivia"
              ? `[Quest complete · Score ${result.score}/${result.total}]`
              : "[New title acquired]"}
          </p>
          <h2 class="reveal-name">{result.outcome.name}</h2>
          <p>
            <strong>{result.outcome.tagline}</strong>
          </p>
          <p>{result.outcome.description}</p>
          {result.outcome.loves.length > 0 && (
            <ul class="perks" aria-label="Loves">
              {result.outcome.loves.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
          {result.outcome.watchOut && (
            <p class="debuff">
              <span class="label">[Debuff]</span> Watch out for: {result.outcome.watchOut}
            </p>
          )}
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

        {quiz.kind === "fun" && (
          <section class="capture">
            <SubscribeForm
              collapsed
              source={`quiz:${quiz.slug}:${result.outcome.key}`}
              className={result.outcome.name}
              siteKey={siteKey}
            />
          </section>
        )}

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
            onClick={async () => {
              await navigator.clipboard?.writeText(partyUrl).catch(() => undefined);
              setCopied(true);
              announce("[Party link copied]", "Send it to a friend. Their result joins yours.");
            }}
          >
            {copied ? "Party link copied" : "Copy a Party up link"}
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
  const locked = Boolean(chosen) || busy;
  return (
    <div class="quiz-player">
      {quiz.disclaimer && <p class="muted">{quiz.disclaimer}</p>}
      <p class="label">
        {q.flavor ?? `[Question ${index + 1}]`}{" "}
        <span class="muted">
          {index + 1} / {quiz.questions.length}
        </span>
      </p>
      <progress max={quiz.questions.length} value={index + 1} aria-label="Progress" />
      <div class={back ? "question from-back" : "question"} key={index}>
        <h2>{q.prompt}</h2>
        <div class={locked ? "options locked" : "options"}>
          {q.options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              class={chosen === o.id ? "option chosen" : "option"}
              aria-pressed={chosen === o.id}
              aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
              onClick={() => pick(o.id)}
            >
              {i < 9 && (
                <span class="key" aria-hidden="true">
                  {i + 1}
                </span>
              )}
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {busy && (
        <p class="label calculating" role="status">
          {quiz.kind === "trivia" ? "[Counting your score]" : "[Calculating your result]"}
        </p>
      )}
      {index > 0 && !busy && (
        <button
          type="button"
          class="link-button"
          onClick={() => {
            setBack(true);
            setIndex(index - 1);
          }}
        >
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
