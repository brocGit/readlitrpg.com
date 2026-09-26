# Runbook: scheduled jobs

Every job is registered in `packages/core/src/scheduler/index.ts` (`JOBS`), has a handler in `apps/jobs/src/jobs/`, and a line here. The heartbeat runs every 5 minutes, queues due jobs on `rlr-jobs`, and the jobs Worker runs them. A run that fails is retried (up to 3 times, with backoff), then lands in the dead-letter queue, which opens an Owner Inbox item.

Admin → Automation shows each job's schedule and history, and can pause, resume, re-time or run any job now.

| Job | When (UTC) | What it does | If it fails |
|---|---|---|---|
| `backup.export` | 03:00 daily | Exports every table in `BACKUP_TABLES` as NDJSON with a checksummed manifest to `rlr-backups` (`d1/daily/<date>/`, plus `d1/monthly/` on the 1st) | Run it again from Automation. Two misses in a row: check R2 and the job error. D1 Time Travel still covers 30 days |
| `audit.verify` | 04:15 daily | Recomputes the audit hash chain | A break opens a priority-100 inbox item naming the row. Treat it as a security incident: compare against the last backup's `audit_log` part |
| `retention.purge` | 05:30 daily | Deletes expired sessions, sign-in tokens and rate counters; job history over 90 days; audit rows over 7 years | Safe to re-run. Nothing depends on it except table size |

If the heartbeat itself stops (the dashboard shows "No heartbeat" or an old time), check the jobs Worker's cron trigger and logs in the Cloudflare dashboard.
