// Follow a series, author, narrator, tag or book (DESIGN §9.6). The page is cached and the same for
// everyone, so the button asks the API for this reader's state after it loads.

import { useEffect, useState } from "preact/hooks";
import { postJson, whoAmI } from "../lib/client";
import { announce } from "../lib/system";

type Notify = "digest" | "instant" | "none";
const LABELS: Record<Notify, string> = {
  digest: "In the weekly email",
  instant: "Email me on release day",
  none: "No emails (calendar only)",
};
const PATHS = {
  author: "authors",
  series: "series",
  narrator: "narrators",
  tag: "tags",
  book: "books",
} as const;

export default function FollowButton({
  type,
  slug,
  name,
}: {
  type: "author" | "series" | "narrator" | "tag" | "book";
  slug: string;
  name: string;
}) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [notify, setNotify] = useState<Notify | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void whoAmI().then(async (me) => {
      setSignedIn(me.signedIn);
      if (!me.signedIn) return;
      const res = await fetch(`/api/me/follow?type=${type}&slug=${encodeURIComponent(slug)}`).catch(
        () => null,
      );
      if (res?.ok) setNotify(((await res.json()) as { notify: Notify | null }).notify);
    });
  }, [type, slug]);

  async function save(next: Notify | null) {
    setBusy(true);
    setError(null);
    const res = await postJson<{ notify: Notify | null; error?: string }>("/api/me/follow", {
      type,
      slug,
      notify: next,
    });
    setBusy(false);
    if (res.ok && res.data) {
      if (res.data.notify && !notify) announce("[Now following]", `${name}. ${LABELS[res.data.notify]}.`);
      else if (!res.data.notify && notify) announce("[Unfollowed]", `${name}. No more news about it.`);
      setNotify(res.data.notify);
    } else setError(res.data?.error ?? "That didn't save. Try again in a moment.");
  }

  // Until /api/me answers, show what most visitors see: the signed-out button. It's the same size as
  // the signed-in one, so the page doesn't jump when the answer comes (and the server renders it).
  if (!signedIn)
    return (
      <p class="follow">
        <a class="button secondary" href={`/signin?next=${encodeURIComponent(`/${PATHS[type]}/${slug}`)}`}>
          Follow {type === "book" ? "this book" : name}
        </a>
      </p>
    );
  return (
    <div class="follow">
      {notify === null ? (
        <button type="button" class="button secondary" disabled={busy} onClick={() => save("digest")}>
          Follow {type === "book" ? "this book" : name}
        </button>
      ) : (
        <>
          <label>
            <span class="label">[Following]</span>{" "}
            <select
              value={notify}
              disabled={busy}
              onChange={(e) => save((e.target as HTMLSelectElement).value as Notify)}
              aria-label={`How to hear about ${name}`}
            >
              {(Object.keys(LABELS) as Notify[]).map((k) => (
                <option key={k} value={k}>
                  {LABELS[k]}
                </option>
              ))}
            </select>
          </label>{" "}
          <button type="button" class="link-button" disabled={busy} onClick={() => save(null)}>
            Unfollow
          </button>
        </>
      )}
      {error && (
        <p class="notice error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
