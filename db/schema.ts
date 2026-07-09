import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    courseId: text("course_id").notNull(),
    courseCode: text("course_code").notNull(),
    courseName: text("course_name").notNull(),
    courseTerm: text("course_term").notNull(),
    courseFolderName: text("course_folder_name").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at").notNull(),
    durationMs: integer("duration_ms").notNull(),
    sourceLanguage: text("source_language").notNull(),
    targetLanguage: text("target_language").notNull(),
    translationModel: text("translation_model").notNull(),
    transcriptionModel: text("transcription_model").notNull(),
    createdByEmail: text("created_by_email"),
    savedAt: text("saved_at").notNull()
  },
  (table) => [
    index("idx_sessions_started_at").on(table.startedAt),
    index("idx_sessions_course_started").on(table.courseId, table.startedAt)
  ]
);

export const transcriptSegments = sqliteTable(
  "transcript_segments",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    position: integer("position").notNull(),
    startedAtMs: integer("started_at_ms").notNull(),
    endedAtMs: integer("ended_at_ms"),
    sourceText: text("source_text").notNull(),
    translatedText: text("translated_text").notNull(),
    isFinal: integer("is_final", { mode: "boolean" }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.id] }),
    index("idx_segments_session_position").on(table.sessionId, table.position)
  ]
);
