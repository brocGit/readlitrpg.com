ALTER TABLE `books` ADD `cover_checked_at` text;--> statement-breakpoint
ALTER TABLE `books` ADD `og_image_key` text;--> statement-breakpoint
ALTER TABLE `books` ADD `og_rendered_at` text;--> statement-breakpoint
ALTER TABLE `media` ADD `source` text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE `media` ADD `subject_type` text;--> statement-breakpoint
ALTER TABLE `media` ADD `subject_id` text;--> statement-breakpoint
ALTER TABLE `media` ADD `original_key` text;--> statement-breakpoint
ALTER TABLE `media` ADD `processed_at` text;--> statement-breakpoint
ALTER TABLE `media` ADD `error` text;--> statement-breakpoint
CREATE INDEX `media_pending_idx` ON `media` (`processed_at`,`status`);