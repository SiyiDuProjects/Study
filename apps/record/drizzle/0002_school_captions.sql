ALTER TABLE sessions ADD source_json text;
--> statement-breakpoint
CREATE TABLE school_caption_courses (
  course_id text PRIMARY KEY NOT NULL REFERENCES courses(id),
  enabled integer NOT NULL CHECK(enabled IN (0, 1)),
  last_checked_at text,
  session_count integer NOT NULL DEFAULT 0,
  error text,
  updated_at text NOT NULL
);
