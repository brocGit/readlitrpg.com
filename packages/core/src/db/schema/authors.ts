// Authors on the site (DESIGN §2.2, §10): who manages which author profile, how they proved it,
// what they submitted, what changed on their books without them, and the release-date checks we
// send them. A profile's trust level lives on `authors.trust_level`.

import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const createdAt = () => text("created_at").notNull().default(isoNow);
const updatedAt = () => text("updated_at").notNull().default(isoNow);

export const MEMBER_ROLES = ["owner", "editor"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** A reader account that manages an author profile (§5.3). Only owners add or remove members. */
export const authorMembers = sqliteTable(
  "author_members",
  {
    authorId: text("author_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: MEMBER_ROLES }).notNull(),
    addedBy: text("added_by"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.authorId, t.userId] }), index("author_members_user_idx").on(t.userId)],
);

/** How a member proves the profile is theirs (§10.2). */
export const VERIFY_METHODS = [
  "website_file",
  "meta_tag",
  "dns_txt",
  "email_domain",
  "bluesky",
  "profile_code",
  "owner_override",
] as const;
export type VerifyMethod = (typeof VERIFY_METHODS)[number];
export const VERIFY_STATUS = ["pending", "review", "verified", "failed", "rejected", "expired"] as const;

export const verificationRequests = sqliteTable(
  "verification_requests",
  {
    id: text("id").primaryKey(),
    authorId: text("author_id").notNull(),
    userId: text("user_id").notNull(),
    method: text("method", { enum: VERIFY_METHODS }).notNull(),
    /**
     * The code the member places (rlr-verify-XXXXXX). Stored as issued: it proves nothing by itself,
     * only its presence on a channel the member controls does, and they need to see it again.
     */
    code: text("code").notNull(),
    /** The domain, handle or profile URL the code is placed on. */
    target: text("target"),
    status: text("status", { enum: VERIFY_STATUS }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    /** What the last check saw: where the code was found, or why not. */
    evidence: text("evidence", { mode: "json" }).$type<Record<string, unknown>>(),
    checkedAt: text("checked_at"),
    expiresAt: text("expires_at").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: text("decided_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("verification_requests_author_idx").on(t.authorId, t.status),
    index("verification_requests_user_idx").on(t.userId),
  ],
);

export const SUBMISSION_STATUS = ["draft", "in_review", "published", "rejected", "withdrawn"] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUS)[number];
export const SUBMISSION_SOURCES = ["form", "paste"] as const;

/**
 * A book an author submitted (§10.3), or a draft an editorial run extracted from pasted text for
 * the author to confirm. `payload` is the form as submitted; the book is created on submit.
 */
export const authorSubmissions = sqliteTable(
  "author_submissions",
  {
    id: text("id").primaryKey(),
    authorId: text("author_id").notNull(),
    userId: text("user_id"),
    bookId: text("book_id"),
    source: text("source", { enum: SUBMISSION_SOURCES }).notNull(),
    status: text("status", { enum: SUBMISSION_STATUS }).notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    reasons: text("reasons", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    inboxItemId: text("inbox_item_id"),
    pasteId: text("paste_id"),
    submittedAt: text("submitted_at"),
    decidedAt: text("decided_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("author_submissions_author_idx").on(t.authorId, t.status),
    index("author_submissions_book_idx").on(t.bookId),
  ],
);

/**
 * "Paste anything" (§10.3 step 0, §7.15): an author's pasted book list, kept until an editorial run
 * has turned it into drafts. Links are parsed at once; the rest waits for the run.
 */
export const authorPastes = sqliteTable(
  "author_pastes",
  {
    id: text("id").primaryKey(),
    authorId: text("author_id").notNull(),
    userId: text("user_id").notNull(),
    text: text("text").notNull(),
    links: text("links", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    status: text("status", { enum: ["queued", "extracted", "failed"] })
      .notNull()
      .default("queued"),
    drafts: integer("drafts").notNull().default(0),
    createdAt: createdAt(),
    extractedAt: text("extracted_at"),
  },
  (t) => [index("author_pastes_author_idx").on(t.authorId), index("author_pastes_status_idx").on(t.status)],
);

/** Changes to a book made by anyone but its author, for the daily email (§10.4). */
export const changeNotifications = sqliteTable(
  "change_notifications",
  {
    id: text("id").primaryKey(),
    authorId: text("author_id").notNull(),
    bookId: text("book_id").notNull(),
    /** Who changed it: admin, ai (an editorial run), api (enrichment), crowd, research. */
    source: text("source").notNull(),
    summary: text("summary").notNull(),
    diff: text("diff", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    emailedAt: text("emailed_at"),
  },
  (t) => [
    index("change_notifications_pending_idx").on(t.emailedAt, t.createdAt),
    index("change_notifications_author_idx").on(t.authorId, t.createdAt),
  ],
);

export const RELEASE_ASK_STAGES = ["t14", "t3", "past"] as const;
export const RELEASE_ASK_ANSWERS = ["confirmed", "new_date", "delayed"] as const;

/**
 * "Still on for Oct 12?" (§7.7): one ask per release, stage and date. The emailed links are signed
 * and name the ask; an answered ask takes no more changes (single use).
 */
export const releaseAsks = sqliteTable(
  "release_asks",
  {
    id: text("id").primaryKey(),
    releaseId: text("release_id").notNull(),
    bookId: text("book_id").notNull(),
    stage: text("stage", { enum: RELEASE_ASK_STAGES }).notNull(),
    date: text("date").notNull(),
    sentAt: text("sent_at").notNull(),
    answer: text("answer", { enum: RELEASE_ASK_ANSWERS }),
    answeredBy: text("answered_by"),
    answeredAt: text("answered_at"),
  },
  (t) => [uniqueIndex("release_asks_uq").on(t.releaseId, t.stage, t.date)],
);

export const AUTHOR_NOTICE_KINDS = [
  "listing_published",
  "listing_rejected",
  "verified",
  "verify_rejected",
  "member_added",
  "claim_approved",
  "claim_rejected",
  "change_approved",
  "change_rejected",
  "drafts_ready",
] as const;
export type AuthorNoticeKind = (typeof AUTHOR_NOTICE_KINDS)[number];

/**
 * An outbox for prompt author emails (§13.4 author templates): any Worker records a notice, and the
 * jobs Worker's `authors.notices` job renders and sends it. With no `user_id`, it goes to the
 * profile's owners.
 */
export const authorNotices = sqliteTable(
  "author_notices",
  {
    id: text("id").primaryKey(),
    authorId: text("author_id").notNull(),
    userId: text("user_id"),
    kind: text("kind", { enum: AUTHOR_NOTICE_KINDS }).notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
    createdAt: createdAt(),
    sentAt: text("sent_at"),
  },
  (t) => [index("author_notices_pending_idx").on(t.sentAt, t.createdAt)],
);
