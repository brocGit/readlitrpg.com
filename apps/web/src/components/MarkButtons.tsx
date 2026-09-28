// Book marks on a book page (DESIGN §9.6): loved it, read it, didn't finish, want to read. Marks
// sharpen matches and keep read books out of them.

import type { LevelUp } from "@rlr/core/readers";
import { useEffect, useState } from "preact/hooks";
import { postJson, whoAmI } from "../lib/client";
import { announceLevelUp } from "../lib/system";

type Mark = "loved" | "read" | "dnf" | "want";
const MARKS: { key: Mark; label: string }[] = [
  { key: "loved", label: "Loved it" },
  { key: "read", label: "Read it" },
  { key: "dnf", label: "Didn't finish" },
  { key: "want", label: "Want to read" },
];

export default function MarkButtons({ slug }: { slug: string }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [mark, setMark] = useState<Mark | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void whoAmI().then(async (me) => {
      setSignedIn(me.signedIn);
      if (!me.signedIn) return;
      const res = await fetch(`/api/me/marks?books=${encodeURIComponent(slug)}`).catch(() => null);
      if (res?.ok) setMark(((await res.json()) as { marks: Record<string, Mark> }).marks[slug] ?? null);
    });
  }, [slug]);

  async function choose(next: Mark) {
    const value = next === mark ? null : next;
    setBusy(true);
    const res = await postJson<{ mark: Mark | null; levelUp?: LevelUp | null }>("/api/me/marks", {
      book: slug,
      mark: value,
    });
    setBusy(false);
    if (res.ok && res.data) {
      setMark(res.data.mark);
      announceLevelUp(res.data.levelUp);
    }
  }

  // Until /api/me answers, render the signed-out line (the server renders it too), so nothing jumps.
  if (!signedIn)
    return (
      <p class="marks muted small">
        <a href={`/signin?next=${encodeURIComponent(`/books/${slug}`)}`}>Sign in</a> to mark books you've read
        and sharpen your matches.
      </p>
    );
  return (
    <fieldset class="marks">
      <legend class="visually-hidden">Your mark</legend>
      {MARKS.map((m) => (
        <button
          key={m.key}
          type="button"
          class={`chip${mark === m.key ? " on" : ""}`}
          aria-pressed={mark === m.key}
          disabled={busy}
          onClick={() => choose(m.key)}
        >
          {m.label}
        </button>
      ))}
    </fieldset>
  );
}
