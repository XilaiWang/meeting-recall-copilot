CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_material_id` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`details` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`language` text DEFAULT 'zh' NOT NULL,
	`confidence` real DEFAULT 0.5 NOT NULL,
	`user_verified` integer DEFAULT false NOT NULL,
	`is_important` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_cards_project_id` ON `cards` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_cards_project_type` ON `cards` (`project_id`,`type`);
--> statement-breakpoint
CREATE INDEX `idx_cards_project_verified` ON `cards` (`project_id`,`user_verified`);
