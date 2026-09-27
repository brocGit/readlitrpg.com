CREATE TABLE `email_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`list` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source` text NOT NULL,
	`ip_hash` text,
	`confirm_token_hash` text,
	`consented_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`confirmed_at` text,
	`unsubscribed_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_consents_user_list_uq` ON `email_consents` (`user_id`,`list`);--> statement-breakpoint
CREATE INDEX `email_consents_token_idx` ON `email_consents` (`confirm_token_hash`);--> statement-breakpoint
CREATE INDEX `email_consents_list_idx` ON `email_consents` (`list`,`status`,`user_id`);--> statement-breakpoint
CREATE TABLE `email_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`template` text NOT NULL,
	`issue_id` text,
	`provider_message_id` text,
	`status` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_sends_provider_idx` ON `email_sends` (`provider_message_id`);--> statement-breakpoint
CREATE INDEX `email_sends_created_idx` ON `email_sends` (`created_at`);--> statement-breakpoint
CREATE INDEX `email_sends_issue_idx` ON `email_sends` (`issue_id`,`status`);--> statement-breakpoint
CREATE TABLE `email_sequences` (
	`user_id` text NOT NULL,
	`sequence` text NOT NULL,
	`step` integer DEFAULT 1 NOT NULL,
	`next_at` text,
	`context` text DEFAULT '{}' NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`done_at` text,
	PRIMARY KEY(`user_id`, `sequence`)
);
--> statement-breakpoint
CREATE INDEX `email_sequences_due_idx` ON `email_sequences` (`done_at`,`next_at`);--> statement-breakpoint
CREATE TABLE `newsletter_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'weekly' NOT NULL,
	`week` text NOT NULL,
	`status` text NOT NULL,
	`content` text DEFAULT '{}' NOT NULL,
	`cursor` text DEFAULT '' NOT NULL,
	`stats` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`sent_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `newsletter_issues_week_uq` ON `newsletter_issues` (`kind`,`week`);--> statement-breakpoint
CREATE TABLE `suppressions` (
	`email_hash` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `book_marks` (
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`status` text NOT NULL,
	`rating` integer,
	`source` text DEFAULT 'site' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`user_id`, `book_id`)
);
--> statement-breakpoint
CREATE INDEX `book_marks_book_idx` ON `book_marks` (`book_id`);--> statement-breakpoint
CREATE TABLE `data_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`object_key` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`ready_at` text,
	`expires_at` text
);
--> statement-breakpoint
CREATE INDEX `data_exports_status_idx` ON `data_exports` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `data_exports_user_idx` ON `data_exports` (`user_id`);--> statement-breakpoint
CREATE TABLE `feed_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text DEFAULT 'ics' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feed_tokens_hash_uq` ON `feed_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `feed_tokens_user_idx` ON `feed_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `follows` (
	`user_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`notify` text DEFAULT 'digest' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`user_id`, `target_type`, `target_id`)
);
--> statement-breakpoint
CREATE INDEX `follows_target_idx` ON `follows` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `library_import_rows` (
	`import_id` text NOT NULL,
	`row_num` integer NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`book_id` text,
	PRIMARY KEY(`import_id`, `row_num`)
);
--> statement-breakpoint
CREATE TABLE `library_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`matched` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `library_imports_status_idx` ON `library_imports` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `library_imports_user_idx` ON `library_imports` (`user_id`);--> statement-breakpoint
CREATE TABLE `reader_profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`inputs` text DEFAULT '{}' NOT NULL,
	`reader_class` text,
	`level` integer DEFAULT 1 NOT NULL,
	`source` text,
	`onboarded_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `saved_queries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`params` text NOT NULL,
	`alert` text DEFAULT 'digest' NOT NULL,
	`last_alerted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `saved_queries_user_idx` ON `saved_queries` (`user_id`);