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
  "publishers",
  "authors",
  "universes",
  "series",
  "books",
  "book_authors",
  "narrators",
  "editions",
  "edition_narrators",
  "releases",
  "book_links",
  "tags",
  "book_tags",
  "book_field_sources",
  "book_scores",
  "media",
  "catalog_confirmations",
  "catalog_merges",
  "catalog_imports",
  "catalog_import_rows",
  "editorial_queue",
  "editorial_runs",
  "editorial_proposals",
] as const;

/**
 * Never exported. Live sessions and sign-in tokens are secrets with short lives; after a restore,
 * people simply sign in again. Rate counters expire within hours. Derived data (`book_similar`,
 * the search index, vectors) is rebuilt, not backed up.
 */
export const BACKUP_EXCLUDED = [
  "sessions",
  "verifications",
  "rate_counters",
  "book_similar",
  "book_embeddings",
] as const;
