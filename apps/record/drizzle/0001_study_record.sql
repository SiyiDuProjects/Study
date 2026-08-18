CREATE TABLE `courses` (
  `id` text PRIMARY KEY NOT NULL,
  `code` text NOT NULL,
  `name` text NOT NULL,
  `term` text NOT NULL,
  `folder_name` text NOT NULL,
  `label` text NOT NULL,
  `source` text NOT NULL CHECK (`source` = 'canvas'),
  `workflow_state` text,
  `start_at` text,
  `end_at` text,
  `is_archived` integer NOT NULL CHECK (`is_archived` IN (0, 1)),
  `first_seen_at` text NOT NULL,
  `last_seen_at` text NOT NULL,
  `archived_at` text,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_courses_archived_name` ON `courses` (`is_archived`, `name`);
--> statement-breakpoint
CREATE TABLE `app_metadata` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `course_match_status` text NOT NULL DEFAULT 'legacy_unmatched';
--> statement-breakpoint
ALTER TABLE `sessions` ADD `finalization_warning` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `status` text NOT NULL DEFAULT 'ready';
--> statement-breakpoint
ALTER TABLE `sessions` ADD `translation_mode` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `updated_at` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `sessions` ADD `revision` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `writer_lease_hash` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `sessions` ADD `writer_epoch` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `transcript_segments` ADD `commit_sequence` integer;
--> statement-breakpoint
CREATE INDEX `idx_sessions_status_started` ON `sessions` (`status`, `started_at` DESC);
--> statement-breakpoint
UPDATE `sessions` SET `course_match_status` = 'daily' WHERE `course_id` = 'daily';
--> statement-breakpoint
UPDATE `sessions`
SET `course_match_status` = 'legacy_unmatched'
WHERE `course_id` <> 'daily' AND (`course_match_status` IS NULL OR `course_match_status` = '');
--> statement-breakpoint
UPDATE `sessions` SET `status` = 'ready' WHERE `status` IS NULL OR `status` = '';
--> statement-breakpoint
UPDATE `sessions` SET `updated_at` = COALESCE(NULLIF(`saved_at`, ''), `started_at`) WHERE `updated_at` = '';
--> statement-breakpoint
UPDATE `transcript_segments` SET `commit_sequence` = `position` WHERE `commit_sequence` IS NULL;
