# Runbook: scheduled jobs

Every job is registered in `packages/core/src/scheduler/index.ts` (`JOBS`), has a handler in `apps/jobs/src/jobs/`, and a line here. The heartbeat runs every 5 minutes, queues due jobs on `rlr-jobs`, and the jobs Worker runs them. A run that fails is retried (up to 3 times, with backoff), then lands in the dead-letter queue, which opens an Owner Inbox item.

Admin → Automation shows each job's schedule and history, and can pause, resume, re-time or run any job now.

| Job | When (UTC) | What it does | If it fails |
|---|---|---|---|
| `backup.export` | 03:00 daily | Exports every table in `BACKUP_TABLES` as NDJSON with a checksummed manifest to `rlr-backups` (`d1/daily/<date>/`, plus `d1/monthly/` on the 1st) | Run it again from Automation. Two misses in a row: check R2 and the job error. D1 Time Travel still covers 30 days |
| `audit.verify` | 04:15 daily | Recomputes the audit hash chain | A break opens a priority-100 inbox item naming the row. Treat it as a security incident: compare against the last backup's `audit_log` part |
| `retention.purge` | 05:30 daily | Deletes expired sessions, sign-in tokens and rate counters; job history over 90 days; audit rows over 7 years | Safe to re-run. Nothing depends on it except table size |
| `taxonomy.sync` | hourly at :07 | Loads `data/taxonomy.yaml` into the `tags` table when its hash has changed (a deploy with taxonomy edits) | Admin → Taxonomy → *Sync now*. Tags are only ever added or updated, never deleted |
| `catalog.enrich` | every 15 minutes | Looks up to 25 books in Open Library (and Google Books if `GOOGLE_BOOKS_API_KEY` is set). A match confirms the book and adds page count and first publication date | Errors are retried after `enrich.retry_days`. A book page's *Look it up again* forces a retry. If every lookup errors, check the Worker's outbound access to openlibrary.org |
| `catalog.import` | every 5 minutes, and straight away after an upload | Ingests the next 20 rows of the oldest queued import, then queues itself again until the file is done | Failed rows are listed on the import's page with the reason; fix and re-upload just those rows (re-importing is safe: matches are updated, not duplicated) |

If the heartbeat itself stops (the dashboard shows "No heartbeat" or an old time), check the jobs Worker's cron trigger and logs in the Cloudflare dashboard.
