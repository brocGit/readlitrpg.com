// The Match Quiz (DESIGN §9.1 Flow B): nine quick steps, every one skippable, with a results
// preview that updates as you answer so you can stop when the list looks right.

import type { DislikeReason, HardNo, MatchInputs, McType } from "@rlr/core/match";
import { useEffect, useRef, useState } from "preact/hooks";
import type { MatchResponse } from "../lib/match";
import { tierOf } from "../lib/tiers";

interface Classic {
  slug: string;
  title: string;
  authors: string;
  series: string | null;
}
type Rating = "loved" | "liked" | "disliked" | "unread";

const REASONS: { key: DislikeReason; label: string }[] = [
  { key: "too_slow", label: "Too slow" },
  { key: "too_crunchy", label: "Too crunchy" },
  { key: "annoying_mc", label: "Annoying MC" },
  { key: "too_dark", label: "Too dark" },
  { key: "too_silly", label: "Too silly" },
  { key: "harem_romance", label: "Harem/romance" },
  { key: "wordy", label: "Wordy prose" },
];
const NOES: { key: HardNo; label: string }[] = [
  { key: "harem", label: "Harem" },
  { key: "heavy_romance", label: "Heavy romance" },
  { key: "explicit", label: "Explicit content" },
  { key: "grimdark", label: "Grimdark" },
  { key: "gore", label: "Gore" },
  { key: "sexual_violence", label: "Sexual violence" },
  { key: "horror", label: "Horror" },
  { key: "villain_mc", label: "Villain MC" },
  { key: "ai_generated", label: "AI-generated books" },
  { key: "unfinished", label: "Unfinished series" },
];
const SUBGENRES: { key: NonNullable<MatchInputs["subgenres"]>[number]; label: string }[] = [
  { key: "system-apocalypse", label: "System Apocalypse" },
  { key: "dungeon-core", label: "Dungeon Core" },
  { key: "dungeon-crawler", label: "Dungeon Crawler" },
  { key: "cultivation", label: "Cultivation" },
  { key: "isekai", label: "Isekai" },
  { key: "vrmmo", label: "VRMMO" },
  { key: "tower-climbing", label: "Tower" },
  { key: "academy", label: "Academy" },
  { key: "time-loop", label: "Time Loop" },
  { key: "regression", label: "Regression" },
  { key: "kingdom-building", label: "Kingdom Building" },
  { key: "crafting", label: "Crafting" },
  { key: "monster-mc", label: "Monster MC" },
  { key: "superhero-progression", label: "Superhero" },
  { key: "gates-and-hunters", label: "Gates & Hunters" },
  { key: "space", label: "Space" },
];
const MCS: { key: McType; label: string }[] = [
  { key: "underdog", label: "Underdog" },
  { key: "planner", label: "Genius planner" },
  { key: "op", label: "Overpowered from the start" },
  { key: "villain", label: "Villain or antihero" },
  { key: "monster", label: "Non-human or monster" },
  { key: "crafter", label: "Crafter or support" },
  { key: "gamer", label: "Gamer" },
  { key: "older", label: "Adult or older" },
];
const MUSTS: { key: NonNullable<MatchInputs["musts"]>[number]; label: string }[] = [
  { key: "competent_mc", label: "Competent MC" },
  { key: "rule_of_cool", label: "Rule of Cool" },
  { key: "number_go_up", label: "Number Go Up" },
  { key: "earned_power", label: "Earned Power" },
  { key: "low_drama", label: "Low Drama" },
  { key: "party_chemistry", label: "Party Chemistry" },
  { key: "fast_start", label: "Fast Start" },
  { key: "satisfying_endings", label: "Satisfying Endings" },
  { key: "hype", label: "Hype Moments" },
];
// Crunch by example, not jargon (§9.1 step 7).
const CRUNCH: { label: string; sample: string }[] = [
  { label: "Narrative only", sample: "He felt stronger than yesterday.\nThe mountain seemed smaller now." },
  { label: "Light", sample: "[Level up! You are now Level 5.]\nShe grinned and kept walking." },
  { label: "Medium", sample: "[Skill gained: Iron Skin (Rank 2)]\nDefense +15%. Stamina cost: 10/min." },
  { label: "Heavy", sample: "STR 45 (+3) · DEX 38 · INT 61 (+12)\nFree points: 5. Build: INT/WIS hybrid." },
];
const STEPS = [
  "Rate the classics",
  "Hard no's",
  "Dark or light",
  "Subgenres",
  "Pace",
  "Your kind of MC",
  "Crunch",
  "MC gender",
  "Must-haves",
];

function toggle<T>(list: T[], item: T, max = 99): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item].slice(-max);
}

function Chips<T extends string>({
  items,
  value,
  onChange,
  max,
}: {
  items: { key: T; label: string }[];
  value: T[];
  onChange: (v: T[]) => void;
  max?: number;
}) {
  return (
    <div class="chips">
      {items.map((it) => (
        <label key={it.key} class="chip">
          <input
            type="checkbox"
            checked={value.includes(it.key)}
            onChange={() => onChange(toggle(value, it.key, max))}
          />{" "}
          {it.label}
        </label>
      ))}
    </div>
  );
}

export default function MatchQuiz({ initial }: { initial: MatchInputs }) {
  const [step, setStep] = useState(0);
  const [back, setBack] = useState(false);
  const [inputs, setInputs] = useState<MatchInputs>(initial);
  const [ratings, setRatings] = useState<Record<string, { rating: Rating; reasons: DislikeReason[] }>>({});
  const [classics, setClassics] = useState<Classic[]>([]);
  const [shown, setShown] = useState<Classic[]>([]);
  const [preview, setPreview] = useState<MatchResponse | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const set = (patch: Partial<MatchInputs>) => setInputs((prev) => ({ ...prev, ...patch }));
  const rated = Object.entries(ratings).filter(([, r]) => r.rating !== "unread");

  async function moreClassics(already: string[]) {
    const res = await fetch(`/api/match/classics?rated=${encodeURIComponent(already.join(","))}`);
    if (!res.ok) return;
    const { books } = (await res.json()) as { books: Classic[] };
    const fresh = books.filter((b) => !already.includes(b.slug));
    setClassics(fresh);
    setShown((prev) => [...prev, ...fresh]);
  }
  useEffect(() => {
    moreClassics([]);
  }, []);

  // The full inputs: quiz answers plus rated classics.
  const full: MatchInputs = {
    ...inputs,
    rated: rated.map(([book, r]) => ({
      book,
      rating: r.rating as "loved" | "liked" | "disliked",
      ...(r.reasons.length ? { reasons: r.reasons } : {}),
    })),
  };
  const key = JSON.stringify(full);
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const res = await fetch("/api/match", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: key,
      });
      if (res.ok) setPreview((await res.json()) as MatchResponse);
    }, 400);
  }, [key]);

  function rate(slug: string, rating: Rating) {
    const next = { ...ratings, [slug]: { rating, reasons: ratings[slug]?.reasons ?? [] } };
    setRatings(next);
    const answered = classics.every((c) => next[c.slug]);
    if (answered && Object.keys(next).length < 16) moreClassics(Object.keys(next));
  }

  const go = (next: number) => {
    setBack(next < step);
    setStep(next);
  };

  return (
    <div class="match-quiz">
      <p class="label">
        [Step {step + 1} of {STEPS.length}] {STEPS[step]}
      </p>
      <progress max={STEPS.length} value={step + 1} aria-label="Progress" />

      <div class={back ? "question from-back" : "question"} key={step}>
        {step === 0 && (
          <div class="classics">
            <p class="muted">Rate the ones you've read. Skip any you haven't.</p>
            {shown.map((c) => (
              <fieldset
                key={c.slug}
                class={ratings[c.slug] ? `classic rated-${ratings[c.slug]?.rating}` : "classic"}
              >
                <legend>
                  <strong>{c.title}</strong> <span class="muted">{c.authors}</span>
                </legend>
                {(["loved", "liked", "disliked", "unread"] as Rating[]).map((r) => (
                  <label key={r} class="chip">
                    <input
                      type="radio"
                      name={`rate-${c.slug}`}
                      checked={ratings[c.slug]?.rating === r}
                      onChange={() => rate(c.slug, r)}
                    />{" "}
                    {r === "loved"
                      ? "Loved"
                      : r === "liked"
                        ? "Liked"
                        : r === "disliked"
                          ? "Didn't like"
                          : "Haven't read"}
                  </label>
                ))}
                {ratings[c.slug]?.rating === "disliked" && (
                  <Chips
                    items={REASONS}
                    value={ratings[c.slug]?.reasons ?? []}
                    max={4}
                    onChange={(reasons) =>
                      setRatings({ ...ratings, [c.slug]: { rating: "disliked", reasons } })
                    }
                  />
                )}
              </fieldset>
            ))}
          </div>
        )}
        {step === 1 && (
          <div class="noes">
            <Chips items={NOES} value={inputs.noes ?? []} onChange={(noes) => set({ noes })} />
          </div>
        )}
        {step === 2 && (
          <div class="sliders">
            <label>
              Tone: grim ↔ hopeful
              <input
                type="range"
                min={0}
                max={10}
                value={inputs.tone ?? 5}
                onChange={(e) => set({ tone: Number((e.target as HTMLInputElement).value) })}
              />
            </label>
            <div class="chips">
              {[
                [1, "Serious"],
                [5, "Some banter"],
                [9, "Comedy first"],
              ].map(([v, label]) => (
                <label key={v} class="chip">
                  <input
                    type="radio"
                    name="humor"
                    checked={inputs.humor === v}
                    onChange={() => set({ humor: v as number })}
                  />{" "}
                  {label}
                </label>
              ))}
            </div>
            <div class="chips">
              {[
                [-1, "Sincere"],
                [0, "Either"],
                [1, "Satirical"],
              ].map(([v, label]) => (
                <label key={v} class="chip">
                  <input
                    type="radio"
                    name="satire"
                    checked={(inputs.satire ?? 0) === v}
                    onChange={() => set({ satire: v as -1 | 0 | 1 })}
                  />{" "}
                  {label}
                </label>
              ))}
            </div>
          </div>
        )}
        {step === 3 && (
          <Chips
            items={SUBGENRES}
            value={inputs.subgenres ?? []}
            onChange={(subgenres) => set({ subgenres })}
          />
        )}
        {step === 4 && (
          <div class="sliders">
            <label>
              Slow-burn deep dive ↔ constant escalation
              <input
                type="range"
                min={0}
                max={10}
                value={inputs.pacing ?? 5}
                onChange={(e) => set({ pacing: Number((e.target as HTMLInputElement).value) })}
              />
            </label>
            <label>
              How fast should the MC grow?
              <input
                type="range"
                min={0}
                max={10}
                value={inputs.progression ?? 5}
                onChange={(e) => set({ progression: Number((e.target as HTMLInputElement).value) })}
              />
            </label>
          </div>
        )}
        {step === 5 && <Chips items={MCS} value={inputs.mc ?? []} onChange={(mc) => set({ mc })} />}
        {step === 6 && (
          <div class="crunch-gauge">
            {CRUNCH.map((c, i) => (
              <label key={c.label} class="crunch-stop">
                <input
                  type="radio"
                  name="crunch"
                  checked={inputs.crunch === i}
                  onChange={() => set({ crunch: i })}
                />{" "}
                <strong>{c.label}</strong>
                <pre>{c.sample}</pre>
              </label>
            ))}
            <label class="chip">
              <input
                type="checkbox"
                checked={inputs.hardRules ?? false}
                onChange={(e) => set({ hardRules: (e.target as HTMLInputElement).checked })}
              />{" "}
              Hard rules matter to me
            </label>
          </div>
        )}
        {step === 7 && (
          <div class="chips">
            {[
              ["female", "Female MC"],
              ["male", "Male MC"],
              ["", "No preference"],
            ].map(([v, label]) => (
              <label key={v} class="chip">
                <input
                  type="radio"
                  name="gender"
                  checked={(inputs.gender ?? "") === v}
                  onChange={() =>
                    set({
                      gender: (v || undefined) as MatchInputs["gender"],
                      genderOnly: v ? inputs.genderOnly : undefined,
                    })
                  }
                />{" "}
                {label}
              </label>
            ))}
            {inputs.gender && (
              <label class="chip">
                <input
                  type="checkbox"
                  checked={inputs.genderOnly ?? false}
                  onChange={(e) => set({ genderOnly: (e.target as HTMLInputElement).checked })}
                />{" "}
                Only show those
              </label>
            )}
          </div>
        )}
        {step === 8 && (
          <Chips items={MUSTS} value={inputs.musts ?? []} max={3} onChange={(musts) => set({ musts })} />
        )}
      </div>

      <div class="quiz-nav">
        {step > 0 && (
          <button type="button" class="button secondary" onClick={() => go(step - 1)}>
            Back
          </button>
        )}
        {step < STEPS.length - 1 ? (
          <button type="button" class="button" onClick={() => go(step + 1)}>
            Next
          </button>
        ) : null}
        <a class="button secondary" href={preview ? `/match/r?p=${preview.share}` : "/match"}>
          See my matches
        </a>
      </div>

      {preview?.ready && preview.best.length > 0 && (
        <aside class="status-screen preview" aria-live="polite">
          <p class="label">[Live preview]{preview.readerClass ? ` ${preview.readerClass.name}` : ""}</p>
          <ol class="loot">
            {preview.best.map((b) => (
              <li key={b.slug}>
                {b.title}{" "}
                {b.isMatch && (
                  <span class={`match-percent small tier-${tierOf(b.percent)}`}>{b.percent}%</span>
                )}
              </li>
            ))}
          </ol>
        </aside>
      )}
    </div>
  );
}
