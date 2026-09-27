// Post shortcodes (DESIGN §14.4, §14.7): `[[book:ID]]`, `[[series:ID]]`, `[[author:ID]]` (an id or a
// slug), `[[releases tag="dungeon-core" month="2026-11"]]` and `[[newsletter-signup]]`. A shortcode
// alone in a paragraph becomes a block (a live book card, a release list); inside a sentence it
// becomes a link with the live title. They are resolved when the page renders, so a roundup follows
// the catalog: if a date moves after publication, the post shows the new one.

import { and, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "../db";
import { authors, books, series } from "../db/schema";
import { type BookListItem, bookItems, releasesBetween, type UpcomingRelease } from "../site/pages";

export type EntityKind = "book" | "series" | "author";

export type Shortcode =
  | { kind: EntityKind; ref: string }
  | { kind: "releases"; tag: string | null; month: string | null }
  | { kind: "newsletter" };

// Matches in markdown (") and in rendered HTML (&quot;).
const Q = `(?:"|&quot;)`;
const SHORTCODE = new RegExp(
  `\\[\\[(?:(book|series|author):([A-Za-z0-9-]{1,200})|releases((?:\\s+[a-z]+=${Q}[A-Za-z0-9-]{0,80}${Q}){0,4})\\s*|(newsletter-signup))\\]\\]`,
  "g",
);

function parse(m: RegExpMatchArray): Shortcode {
  if (m[1] && m[2]) return { kind: m[1] as EntityKind, ref: m[2] };
  if (m[4]) return { kind: "newsletter" };
  const attrs = Object.fromEntries(
    [...(m[3] ?? "").matchAll(new RegExp(`([a-z]+)=${Q}([A-Za-z0-9-]{0,80})${Q}`, "g"))].map((a) => [
      a[1],
      a[2],
    ]),
  );
  const month = /^\d{4}-\d{2}$/.test(attrs.month ?? "") ? (attrs.month as string) : null;
  return { kind: "releases", tag: attrs.tag || null, month };
}

/** Every shortcode in some markdown, in order. */
export function shortcodesIn(text: string): Shortcode[] {
  return [...text.matchAll(SHORTCODE)].map(parse);
}

/** The book refs (ids or slugs) a post mentions. */
export function bookRefsIn(md: string): string[] {
  return [
    ...new Set(shortcodesIn(md).flatMap((s) => (s.kind === "book" ? [(s as { ref: string }).ref] : []))),
  ];
}

export type BodySegment =
  | { kind: "html"; html: string }
  | { kind: "book"; book: BookListItem }
  | { kind: "series"; slug: string; name: string }
  | { kind: "author"; slug: string; name: string }
  | { kind: "releases"; title: string; releases: UpcomingRelease[] }
  | { kind: "newsletter" };

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

interface Resolved {
  books: Map<string, BookListItem>;
  series: Map<string, { slug: string; name: string }>;
  authors: Map<string, { slug: string; name: string }>;
}

async function resolveRefs(db: Db, codes: Shortcode[], now: string): Promise<Resolved> {
  const refs = (kind: EntityKind) => [
    ...new Set(codes.flatMap((c) => (c.kind === kind ? [(c as { ref: string }).ref] : []))),
  ];
  const out: Resolved = { books: new Map(), series: new Map(), authors: new Map() };
  const bookRefs = refs("book").slice(0, 90);
  if (bookRefs.length) {
    const found = await db
      .select({ id: books.id, slug: books.slug })
      .from(books)
      .where(and(or(inArray(books.id, bookRefs), inArray(books.slug, bookRefs)), isNull(books.redirectTo)));
    const items = await bookItems(
      db,
      found.map((b) => b.id),
      { now },
    );
    for (const item of items) {
      out.books.set(item.id, item);
      out.books.set(item.slug, item);
    }
  }
  const seriesRefs = refs("series").slice(0, 90);
  if (seriesRefs.length)
    for (const s of await db
      .select({ id: series.id, slug: series.slug, name: series.name })
      .from(series)
      .where(or(inArray(series.id, seriesRefs), inArray(series.slug, seriesRefs)))) {
      out.series.set(s.id, s);
      out.series.set(s.slug, s);
    }
  const authorRefs = refs("author").slice(0, 90);
  if (authorRefs.length)
    for (const a of await db
      .select({ id: authors.id, slug: authors.slug, name: authors.name })
      .from(authors)
      .where(
        and(
          or(inArray(authors.id, authorRefs), inArray(authors.slug, authorRefs)),
          isNull(authors.redirectTo),
        ),
      )) {
      out.authors.set(a.id, a);
      out.authors.set(a.slug, a);
    }
  return out;
}

function inlineLink(code: Shortcode, r: Resolved): string {
  if (code.kind === "book") {
    const b = r.books.get(code.ref);
    return b ? `<a href="/books/${b.slug}">${escapeHtml(b.title)}</a>` : "";
  }
  if (code.kind === "series") {
    const s = r.series.get(code.ref);
    return s ? `<a href="/series/${s.slug}">${escapeHtml(s.name)}</a>` : "";
  }
  if (code.kind === "author") {
    const a = r.authors.get(code.ref);
    return a ? `<a href="/authors/${a.slug}">${escapeHtml(a.name)}</a>` : "";
  }
  if (code.kind === "newsletter") return `<a href="/subscribe">Get Patch Notes</a>`;
  return "";
}

const monthRange = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${month}-01`, `${month}-${String(last).padStart(2, "0")}`] as const;
};

/**
 * Turn a post's stored HTML into segments for the page: HTML with inline shortcodes resolved, and
 * blocks for shortcodes that stand alone. Unknown or unpublished refs render as nothing.
 */
export async function renderBody(db: Db, html: string, opts: { now?: string } = {}): Promise<BodySegment[]> {
  const now = opts.now ?? new Date().toISOString();
  const codes = shortcodesIn(html);
  const r = codes.length
    ? await resolveRefs(db, codes, now)
    : { books: new Map(), series: new Map(), authors: new Map() };
  const segments: BodySegment[] = [];
  const pushHtml = (h: string) => {
    const resolved = h.replace(SHORTCODE, (...m) => inlineLink(parse(m as unknown as RegExpMatchArray), r));
    if (resolved.trim()) segments.push({ kind: "html", html: resolved });
  };
  const block = new RegExp(`<p>(${SHORTCODE.source})</p>`, "g");
  let last = 0;
  for (const m of html.matchAll(block)) {
    pushHtml(html.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    const code = parse([...(m[1] ?? "").matchAll(SHORTCODE)][0] as RegExpMatchArray);
    if (code.kind === "book") {
      const b = r.books.get(code.ref);
      if (b) segments.push({ kind: "book", book: b });
    } else if (code.kind === "series" || code.kind === "author") {
      const e = (code.kind === "series" ? r.series : r.authors).get(code.ref);
      if (e) segments.push({ kind: code.kind, slug: e.slug, name: e.name });
    } else if (code.kind === "newsletter") segments.push({ kind: "newsletter" });
    else if (code.kind === "releases") {
      const month = code.month ?? now.slice(0, 7);
      const [from, to] = monthRange(month);
      const releases = await releasesBetween(db, from, to, {
        now,
        tagSlug: code.tag ?? undefined,
        limit: 60,
      });
      segments.push({
        kind: "releases",
        title: `${code.tag ? `${code.tag.replace(/-/g, " ")} ` : ""}releases, ${new Date(`${from}T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}`,
        releases,
      });
    }
  }
  pushHtml(html.slice(last));
  return segments;
}
