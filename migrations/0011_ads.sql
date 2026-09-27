CREATE TABLE `ad_products` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`surface` text NOT NULL,
	`specs` text DEFAULT '{}' NOT NULL,
	`base_price_cents` integer NOT NULL,
	`pricing_rule` text,
	`active` integer DEFAULT true NOT NULL,
	`phase` text DEFAULT '1.5' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ad_products_key_uq` ON `ad_products` (`key`);--> statement-breakpoint
CREATE TABLE `ad_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`key` text NOT NULL,
	`capacity_per_period` integer DEFAULT 1 NOT NULL,
	`period` text NOT NULL,
	`surface` text NOT NULL,
	`targeting` text DEFAULT 'none' NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ad_slots_key_uq` ON `ad_slots` (`key`);--> statement-breakpoint
CREATE TABLE `advertisers` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text,
	`name` text NOT NULL,
	`stripe_customer_id` text,
	`trust_level` text DEFAULT 'T0' NOT NULL,
	`is_house` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `advertisers_owner_uq` ON `advertisers` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`inventory_unit_id` text NOT NULL,
	`status` text NOT NULL,
	`hold_expires_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bookings_unit_idx` ON `bookings` (`inventory_unit_id`,`status`);--> statement-breakpoint
CREATE INDEX `bookings_campaign_idx` ON `bookings` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `bookings_hold_idx` ON `bookings` (`status`,`hold_expires_at`);--> statement-breakpoint
CREATE TABLE `campaign_stats_daily` (
	`campaign_key` text NOT NULL,
	`date` text NOT NULL,
	`surface` text NOT NULL,
	`impressions` integer DEFAULT 0 NOT NULL,
	`viewable` integer DEFAULT 0 NOT NULL,
	`clicks` integer DEFAULT 0 NOT NULL,
	`email_sends` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`campaign_key`, `date`, `surface`)
);
--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`advertiser_id` text NOT NULL,
	`product_id` text NOT NULL,
	`name` text NOT NULL,
	`book_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`mode` text NOT NULL,
	`targeting` text DEFAULT '{}' NOT NULL,
	`weight` integer DEFAULT 1 NOT NULL,
	`own_book` integer DEFAULT false NOT NULL,
	`start_at` text NOT NULL,
	`end_at` text,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `campaigns_status_idx` ON `campaigns` (`status`,`start_at`);--> statement-breakpoint
CREATE INDEX `campaigns_advertiser_idx` ON `campaigns` (`advertiser_id`);--> statement-breakpoint
CREATE TABLE `creatives` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`headline` text NOT NULL,
	`body` text,
	`cta_label` text NOT NULL,
	`destination_link_id` text,
	`custom_url` text,
	`image_media_id` text,
	`review_status` text DEFAULT 'approved' NOT NULL,
	`review_notes` text,
	`risk_score` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `creatives_campaign_idx` ON `creatives` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `inventory_units` (
	`id` text PRIMARY KEY NOT NULL,
	`slot_id` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`target` text DEFAULT '' NOT NULL,
	`capacity` integer NOT NULL,
	`sold` integer DEFAULT 0 NOT NULL,
	`held` integer DEFAULT 0 NOT NULL,
	`price_cents` integer NOT NULL,
	`blackout` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_units_uq` ON `inventory_units` (`slot_id`,`period_start`,`target`);--> statement-breakpoint
CREATE INDEX `inventory_units_period_idx` ON `inventory_units` (`period_start`,`period_end`);