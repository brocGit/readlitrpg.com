// Ingest (DESIGN §7.3 steps 1–2 and the write side of 3): normalize, resolve entities, then write
// everything with provenance. Every source goes through here: quick-add, CSV, seeds, API results.
//
// D1 has no interactive transactions, so each step is idempotent: re-running the same input finds
// the same records and writes nothing new. A half-finished ingest leaves a draft, never a public book.

import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import {
  bookAuthors,
  bookLinks,
  books,
  type ConfirmationSource,
  editionNarrators,
  editions,
  type FieldSource,
  type Format,
  type Origin,
  releases,
  series,
} from "../db/schema";
import { ulid } from "../ids";
import { openInboxItem } from "../inbox";
import { canonicalTagSlug, findTag, GENRE_SLUGS } from "../taxonomy";
import { nowIso } from "../time";
import { addConfirmation } from "./confirm";
import { type FieldWrite, writeBookFields } from "./fields";
import type { BookInput, EditionInput } from "./input";
import {
  cleanText,
  extractVolume,
  hasMixedScripts,
  normalizeAsin,
  normalizeIsbn,
  parseDate,
  parseLink,
  titleKey,
} from "./normalize";
import { CONFIDENCE_VALUES } from "./provenance";
import {
  findOrCreateAuthor,
  findOrCreateNarrator,
  findOrCreatePublisher,
  findOrCreateSeries,
  type MatchKind,
  matchBook,
  uniqueSlug,
} from "./resolve";
import { writeBookTags } from "./tags";

export interface IngestContext {
  source: FieldSource;
  /** Origin recorded on records this ingest creates. */
  origin: Origin;
  sourceRef?: string;
  actorId?: string | null;
  /** Record an independent confirmation for the book (e.g. owner_check for the owner's quick-add). */
  confirmation?: { source: ConfirmationSource; ref?: string; evidence?: unknown };
  fuzzyMin: number;
  crowdMinVotes: number;
}

export interface IngestResult {
  bookId: string;
  created: boolean;
  matchedBy: MatchKind | "created";
  duplicates: { bookId: string; similarity: number; reason: string }[];
  warnings: string[];
}

/** Sources trusted to add co-authors, authors' own websites and series status. */
const TRUSTED: FieldSource[] = ["admin", "author_verified", "api", "research"];

export async function ingestBook(db: Db, input: BookInput, ctx: IngestContext): Promise<IngestResult> {
  const warnings: string[] = [];
  const title = cleanText(input.title);
  const key = titleKey(title);
  if (!key) throw new Error("title has no letters or numbers");
  if (hasMixedScripts(title) || input.authors.some((a) => hasMixedScripts(a.name))) {
    warnings.push("mixed alphabets in the title or an author name (possible look-alike spoof)");
  }

  // Authors and series.
  const authorIds: string[] = [];
  for (const a of input.authors) {
    const r = await findOrCreateAuthor(db, a.name, ctx.origin);
    if (r.warning) warnings.push(r.warning);
    if (!authorIds.includes(r.id)) authorIds.push(r.id);
  }
  let seriesId: string | null = null;
  if (input.series) {
    const r = await findOrCreateSeries(db, input.series.name, authorIds, ctx.origin);
    if (r.warning) warnings.push(r.warning);
    seriesId = r.id;
  }
  const position = input.series ? (input.series.position ?? extractVolume(title)) : null;

  // Identifiers from editions and from retail links.
  const parsedLinks = (input.links ?? []).map((raw) => ({ raw, result: parseLink(raw) }));
  const editionInputs: EditionInput[] = [...(input.editions ?? [])];
  for (const { result } of parsedLinks) {
    if (!result.ok || !result.link.asin) continue;
    const asin = result.link.asin;
    if (result.link.kind === "amazon" && !editionInputs.some((e) => normalizeAsin(e.asin) === asin)) {
      editionInputs.push({ format: "ebook", asin });
    }
    if (result.link.kind === "audible" && !editionInputs.some((e) => normalizeAsin(e.audibleAsin) === asin)) {
      editionInputs.push({ format: "audiobook", audibleAsin: asin });
    }
  }
  const normEditions = editionInputs.map((e) => ({
    ...e,
    asin: normalizeAsin(e.asin),
    isbn13: normalizeIsbn(e.isbn),
    audibleAsin: normalizeAsin(e.audibleAsin),
  }));
  for (const e of editionInputs) {
    if (e.isbn && !normalizeIsbn(e.isbn)) warnings.push(`ignored invalid ISBN ${e.isbn}`);
    if (e.asin && !normalizeAsin(e.asin)) warnings.push(`ignored invalid ASIN ${e.asin}`);
  }

  const { match, candidates } = await matchBook(
    db,
    {
      asins: normEditions.map((e) => e.asin).filter((v): v is string => !!v),
      isbns: normEditions.map((e) => e.isbn13).filter((v): v is string => !!v),
      audibleAsins: normEditions.map((e) => e.audibleAsin).filter((v): v is string => !!v),
      authorIds,
      titleKey: key,
      title,
      seriesId,
      position,
    },
    ctx.fuzzyMin,
  );

  let bookId: string;
  let created = false;
  if (match) {
    bookId = match.bookId;
  } else {
    bookId = ulid();
    created = true;
    const firstAuthor = input.authors[0]?.name ?? "";
    await db.insert(books).values({
      id: bookId,
      slug: await uniqueSlug(db, books, title, [firstAuthor]),
      title,
      titleKey: key,
      origin: ctx.origin,
      createdBy: ctx.actorId ?? null,
    });
  }

  // Authors on the book. New books get everyone; trusted sources can add co-authors later.
  const existingAuthors = new Set(
    (
      await db.select({ id: bookAuthors.authorId }).from(bookAuthors).where(eq(bookAuthors.bookId, bookId))
    ).map((r) => r.id),
  );
  const missing = authorIds.filter((id) => !existingAuthors.has(id));
  if (missing.length && (created || existingAuthors.size === 0 || TRUSTED.includes(ctx.source))) {
    await db
      .insert(bookAuthors)
      .values(
        missing.map((authorId) => ({
          bookId,
          authorId,
          role:
            input.authors[authorIds.indexOf(authorId)]?.role ??
            (authorIds.indexOf(authorId) === 0 ? "author" : "coauthor"),
          position: authorIds.indexOf(authorId),
        })),
      )
      .onConflictDoNothing();
  } else if (missing.length) {
    warnings.push("the author list differs from the existing record; not changed");
  }

  // Scalar fields, with provenance.
  const confidence = input.confidence ?? null;
  const date = input.firstPublished ? parseDate(input.firstPublished) : null;
  if (input.firstPublished && !date) warnings.push(`couldn't read the date "${input.firstPublished}"`);
  let primaryGenre = input.primaryGenre ? (findTag(input.primaryGenre)?.slug ?? null) : undefined;
  if (primaryGenre !== undefined && (primaryGenre === null || !GENRE_SLUGS.has(primaryGenre))) {
    warnings.push(`"${input.primaryGenre}" isn't a genre`);
    primaryGenre = undefined;
  }
  const fields: FieldWrite[] = [
    { field: "title", value: title, confidence },
    { field: "subtitle", value: input.subtitle ? cleanText(input.subtitle) : undefined },
    { field: "seriesId", value: seriesId ?? undefined },
    { field: "seriesPosition", value: position ?? undefined },
    { field: "firstPublished", value: date ?? undefined },
    { field: "pageCount", value: input.pageCount },
    { field: "wordCountEst", value: input.wordCountEst },
    { field: "language", value: input.language },
    { field: "pubStatus", value: input.pubStatus },
    { field: "primaryGenre", value: primaryGenre, confidence },
    { field: "inScope", value: input.inScope, confidence },
    { field: "crunchLevel", value: input.crunchLevel, confidence },
    { field: "romanceLevel", value: input.romanceLevel, confidence },
    { field: "harem", value: input.harem, confidence },
    { field: "contentFlags", value: input.contentFlags, confidence },
    { field: "isAiGenerated", value: input.isAiGenerated },
    { field: "blurbAuthor", value: input.blurb ? cleanText(input.blurb) : undefined },
  ];
  await writeBookFields(db, bookId, fields, {
    source: ctx.source,
    sourceRef: ctx.sourceRef,
    createdBy: ctx.actorId,
  });

  if (seriesId && input.series?.status && input.series.status !== "unknown") {
    const [s] = await db.select({ status: series.status }).from(series).where(eq(series.id, seriesId));
    if (s && (s.status === "unknown" || TRUSTED.includes(ctx.source))) {
      await db
        .update(series)
        .set({ status: input.series.status, updatedAt: nowIso() })
        .where(eq(series.id, seriesId));
    }
  }

  // Editions, links, releases, tags.
  const duplicates: IngestResult["duplicates"] = candidates.map((c) => ({ ...c, reason: "similar title" }));
  for (const e of normEditions) {
    const conflict = await upsertEdition(db, bookId, e, ctx.source);
    if (conflict) {
      warnings.push(`an identifier is already on another book`);
      duplicates.push({ bookId: conflict, similarity: 1, reason: "shared identifier" });
    }
  }
  for (const { raw, result } of parsedLinks) {
    if (!result.ok) {
      warnings.push(`link skipped (${result.reason}): ${raw.slice(0, 80)}`);
      continue;
    }
    let kind: string = result.link.kind;
    if (kind === "other") {
      if (!TRUSTED.includes(ctx.source) && ctx.source !== "author") {
        warnings.push(`link skipped (not a known store or platform): ${result.link.url.slice(0, 80)}`);
        continue;
      }
      kind = "author_site";
    }
    await db
      .insert(bookLinks)
      .values({ id: ulid(), bookId, kind, url: result.link.url, region: result.link.region })
      .onConflictDoNothing();
  }
  for (const r of input.releases ?? []) {
    const d = parseDate(r.date);
    if (!d) {
      warnings.push(`release date "${r.date}" unreadable`);
      continue;
    }
    await addRelease(db, bookId, r.kind, d, r.region ?? "US", ctx.source);
  }
  if (input.tags?.length) {
    const writes = [];
    for (const t of input.tags) {
      const slug = canonicalTagSlug(findTag(t.slug)?.slug ?? t.slug);
      if (!slug) {
        warnings.push(`unknown tag "${t.slug}"`);
        continue;
      }
      writes.push({
        slug,
        value: t.confidence ?? confidence ?? (ctx.source === "ai" ? CONFIDENCE_VALUES.medium : 1),
      });
    }
    const { unknown } = await writeBookTags(db, bookId, writes, ctx.source, ctx.crowdMinVotes);
    for (const u of unknown) warnings.push(`tag "${u}" isn't active in the database (run the taxonomy sync)`);
  }

  if (ctx.confirmation) {
    await addConfirmation(db, {
      subjectType: "book",
      subjectId: bookId,
      source: ctx.confirmation.source,
      sourceRef: ctx.confirmation.ref,
      evidence: ctx.confirmation.evidence,
      createdBy: ctx.actorId,
    });
  }

  const unique = duplicates.filter(
    (d, i) => d.bookId !== bookId && duplicates.findIndex((x) => x.bookId === d.bookId) === i,
  );
  for (const d of unique) {
    const pair = [bookId, d.bookId].sort().join(":");
    await openInboxItem(db, {
      type: "possible_duplicate",
      title: `Possible duplicate: "${title}"`,
      subjectType: "book",
      subjectId: bookId,
      priority: 40,
      payload: {
        bookId,
        otherId: d.bookId,
        similarity: Math.round(d.similarity * 100) / 100,
        reason: d.reason,
      },
      dedupeKey: `dup:${pair}`,
    });
  }
  return { bookId, created, matchedBy: match?.by ?? "created", duplicates: unique, warnings };
}

type NormEdition = Omit<EditionInput, "asin" | "audibleAsin"> & {
  asin: string | null;
  isbn13: string | null;
  audibleAsin: string | null;
};

/** Insert or fill in an edition. Returns another book's id if an identifier already belongs to it. */
async function upsertEdition(
  db: Db,
  bookId: string,
  e: NormEdition,
  source: FieldSource,
): Promise<string | null> {
  const ids = [
    e.asin ? eq(editions.asin, e.asin) : undefined,
    e.isbn13 ? eq(editions.isbn13, e.isbn13) : undefined,
    e.audibleAsin ? eq(editions.audibleAsin, e.audibleAsin) : undefined,
  ].filter((c) => c !== undefined);
  let existing: typeof editions.$inferSelect | undefined;
  for (const condition of ids) {
    [existing] = await db.select().from(editions).where(condition);
    if (existing) break;
  }
  if (!existing && ids.length === 0) {
    // No identifiers: one edition per format is enough to record that the format exists.
    [existing] = await db
      .select()
      .from(editions)
      .where(and(eq(editions.bookId, bookId), eq(editions.format, e.format as Format)));
  }
  if (existing && existing.bookId !== bookId) return existing.bookId;

  const publisherId = e.publisher ? await findOrCreatePublisher(db, e.publisher) : undefined;
  const fill = {
    asin: e.asin ?? undefined,
    isbn13: e.isbn13 ?? undefined,
    audibleAsin: e.audibleAsin ?? undefined,
    publisherId,
    narrationType: e.narrationType,
    durationMinutes: e.durationMinutes,
    kindleUnlimited: e.kindleUnlimited,
    audiblePlus: e.audiblePlus,
  };
  let editionId: string;
  if (existing) {
    editionId = existing.id;
    // Fill gaps; only the owner or a verified author overwrites what's there.
    const overwrite = source === "admin" || source === "author_verified";
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fill)) {
      if (v === undefined) continue;
      if (overwrite || (existing as Record<string, unknown>)[k] === null) patch[k] = v;
    }
    if (Object.keys(patch).length) {
      await db
        .update(editions)
        .set({ ...patch, updatedAt: nowIso() })
        .where(eq(editions.id, existing.id));
    }
  } else {
    editionId = ulid();
    await db.insert(editions).values({ id: editionId, bookId, format: e.format as Format, ...fill });
  }
  for (const [i, n] of (e.narrators ?? []).entries()) {
    const narratorId = await findOrCreateNarrator(db, n);
    await db.insert(editionNarrators).values({ editionId, narratorId, position: i }).onConflictDoNothing();
  }
  return null;
}

async function addRelease(
  db: Db,
  bookId: string,
  kind: (typeof releases.$inferInsert)["kind"],
  d: { date: string | null; precision: (typeof releases.$inferInsert)["datePrecision"] },
  region: string,
  source: FieldSource,
): Promise<void> {
  const existing = await db
    .select({ id: releases.id, date: releases.date })
    .from(releases)
    .where(and(eq(releases.bookId, bookId), eq(releases.kind, kind), eq(releases.region, region)));
  if (existing.some((r) => r.date === d.date)) return;
  const today = new Date().toISOString().slice(0, 10);
  const confirmedBy =
    source === "admin" ? "admin" : source.startsWith("author") ? "author" : source === "api" ? "api" : "ai";
  await db.insert(releases).values({
    id: ulid(),
    bookId,
    kind,
    date: d.date,
    datePrecision: d.precision,
    region,
    status: d.date && d.precision === "day" && d.date <= today ? "released" : "scheduled",
    confirmedBy,
    confirmedAt: nowIso(),
  });
}
