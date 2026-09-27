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
| `editorial.queue` | every 15 minutes | Queues work for editorial runs: every unclassified book, each open "Possible duplicate" without a run's verdict, and seeds Open Library couldn't confirm (not retried within 30 days) | Safe to re-run: each cause has at most one open item. Admin → Editorial → *Look for new work now* does the same |
| `editorial.watchdog` | hourly at :23 | Returns expired claims to the queue (an item is expired after three unanswered claims), closes runs still "running" after 12 hours, and opens an `editorial_stale` inbox item when work has waited longer than `editorial.stale_hours` with no successful run | Check the routines and the environment's tokens ([editorial-runs.md](editorial-runs.md)) |
| `editorial.citations` | every 10 minutes | Fetches the pages research runs cited (up to 10 proposals a run). A page showing the title and an author's full name confirms the seed and applies the cited facts | Network errors are retried three times, then the proposal is marked unverified and the seed is researched again later |
| `vectors.update` | hourly at :40 | Embeds up to `embed.batch_size` new or changed books with Workers AI, then flags near-identical books by one author as possible duplicates | Does nothing until `CF_ACCOUNT_ID` and `CF_API_TOKEN` are set on the jobs Worker. A 401/403 means the token lacks the Workers AI permission |
| `catalog.import` | every 5 minutes, and straight away after an upload | Ingests the next 20 rows of the oldest queued import, then queues itself again until the file is done | Failed rows are listed on the import's page with the reason; fix and re-upload just those rows (re-importing is safe: matches are updated, not duplicated) |

Every heartbeat also runs **inbox default actions** that are due, for item types whose change is already live (`tag_check`, `scope_check`): their default just closes them. Types whose default would change something get handlers as they arrive.

If the heartbeat itself stops (the dashboard shows "No heartbeat" or an old time), check the jobs Worker's cron trigger and logs in the Cloudflare dashboard.
