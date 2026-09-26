-- The audit log is append-only (DESIGN §15.11). The application has no update or delete path,
-- and the database refuses one too. Only rows past the seven-year retention period may be
-- deleted, oldest first, so the remaining chain still verifies from its first row.
CREATE TRIGGER `audit_log_no_update` BEFORE UPDATE ON `audit_log`
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_log_no_recent_delete` BEFORE DELETE ON `audit_log`
WHEN OLD.`created_at` > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2557 days')
BEGIN
  SELECT RAISE(ABORT, 'audit_log rows younger than seven years cannot be deleted');
END;
