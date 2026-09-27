CREATE TABLE `book_embeddings` (
	`book_id` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`dims` integer NOT NULL,
	`vector` text NOT NULL,
	`text_hash` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `editorial_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`queue_item_id` text,
	`kind` text NOT NULL,
	`subject_type` text,
	`subject_id` text,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`reasons` text,
	`result` text,
	`inbox_item_id` text,
	`decided_by` text,
	`decided_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `editorial_proposals_run_idx` ON `editorial_proposals` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `editorial_proposals_subject_idx` ON `editorial_proposals` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `editorial_proposals_status_idx` ON `editorial_proposals` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `editorial_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`payload` text,
	`priority` integer DEFAULT 50 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`open_key` text,
	`claimed_by_run` text,
	`claimed_at` text,
	`claim_expires_at` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`due_at` text,
	`done_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `editorial_queue_open_uq` ON `editorial_queue` (`open_key`);--> statement-breakpoint
CREATE INDEX `editorial_queue_claim_idx` ON `editorial_queue` (`status`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `editorial_queue_subject_idx` ON `editorial_queue` (`kind`,`subject_id`);--> statement-breakpoint
CREATE INDEX `editorial_queue_run_idx` ON `editorial_queue` (`claimed_by_run`);--> statement-breakpoint
CREATE TABLE `editorial_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`items_claimed` integer DEFAULT 0 NOT NULL,
	`proposals_accepted` integer DEFAULT 0 NOT NULL,
	`proposals_rejected` integer DEFAULT 0 NOT NULL,
	`proposals_held` integer DEFAULT 0 NOT NULL,
	`circuit_open` integer DEFAULT false NOT NULL,
	`skills` text,
	`notes` text
);
--> statement-breakpoint
CREATE INDEX `editorial_runs_started_idx` ON `editorial_runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `editorial_runs_status_idx` ON `editorial_runs` (`status`);--> statement-breakpoint
ALTER TABLE `books` ADD `hook_ai` text;--> statement-breakpoint
ALTER TABLE `books` ADD `classified_at` text;