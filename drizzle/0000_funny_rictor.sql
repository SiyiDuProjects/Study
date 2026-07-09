CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`course_id` text NOT NULL,
	`course_code` text NOT NULL,
	`course_name` text NOT NULL,
	`course_term` text NOT NULL,
	`course_folder_name` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`source_language` text NOT NULL,
	`target_language` text NOT NULL,
	`translation_model` text NOT NULL,
	`transcription_model` text NOT NULL,
	`created_by_email` text,
	`saved_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_started_at` ON `sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_course_started` ON `sessions` (`course_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `transcript_segments` (
	`session_id` text NOT NULL,
	`id` text NOT NULL,
	`position` integer NOT NULL,
	`started_at_ms` integer NOT NULL,
	`ended_at_ms` integer,
	`source_text` text NOT NULL,
	`translated_text` text NOT NULL,
	`is_final` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`session_id`, `id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_segments_session_position` ON `transcript_segments` (`session_id`,`position`);