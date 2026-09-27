// Reader-side tables for M3 (DESIGN §5.6, §6.7, §9.3, QUIZZES §4.3): quiz takes and their daily
// aggregates, which quizzes are live, and appraisals.

import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/**
 * One quiz response. The id is a random token kept in the reader's browser, which is what lets a
 * take attach to an account later on the same browser. Anonymous takes are deleted after 90 days;
 * `quiz_daily` keeps the counts.
 */
export const quizTakes = sqliteTable(
  "quiz_takes",
  {
    id: text("id").primaryKey(),
    quizSlug: text("quiz_slug").notNull(),
    userId: text("user_id"),
    answers: text("answers", { mode: "json" }).$type<string[]>().notNull(),
    outcomeKey: text("outcome_key").notNull(),
    score: integer("score"),
    /** Where the reader came from: share, search, community, author, onsite. */
    source: text("source").notNull().default("onsite"),
    /** The take that invited this one (Party up). */
    partyRef: text("party_ref"),
    createdAt: text("created_at").notNull().default(isoNow),
    attachedAt: text("attached_at"),
  },
  (t) => [
    index("quiz_takes_quiz_idx").on(t.quizSlug, t.createdAt),
    index("quiz_takes_user_idx").on(t.userId),
  ],
);

/** Counts that outlive the takes themselves. */
export const quizDaily = sqliteTable(
  "quiz_daily",
  {
    quizSlug: text("quiz_slug").notNull(),
    day: text("day").notNull(),
    outcomeKey: text("outcome_key").notNull(),
    takes: integer("takes").notNull().default(0),
    parties: integer("parties").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.quizSlug, t.day, t.outcomeKey] })],
);

/** Quiz content lives in git; whether a quiz is live is the owner's call (no row = not live). */
export const quizStatus = sqliteTable("quiz_status", {
  slug: text("slug").primaryKey(),
  status: text("status", { enum: ["live", "retired"] }).notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: text("updated_at").notNull().default(isoNow),
});

export const APPRAISAL_STATUS = ["counted", "held", "rejected"] as const;

/**
 * A reader's appraisal of one dial or stat of one book (DESIGN §6.7): one per reader, book and key.
 * `value` is on the 0–10 scale. Held appraisals (a burst from new accounts) don't count until
 * the owner releases them.
 */
export const appraisals = sqliteTable(
  "appraisals",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    bookId: text("book_id").notNull(),
    key: text("key").notNull(),
    value: real("value").notNull(),
    status: text("status", { enum: APPRAISAL_STATUS }).notNull().default("counted"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (t) => [
    uniqueIndex("appraisals_user_book_key_uq").on(t.userId, t.bookId, t.key),
    index("appraisals_book_idx").on(t.bookId, t.key, t.status),
  ],
);
