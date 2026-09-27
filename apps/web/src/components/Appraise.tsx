// Appraise (DESIGN §6.7): the reader's LitRPG skill. Up to five one-tap questions about a book's
// hidden or least-certain stats and dials. Signed-in readers only; the page itself stays cached.

import { useEffect, useState } from "preact/hooks";

interface Question {
  key: string;
  kind: "dial" | "stat";
  prompt: string;
  choices: { answer: string; label: string }[];
}

export default function Appraise({ slug, shown }: { slug: string; shown: Record<string, number | null> }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json() as Promise<{ signedIn: boolean }>)
      .then((me) => setSignedIn(me.signedIn))
      .catch(() => setSignedIn(false));
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    fetch(`/api/appraise/${slug}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ questions: Question[] }>) : { questions: [] }))
      .then((d) => setQuestions(d.questions));
  }, [signedIn]);

  if (signedIn === null) return null;
  if (!signedIn) {
    return (
      <p class="muted">
        Read it? <a href={`/signin?next=${encodeURIComponent(`/books-like/${slug}`)}`}>Sign in</a> to appraise
        it and reveal its ??? stats.
      </p>
    );
  }
  if (message) return <p class="notice">{message}</p>;
  if (questions.length === 0) return null;

  async function submit(e: Event) {
    e.preventDefault();
    const list = Object.entries(answers).map(([key, answer]) => ({ key, answer }));
    if (list.length === 0) return;
    const res = await fetch(`/api/appraise/${slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: list, shown }),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      message?: string;
      revealed?: string[];
      held?: boolean;
    };
    if (!res.ok) setMessage(data.message ?? "That didn't go through.");
    else if (data.revealed?.length)
      setMessage(`[Identified!] You helped reveal: ${data.revealed.join(", ").replaceAll("_", " ")}.`);
    else setMessage("[Appraisal recorded] Thanks: every appraisal sharpens everyone's matches.");
  }

  return (
    <form class="appraise status-screen" onSubmit={submit}>
      <p class="label">[Appraise]</p>
      {questions.map((q) => (
        <fieldset key={q.key}>
          <legend>{q.prompt}</legend>
          {q.choices.map((c) => (
            <label key={c.answer} class="chip">
              <input
                type="radio"
                name={q.key}
                checked={answers[q.key] === c.answer}
                onChange={() => setAnswers({ ...answers, [q.key]: c.answer })}
              />{" "}
              {c.label}
            </label>
          ))}
        </fieldset>
      ))}
      <button type="submit" class="button small">
        Appraise
      </button>
    </form>
  );
}
