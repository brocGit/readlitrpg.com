// Email lists, consent and delivery (DESIGN §5.4, §13). Consent is per list, recorded with its source
// and a daily-salted IP hash; suppressions are email hashes, so an address that asked us to stop is
// never mailed again, even after its account is gone.

import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/**
 * weekly_digest: Patch Notes (§13.5). daily_digest: Patch Notes Daily, the morning roundup (M7,
 * opt-in, §14.6). release_alerts: one bundled email a day on release days
 * (§13.6). reading_list: the one-off quiz reading list and welcome emails for "just the list".
 */
export const EMAIL_LISTS = ["weekly_digest", "daily_digest", "release_alerts", "reading_list"] as const;
export type EmailList = (typeof EMAIL_LISTS)[number];
export const CONSENT_STATUS = ["pending", "active", "unsubscribed"] as const;

export const emailConsents = sqliteTable(
  "email_consents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    list: text("list", { enum: EMAIL_LISTS }).notNull(),
    status: text("status", { enum: CONSENT_STATUS }).notNull().default("pending"),
    /** quiz:{slug}:{outcome}, account, signup… */
    source: text("source").notNull(),
    ipHash: text("ip_hash"),
    confirmTokenHash: text("confirm_token_hash"),
    consentedAt: text("consented_at").notNull().default(isoNow),
    confirmedAt: text("confirmed_at"),
    unsubscribedAt: text("unsubscribed_at"),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (t) => [
    uniqueIndex("email_consents_user_list_uq").on(t.userId, t.list),
    index("email_consents_token_idx").on(t.confirmTokenHash),
    index("email_consents_list_idx").on(t.list, t.status, t.userId),
  ],
);

export const SUPPRESSION_REASONS = [
  "bounce_hard",
  "complaint",
  "manual",
  "unsub_all",
  "account_deleted",
] as const;

export const suppressions = sqliteTable("suppressions", {
  emailHash: text("email_hash").primaryKey(),
  reason: text("reason", { enum: SUPPRESSION_REASONS }).notNull(),
  createdAt: text("created_at").notNull().default(isoNow),
});

export const SEND_STATUS = ["sent", "suppressed", "failed", "bounced", "complained", "delivered"] as const;

/** Delivery log, kept 90 days (§16.2). */
export const emailSends = sqliteTable(
  "email_sends",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    template: text("template").notNull(),
    issueId: text("issue_id"),
    providerMessageId: text("provider_message_id"),
    status: text("status", { enum: SEND_STATUS }).notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [
    index("email_sends_provider_idx").on(t.providerMessageId),
    index("email_sends_created_idx").on(t.createdAt),
    index("email_sends_issue_idx").on(t.issueId, t.status),
  ],
);

/** Where each reader is in a timed sequence, e.g. the welcome emails (QUIZZES §3.4). */
export const emailSequences = sqliteTable(
  "email_sequences",
  {
    userId: text("user_id").notNull(),
    sequence: text("sequence", { enum: ["welcome", "list_only"] }).notNull(),
    step: integer("step").notNull().default(1),
    nextAt: text("next_at"),
    context: text("context", { mode: "json" }).$type<Record<string, string>>().notNull().default(sql`'{}'`),
    startedAt: text("started_at").notNull().default(isoNow),
    doneAt: text("done_at"),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.sequence] }),
    index("email_sequences_due_idx").on(t.doneAt, t.nextAt),
  ],
);

/** One weekly issue of Patch Notes (§13.5): frozen Thursday, fanned out Friday in chunks. */
export const newsletterIssues = sqliteTable(
  "newsletter_issues",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["weekly", "daily"] })
      .notNull()
      .default("weekly"),
    week: text("week").notNull(),
    status: text("status", { enum: ["building", "ready", "sending", "sent", "paused", "failed"] }).notNull(),
    /** The frozen candidates: new and upcoming books, the featured quiz. */
    content: text("content", { mode: "json" }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
    /** Keyset cursor over subscriber ids while sending. */
    cursor: text("cursor").notNull().default(""),
    stats: text("stats", { mode: "json" }).$type<Record<string, number>>().notNull().default(sql`'{}'`),
    createdAt: text("created_at").notNull().default(isoNow),
    sentAt: text("sent_at"),
  },
  (t) => [uniqueIndex("newsletter_issues_week_uq").on(t.kind, t.week)],
);
