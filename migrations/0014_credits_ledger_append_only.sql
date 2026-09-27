-- The credits ledger is append-only (DESIGN §12.5): a balance is the sum of its rows, and a
-- correction is a new row, never an edit. Like the audit log, the database refuses changes, and
-- only rows past the seven-year record-keeping period (§12.8) may be deleted.
CREATE TRIGGER `credits_ledger_no_update` BEFORE UPDATE ON `credits_ledger`
BEGIN
  SELECT RAISE(ABORT, 'credits_ledger is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `credits_ledger_no_recent_delete` BEFORE DELETE ON `credits_ledger`
WHEN OLD.`created_at` > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2557 days')
BEGIN
  SELECT RAISE(ABORT, 'credits_ledger rows younger than seven years cannot be deleted');
END;
