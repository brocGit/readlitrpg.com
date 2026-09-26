-- The audit log is append-only (DESIGN §15.11). The application has no update or delete path,
-- and the database refuses one too. Rows older than two years may be deleted by the retention job
-- (money rows are kept seven years; the job enforces that). The hash chain makes gaps evident.
CREATE TRIGGER `audit_log_no_update` BEFORE UPDATE ON `audit_log`
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_log_no_recent_delete` BEFORE DELETE ON `audit_log`
WHEN OLD.`created_at` > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-730 days')
BEGIN
  SELECT RAISE(ABORT, 'audit_log rows younger than two years cannot be deleted');
END;
