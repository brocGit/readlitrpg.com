// Operations tables (DESIGN §5.7): settings, the scheduler, job history, the audit log and the
// Owner Inbox. Timestamps are ISO-8601 UTC strings.

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/** Overrides only. Defaults live in code (`settings/registry.ts`), so a missing row means "default". */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: text("updated_at").notNull().default(isoNow),
});

/** One row per job. Seeded from the code registry; cadence and pause are editable in admin. */
export const schedules = sqliteTable("schedules", {
  key: text("key").primaryKey(),
  cronExpr: text("cron_expr").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastRunAt: text("last_run_at"),
  nextRunAt: text("next_run_at").notNull(),
  lockUntil: text("lock_until"),
  lockOwner: text("lock_owner"),
  updatedAt: text("updated_at").notNull().default(isoNow),
});

export const JOB_RUN_STATUSES = ["queued", "running", "succeeded", "failed"] as const;

export const jobRuns = sqliteTable(
  "job_runs",
  {
    id: text("id").primaryKey(),
    job: text("job").notNull(),
    trigger: text("trigger", { enum: ["schedule", "manual", "retry"] })
      .notNull()
      .default("schedule"),
    status: text("status", { enum: JOB_RUN_STATUSES }).notNull().default("queued"),
    queuedAt: text("queued_at").notNull().default(isoNow),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    items: integer("items"),
    error: text("error"),
    costCents: integer("cost_cents"),
  },
  (t) => [index("job_runs_job_idx").on(t.job, t.queuedAt)],
);

export const ACTOR_TYPES = ["user", "admin", "system", "editorial_run"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/**
 * Append-only (DESIGN §15.11). `seq` makes the chain linear: two writers racing for the same seq
 * collide on the unique index and the loser retries. `hash = sha256(prev_hash + row)`.
 * Triggers in the migration refuse UPDATE, and refuse DELETE for rows younger than two years.
 */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    seq: integer("seq").notNull(),
    actorType: text("actor_type", { enum: ACTOR_TYPES }).notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    diff: text("diff", { mode: "json" }),
    ipHash: text("ip_hash"),
    requestId: text("request_id"),
    createdAt: text("created_at").notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [
    uniqueIndex("audit_log_seq_uq").on(t.seq),
    index("audit_log_subject_idx").on(t.subjectType, t.subjectId),
    index("audit_log_actor_idx").on(t.actorType, t.actorId),
  ],
);

export const INBOX_STATUSES = [
  "open",
  "snoozed",
  "approved",
  "rejected",
  "auto_approved",
  "auto_rejected",
  "expired",
  "resolved",
] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export const INBOX_RECOMMENDATIONS = ["approve", "reject", "edit", "escalate"] as const;

export const inboxItems = sqliteTable(
  "inbox_items",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    title: text("title").notNull(),
    // Written by editorial runs (DESIGN §7.1); null until a run has looked at the item.
    aiSummary: text("ai_summary"),
    aiRecommendation: text("ai_recommendation", { enum: INBOX_RECOMMENDATIONS }),
    riskScore: integer("risk_score"),
    priority: integer("priority").notNull().default(50),
    status: text("status", { enum: INBOX_STATUSES }).notNull().default("open"),
    payload: text("payload", { mode: "json" }),
    // Stops the same alert (a DLQ message, a watchdog alarm) from opening twice.
    dedupeKey: text("dedupe_key"),
    dueAt: text("due_at"),
    defaultAction: text("default_action", { enum: ["approve", "reject", "expire", "none"] })
      .notNull()
      .default("none"),
    defaultActionAt: text("default_action_at"),
    decidedBy: text("decided_by"),
    decidedAt: text("decided_at"),
    reasonCode: text("reason_code"),
    note: text("note"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (t) => [
    uniqueIndex("inbox_items_dedupe_uq").on(t.dedupeKey),
    index("inbox_items_open_idx").on(t.status, t.priority),
    index("inbox_items_default_action_idx").on(t.status, t.defaultActionAt),
  ],
);

/**
 * Fixed-window counters for limits longer than the Rate Limiting binding's 60-second maximum
 * (DESIGN §15.9), e.g. 3 sign-in links per email per 15 minutes. Keys are hashes, never raw
 * emails or IPs. The retention job deletes expired windows.
 */
export const rateCounters = sqliteTable(
  "rate_counters",
  {
    key: text("key").notNull(),
    windowStart: text("window_start").notNull(),
    count: integer("count").notNull().default(0),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [
    uniqueIndex("rate_counters_key_window_uq").on(t.key, t.windowStart),
    index("rate_counters_expires_idx").on(t.expiresAt),
  ],
);
