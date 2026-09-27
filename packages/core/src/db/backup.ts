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
  "quiz_takes",
  "quiz_daily",
  "quiz_status",
  "appraisals",
  // Readers and email (M5). Suppressions are hashes and must survive any restore.
  "reader_profiles",
  "follows",
  "book_marks",
  "saved_queries",
  "feed_tokens",
  "library_imports",
  "email_consents",
  "suppressions",
  "email_sequences",
  "newsletter_issues",
  // Authors (M6).
  "author_members",
  "verification_requests",
  "author_submissions",
  "change_notifications",
  "release_asks",
  // Blog and news (M7).
  "posts",
  "post_revisions",
  "post_books",
  "guest_submissions",
  "interview_responses",
  "editorial_slots",
  "news_tips",
  // Ads (M7: house campaigns) and money (M8). Financial records are kept seven years (§12.8).
  "advertisers",
  "ad_products",
  "ad_slots",
  "inventory_units",
  "campaigns",
  "creatives",
  "bookings",
  "campaign_stats_daily",
  "orders",
  "order_items",
  "refunds",
  "credits_ledger",
  "subscriptions",
  "promo_codes",
  // Analytics Engine keeps 90 days; these daily totals are the long-term record.
  "page_views_daily",
  "referrers_daily",
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
  // Short-lived: import rows are deleted when the import finishes, exports expire in days, and
  // the send log is kept 90 days for deliverability only.
  "library_import_rows",
  "data_exports",
  "email_sends",
  // Pasted text waits only until an editorial run has turned it into drafts, and notices only
  // until they're emailed (M6).
  "author_pastes",
  "author_notices",
  // An idempotency log for webhooks: Stripe keeps every event and the orders hold the outcome (M8).
  "stripe_events",
] as const;
