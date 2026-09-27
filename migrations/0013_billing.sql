CREATE TABLE `credits_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`advertiser_id` text NOT NULL,
	`delta_cents` integer NOT NULL,
	`reason` text NOT NULL,
	`ref` text,
	`note` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `credits_ledger_advertiser_idx` ON `credits_ledger` (`advertiser_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`campaign_id` text,
	`booking_id` text,
	`description` text NOT NULL,
	`amount_cents` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `order_items_order_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_items_campaign_idx` ON `order_items` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`advertiser_id` text,
	`user_id` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`amount_cents` integer NOT NULL,
	`discount_cents` integer DEFAULT 0 NOT NULL,
	`credits_cents` integer DEFAULT 0 NOT NULL,
	`charged_cents` integer DEFAULT 0 NOT NULL,
	`refunded_cents` integer DEFAULT 0 NOT NULL,
	`promo_code_id` text,
	`stripe_checkout_session_id` text,
	`stripe_payment_intent_id` text,
	`stripe_invoice_id` text,
	`stripe_subscription_id` text,
	`expires_at` text,
	`paid_at` text,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_session_uq` ON `orders` (`stripe_checkout_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_invoice_uq` ON `orders` (`stripe_invoice_id`);--> statement-breakpoint
CREATE INDEX `orders_payment_intent_idx` ON `orders` (`stripe_payment_intent_id`);--> statement-breakpoint
CREATE INDEX `orders_advertiser_idx` ON `orders` (`advertiser_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `promo_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`percent_off` integer,
	`amount_off_cents` integer,
	`products` text DEFAULT '[]' NOT NULL,
	`max_redemptions` integer DEFAULT 1 NOT NULL,
	`redemptions` integer DEFAULT 0 NOT NULL,
	`expires_at` text,
	`active` integer DEFAULT true NOT NULL,
	`note` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `promo_codes_code_uq` ON `promo_codes` (`code`);--> statement-breakpoint
CREATE TABLE `refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`stripe_refund_id` text,
	`amount_cents` integer NOT NULL,
	`to_credits` integer DEFAULT false NOT NULL,
	`reason_code` text NOT NULL,
	`note` text,
	`initiated_by` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_stripe_uq` ON `refunds` (`stripe_refund_id`);--> statement-breakpoint
CREATE INDEX `refunds_order_idx` ON `refunds` (`order_id`);--> statement-breakpoint
CREATE TABLE `stripe_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`object_id` text,
	`livemode` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`received_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`processed_at` text
);
--> statement-breakpoint
CREATE INDEX `stripe_events_status_idx` ON `stripe_events` (`status`,`received_at`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`advertiser_id` text,
	`user_id` text,
	`plan` text NOT NULL,
	`interval` text NOT NULL,
	`status` text NOT NULL,
	`stripe_subscription_id` text NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`current_period_end` text,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`last_credit_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_stripe_uq` ON `subscriptions` (`stripe_subscription_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_advertiser_idx` ON `subscriptions` (`advertiser_id`);--> statement-breakpoint
ALTER TABLE `campaigns` ADD `budget_cents` integer;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `cpm_cents` integer;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `spent_millicents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `qualified_impressions` integer DEFAULT 0 NOT NULL;