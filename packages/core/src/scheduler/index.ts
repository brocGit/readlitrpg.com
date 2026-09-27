// The heartbeat scheduler (DESIGN §7.9). One Cron Trigger calls the jobs Worker every 5 minutes.
// The heartbeat reads `schedules`, takes a short lease on each due row with a conditional UPDATE
// (so overlapping heartbeats never dispatch a job twice), queues the job, and sets the next run.

import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import { jobRuns, schedules } from "../db/schema";
import { ulid } from "../ids";
import { addSeconds, nowIso } from "../time";
import { CronError, nextCronTime, parseCron } from "./cron";

export * from "./cron";

export interface JobDef {
  key: string;
  cron: string;
  description: string;
}

/**
 * Jobs that exist today. A new job needs an entry here (which seeds its schedule row), a handler in
 * the jobs Worker, and a runbook line (DESIGN §20 definition of done). Times are UTC.
 */
export const JOBS = [
  {
    key: "backup.export",
    cron: "0 3 * * *",
    description: "Nightly NDJSON export of every D1 table to the BACKUPS bucket",
  },
  {
    key: "audit.verify",
    cron: "15 4 * * *",
    description: "Check the audit log hash chain; open an inbox item if it is broken",
  },
  {
    key: "retention.purge",
    cron: "30 5 * * *",
    description: "Delete expired sessions and sign-in tokens, and job history older than 90 days",
  },
  {
    key: "taxonomy.sync",
    cron: "7 * * * *",
    description: "Load data/taxonomy.yaml into the tags table when it has changed",
  },
  {
    key: "catalog.enrich",
    cron: "*/15 * * * *",
    description: "Look up books in Open Library and Google Books; a match confirms a seed",
  },
  {
    key: "catalog.import",
    cron: "*/5 * * * *",
    description: "Ingest the next chunk of any queued CSV, seed or dump import",
  },
  {
    key: "editorial.queue",
    cron: "*/15 * * * *",
    description: "Queue classification, dedupe and research work for editorial runs",
  },
  {
    key: "editorial.watchdog",
    cron: "23 * * * *",
    description: "Release expired claims, close dead runs, alert when no run has succeeded",
  },
  {
    key: "editorial.citations",
    cron: "*/10 * * * *",
    description: "Fetch pages that research runs cite; a page naming the book confirms it",
  },
  {
    key: "media.covers",
    cron: "*/15 * * * *",
    description: "Look for licensed covers (Open Library) for up to 10 books without one",
  },
  {
    key: "media.process",
    cron: "*/5 * * * *",
    description: "Re-encode pending images into the WebP variants readers see, and queue their review",
  },
  {
    key: "stats.rollup",
    cron: "17 * * * *",
    description:
      "Copy the last two days of page views and ad delivery from Analytics Engine into daily totals",
  },
  {
    key: "og.render",
    cron: "*/15 * * * *",
    description: "Render link-preview PNGs: the site, reader classes, live quiz results and changed books",
  },
  {
    key: "quiz.announce",
    cron: "9 * * * *",
    description: "Open an inbox item for each quiz that shipped in the code and awaits a publish decision",
  },
  {
    key: "match.model_build",
    cron: "50 * * * *",
    description: "Rebuild the match feature matrix from published books and store it in KV",
  },
  {
    key: "vectors.update",
    cron: "40 * * * *",
    description: "Embed new and changed books with Workers AI; flag near-duplicates",
  },
  {
    key: "email.welcome",
    cron: "*/5 * * * *",
    description: "Send due welcome-sequence emails (the reading list on confirmation, then days 2, 5 and 9)",
  },
  {
    key: "email.release_alerts",
    cron: "*/10 11-13 * * *",
    description: "From 11:00 UTC, one bundled release-day email per opted-in reader, in chunks",
  },
  {
    key: "email.digest_build",
    cron: "0 9 * * 4",
    description: "Thursday: freeze this week's Patch Notes issue (new books, quiz of the week)",
  },
  {
    key: "email.digest_send",
    cron: "*/5 13-23 * * 5,6",
    description: "From Friday 13:00 UTC: build and queue Patch Notes in chunks, with the circuit breaker",
  },
  {
    key: "exports.build",
    cron: "*/10 * * * *",
    description: "Build queued data exports into PRIVATE and email the reader a link",
  },
  {
    key: "authors.notices",
    cron: "*/5 * * * *",
    description:
      "Email authors about decisions: a listing published or not, verification, claims, team changes",
  },
  {
    key: "authors.change_digest",
    cron: "*/15 17-18 * * *",
    description: "From 17:00 UTC, email each author what others changed on their books today",
  },
  {
    key: "release.confirm_asks",
    cron: "0,20,40 15 * * *",
    description: "Ask authors to confirm release dates 14 and 3 days out, with signed one-click links",
  },
  {
    key: "release.rollover",
    cron: "5 * * * *",
    description: "Mark dated releases as out once their day has come (US dates by New York time)",
  },
  {
    key: "library.import",
    cron: "*/5 * * * *",
    description: "Match the next chunks of imported Goodreads / StoryGraph libraries to the catalog",
  },
  {
    key: "news.from_catalog",
    cron: "12 * * * *",
    description: "Turn new announcements, date changes, cancellations and completed series into news tips",
  },
  {
    key: "news.briefs",
    cron: "*/10 * * * *",
    description:
      "Check the pages cited by the morning run's news briefs, then publish or send them to the inbox",
  },
  {
    key: "interviews.invite",
    cron: "53 13 * * *",
    description: "Invite verified authors with a release 21–35 days out to answer interview questions",
  },
  {
    key: "news.daily_roundup",
    cron: "30 10 * * *",
    description: 'Build and publish "Today in LitRPG", then post it to Bluesky and Mastodon if set up',
  },
  {
    key: "news.daily_send",
    cron: "*/5 11-13 * * *",
    description: "Email today's roundup to Patch Notes Daily readers, a chunk a run",
  },
  {
    key: "blog.weekly_roundup",
    cron: "4 11 * * 1",
    description: "Build the week's release roundup (publishes, or waits a day in the inbox for a veto)",
  },
  {
    key: "blog.monthly_roundups",
    cron: "8 11 1,15 * *",
    description:
      "Build the monthly roundups: audiobooks and new series on the 1st, most followed on the 15th",
  },
  {
    key: "inventory.generate",
    cron: "30 4 * * *",
    description: "Keep ad inventory 120 days ahead: one unit per slot and day (or week) with its price",
  },
  {
    key: "stripe.events",
    cron: "*/5 * * * *",
    description:
      "Process recorded Stripe webhook events (a verified webhook also queues this at once), then expire lost checkouts",
  },
  {
    key: "stripe.reconcile",
    cron: "0 5 * * *",
    description: "Compare the last 48 hours of Stripe checkouts with our orders; repair or report mismatches",
  },
  {
    key: "ads.settle",
    cron: "25 * * * *",
    description:
      "Settle finished paid campaigns (unspent budget to credit, report emailed) and make good newsletter slots that didn't go out",
  },
  {
    key: "ads.price_suggestions",
    cron: "10 6 1 * *",
    description: "Suggest next month's placement prices from audience and sell-through (one inbox item)",
  },
  {
    key: "trust.recompute",
    cron: "0 4 * * *",
    description:
      "Promote verified authors who've earned it to Trusted (T2): 60 days, 3 books, a delivered campaign",
  },
  {
    key: "owner.alerts",
    cron: "*/5 * * * *",
    description: "Tell the owner at once about security events, disputes, circuit breakers and urgent items",
  },
  {
    key: "owner.daily_digest",
    cron: "0 13 * * *",
    description: "Email the owner the items due within 48 hours and anything urgent (nothing on a quiet day)",
  },
  {
    key: "owner.weekly_summary",
    cron: "0 14 * * 0",
    description:
      "Sunday: the week in numbers, what decided itself (with undo links), and next week's schedule",
  },
] as const satisfies readonly JobDef[];

export type JobKey = (typeof JOBS)[number]["key"];

export function isJobKey(key: string): key is JobKey {
  return JOBS.some((j) => j.key === key);
}

/** A queued job run. This is the message body on `Q_JOBS`. */
export interface JobMessage {
  job: JobKey;
  runId: string;
}

export const LEASE_SECONDS = 120;

/** KV key the heartbeat writes its last tick to, so the console can show the scheduler is alive. */
export const HEARTBEAT_KV_KEY = "heartbeat:last";

/** Insert a schedule row for every registered job that doesn't have one. Existing rows keep their edits. */
export async function ensureSchedules(
  db: Db,
  jobs: readonly JobDef[] = JOBS,
  now = new Date(),
): Promise<void> {
  // 4 bound parameters a row; D1 allows 100 a statement, which the job list outgrew.
  for (let i = 0; i < jobs.length; i += 20)
    await db
      .insert(schedules)
      .values(
        jobs.slice(i, i + 20).map((j) => ({
          key: j.key,
          cronExpr: j.cron,
          nextRunAt: nextCronTime(j.cron, now).toISOString(),
        })),
      )
      .onConflictDoNothing({ target: schedules.key });
}

export type ScheduleRow = typeof schedules.$inferSelect;

/** Take the lease on every due schedule. Returns only the rows this caller won. */
export async function claimDueSchedules(
  db: Db,
  owner: string,
  now = new Date(),
  leaseSeconds = LEASE_SECONDS,
): Promise<ScheduleRow[]> {
  const nowText = now.toISOString();
  const leaseFree = or(isNull(schedules.lockUntil), lt(schedules.lockUntil, nowText));
  const due = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.enabled, true), lte(schedules.nextRunAt, nowText), leaseFree))
    .orderBy(asc(schedules.nextRunAt));

  const claimed: ScheduleRow[] = [];
  const lockUntil = addSeconds(nowText, leaseSeconds);
  for (const row of due) {
    const result = await db
      .update(schedules)
      .set({ lockUntil, lockOwner: owner })
      .where(
        and(
          eq(schedules.key, row.key),
          eq(schedules.enabled, true),
          lte(schedules.nextRunAt, nowText),
          leaseFree,
        ),
      )
      .returning({ key: schedules.key });
    if (result.length === 1) claimed.push({ ...row, lockUntil, lockOwner: owner });
  }
  return claimed;
}

/** After a successful dispatch: record the run and move to the next slot. */
export async function completeDispatch(
  db: Db,
  row: ScheduleRow,
  owner: string,
  now = new Date(),
): Promise<string> {
  let next: string;
  try {
    next = nextCronTime(row.cronExpr, now).toISOString();
  } catch (error) {
    // A bad cron expression pauses the job instead of re-running it every tick.
    if (!(error instanceof CronError)) throw error;
    await db
      .update(schedules)
      .set({ enabled: false, lockUntil: null, lockOwner: null, updatedAt: now.toISOString() })
      .where(and(eq(schedules.key, row.key), eq(schedules.lockOwner, owner)));
    throw error;
  }
  await db
    .update(schedules)
    .set({ lastRunAt: now.toISOString(), nextRunAt: next, lockUntil: null, lockOwner: null })
    .where(and(eq(schedules.key, row.key), eq(schedules.lockOwner, owner)));
  return next;
}

/** After a failed dispatch: drop the lease so the next heartbeat retries. */
export async function releaseLease(db: Db, key: string, owner: string): Promise<void> {
  await db
    .update(schedules)
    .set({ lockUntil: null, lockOwner: null })
    .where(and(eq(schedules.key, key), eq(schedules.lockOwner, owner)));
}

export interface HeartbeatResult {
  dispatched: { job: string; runId: string; next: string }[];
  failed: { job: string; error: string }[];
}

/**
 * One heartbeat tick. `dispatch` queues the job (the jobs Worker sends it to `Q_JOBS`).
 * Jobs in the schedules table that the code no longer knows are skipped, not dispatched.
 */
export async function runHeartbeat(opts: {
  db: Db;
  owner?: string;
  now?: Date;
  jobs?: readonly JobDef[];
  dispatch: (message: { job: string; runId: string }) => Promise<void>;
}): Promise<HeartbeatResult> {
  const { db, dispatch } = opts;
  const now = opts.now ?? new Date();
  const owner = opts.owner ?? ulid();
  const jobs = opts.jobs ?? JOBS;
  await ensureSchedules(db, jobs, now);
  const known = new Set(jobs.map((j) => j.key));
  const result: HeartbeatResult = { dispatched: [], failed: [] };

  for (const row of await claimDueSchedules(db, owner, now)) {
    if (!known.has(row.key)) {
      await releaseLease(db, row.key, owner);
      result.failed.push({ job: row.key, error: "unknown job" });
      continue;
    }
    const runId = ulid(now.getTime());
    try {
      await db.insert(jobRuns).values({ id: runId, job: row.key, queuedAt: now.toISOString() });
      await dispatch({ job: row.key, runId });
      const next = await completeDispatch(db, row, owner, now);
      result.dispatched.push({ job: row.key, runId, next });
    } catch (error) {
      await db
        .update(jobRuns)
        .set({ status: "failed", finishedAt: nowIso(), error: String(error).slice(0, 500) })
        .where(eq(jobRuns.id, runId));
      await releaseLease(db, row.key, owner);
      result.failed.push({ job: row.key, error: String(error) });
    }
  }
  return result;
}

/**
 * Queue a job run right away, outside its schedule. Long jobs use this to continue in a fresh
 * invocation (each invocation may run at most 1,000 D1 queries).
 */
export async function enqueueJob(
  db: Db,
  queue: { send(message: JobMessage): Promise<unknown> },
  job: JobKey,
): Promise<string> {
  const runId = ulid();
  await db.insert(jobRuns).values({ id: runId, job, trigger: "manual" });
  await queue.send({ job, runId });
  return runId;
}

/** "Run now" from admin: make the job due on the next heartbeat. */
export async function requestRunNow(db: Db, key: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(schedules)
    .set({ nextRunAt: now.toISOString(), updatedAt: now.toISOString() })
    .where(eq(schedules.key, key))
    .returning({ key: schedules.key });
  return rows.length === 1;
}

export async function updateSchedule(
  db: Db,
  key: string,
  patch: { cronExpr?: string; enabled?: boolean },
  now = new Date(),
): Promise<boolean> {
  const set: Partial<ScheduleRow> = { updatedAt: now.toISOString() };
  if (patch.cronExpr !== undefined) {
    parseCron(patch.cronExpr);
    set.cronExpr = patch.cronExpr;
    set.nextRunAt = nextCronTime(patch.cronExpr, now).toISOString();
  }
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  const rows = await db
    .update(schedules)
    .set(set)
    .where(eq(schedules.key, key))
    .returning({ key: schedules.key });
  return rows.length === 1;
}

export async function startJobRun(db: Db, runId: string): Promise<boolean> {
  // Only a queued run can start, so a redelivered queue message doesn't run the job twice.
  const rows = await db
    .update(jobRuns)
    .set({ status: "running", startedAt: nowIso() })
    .where(and(eq(jobRuns.id, runId), eq(jobRuns.status, "queued")))
    .returning({ id: jobRuns.id });
  return rows.length === 1;
}

export async function finishJobRun(
  db: Db,
  runId: string,
  outcome: { ok: true; items?: number } | { ok: false; error: string },
): Promise<void> {
  await db
    .update(jobRuns)
    .set(
      outcome.ok
        ? { status: "succeeded", finishedAt: nowIso(), items: outcome.items ?? null }
        : { status: "failed", finishedAt: nowIso(), error: outcome.error.slice(0, 2000) },
    )
    .where(eq(jobRuns.id, runId));
}

/** Put a failed or stuck run back in the queue state so a retry can start it. */
export async function requeueJobRun(db: Db, runId: string): Promise<void> {
  await db
    .update(jobRuns)
    .set({ status: "queued", trigger: "retry", startedAt: null, error: null })
    .where(and(eq(jobRuns.id, runId), sql`${jobRuns.status} in ('running', 'failed')`));
}
