import { LIVING_LISTS } from "@rlr/core/match";
import { liveQuizzes } from "@rlr/core/quiz";
import {
  SITEMAP_KINDS,
  type SitemapEntry,
  type SitemapKind,
  sitemapEntries,
  sitemapXml,
  tagIndex,
} from "@rlr/core/site";
import type { APIRoute } from "astro";
import { getMatrix } from "../../lib/match";
import { getDb } from "../../lib/runtime";
import { origin, pageOptions } from "../../lib/site";

const xmlResponse = (entries: SitemapEntry[]) =>
  new Response(sitemapXml(entries, origin()), {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });

/** One sitemap file: `pages`, `tags`, or `{books|series|authors|narrators}-{n}`. */
export const GET: APIRoute = async ({ params, locals }) => {
  const name = params.name ?? "";
  const db = getDb();
  if (name === "pages") {
    const quizzes = await liveQuizzes(db);
    const m = await getMatrix();
    // Books-like pages are indexable only for well-documented books (see books-like/[slug].astro).
    const booksLike =
      m && m.n >= 50
        ? m.slugs.filter((_, i) => (m.quality[i] ?? 0) >= 60).map((s) => `/books-like/${s}`)
        : [];
    return xmlResponse(
      [
        "/",
        "/match",
        "/match/quiz",
        "/find",
        "/new",
        "/tags",
        "/for-authors",
        "/subscribe",
        "/lists",
        ...LIVING_LISTS.map((l) => `/lists/${l.slug}`),
        "/quiz",
        ...quizzes.flatMap((q) => [
          `/quiz/${q.slug}`,
          ...(q.kind === "fun" ? q.outcomes.map((o) => `/quiz/${q.slug}/r/${o.key}`) : []),
        ]),
        ...booksLike.slice(0, 10_000),
      ].map((path) => ({ path })),
    );
  }
  if (name === "tags") {
    const tags = await tagIndex(db, pageOptions(await locals.settings()));
    return xmlResponse(tags.filter((t) => t.books > 0).map((t) => ({ path: `/tags/${t.slug}` })));
  }
  const m = /^([a-z]+)-(\d{1,4})$/.exec(name);
  const kind = m?.[1] as SitemapKind | undefined;
  if (!m || !kind || !SITEMAP_KINDS.includes(kind)) return new Response("Not found", { status: 404 });
  const entries = await sitemapEntries(db, kind, Number(m[2]));
  if (entries.length === 0) return new Response("Not found", { status: 404 });
  return xmlResponse(entries);
};
