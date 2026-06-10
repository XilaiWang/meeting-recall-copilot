CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users_local` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`license_status` text DEFAULT 'none' NOT NULL,
	`license_tier` text,
	`license_cache_fetched_at` integer,
	`license_cache_until` integer,
	`created_at` integer NOT NULL
);
