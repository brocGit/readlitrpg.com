CREATE TABLE `page_views_daily` (
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `kind`, `key`)
);
--> statement-breakpoint
CREATE TABLE `referrers_daily` (
	`day` text NOT NULL,
	`host` text NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `host`)
);
