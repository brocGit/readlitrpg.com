CREATE TABLE `author_members` (
	`author_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`added_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`author_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `author_members_user_idx` ON `author_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `author_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`user_id` text,
	`kind` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`sent_at` text
);
--> statement-breakpoint
CREATE INDEX `author_notices_pending_idx` ON `author_notices` (`sent_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `author_pastes` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`user_id` text NOT NULL,
	`text` text NOT NULL,
	`links` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`drafts` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`extracted_at` text
);
--> statement-breakpoint
CREATE INDEX `author_pastes_author_idx` ON `author_pastes` (`author_id`);--> statement-breakpoint
CREATE INDEX `author_pastes_status_idx` ON `author_pastes` (`status`);--> statement-breakpoint
CREATE TABLE `author_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`user_id` text,
	`book_id` text,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`reasons` text DEFAULT '[]' NOT NULL,
	`inbox_item_id` text,
	`paste_id` text,
	`submitted_at` text,
	`decided_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `author_submissions_author_idx` ON `author_submissions` (`author_id`,`status`);--> statement-breakpoint
CREATE INDEX `author_submissions_book_idx` ON `author_submissions` (`book_id`);--> statement-breakpoint
CREATE TABLE `change_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`book_id` text NOT NULL,
	`source` text NOT NULL,
	`summary` text NOT NULL,
	`diff` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`emailed_at` text
);
--> statement-breakpoint
CREATE INDEX `change_notifications_pending_idx` ON `change_notifications` (`emailed_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `change_notifications_author_idx` ON `change_notifications` (`author_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `release_asks` (
	`id` text PRIMARY KEY NOT NULL,
	`release_id` text NOT NULL,
	`book_id` text NOT NULL,
	`stage` text NOT NULL,
	`date` text NOT NULL,
	`sent_at` text NOT NULL,
	`answer` text,
	`answered_by` text,
	`answered_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_asks_uq` ON `release_asks` (`release_id`,`stage`,`date`);--> statement-breakpoint
CREATE TABLE `verification_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`user_id` text NOT NULL,
	`method` text NOT NULL,
	`code` text NOT NULL,
	`target` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`evidence` text,
	`checked_at` text,
	`expires_at` text NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_requests_author_idx` ON `verification_requests` (`author_id`,`status`);--> statement-breakpoint
CREATE INDEX `verification_requests_user_idx` ON `verification_requests` (`user_id`);