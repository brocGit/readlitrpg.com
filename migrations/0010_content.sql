CREATE TABLE `editorial_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`kind` text NOT NULL,
	`post_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `editorial_slots_uq` ON `editorial_slots` (`date`,`kind`);--> statement-breakpoint
CREATE INDEX `editorial_slots_post_idx` ON `editorial_slots` (`post_id`);--> statement-breakpoint
CREATE TABLE `guest_submissions` (
	`post_id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`user_id` text,
	`pitch` text NOT NULL,
	`pitch_status` text DEFAULT 'pending' NOT NULL,
	`guideline_ack_at` text,
	`license_ack_at` text,
	`ai_screen` text,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `guest_submissions_author_idx` ON `guest_submissions` (`author_id`);--> statement-breakpoint
CREATE TABLE `interview_responses` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`book_id` text NOT NULL,
	`user_id` text,
	`answers` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'invited' NOT NULL,
	`formatted` text,
	`post_id` text,
	`release_date` text,
	`invited_at` text,
	`answered_at` text,
	`approved_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interview_responses_book_uq` ON `interview_responses` (`author_id`,`book_id`);--> statement-breakpoint
CREATE INDEX `interview_responses_status_idx` ON `interview_responses` (`status`);--> statement-breakpoint
CREATE TABLE `news_tips` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`body` text,
	`source_url` text,
	`book_id` text,
	`series_id` text,
	`author_id` text,
	`user_id` text,
	`data` text,
	`status` text DEFAULT 'new' NOT NULL,
	`dedupe_key` text,
	`post_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `news_tips_dedupe_uq` ON `news_tips` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `news_tips_status_idx` ON `news_tips` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `post_books` (
	`post_id` text NOT NULL,
	`book_id` text NOT NULL,
	PRIMARY KEY(`post_id`, `book_id`)
);
--> statement-breakpoint
CREATE INDEX `post_books_book_idx` ON `post_books` (`book_id`);--> statement-breakpoint
CREATE TABLE `post_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`title` text NOT NULL,
	`dek` text,
	`body_md` text NOT NULL,
	`edited_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `post_revisions_post_idx` ON `post_revisions` (`post_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `posts` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'drafting' NOT NULL,
	`title` text NOT NULL,
	`dek` text,
	`body_md` text DEFAULT '' NOT NULL,
	`body_html` text DEFAULT '' NOT NULL,
	`hero_media_id` text,
	`author_user_id` text,
	`byline_author_id` text,
	`byline_name` text,
	`publish_at` text,
	`published_at` text,
	`ai_involvement` text DEFAULT 'none' NOT NULL,
	`disclosure` text,
	`seo_title` text,
	`seo_description` text,
	`canonical_url` text,
	`is_sponsored` integer DEFAULT false NOT NULL,
	`sources` text DEFAULT '[]' NOT NULL,
	`data` text,
	`gen_key` text,
	`noindex` integer DEFAULT false NOT NULL,
	`inbox_item_id` text,
	`og_image_key` text,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `posts_slug_uq` ON `posts` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `posts_gen_key_uq` ON `posts` (`gen_key`);--> statement-breakpoint
CREATE INDEX `posts_status_idx` ON `posts` (`status`,`published_at`);--> statement-breakpoint
CREATE INDEX `posts_type_idx` ON `posts` (`type`,`status`,`published_at`);--> statement-breakpoint
CREATE INDEX `posts_publish_at_idx` ON `posts` (`status`,`publish_at`);