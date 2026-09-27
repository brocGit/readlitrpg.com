// Match results (DESIGN §9.1 results page): best bets, more, a wildcard, heads-ups with "Doesn't
// bother me", feedback that re-ranks instantly, tune sliders and a share link. The inputs live in
// the URL, never the person.

import type { MatchInputs } from "@rlr/core/match";
import { useState } from "preact/hooks";
import type { MatchResponse, ResultCard } from "../lib/match";

const TUNE_DIALS = [
  { key: "pacing", label: "Pacing", low: "Slow burn", high: "Relentless" },
  { key: "crunch", label: "Crunch", low: "No stats", high: "Spreadsheets" },
  { key: "tone", label: "Tone", low: "Grim", high: "Hopeful" },
  { key: "humor", label: "Humor", low: "Serious", high: "Comedy" },
  { key: "progression_speed", label: "Progression", low: "Hard-won", high: "Fast" },
] as const;

export async function fetchMatch(inputs: MatchInputs): Promise<MatchResponse> {
  const res = await fetch("/api/match", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(inputs),
  });
  if (!res.ok)
    throw new Error(res.status === 429 ? "Too many requests. Try again in a minute." : "Matching failed.");
  return (await res.json()) as MatchResponse;
}

function StatusMini({ card }: { card: ResultCard }) {
  if (card.status.length === 0) return null;
  return (
    <dl class="status-mini">
      {card.status.map((s) => (
        <div key={s.key}>
          <dt>{s.name}</dt>
          <dd>
            {s.value === null ? (
              <span class="unknown" title="Readers haven't appraised this yet">
                ???
              </span>
            ) : (
              <>
                <meter min={0} max={10} value={s.value} aria-label={`${s.name} ${s.value} of 10`} /> {s.value}
                <span class="muted"> · {s.label}</span>
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Card({
  card,
  full,
  onRelax,
  onFeedback,
  label,
}: {
  card: ResultCard;
  full: boolean;
  onRelax: (key: string) => void;
  onFeedback: (slug: string, kind: "loved" | "bounced" | "read") => void;
  label?: string;
}) {
  return (
    <article class="match-card">
      {label && <p class="label">{label}</p>}
      <header>
        <h3>{card.title}</h3>
        <p class="match-percent">
          {card.isMatch ? `${card.percent}%` : "Close"}
          <span class="visually-hidden"> match</span>
        </p>
      </header>
      <p class="muted">
        {card.authors.join(", ")}
        {card.series && ` · ${card.series.name}${card.series.position ? ` #${card.series.position}` : ""}`}
        {card.series?.status === "complete" && " · complete"}
        {card.formats.includes("audiobook") && " · audio"}
        {card.kindleUnlimited && " · KU"}
      </p>
      {card.hook && <p class="hook">{card.hook}</p>}
      <p>{card.why}</p>
      {full && card.differs && <p class="muted">{card.differs}</p>}
      {card.notes.length > 0 && <p class="notes">{card.notes.join(" ")}</p>}
      {full && <StatusMini card={card} />}
      {card.headsUps.length > 0 && (
        <ul class="heads-ups" aria-label="Heads-ups">
          {card.headsUps.map((h) => (
            <li key={h.key}>
              ⚠ {h.text}{" "}
              <button type="button" class="link-button" onClick={() => onRelax(h.key)}>
                Doesn't bother me
              </button>
            </li>
          ))}
        </ul>
      )}
      <div class="feedback">
        <button type="button" class="button small secondary" onClick={() => onFeedback(card.slug, "loved")}>
          Loved it
        </button>
        <button type="button" class="button small secondary" onClick={() => onFeedback(card.slug, "bounced")}>
          Not for me
        </button>
        <button type="button" class="button small secondary" onClick={() => onFeedback(card.slug, "read")}>
          Already read
        </button>
      </div>
    </article>
  );
}

export default function MatchResults({
  initial,
  inputs: startInputs,
}: {
  initial: MatchResponse;
  inputs: MatchInputs;
}) {
  const [data, setData] = useState(initial);
  const [inputs, setInputs] = useState<MatchInputs>(startInputs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function rerun(next: MatchInputs) {
    setInputs(next);
    setBusy(true);
    setError(null);
    try {
      const res = await fetchMatch(next);
      setData(res);
      window.history.replaceState(null, "", `/match/r?p=${res.share}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const relax = (key: string) => rerun({ ...inputs, relax: [...new Set([...(inputs.relax ?? []), key])] });
  const feedback = (slug: string, kind: "loved" | "bounced" | "read") => {
    if (kind === "loved") rerun({ ...inputs, loved: [...(inputs.loved ?? []), slug].slice(-5) });
    else if (kind === "bounced")
      rerun({ ...inputs, bounced: [...(inputs.bounced ?? []), { book: slug }].slice(-5) });
    else rerun({ ...inputs, read: [...(inputs.read ?? []), slug] });
  };
  const tune = (key: string, value: number) =>
    rerun({ ...inputs, tune: { ...(inputs.tune ?? {}), [key]: value } });

  if (!data.ready) {
    return (
      <div class="status-screen">
        <p class="label">[Loading the guild archives]</p>
        <p>The catalog is still being stocked. Matches open as soon as the first books are published.</p>
      </div>
    );
  }
  const shareUrl = `/match/r?p=${data.share}`;
  const empty = data.best.length === 0;
  return (
    <div class="match-results" aria-busy={busy}>
      {data.readerClass && (
        <section class="status-screen class-badge">
          <p class="label">[Class identified]</p>
          <p>
            <strong>{data.readerClass.name}</strong>: {data.readerClass.tagline}
          </p>
          <meter min={0} max={1} value={data.strength} aria-label="Match confidence" />{" "}
          <span class="muted">match confidence</span>
        </section>
      )}
      {error && (
        <p class="notice error" role="alert">
          {error}
        </p>
      )}
      {empty ? (
        <div class="status-screen">
          <p class="label">[No matches]</p>
          <p>Nothing passes those filters yet. Loosen a hard no, or add a book you loved.</p>
        </div>
      ) : (
        <>
          <h2>Best bets</h2>
          {data.best.map((c) => (
            <Card key={c.slug} card={c} full onRelax={relax} onFeedback={feedback} />
          ))}
          {data.more.length > 0 && <h2>More matches</h2>}
          {data.more.map((c) => (
            <Card key={c.slug} card={c} full={false} onRelax={relax} onFeedback={feedback} />
          ))}
          {data.wildcard && (
            <Card
              card={data.wildcard}
              full
              onRelax={relax}
              onFeedback={feedback}
              label="Wildcard: different setting, same things you love"
            />
          )}
        </>
      )}
      <details class="tune">
        <summary>Tune it</summary>
        {TUNE_DIALS.map((d) => (
          <label key={d.key} class="tune-row">
            <span>{d.label}</span>
            <span class="muted">{d.low}</span>
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={inputs.tune?.[d.key] ?? 5}
              onChange={(e) => tune(d.key, Number((e.target as HTMLInputElement).value))}
            />
            <span class="muted">{d.high}</span>
          </label>
        ))}
      </details>
      <p class="share">
        <a href={shareUrl}>Link to these results</a>{" "}
        <button
          type="button"
          class="link-button"
          onClick={async () => {
            await navigator.clipboard?.writeText(new URL(shareUrl, window.location.href).toString());
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>{" "}
        · <a href={`/match/card.svg?p=${data.share}`}>Your reader class card</a>
      </p>
    </div>
  );
}
