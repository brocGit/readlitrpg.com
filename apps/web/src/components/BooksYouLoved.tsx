// Flow A (DESIGN §9.1): add 1–5 books you loved, optionally books you bounced off (with a reason),
// and see matches in under a second. Nothing is stored; the inputs go into a share link.

import type { DislikeReason, HardNo, MatchInputs } from "@rlr/core/match";
import { useEffect, useId, useRef, useState } from "preact/hooks";

interface Hit {
  slug: string;
  title: string;
  series: string | null;
  position: number | null;
  authors: string;
}

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
];

/**
 * A book typeahead that plays like a game menu: arrows move the highlight, Enter picks (the first
 * hit if none is highlighted), Escape closes. ARIA combobox: focus stays in the input.
 */
function BookSearch({
  placeholder,
  onPick,
  exclude,
}: {
  placeholder: string;
  onPick: (h: Hit) => void;
  exclude: string[];
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(-1);
  const [empty, setEmpty] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const listId = useId();
  useEffect(() => {
    clearTimeout(timer.current);
    setEmpty(false);
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    timer.current = setTimeout(async () => {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) return;
      const found = ((await res.json()) as { books: Hit[] }).books.filter((h) => !exclude.includes(h.slug));
      setHits(found);
      setActive(-1);
      setEmpty(found.length === 0);
    }, 180);
  }, [q]);

  function pick(h: Hit) {
    onPick(h);
    setQ("");
    setHits([]);
    setActive(-1);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      setHits([]);
      setActive(-1);
      return;
    }
    if (hits.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a <= 0 ? hits.length - 1 : a - 1));
    } else if (e.key === "Enter") {
      const h = hits[active >= 0 ? active : 0];
      if (h) {
        e.preventDefault();
        pick(h);
      }
    }
  }

  const open = hits.length > 0;
  return (
    <div class="book-search">
      <input
        type="search"
        role="combobox"
        placeholder={placeholder}
        aria-label={placeholder}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        value={q}
        onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div class="hits" id={listId} role="listbox" aria-label="Matching books">
          {hits.map((h, i) => (
            <div key={h.slug} role="presentation">
              <button
                type="button"
                id={`${listId}-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(h)}
              >
                <strong>{h.title}</strong>
                <span class="muted">
                  {" "}
                  {h.authors}
                  {h.series ? ` · ${h.series}${h.position ? ` #${h.position}` : ""}` : ""}
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
      {empty && (
        <p class="no-hits muted" role="status">
          [No loot found] Nothing matches that yet. Try the author's name.
        </p>
      )}
    </div>
  );
}

export default function BooksYouLoved() {
  const [loved, setLoved] = useState<Hit[]>([]);
  const [bounced, setBounced] = useState<(Hit & { reasons: DislikeReason[] })[]>([]);
  const [noes, setNoes] = useState<HardNo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taken = [...loved.map((b) => b.slug), ...bounced.map((b) => b.slug)];

  async function submit(e: Event) {
    e.preventDefault();
    if (loved.length === 0) return;
    setBusy(true);
    setError(null);
    const inputs: MatchInputs = {
      loved: loved.map((b) => b.slug),
      ...(bounced.length ? { bounced: bounced.map((b) => ({ book: b.slug, reasons: b.reasons })) } : {}),
      ...(noes.length ? { noes } : {}),
    };
    const res = await fetch("/api/match", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(inputs),
    });
    if (!res.ok) {
      setError("Matching didn't work. Try again in a moment.");
      setBusy(false);
      return;
    }
    const { share } = (await res.json()) as { share: string };
    window.location.assign(`/match/r?p=${share}`);
  }

  return (
    <form class="loved-form" onSubmit={submit}>
      <h2>Books you loved</h2>
      <ol class="picked">
        {loved.map((b) => (
          <li key={b.slug}>
            {b.title} <span class="muted">{b.authors}</span>{" "}
            <button
              type="button"
              class="link-button"
              onClick={() => setLoved(loved.filter((x) => x.slug !== b.slug))}
            >
              Remove
            </button>
          </li>
        ))}
      </ol>
      {loved.length < 5 && (
        <BookSearch
          placeholder="Search a title, series or author"
          exclude={taken}
          onPick={(h) => setLoved([...loved, h])}
        />
      )}

      <details>
        <summary>Books you bounced off (optional)</summary>
        {bounced.map((b) => (
          <fieldset key={b.slug} class="bounced">
            <legend>
              {b.title}{" "}
              <button
                type="button"
                class="link-button"
                onClick={() => setBounced(bounced.filter((x) => x.slug !== b.slug))}
              >
                Remove
              </button>
            </legend>
            {REASONS.map((r) => (
              <label key={r.key} class="chip">
                <input
                  type="checkbox"
                  checked={b.reasons.includes(r.key)}
                  onChange={(e) => {
                    const on = (e.target as HTMLInputElement).checked;
                    setBounced(
                      bounced.map((x) =>
                        x.slug === b.slug
                          ? {
                              ...x,
                              reasons: on
                                ? [...x.reasons, r.key].slice(0, 4)
                                : x.reasons.filter((k) => k !== r.key),
                            }
                          : x,
                      ),
                    );
                  }}
                />{" "}
                {r.label}
              </label>
            ))}
          </fieldset>
        ))}
        {bounced.length < 5 && (
          <BookSearch
            placeholder="A book that wasn't for you"
            exclude={taken}
            onPick={(h) => setBounced([...bounced, { ...h, reasons: [] }])}
          />
        )}
      </details>

      <fieldset class="noes">
        <legend>Hard no's</legend>
        {NOES.map((n) => (
          <label key={n.key} class="chip">
            <input
              type="checkbox"
              checked={noes.includes(n.key)}
              onChange={(e) =>
                setNoes(
                  (e.target as HTMLInputElement).checked ? [...noes, n.key] : noes.filter((k) => k !== n.key),
                )
              }
            />{" "}
            {n.label}
          </label>
        ))}
      </fieldset>

      {error && (
        <p class="notice error" role="alert">
          {error}
        </p>
      )}
      <button
        class={busy ? "button calculating" : "button"}
        type="submit"
        disabled={busy || loved.length === 0}
      >
        {busy ? "Scanning the archives" : "Find my next read"}
      </button>
    </form>
  );
}
