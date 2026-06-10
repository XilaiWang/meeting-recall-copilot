CREATE TABLE `materials` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`type` text NOT NULL,
	`source_ref` text,
	`raw_content` text NOT NULL,
	`file_size` integer,
	`uploaded_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
