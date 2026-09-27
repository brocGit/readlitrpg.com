// Catalog tables (DESIGN §5.2, §6, §7.3–7.4, §7.15). ISO timestamps, ULID ids.
// `redirect_to` on books, series and authors records merges: the loser row stays and points at the
// survivor, so URLs keep working and a merge can be undone.

import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const createdAt = () => text("created_at").notNull().default(isoNow);
const updatedAt = () => text("updated_at").notNull().default(isoNow);

/** Where a record first came from (DESIGN §7.15). */
export const ORIGINS = ["ai_seed", "admin", "author", "import", "reader", "api"] as const;
export type Origin = (typeof ORIGINS)[number];

export const VISIBILITY = ["draft", "pending", "published", "hidden", "removed"] as const;
export type Visibility = (typeof VISIBILITY)[number];
export const PUB_STATUS = ["announced", "preorder", "released", "delayed", "cancelled", "unknown"] as const;
export const HAREM = ["none", "implied", "harem", "reverse_harem", "unknown"] as const;
export type Harem = (typeof HAREM)[number];
export const AI_USE = ["human", "ai_assisted", "ai_generated", "unknown"] as const;
export const IN_SCOPE = ["yes", "borderline", "no", "unknown"] as const;
export const DATE_PRECISION = ["day", "month", "quarter", "year", "tba"] as const;
export const SERIES_STATUS = ["ongoing", "complete", "hiatus", "no_recent_releases", "unknown"] as const;
export const FORMATS = ["ebook", "audiobook", "paperback", "hardcover", "serial"] as const;
export type Format = (typeof FORMATS)[number];
export const NARRATION = ["single", "duet", "multicast", "full_cast"] as const;
export const RELEASE_KINDS = [
  "ebook",
  "audio",
  "print",
  "serial_start",
  "serial_complete",
  "ku_add",
] as const;
export const RELEASE_STATUS = ["scheduled", "confirmed", "released", "slipped", "cancelled"] as const;
export const ENRICH_STATUS = ["pending", "matched", "no_match", "error", "skipped"] as const;
export const TRUST_LEVELS = ["T-1", "T0", "T1", "T2"] as const;
export const TAG_STATUS = ["active", "proposed", "retired"] as const;

/** Who supplied a field value (DESIGN §6.4). */
export const FIELD_SOURCES = [
  "admin",
  "author_verified",
  "author",
  "api",
  "research",
  "ai",
  "reader",
  "crowd",
] as const;
export type FieldSource = (typeof FIELD_SOURCES)[number];

/** Independent confirmations that let a seeded record go public (DESIGN §7.15 publication gate). */
export const CONFIRMATION_SOURCES = [
  "openlibrary",
  "google_books",
  "creators_api",
  "research",
  "author_claim",
  "owner_check",
  "publisher_feed",
] as const;
export type ConfirmationSource = (typeof CONFIRMATION_SOURCES)[number];

export const publishers = sqliteTable(
  "publishers",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    website: text("website"),
    verifiedAt: text("verified_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("publishers_slug_uq").on(t.slug), index("publishers_name_key_idx").on(t.nameKey)],
);

export const authors = sqliteTable(
  "authors",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    bio: text("bio"),
    links: text("links", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    photoMediaId: text("photo_media_id"),
    verifiedAt: text("verified_at"),
    trustLevel: text("trust_level", { enum: TRUST_LEVELS }).notNull().default("T0"),
    publisherId: text("publisher_id"),
    newsletterUrl: text("newsletter_url"),
    patreonUrl: text("patreon_url"),
    royalroadUrl: text("royalroad_url"),
    origin: text("origin", { enum: ORIGINS }).notNull(),
    redirectTo: text("redirect_to"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("authors_slug_uq").on(t.slug), index("authors_name_key_idx").on(t.nameKey)],
);

export const universes = sqliteTable(
  "universes",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("universes_slug_uq").on(t.slug)],
);

export const series = sqliteTable(
  "series",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    status: text("status", { enum: SERIES_STATUS }).notNull().default("unknown"),
    expectedLength: integer("expected_length"),
    universeId: text("universe_id"),
    origin: text("origin", { enum: ORIGINS }).notNull(),
    redirectTo: text("redirect_to"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("series_slug_uq").on(t.slug), index("series_name_key_idx").on(t.nameKey)],
);

export const books = sqliteTable(
  "books",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    titleKey: text("title_key").notNull(),
    subtitle: text("subtitle"),
    seriesId: text("series_id"),
    seriesPosition: real("series_position"),
    /** Licensed text from a verified author only (DESIGN §6.4). */
    blurbAuthor: text("blurb_author"),
    /** Our own 2–3 sentence summary, written in an editorial run. */
    summaryAi: text("summary_ai"),
    coverMediaId: text("cover_media_id"),
    pageCount: integer("page_count"),
    wordCountEst: integer("word_count_est"),
    language: text("language").notNull().default("en"),
    visibility: text("visibility", { enum: VISIBILITY }).notNull().default("draft"),
    pubStatus: text("pub_status", { enum: PUB_STATUS }).notNull().default("unknown"),
    firstPublished: text("first_published"),
    firstPublishedPrecision: text("first_published_precision", { enum: DATE_PRECISION }),
    embargoUntil: text("embargo_until"),
    isAiGenerated: text("is_ai_generated", { enum: AI_USE }).notNull().default("unknown"),
    contentFlags: text("content_flags", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    crunchLevel: integer("crunch_level"),
    romanceLevel: integer("romance_level"),
    harem: text("harem", { enum: HAREM }).notNull().default("unknown"),
    primaryGenre: text("primary_genre"),
    inScope: text("in_scope", { enum: IN_SCOPE }).notNull().default("unknown"),
    origin: text("origin", { enum: ORIGINS }).notNull(),
    /** Set when the first independent confirmation arrives (the publication gate). */
    confirmedAt: text("confirmed_at"),
    enrichStatus: text("enrich_status", { enum: ENRICH_STATUS }).notNull().default("pending"),
    enrichedAt: text("enriched_at"),
    createdBy: text("created_by"),
    claimed: integer("claimed", { mode: "boolean" }).notNull().default(false),
    classificationVersion: integer("classification_version"),
    redirectTo: text("redirect_to"),
    publishedAt: text("published_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("books_slug_uq").on(t.slug),
    index("books_title_key_idx").on(t.titleKey),
    index("books_series_idx").on(t.seriesId, t.seriesPosition),
    index("books_visibility_idx").on(t.visibility, t.updatedAt),
    index("books_enrich_idx").on(t.enrichStatus, t.enrichedAt),
  ],
);

export const bookAuthors = sqliteTable(
  "book_authors",
  {
    bookId: text("book_id").notNull(),
    authorId: text("author_id").notNull(),
    role: text("role", { enum: ["author", "coauthor", "with"] })
      .notNull()
      .default("author"),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.authorId] }), index("book_authors_author_idx").on(t.authorId)],
);

export const narrators = sqliteTable(
  "narrators",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    links: text("links", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("narrators_slug_uq").on(t.slug), index("narrators_name_key_idx").on(t.nameKey)],
);

export const editions = sqliteTable(
  "editions",
  {
    id: text("id").primaryKey(),
    bookId: text("book_id").notNull(),
    format: text("format", { enum: FORMATS }).notNull(),
    asin: text("asin"),
    isbn13: text("isbn13"),
    audibleAsin: text("audible_asin"),
    publisherId: text("publisher_id"),
    narrationType: text("narration_type", { enum: NARRATION }),
    durationMinutes: integer("duration_minutes"),
    kindleUnlimited: integer("kindle_unlimited", { mode: "boolean" }),
    audiblePlus: integer("audible_plus", { mode: "boolean" }),
    priceCents: integer("price_cents"),
    currency: text("currency"),
    priceCheckedAt: text("price_checked_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("editions_book_idx").on(t.bookId),
    uniqueIndex("editions_asin_uq").on(t.asin),
    uniqueIndex("editions_isbn13_uq").on(t.isbn13),
    uniqueIndex("editions_audible_asin_uq").on(t.audibleAsin),
  ],
);

export const editionNarrators = sqliteTable(
  "edition_narrators",
  {
    editionId: text("edition_id").notNull(),
    narratorId: text("narrator_id").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.editionId, t.narratorId] }),
    index("edition_narrators_narrator_idx").on(t.narratorId),
  ],
);

export const releases = sqliteTable(
  "releases",
  {
    id: text("id").primaryKey(),
    bookId: text("book_id").notNull(),
    editionId: text("edition_id"),
    kind: text("kind", { enum: RELEASE_KINDS }).notNull(),
    date: text("date"),
    datePrecision: text("date_precision", { enum: DATE_PRECISION }).notNull(),
    region: text("region").notNull().default("US"),
    status: text("status", { enum: RELEASE_STATUS }).notNull().default("scheduled"),
    confirmedBy: text("confirmed_by", { enum: ["author", "api", "admin", "ai", "publisher"] }),
    confirmedAt: text("confirmed_at"),
    previousDate: text("previous_date"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("releases_book_idx").on(t.bookId), index("releases_date_idx").on(t.date)],
);

export const bookLinks = sqliteTable(
  "book_links",
  {
    id: text("id").primaryKey(),
    bookId: text("book_id").notNull(),
    editionId: text("edition_id"),
    kind: text("kind").notNull(),
    url: text("url").notNull(),
    region: text("region"),
    affiliateEligible: integer("affiliate_eligible", { mode: "boolean" }).notNull().default(false),
    verified: integer("verified", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("book_links_book_url_uq").on(t.bookId, t.url)],
);

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    facet: text("facet").notNull(),
    description: text("description").notNull(),
    includeWhen: text("include_when"),
    examples: text("examples"),
    parentId: text("parent_id"),
    synonyms: text("synonyms", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    commonlyExcluded: integer("commonly_excluded", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: TAG_STATUS }).notNull().default("active"),
    replacedBy: text("replaced_by"),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("tags_slug_uq").on(t.slug), index("tags_facet_idx").on(t.facet, t.sort)],
);

/** One row per book and tag, with the evidence behind its score (DESIGN §6.2). */
export const bookTags = sqliteTable(
  "book_tags",
  {
    bookId: text("book_id").notNull(),
    tagId: text("tag_id").notNull(),
    score: real("score").notNull().default(0),
    aiConfidence: real("ai_confidence"),
    authorAsserted: integer("author_asserted", { mode: "boolean" }),
    crowdUp: integer("crowd_up").notNull().default(0),
    crowdDown: integer("crowd_down").notNull().default(0),
    adminLocked: integer("admin_locked", { mode: "boolean" }).notNull().default(false),
    adminValue: real("admin_value"),
    sources: text("sources", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.tagId] }), index("book_tags_tag_idx").on(t.tagId, t.score)],
);

/** Append-only provenance for every scalar book field (DESIGN §6.4). */
export const bookFieldSources = sqliteTable(
  "book_field_sources",
  {
    id: text("id").primaryKey(),
    bookId: text("book_id").notNull(),
    field: text("field").notNull(),
    value: text("value", { mode: "json" }),
    source: text("source", { enum: FIELD_SOURCES }).notNull(),
    sourceRef: text("source_ref"),
    confidence: real("confidence"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("book_field_sources_book_idx").on(t.bookId, t.field)],
);

/** Taste dials and book stats (DESIGN §6.6, §6.7). Values 0–10. */
export const bookScores = sqliteTable(
  "book_scores",
  {
    bookId: text("book_id").notNull(),
    key: text("key").notNull(),
    kind: text("kind", { enum: ["dial", "stat"] }).notNull(),
    value: real("value"),
    confidence: real("confidence"),
    aiValue: real("ai_value"),
    aiConfidence: real("ai_confidence"),
    authorValue: real("author_value"),
    crowdMean: real("crowd_mean"),
    crowdN: integer("crowd_n").notNull().default(0),
    adminLocked: integer("admin_locked", { mode: "boolean" }).notNull().default(false),
    public: integer("public", { mode: "boolean" }).notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.key] })],
);

/** Precomputed neighbors for "books like X". Derived: rebuilt, never backed up. */
export const bookSimilar = sqliteTable(
  "book_similar",
  {
    bookId: text("book_id").notNull(),
    similarId: text("similar_id").notNull(),
    score: real("score").notNull(),
    reason: text("reason", { mode: "json" }),
    computedAt: text("computed_at").notNull().default(isoNow),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.similarId] })],
);

export const media = sqliteTable(
  "media",
  {
    id: text("id").primaryKey(),
    bucket: text("bucket").notNull(),
    key: text("key").notNull(),
    mime: text("mime").notNull(),
    bytes: integer("bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    sha256: text("sha256").notNull(),
    uploadedBy: text("uploaded_by"),
    purpose: text("purpose", { enum: ["cover", "author_photo", "blog", "ad"] }).notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected"] })
      .notNull()
      .default("pending"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("media_key_uq").on(t.bucket, t.key), index("media_sha256_idx").on(t.sha256)],
);

/** Independent evidence that a record is real (DESIGN §7.15). One is enough to publish a seed. */
export const catalogConfirmations = sqliteTable(
  "catalog_confirmations",
  {
    id: text("id").primaryKey(),
    subjectType: text("subject_type", { enum: ["book", "series", "author"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    source: text("source", { enum: CONFIRMATION_SOURCES }).notNull(),
    sourceRef: text("source_ref").notNull().default(""),
    evidence: text("evidence", { mode: "json" }),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("catalog_confirmations_uq").on(t.subjectType, t.subjectId, t.source, t.sourceRef),
    index("catalog_confirmations_subject_idx").on(t.subjectType, t.subjectId),
  ],
);

/** Every merge, with the child rows it moved, so it can be undone (DESIGN §7.4). */
export const catalogMerges = sqliteTable(
  "catalog_merges",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type", { enum: ["book", "series", "author"] }).notNull(),
    winnerId: text("winner_id").notNull(),
    loserId: text("loser_id").notNull(),
    moved: text("moved", { mode: "json" }).notNull(),
    mergedBy: text("merged_by").notNull(),
    mergedAt: text("merged_at").notNull().default(isoNow),
    undoneAt: text("undone_at"),
    undoneBy: text("undone_by"),
  },
  (t) => [index("catalog_merges_loser_idx").on(t.entityType, t.loserId)],
);

export const IMPORT_STATUS = ["queued", "processing", "done", "failed", "cancelled"] as const;

/** A bulk import (CSV, seed file, Open Library dump extract), processed in chunks by a job. */
export const catalogImports = sqliteTable(
  "catalog_imports",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["csv", "seed", "ol_dump"] }).notNull(),
    filename: text("filename"),
    status: text("status", { enum: IMPORT_STATUS }).notNull().default("queued"),
    /** Field source for everything the import writes: admin for the owner's own files, ai for seeds. */
    fieldSource: text("field_source", { enum: FIELD_SOURCES }).notNull(),
    origin: text("origin", { enum: ORIGINS }).notNull(),
    total: integer("total").notNull().default(0),
    processed: integer("processed").notNull().default(0),
    created: integer("created").notNull().default(0),
    matched: integer("matched").notNull().default(0),
    flagged: integer("flagged").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    finishedAt: text("finished_at"),
  },
  (t) => [index("catalog_imports_status_idx").on(t.status, t.createdAt)],
);

export const catalogImportRows = sqliteTable(
  "catalog_import_rows",
  {
    importId: text("import_id").notNull(),
    rowNum: integer("row_num").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    status: text("status", { enum: ["pending", "done", "error"] })
      .notNull()
      .default("pending"),
    result: text("result", { mode: "json" }),
    processedAt: text("processed_at"),
  },
  (t) => [
    primaryKey({ columns: [t.importId, t.rowNum] }),
    index("catalog_import_rows_status_idx").on(t.importId, t.status),
  ],
);
