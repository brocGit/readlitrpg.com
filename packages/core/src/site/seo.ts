// Structured data for search engines and AI answers (DESIGN §17.2): Book with a workExample per
// format, BookSeries, Person and BreadcrumbList. Only facts we hold go in; nothing is inferred,
// and there are no ratings until readers have made them.

import type { AuthorPage, BookPage, NarratorPage, SeriesPage } from "./pages";

type Json = Record<string, unknown>;

const BOOK_FORMAT: Record<string, string> = {
  ebook: "https://schema.org/EBook",
  audiobook: "https://schema.org/AudiobookFormat",
  paperback: "https://schema.org/Paperback",
  hardcover: "https://schema.org/Hardcover",
  serial: "https://schema.org/EBook",
};

/** A date at the precision we know it: "2026", "2026-11" or "2026-11-03". */
function schemaDate(date: string | null, precision: string | null): string | undefined {
  if (!date || precision === "tba") return undefined;
  if (precision === "year") return date.slice(0, 4);
  if (precision === "month" || precision === "quarter") return date.slice(0, 7);
  return date.slice(0, 10);
}

const clean = (o: Json): Json =>
  Object.fromEntries(
    Object.entries(o).filter(
      ([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0),
    ),
  );

export function bookJsonLd(p: BookPage, origin: string, coverUrl: string | null): Json {
  const url = `${origin}/books/${p.slug}`;
  const isoDuration = (m: number | null) => (m ? `PT${Math.floor(m / 60)}H${m % 60}M` : undefined);
  return clean({
    "@context": "https://schema.org",
    "@type": "Book",
    "@id": `${url}#book`,
    name: p.title,
    alternativeHeadline: p.subtitle ?? undefined,
    url,
    author: p.authors.map((a) => ({ "@type": "Person", name: a.name, url: `${origin}/authors/${a.slug}` })),
    image: coverUrl ?? undefined,
    description: p.description?.text,
    numberOfPages: p.pageCount ?? undefined,
    datePublished: schemaDate(p.firstPublished, p.firstPublishedPrecision),
    inLanguage: "en",
    isPartOf: p.series
      ? { "@type": "BookSeries", name: p.series.name, url: `${origin}/series/${p.series.slug}` }
      : undefined,
    position: p.series?.position ?? undefined,
    keywords: p.tags.flatMap((g) => g.tags.map((t) => t.name)).join(", ") || undefined,
    workExample: p.editions.map((e) =>
      clean({
        "@type": e.format === "audiobook" ? ["Book", "Audiobook"] : "Book",
        bookFormat: BOOK_FORMAT[e.format],
        isbn: e.isbn13 ?? undefined,
        publisher: e.publisher ? { "@type": "Organization", name: e.publisher } : undefined,
        readBy: e.narrators.map((n) => ({
          "@type": "Person",
          name: n.name,
          url: `${origin}/narrators/${n.slug}`,
        })),
        duration: e.format === "audiobook" ? isoDuration(e.durationMinutes) : undefined,
      }),
    ),
    dateModified: p.updatedAt,
  });
}

export function seriesJsonLd(s: SeriesPage, origin: string): Json {
  const url = `${origin}/series/${s.slug}`;
  return clean({
    "@context": "https://schema.org",
    "@type": "BookSeries",
    "@id": `${url}#series`,
    name: s.name,
    url,
    author: s.authors.map((a) => ({ "@type": "Person", name: a.name, url: `${origin}/authors/${a.slug}` })),
    hasPart: s.books.map((b) =>
      clean({
        "@type": "Book",
        name: b.title,
        url: `${origin}/books/${b.slug}`,
        position: b.position ?? undefined,
      }),
    ),
    dateModified: s.updatedAt,
  });
}

export function personJsonLd(
  p: AuthorPage | NarratorPage,
  origin: string,
  kind: "authors" | "narrators",
): Json {
  const url = `${origin}/${kind}/${p.slug}`;
  return clean({
    "@context": "https://schema.org",
    "@type": "Person",
    "@id": `${url}#person`,
    name: p.name,
    url,
    // Only a verified author's own links: nobody else can say which profiles are theirs.
    sameAs: "links" in p ? p.links : undefined,
    description: "bio" in p ? (p.bio ?? undefined) : undefined,
  });
}

export function breadcrumbJsonLd(crumbs: { name: string; path: string }[], origin: string): Json {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: `${origin}${c.path}`,
    })),
  };
}

/** JSON for a `<script type="application/ld+json">`: `<` is escaped so text can't close the tag. */
export function jsonLdText(data: Json | Json[]): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
