// Which tables the nightly backup exports (DESIGN §15.12). A test fails if a table in the schema
// is in neither list, so a new table can't be silently left out of backups.

/** Exported nightly as NDJSON to the BACKUPS bucket. */
export const BACKUP_TABLES = [
  "users",
  "accounts",
  "passkeys",
  "settings",
  "schedules",
  "job_runs",
  "audit_log",
  "inbox_items",
] as const;

/**
 * Never exported. Live sessions and sign-in tokens are secrets with short lives; after a restore,
 * people simply sign in again. Rate counters expire within hours. Derived data (search index,
 * vectors) is rebuilt, not backed up.
 */
export const BACKUP_EXCLUDED = ["sessions", "verifications", "rate_counters"] as const;
