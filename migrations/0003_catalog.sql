CREATE TABLE `authors` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`bio` text,
	`links` text DEFAULT '[]' NOT NULL,
	`photo_media_id` text,
	`verified_at` text,
	`trust_level` text DEFAULT 'T0' NOT NULL,
	`publisher_id` text,
	`newsletter_url` text,
	`patreon_url` text,
	`royalroad_url` text,
	`origin` text NOT NULL,
	`redirect_to` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `authors_slug_uq` ON `authors` (`slug`);--> statement-breakpoint
CREATE INDEX `authors_name_key_idx` ON `authors` (`name_key`);--> statement-breakpoint
CREATE TABLE `book_authors` (
	`book_id` text NOT NULL,
	`author_id` text NOT NULL,
	`role` text DEFAULT 'author' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`book_id`, `author_id`)
);
--> statement-breakpoint
CREATE INDEX `book_authors_author_idx` ON `book_authors` (`author_id`);--> statement-breakpoint
CREATE TABLE `book_field_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`field` text NOT NULL,
	`value` text,
	`source` text NOT NULL,
	`source_ref` text,
	`confidence` real,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `book_field_sources_book_idx` ON `book_field_sources` (`book_id`,`field`);--> statement-breakpoint
CREATE TABLE `book_links` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`edition_id` text,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`region` text,
	`affiliate_eligible` integer DEFAULT false NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `book_links_book_url_uq` ON `book_links` (`book_id`,`url`);--> statement-breakpoint
CREATE TABLE `book_scores` (
	`book_id` text NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`value` real,
	`confidence` real,
	`ai_value` real,
	`ai_confidence` real,
	`author_value` real,
	`crowd_mean` real,
	`crowd_n` integer DEFAULT 0 NOT NULL,
	`admin_locked` integer DEFAULT false NOT NULL,
	`public` integer DEFAULT false NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`book_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `book_similar` (
	`book_id` text NOT NULL,
	`similar_id` text NOT NULL,
	`score` real NOT NULL,
	`reason` text,
	`computed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`book_id`, `similar_id`)
);
--> statement-breakpoint
CREATE TABLE `book_tags` (
	`book_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`score` real DEFAULT 0 NOT NULL,
	`ai_confidence` real,
	`author_asserted` integer,
	`crowd_up` integer DEFAULT 0 NOT NULL,
	`crowd_down` integer DEFAULT 0 NOT NULL,
	`admin_locked` integer DEFAULT false NOT NULL,
	`admin_value` real,
	`sources` text DEFAULT '[]' NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`book_id`, `tag_id`)
);
--> statement-breakpoint
CREATE INDEX `book_tags_tag_idx` ON `book_tags` (`tag_id`,`score`);--> statement-breakpoint
CREATE TABLE `books` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`title_key` text NOT NULL,
	`subtitle` text,
	`series_id` text,
	`series_position` real,
	`blurb_author` text,
	`summary_ai` text,
	`cover_media_id` text,
	`page_count` integer,
	`word_count_est` integer,
	`language` text DEFAULT 'en' NOT NULL,
	`visibility` text DEFAULT 'draft' NOT NULL,
	`pub_status` text DEFAULT 'unknown' NOT NULL,
	`first_published` text,
	`first_published_precision` text,
	`embargo_until` text,
	`is_ai_generated` text DEFAULT 'unknown' NOT NULL,
	`content_flags` text DEFAULT '[]' NOT NULL,
	`crunch_level` integer,
	`romance_level` integer,
	`harem` text DEFAULT 'unknown' NOT NULL,
	`primary_genre` text,
	`in_scope` text DEFAULT 'unknown' NOT NULL,
	`origin` text NOT NULL,
	`confirmed_at` text,
	`enrich_status` text DEFAULT 'pending' NOT NULL,
	`enriched_at` text,
	`created_by` text,
	`claimed` integer DEFAULT false NOT NULL,
	`classification_version` integer,
	`redirect_to` text,
	`published_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `books_slug_uq` ON `books` (`slug`);--> statement-breakpoint
CREATE INDEX `books_title_key_idx` ON `books` (`title_key`);--> statement-breakpoint
CREATE INDEX `books_series_idx` ON `books` (`series_id`,`series_position`);--> statement-breakpoint
CREATE INDEX `books_visibility_idx` ON `books` (`visibility`,`updated_at`);--> statement-breakpoint
CREATE INDEX `books_enrich_idx` ON `books` (`enrich_status`,`enriched_at`);--> statement-breakpoint
CREATE TABLE `catalog_confirmations` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`source` text NOT NULL,
	`source_ref` text DEFAULT '' NOT NULL,
	`evidence` text,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_confirmations_uq` ON `catalog_confirmations` (`subject_type`,`subject_id`,`source`,`source_ref`);--> statement-breakpoint
CREATE INDEX `catalog_confirmations_subject_idx` ON `catalog_confirmations` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `catalog_import_rows` (
	`import_id` text NOT NULL,
	`row_num` integer NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`processed_at` text,
	PRIMARY KEY(`import_id`, `row_num`)
);
--> statement-breakpoint
CREATE INDEX `catalog_import_rows_status_idx` ON `catalog_import_rows` (`import_id`,`status`);--> statement-breakpoint
CREATE TABLE `catalog_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`filename` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`field_source` text NOT NULL,
	`origin` text NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`created` integer DEFAULT 0 NOT NULL,
	`matched` integer DEFAULT 0 NOT NULL,
	`flagged` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `catalog_imports_status_idx` ON `catalog_imports` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `catalog_merges` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`winner_id` text NOT NULL,
	`loser_id` text NOT NULL,
	`moved` text NOT NULL,
	`merged_by` text NOT NULL,
	`merged_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`undone_at` text,
	`undone_by` text
);
--> statement-breakpoint
CREATE INDEX `catalog_merges_loser_idx` ON `catalog_merges` (`entity_type`,`loser_id`);--> statement-breakpoint
CREATE TABLE `edition_narrators` (
	`edition_id` text NOT NULL,
	`narrator_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`edition_id`, `narrator_id`)
);
--> statement-breakpoint
CREATE INDEX `edition_narrators_narrator_idx` ON `edition_narrators` (`narrator_id`);--> statement-breakpoint
CREATE TABLE `editions` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`format` text NOT NULL,
	`asin` text,
	`isbn13` text,
	`audible_asin` text,
	`publisher_id` text,
	`narration_type` text,
	`duration_minutes` integer,
	`kindle_unlimited` integer,
	`audible_plus` integer,
	`price_cents` integer,
	`currency` text,
	`price_checked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `editions_book_idx` ON `editions` (`book_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `editions_asin_uq` ON `editions` (`asin`);--> statement-breakpoint
CREATE UNIQUE INDEX `editions_isbn13_uq` ON `editions` (`isbn13`);--> statement-breakpoint
CREATE UNIQUE INDEX `editions_audible_asin_uq` ON `editions` (`audible_asin`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`bucket` text NOT NULL,
	`key` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`sha256` text NOT NULL,
	`uploaded_by` text,
	`purpose` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_key_uq` ON `media` (`bucket`,`key`);--> statement-breakpoint
CREATE INDEX `media_sha256_idx` ON `media` (`sha256`);--> statement-breakpoint
CREATE TABLE `narrators` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`links` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `narrators_slug_uq` ON `narrators` (`slug`);--> statement-breakpoint
CREATE INDEX `narrators_name_key_idx` ON `narrators` (`name_key`);--> statement-breakpoint
CREATE TABLE `publishers` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`website` text,
	`verified_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publishers_slug_uq` ON `publishers` (`slug`);--> statement-breakpoint
CREATE INDEX `publishers_name_key_idx` ON `publishers` (`name_key`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`edition_id` text,
	`kind` text NOT NULL,
	`date` text,
	`date_precision` text NOT NULL,
	`region` text DEFAULT 'US' NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`confirmed_by` text,
	`confirmed_at` text,
	`previous_date` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `releases_book_idx` ON `releases` (`book_id`);--> statement-breakpoint
CREATE INDEX `releases_date_idx` ON `releases` (`date`);--> statement-breakpoint
CREATE TABLE `series` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`expected_length` integer,
	`universe_id` text,
	`origin` text NOT NULL,
	`redirect_to` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `series_slug_uq` ON `series` (`slug`);--> statement-breakpoint
CREATE INDEX `series_name_key_idx` ON `series` (`name_key`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`facet` text NOT NULL,
	`description` text NOT NULL,
	`include_when` text,
	`examples` text,
	`parent_id` text,
	`synonyms` text DEFAULT '[]' NOT NULL,
	`commonly_excluded` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`replaced_by` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_slug_uq` ON `tags` (`slug`);--> statement-breakpoint
CREATE INDEX `tags_facet_idx` ON `tags` (`facet`,`sort`);--> statement-breakpoint
CREATE TABLE `universes` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `universes_slug_uq` ON `universes` (`slug`);