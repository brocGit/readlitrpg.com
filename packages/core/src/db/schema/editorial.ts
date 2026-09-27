// Editorial runs (DESIGN §5.7, §7.1): the work queue that Claude sessions pull from, one row per
// run, and every proposal a run pushes back. Runs never write catalog rows directly; accepted
// proposals are applied by the server through the same provenance code as everything else.

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/** Kinds of work. Later milestones add news_scan, brief_review, feed_summary, draft, quiz, audit. */
export const EDITORIAL_KINDS = [
  "classify",
  "dedupe",
  "research",
  "moderate",
  "image_review",
  "import_extract",
] as const;
export type EditorialKind = (typeof EDITORIAL_KINDS)[number];

export const QUEUE_STATUS = ["queued", "claimed", "done", "rejected", "expired"] as const;
export type QueueStatus = (typeof QUEUE_STATUS)[number];

export const RUN_KINDS = ["daily", "weekly", "monthly", "manual"] as const;
export const RUN_STATUS = ["running", "succeeded", "failed", "abandoned"] as const;

/**
 * accepted: applied. held: waiting in the inbox (an anomaly, the circuit breaker, or auto-publish
 * off). rejected: failed validation. pending_check: accepted, waiting for a server-side check
 * (research citations are fetched before anything is applied). discarded: the owner said no.
 */
export const PROPOSAL_STATUS = [
  "accepted",
  "held",
  "rejected",
  "pending_check",
  "discarded",
  "unverified",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUS)[number];

export const editorialQueue = sqliteTable(
  "editorial_queue",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: EDITORIAL_KINDS }).notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    /** Small hints only. The full payload is built when the item is claimed, so it is never stale. */
    payload: text("payload", { mode: "json" }),
    /** Higher is more urgent (DESIGN §7.13). */
    priority: integer("priority").notNull().default(50),
    status: text("status", { enum: QUEUE_STATUS }).notNull().default("queued"),
    /** One open item per cause: e.g. `classify:{bookId}`. Cleared when the item closes. */
    openKey: text("open_key"),
    claimedByRun: text("claimed_by_run"),
    claimedAt: text("claimed_at"),
    claimExpiresAt: text("claim_expires_at"),
    attempts: integer("attempts").notNull().default(0),
    dueAt: text("due_at"),
    doneAt: text("done_at"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (t) => [
    uniqueIndex("editorial_queue_open_uq").on(t.openKey),
    index("editorial_queue_claim_idx").on(t.status, t.priority, t.createdAt),
    index("editorial_queue_subject_idx").on(t.kind, t.subjectId),
    index("editorial_queue_run_idx").on(t.claimedByRun),
  ],
);

export const editorialRuns = sqliteTable(
  "editorial_runs",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: RUN_KINDS }).notNull(),
    /** Free text from the run, e.g. "morning" or "seed backlog". */
    label: text("label"),
    status: text("status", { enum: RUN_STATUS }).notNull().default("running"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    itemsClaimed: integer("items_claimed").notNull().default(0),
    proposalsAccepted: integer("proposals_accepted").notNull().default(0),
    proposalsRejected: integer("proposals_rejected").notNull().default(0),
    proposalsHeld: integer("proposals_held").notNull().default(0),
    /** Set when too many proposals fail validation: the rest of the run waits for the owner (§7.11). */
    circuitOpen: integer("circuit_open", { mode: "boolean" }).notNull().default(false),
    /** The skill versions the run says it followed, for evals. */
    skills: text("skills", { mode: "json" }),
    notes: text("notes"),
  },
  (t) => [
    index("editorial_runs_started_idx").on(t.startedAt),
    index("editorial_runs_status_idx").on(t.status),
  ],
);

export const editorialProposals = sqliteTable(
  "editorial_proposals",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    queueItemId: text("queue_item_id"),
    kind: text("kind", { enum: EDITORIAL_KINDS }).notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    /** The proposal as received (after parsing). Untrusted text inside it is data, never HTML. */
    payload: text("payload", { mode: "json" }).notNull(),
    status: text("status", { enum: PROPOSAL_STATUS }).notNull(),
    /** Validation errors, or the policy's reasons for holding. */
    reasons: text("reasons", { mode: "json" }).$type<string[]>(),
    /** What applying it changed, so the console can show it. */
    result: text("result", { mode: "json" }),
    inboxItemId: text("inbox_item_id"),
    decidedBy: text("decided_by"),
    decidedAt: text("decided_at"),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [
    index("editorial_proposals_run_idx").on(t.runId, t.createdAt),
    index("editorial_proposals_subject_idx").on(t.subjectType, t.subjectId),
    index("editorial_proposals_status_idx").on(t.status, t.createdAt),
  ],
);

/**
 * One embedding per book (DESIGN §7.2): Workers AI bge-base-en-v1.5, 768 floats stored as base64
 * little-endian float32. Derived data: rebuilt, never backed up. Vectorize is the upgrade path once
 * brute-force neighbor search gets slow (tens of thousands of books).
 */
export const bookEmbeddings = sqliteTable("book_embeddings", {
  bookId: text("book_id").primaryKey(),
  model: text("model").notNull(),
  dims: integer("dims").notNull(),
  vector: text("vector").notNull(),
  /** Hash of the text that was embedded; a change means re-embed. */
  textHash: text("text_hash").notNull(),
  updatedAt: text("updated_at").notNull().default(isoNow),
});
