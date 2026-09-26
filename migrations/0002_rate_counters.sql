CREATE TABLE `rate_counters` (
	`key` text NOT NULL,
	`window_start` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_counters_key_window_uq` ON `rate_counters` (`key`,`window_start`);--> statement-breakpoint
CREATE INDEX `rate_counters_expires_idx` ON `rate_counters` (`expires_at`);