// Sitemaps split by type (DESIGN §17.2): an index at /sitemap.xml, then /sitemaps/{type}-{n}.xml
// with at most 10,000 URLs each. Only public records are listed; embargoed books never are.

import { and, asc, count, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import { authors, books, narrators, series } from "../db/schema";

export const SITEMAP_PAGE = 10_000;
export const SITEMAP_KINDS = ["books", "series", "authors", "narrators"] as const;
export type SitemapKind = (typeof SITEMAP_KINDS)[number];

export interface SitemapEntry {
  path: string;
  lastmod?: string | null;
}

const publicBook = (now: string) =>
  and(
    eq(books.visibility, "published"),
    isNull(books.redirectTo),
    or(isNull(books.embargoUntil), lte(books.embargoUntil, now)),
  );

// Written out with aliases so the correlated subqueries stay unambiguous (see pages.ts tagIndex).
const publicBookSql = (now: string) =>
  sql`b.visibility = 'published' and b.redirect_to is null and (b.embargo_until is null or b.embargo_until <= ${now})`;

function query(kind: SitemapKind, now: string) {
  switch (kind) {
    case "books":
      return { table: books, where: publicBook(now), prefix: "/books/" };
    case "series":
      return {
        table: series,
        where: and(
          isNull(series.redirectTo),
          sql`exists (select 1 from books b where b.series_id = "series"."id" and ${publicBookSql(now)})`,
        ),
        prefix: "/series/",
      };
    case "authors":
      return {
        table: authors,
        where: and(
          isNull(authors.redirectTo),
          sql`exists (select 1 from book_authors ba join books b on b.id = ba.book_id where ba.author_id = "authors"."id" and ${publicBookSql(now)})`,
        ),
        prefix: "/authors/",
      };
    case "narrators":
      return {
        table: narrators,
        where: sql`exists (select 1 from edition_narrators en join editions e on e.id = en.edition_id join books b on b.id = e.book_id where en.narrator_id = "narrators"."id" and ${publicBookSql(now)})`,
        prefix: "/narrators/",
      };
  }
}

export async function sitemapCounts(
  db: Db,
  now = new Date().toISOString(),
): Promise<Record<SitemapKind, number>> {
  const out = {} as Record<SitemapKind, number>;
  for (const kind of SITEMAP_KINDS) {
    const q = query(kind, now);
    const [row] = await db.select({ n: count() }).from(q.table).where(q.where);
    out[kind] = row?.n ?? 0;
  }
  return out;
}

export async function sitemapEntries(
  db: Db,
  kind: SitemapKind,
  page: number,
  now = new Date().toISOString(),
): Promise<SitemapEntry[]> {
  const q = query(kind, now);
  const lastmod = "updatedAt" in q.table ? q.table.updatedAt : q.table.createdAt;
  const rows = await db
    .select({ slug: q.table.slug, lastmod })
    .from(q.table)
    .where(q.where)
    .orderBy(asc(q.table.id))
    .limit(SITEMAP_PAGE)
    .offset((page - 1) * SITEMAP_PAGE);
  return rows.map((r) => ({ path: `${q.prefix}${r.slug}`, lastmod: r.lastmod }));
}

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function sitemapXml(entries: SitemapEntry[], origin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map(
    (e) =>
      `<url><loc>${xml(origin + e.path)}</loc>${e.lastmod ? `<lastmod>${xml(e.lastmod.slice(0, 10))}</lastmod>` : ""}</url>`,
  )
  .join("\n")}
</urlset>
`;
}

export function sitemapIndexXml(names: string[], origin: string, lastmod: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${names.map((n) => `<sitemap><loc>${xml(`${origin}/sitemaps/${n}.xml`)}</loc><lastmod>${lastmod.slice(0, 10)}</lastmod></sitemap>`).join("\n")}
</sitemapindex>
`;
}

/** Sitemap file names for the index: pages and tags, then each type split into pages. */
export function sitemapNames(counts: Record<SitemapKind, number>): string[] {
  const names = ["pages", "tags"];
  for (const kind of SITEMAP_KINDS) {
    const files = Math.max(1, Math.ceil(counts[kind] / SITEMAP_PAGE));
    for (let n = 1; n <= files; n++) if (counts[kind] > 0) names.push(`${kind}-${n}`);
  }
  return names;
}

// ---------------------------------------------------------------------------------------------
// robots.txt (DESIGN §17.2): search and citation crawlers are welcome; crawlers that only collect
// training data are not. The list is ours to keep current.

export const TRAINING_ONLY_CRAWLERS = [
  "GPTBot",
  "Google-Extended",
  "CCBot",
  "ClaudeBot",
  "anthropic-ai",
  "Applebot-Extended",
  "Bytespider",
  "meta-externalagent",
  "cohere-training-data-crawler",
  "Diffbot",
  "Omgilibot",
] as const;

export function robotsTxt(origin: string): string {
  return [
    "# Search engines and AI answer engines that cite sources are welcome (Googlebot, Bingbot,",
    "# OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot and others).",
    "User-agent: *",
    "Disallow: /api/",
    "Disallow: /account",
    "Disallow: /signin",
    "Disallow: /match/r",
    "Disallow: /search",
    "Disallow: /welcome",
    "Disallow: /subscribe/confirm",
    "Disallow: /u/",
    "Disallow: /m/",
    "Disallow: /dashboard",
    "",
    "# Crawlers that only collect training data.",
    ...TRAINING_ONLY_CRAWLERS.map((ua) => `User-agent: ${ua}`),
    "Disallow: /",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}
