CREATE TABLE `appraisals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`key` text NOT NULL,
	`value` real NOT NULL,
	`status` text DEFAULT 'counted' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `appraisals_user_book_key_uq` ON `appraisals` (`user_id`,`book_id`,`key`);--> statement-breakpoint
CREATE INDEX `appraisals_book_idx` ON `appraisals` (`book_id`,`key`,`status`);--> statement-breakpoint
CREATE TABLE `quiz_daily` (
	`quiz_slug` text NOT NULL,
	`day` text NOT NULL,
	`outcome_key` text NOT NULL,
	`takes` integer DEFAULT 0 NOT NULL,
	`parties` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`quiz_slug`, `day`, `outcome_key`)
);
--> statement-breakpoint
CREATE TABLE `quiz_status` (
	`slug` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `quiz_takes` (
	`id` text PRIMARY KEY NOT NULL,
	`quiz_slug` text NOT NULL,
	`user_id` text,
	`answers` text NOT NULL,
	`outcome_key` text NOT NULL,
	`score` integer,
	`source` text DEFAULT 'onsite' NOT NULL,
	`party_ref` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`attached_at` text
);
--> statement-breakpoint
CREATE INDEX `quiz_takes_quiz_idx` ON `quiz_takes` (`quiz_slug`,`created_at`);--> statement-breakpoint
CREATE INDEX `quiz_takes_user_idx` ON `quiz_takes` (`user_id`);