CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_project_id` text,
	`name` text NOT NULL,
	`target_role` text NOT NULL,
	`jd_text` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`parent_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
