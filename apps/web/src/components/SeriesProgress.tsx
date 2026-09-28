// Series progress (DESIGN §9.10): for a signed-in reader, how far through the series their marks
// say they are, the next book to read, and a tag on each book they've marked. The series page is
// cached and the same for everyone, so all of this loads here, after /api/me.

import { useEffect, useState } from "preact/hooks";
import { whoAmI } from "../lib/client";

type Mark = "loved" | "read" | "dnf" | "want";
const TAGS: Record<Mark, string> = {
  loved: "✓ Loved it",
  read: "✓ Read",
  dnf: "Didn't finish",
  want: "Want to read",
};
const finished = (m: Mark | undefined) => m === "loved" || m === "read";

export default function SeriesProgress({ books }: { books: { slug: string; title: string }[] }) {
  const [marks, setMarks] = useState<Record<string, Mark> | null>(null);

  useEffect(() => {
    void whoAmI().then(async (me) => {
      if (!me.signedIn || books.length === 0) return;
      const slugs = books.map((b) => b.slug).join(",");
      const res = await fetch(`/api/me/marks?books=${encodeURIComponent(slugs)}`).catch(() => null);
      if (res?.ok) setMarks(((await res.json()) as { marks: Record<string, Mark> }).marks);
    });
  }, []);

  // Tag the reading-order rows the server rendered (the same for everyone) with this reader's marks.
  useEffect(() => {
    if (!marks) return;
    for (const b of books) {
      const row = document.querySelector(`.book-list [data-book="${CSS.escape(b.slug)}"]`);
      if (!row) continue;
      const mark = marks[b.slug];
      row.classList.toggle("mark-done", finished(mark));
      row.querySelector(".mark-tag")?.remove();
      if (!mark) continue;
      const tag = document.createElement("span");
      tag.className = `mark-tag mark-${mark}`;
      tag.textContent = TAGS[mark];
      row.querySelector("h3")?.appendChild(tag);
    }
  }, [marks]);

  if (!marks) return null;
  const done = books.filter((b) => finished(marks[b.slug])).length;
  const next = books.find((b) => !finished(marks[b.slug]));
  const complete = done === books.length;
  return (
    <section class={complete ? "status-screen series-progress complete" : "status-screen series-progress"}>
      <p class="label">{complete ? "[Series complete!]" : "[Series progress]"}</p>
      <div class="xp">
        <progress max={books.length} value={done} aria-label={`${done} of ${books.length} books read`} />
        <span class="xp-count" aria-hidden="true">
          {done}/{books.length} read
        </span>
      </div>
      {complete ? (
        <p>Every book here, read. Follow the series to hear the moment the next one is announced.</p>
      ) : (
        next && (
          <p>
            {done === 0 ? "Start with" : "Next up"}: <a href={`/books/${next.slug}`}>{next.title}</a>
          </p>
        )
      )}
    </section>
  );
}
