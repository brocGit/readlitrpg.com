// The blog and the news desk (DESIGN §5.6, §14): posts of every type, their revisions and the books
// they mention, guest submissions, author interviews, the publishing calendar and news tips.

import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const createdAt = () => text("created_at").notNull().default(isoNow);
const updatedAt = () => text("updated_at").notNull().default(isoNow);

/**
 * `roundup` is the weekly and monthly release roundups, `daily` is "Today in LitRPG", `news` a
 * short cited brief. The first three and `data_story` live under /news; the rest under /blog.
 */
export const POST_TYPES = [
  "roundup",
  "daily",
  "news",
  "data_story",
  "ai_editorial",
  "guest",
  "interview",
  "owner",
  "sponsored",
] as const;
export type PostType = (typeof POST_TYPES)[number];
export const NEWS_TYPES: ReadonlySet<PostType> = new Set(["daily", "news", "data_story"]);

export const POST_STATUSES = [
  "idea",
  "drafting",
  "in_review",
  "changes_requested",
  "approved",
  "scheduled",
  "published",
  "unpublished",
  "rejected",
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const AI_INVOLVEMENT = ["none", "assisted", "generated"] as const;

export interface PostSource {
  url: string;
  title?: string;
}

export const posts = sqliteTable(
  "posts",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    type: text("type", { enum: POST_TYPES }).notNull(),
    status: text("status", { enum: POST_STATUSES }).notNull().default("drafting"),
    title: text("title").notNull(),
    dek: text("dek"),
    bodyMd: text("body_md").notNull().default(""),
    // Rendered and sanitized at save; shortcodes stay as text and become live cards at render.
    bodyHtml: text("body_html").notNull().default(""),
    heroMediaId: text("hero_media_id"),
    authorUserId: text("author_user_id"),
    bylineAuthorId: text("byline_author_id"),
    bylineName: text("byline_name"),
    publishAt: text("publish_at"),
    publishedAt: text("published_at"),
    aiInvolvement: text("ai_involvement", { enum: AI_INVOLVEMENT }).notNull().default("none"),
    // The label readers see about how the post was made (§14.1).
    disclosure: text("disclosure"),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    canonicalUrl: text("canonical_url"),
    isSponsored: integer("is_sponsored", { mode: "boolean" }).notNull().default(false),
    // Required for news: every brief links what it reports (§14.6).
    sources: text("sources", { mode: "json" }).$type<PostSource[]>().notNull().default(sql`'[]'`),
    // What an automated post was built from (sections of book ids), so it renders live (§14.4).
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>(),
    // One automated post per cause, e.g. `daily:2026-10-05` or `roundup:weekly:2026-W41`.
    genKey: text("gen_key"),
    // Thin automated posts stay out of search (§14.4 scaled-content hygiene).
    noindex: integer("noindex", { mode: "boolean" }).notNull().default(false),
    inboxItemId: text("inbox_item_id"),
    // The link-preview PNG the jobs Worker drew for the current title (like books.og_image_key).
    ogImageKey: text("og_image_key"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("posts_slug_uq").on(t.slug),
    uniqueIndex("posts_gen_key_uq").on(t.genKey),
    index("posts_status_idx").on(t.status, t.publishedAt),
    index("posts_type_idx").on(t.type, t.status, t.publishedAt),
    index("posts_publish_at_idx").on(t.status, t.publishAt),
  ],
);

/** Every save of a post's text, so the owner can compare and restore (§14.2). */
export const postRevisions = sqliteTable(
  "post_revisions",
  {
    id: text("id").primaryKey(),
    postId: text("post_id").notNull(),
    title: text("title").notNull(),
    dek: text("dek"),
    bodyMd: text("body_md").notNull(),
    editedBy: text("edited_by"),
    createdAt: createdAt(),
  },
  (t) => [index("post_revisions_post_idx").on(t.postId, t.createdAt)],
);

/** Books a post mentions through shortcodes: book pages link back to the posts about them. */
export const postBooks = sqliteTable(
  "post_books",
  {
    postId: text("post_id").notNull(),
    bookId: text("book_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.bookId] }), index("post_books_book_idx").on(t.bookId)],
);

export const PITCH_STATUSES = ["pending", "accepted", "declined"] as const;

/** A verified author's guest post (§14.3): the pitch, the acknowledgements and the pre-review. */
export const guestSubmissions = sqliteTable(
  "guest_submissions",
  {
    postId: text("post_id").primaryKey(),
    authorId: text("author_id").notNull(),
    userId: text("user_id"),
    pitch: text("pitch").notNull(),
    pitchStatus: text("pitch_status", { enum: PITCH_STATUSES }).notNull().default("pending"),
    guidelineAckAt: text("guideline_ack_at"),
    licenseAckAt: text("license_ack_at"),
    aiScreen: text("ai_screen", { mode: "json" }).$type<Record<string, unknown>>(),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("guest_submissions_author_idx").on(t.authorId)],
);

export const INTERVIEW_STATUSES = [
  "invited",
  "answered",
  "formatted",
  "approved",
  "published",
  "declined",
  "expired",
] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

/** An author's interview answers (§14.5), invited before a release and published the week before. */
export const interviewResponses = sqliteTable(
  "interview_responses",
  {
    id: text("id").primaryKey(),
    authorId: text("author_id").notNull(),
    bookId: text("book_id").notNull(),
    userId: text("user_id"),
    // question key → the author's answer, in their words.
    answers: text("answers", { mode: "json" }).$type<Record<string, string>>().notNull().default(sql`'{}'`),
    status: text("status", { enum: INTERVIEW_STATUSES }).notNull().default("invited"),
    // What the editorial run chose: headline, intro and the order of answer keys; typos fixed only.
    formatted: text("formatted", { mode: "json" }).$type<Record<string, unknown>>(),
    postId: text("post_id"),
    releaseDate: text("release_date"),
    invitedAt: text("invited_at"),
    answeredAt: text("answered_at"),
    approvedAt: text("approved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("interview_responses_book_uq").on(t.authorId, t.bookId),
    index("interview_responses_status_idx").on(t.status),
  ],
);

export const SLOT_KINDS = ["roundup", "news", "editorial", "guest", "owner"] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

/** The publishing calendar (§14.2): one post per slot kind per day. */
export const editorialSlots = sqliteTable(
  "editorial_slots",
  {
    id: text("id").primaryKey(),
    date: text("date").notNull(),
    kind: text("kind", { enum: SLOT_KINDS }).notNull(),
    postId: text("post_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("editorial_slots_uq").on(t.date, t.kind),
    index("editorial_slots_post_idx").on(t.postId),
  ],
);

export const TIP_SOURCES = ["author", "publisher", "data", "research"] as const;
export const TIP_STATUSES = ["new", "queued", "briefed", "used", "rejected"] as const;

/**
 * Things that may become news (§14.6): catalog changes found by the hourly check, author "Submit
 * news" items and research finds. Data tips feed "Today in LitRPG"; the others become briefs.
 */
export const newsTips = sqliteTable(
  "news_tips",
  {
    id: text("id").primaryKey(),
    source: text("source", { enum: TIP_SOURCES }).notNull(),
    // e.g. announced, date_moved, completed, audio_out for data tips; free text otherwise.
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    body: text("body"),
    sourceUrl: text("source_url"),
    bookId: text("book_id"),
    seriesId: text("series_id"),
    authorId: text("author_id"),
    userId: text("user_id"),
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>(),
    status: text("status", { enum: TIP_STATUSES }).notNull().default("new"),
    // One tip per cause (a data change seen twice stays one tip).
    dedupeKey: text("dedupe_key"),
    postId: text("post_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("news_tips_dedupe_uq").on(t.dedupeKey),
    index("news_tips_status_idx").on(t.status, t.createdAt),
  ],
);
