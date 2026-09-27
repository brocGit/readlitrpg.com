// Readers' own data (DESIGN §5.3, §9.6–9.8, QUIZZES §4): taste profiles, follows, book marks, saved
// matches and searches, private feed tokens, library imports and data exports. All of it belongs
// to one user and goes with them when they delete their account (§9.8).

import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const createdAt = () => text("created_at").notNull().default(isoNow);
const updatedAt = () => text("updated_at").notNull().default(isoNow);

export const FOLLOW_TARGETS = ["author", "series", "narrator", "tag", "book", "publisher"] as const;
export type FollowTarget = (typeof FOLLOW_TARGETS)[number];
export const FOLLOW_NOTIFY = ["digest", "instant", "none"] as const;
export const MARK_STATUS = ["loved", "read", "dnf", "want"] as const;
export type MarkStatus = (typeof MARK_STATUS)[number];
export const QUERY_KINDS = ["match", "find"] as const;
export const QUERY_ALERTS = ["digest", "instant", "none"] as const;

/**
 * A reader's stated tastes: the same inputs the match engine takes from a share link (MatchInputs),
 * kept per account. Book marks are merged in when the profile is used (see readers/profile.ts).
 */
export const readerProfiles = sqliteTable("reader_profiles", {
  userId: text("user_id").primaryKey(),
  inputs: text("inputs", { mode: "json" }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
  readerClass: text("reader_class"),
  /** 1–5 (QUIZZES §4.2), recomputed whenever the profile or marks change. */
  level: integer("level").notNull().default(1),
  /** Where the starting profile came from: quiz:{slug}:{outcome}, match, find, import, signup. */
  source: text("source"),
  onboardedAt: text("onboarded_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const follows = sqliteTable(
  "follows",
  {
    userId: text("user_id").notNull(),
    targetType: text("target_type", { enum: FOLLOW_TARGETS }).notNull(),
    targetId: text("target_id").notNull(),
    notify: text("notify", { enum: FOLLOW_NOTIFY }).notNull().default("digest"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.targetType, t.targetId] }),
    index("follows_target_idx").on(t.targetType, t.targetId),
  ],
);

export const bookMarks = sqliteTable(
  "book_marks",
  {
    userId: text("user_id").notNull(),
    bookId: text("book_id").notNull(),
    status: text("status", { enum: MARK_STATUS }).notNull(),
    /** A 1–5 star rating when it came from a library import. */
    rating: integer("rating"),
    source: text("source", { enum: ["site", "email", "import"] })
      .notNull()
      .default("site"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.bookId] }), index("book_marks_book_idx").on(t.bookId)],
);

export const savedQueries = sqliteTable(
  "saved_queries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    kind: text("kind", { enum: QUERY_KINDS }).notNull(),
    name: text("name").notNull(),
    /** The share-link encoding (match) or the /find query string (find). */
    params: text("params").notNull(),
    alert: text("alert", { enum: QUERY_ALERTS }).notNull().default("digest"),
    /** Books published after this can trigger an alert. */
    lastAlertedAt: text("last_alerted_at"),
    createdAt: createdAt(),
  },
  (t) => [index("saved_queries_user_idx").on(t.userId)],
);

/** Private calendar feeds (DESIGN §9.6): only the token's hash is stored; revoking is final. */
export const feedTokens = sqliteTable(
  "feed_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    kind: text("kind", { enum: ["ics"] })
      .notNull()
      .default("ics"),
    createdAt: createdAt(),
    revokedAt: text("revoked_at"),
  },
  (t) => [uniqueIndex("feed_tokens_hash_uq").on(t.tokenHash), index("feed_tokens_user_idx").on(t.userId)],
);

export const IMPORT_SOURCES = ["goodreads", "storygraph"] as const;

/** A Goodreads or StoryGraph library export, matched to the catalog by a job in chunks. */
export const libraryImports = sqliteTable(
  "library_imports",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    source: text("source", { enum: IMPORT_SOURCES }).notNull(),
    status: text("status", { enum: ["queued", "processing", "done", "failed"] })
      .notNull()
      .default("queued"),
    total: integer("total").notNull().default(0),
    processed: integer("processed").notNull().default(0),
    matched: integer("matched").notNull().default(0),
    createdAt: createdAt(),
    finishedAt: text("finished_at"),
  },
  (t) => [
    index("library_imports_status_idx").on(t.status, t.createdAt),
    index("library_imports_user_idx").on(t.userId),
  ],
);

export const libraryImportRows = sqliteTable(
  "library_import_rows",
  {
    importId: text("import_id").notNull(),
    rowNum: integer("row_num").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    status: text("status", { enum: ["pending", "matched", "unmatched"] })
      .notNull()
      .default("pending"),
    bookId: text("book_id"),
  },
  (t) => [primaryKey({ columns: [t.importId, t.rowNum] })],
);

/** "Export my data" (DESIGN §9.8): built by a job into PRIVATE, fetched by a signed, expiring link. */
export const dataExports = sqliteTable(
  "data_exports",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    status: text("status", { enum: ["queued", "ready", "expired"] })
      .notNull()
      .default("queued"),
    objectKey: text("object_key"),
    createdAt: createdAt(),
    readyAt: text("ready_at"),
    expiresAt: text("expires_at"),
  },
  (t) => [
    index("data_exports_status_idx").on(t.status, t.createdAt),
    index("data_exports_user_idx").on(t.userId),
  ],
);
