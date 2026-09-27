// The author book form (DESIGN §10.3): one set of field names for "add a book" and "edit", read into
// the shapes the core validates (submissionSchema, editPatchSchema). Nothing here trusts the input:
// the core parses it again with Zod.

import { DIALS } from "@rlr/core/taxonomy";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const list = (f: FormData, k: string) =>
  str(f, k)
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
const lines = (f: FormData, k: string) =>
  str(f, k)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
const numOrNull = (f: FormData, k: string) => (str(f, k) === "" ? null : Number(str(f, k)));

export const RELEASE_FIELDS = [
  ["ebook", "date_ebook", "Ebook"],
  ["audio", "date_audio", "Audiobook"],
  ["print", "date_print", "Print"],
] as const;

function common(f: FormData) {
  const seriesName = str(f, "series_name");
  const position = str(f, "series_position");
  return {
    title: str(f, "title"),
    subtitle: str(f, "subtitle"),
    series: seriesName ? { name: seriesName, ...(position ? { position: Number(position) } : {}) } : null,
    blurb: str(f, "blurb"),
    kindleUnlimited: f.get("ku") === "on",
    narrators: list(f, "narrators"),
    tags: f.getAll("tags").map(String),
    dials: Object.fromEntries(
      DIALS.map((d) => [d.key, str(f, `dial.${d.key}`)])
        .filter(([, v]) => v !== "")
        .map(([k, v]) => [k, Number(v)]),
    ),
    crunchLevel: numOrNull(f, "crunch"),
    romanceLevel: numOrNull(f, "romance"),
    harem: str(f, "harem") || "unknown",
    contentFlags: f.getAll("flags").map(String),
    aiUse: str(f, "ai") || "unknown",
    embargoUntil: str(f, "embargo") || null,
  };
}

/** For submitBook (core `submissionSchema`). */
export function submissionFromForm(f: FormData) {
  const c = common(f);
  return {
    ...c,
    subtitle: c.subtitle || undefined,
    series: c.series ?? undefined,
    blurb: c.blurb || undefined,
    coAuthors: list(f, "coauthors"),
    primaryGenre: str(f, "genre"),
    links: lines(f, "links"),
    releases: RELEASE_FIELDS.filter(([, k]) => str(f, k)).map(([kind, k]) => ({ kind, date: str(f, k) })),
    narrationType: str(f, "narration") || undefined,
    crunchLevel: c.crunchLevel ?? undefined,
    romanceLevel: c.romanceLevel ?? undefined,
    embargoUntil: c.embargoUntil ?? undefined,
  };
}

/** For editBook (core `editPatchSchema`), before `diffEdit` drops what didn't change. */
export function editFromForm(f: FormData) {
  const c = common(f);
  return {
    ...c,
    subtitle: c.subtitle || null,
    blurb: c.blurb || null,
    addLinks: lines(f, "links"),
  };
}
