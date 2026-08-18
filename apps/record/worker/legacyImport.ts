export interface LegacyImportCounts {
  courses: number;
  metadata: number;
  sessions: number;
  segments: number;
}

export async function importLegacySqliteExport(db: D1Database, input: unknown): Promise<LegacyImportCounts> {
  const payload = record(input, "payload");
  if (payload.version !== 1) throw new Error("Unsupported migration export version");
  const tables = record(payload.tables, "tables");
  const courseRows = rows(tables.courses, "courses", 500);
  const metadataRows = rows(tables.app_metadata, "app_metadata", 100);
  const sessionRows = rows(tables.sessions, "sessions", 10_000);
  const segmentRows = rows(tables.transcript_segments, "transcript_segments", 500_000);

  const existing = await Promise.all([
    count(db, "courses"),
    count(db, "sessions"),
    count(db, "transcript_segments")
  ]);
  if (existing.some((value) => value !== 0)) {
    throw new Error("Study Record D1 is not empty");
  }

  const statements: D1PreparedStatement[] = [];
  for (const value of courseRows) {
    const row = record(value, "course");
    statements.push(db.prepare(`
      INSERT INTO courses(
        id, code, name, term, folder_name, label, source, workflow_state,
        start_at, end_at, is_archived, first_seen_at, last_seen_at, archived_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'canvas', ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      text(row.id, "course.id"),
      text(row.code, "course.code"),
      text(row.name, "course.name"),
      text(row.term, "course.term"),
      text(row.folder_name, "course.folder_name"),
      text(row.label, "course.label"),
      nullableText(row.workflow_state, "course.workflow_state"),
      nullableText(row.start_at, "course.start_at"),
      nullableText(row.end_at, "course.end_at"),
      bit(row.is_archived, "course.is_archived"),
      text(row.first_seen_at, "course.first_seen_at"),
      text(row.last_seen_at, "course.last_seen_at"),
      nullableText(row.archived_at, "course.archived_at"),
      text(row.updated_at, "course.updated_at")
    ));
  }

  for (const value of metadataRows) {
    const row = record(value, "metadata");
    statements.push(db.prepare(`
      INSERT INTO app_metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).bind(text(row.key, "metadata.key"), text(row.value, "metadata.value")));
  }

  for (const value of sessionRows) {
    const row = record(value, "session");
    const status = text(row.status, "session.status");
    if (!["recording", "ready", "failed", "archived"].includes(status)) {
      throw new Error("Invalid legacy session status");
    }
    statements.push(db.prepare(`
      INSERT INTO sessions(
        id, title, course_id, course_code, course_name, course_term, course_folder_name,
        course_match_status, finalization_warning, status, started_at, ended_at, duration_ms,
        source_language, target_language, translation_model, transcription_model,
        translation_mode, created_by_email, saved_at, updated_at, revision,
        writer_lease_hash, writer_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, '', 0)
    `).bind(
      text(row.id, "session.id"),
      text(row.title, "session.title"),
      text(row.course_id, "session.course_id"),
      text(row.course_code, "session.course_code"),
      text(row.course_name, "session.course_name"),
      text(row.course_term, "session.course_term"),
      text(row.course_folder_name, "session.course_folder_name"),
      text(row.course_match_status, "session.course_match_status"),
      nullableText(row.finalization_warning, "session.finalization_warning"),
      status,
      text(row.started_at, "session.started_at"),
      text(row.ended_at ?? "", "session.ended_at"),
      integer(row.duration_ms, "session.duration_ms"),
      text(row.source_language, "session.source_language"),
      text(row.target_language, "session.target_language"),
      text(row.translation_model, "session.translation_model"),
      text(row.transcription_model, "session.transcription_model"),
      nullableText(row.translation_mode, "session.translation_mode"),
      text(row.saved_at ?? "", "session.saved_at"),
      text(row.updated_at, "session.updated_at"),
      integer(row.revision, "session.revision")
    ));
  }

  for (const value of segmentRows) {
    const row = record(value, "segment");
    statements.push(db.prepare(`
      INSERT INTO transcript_segments(
        session_id, id, position, commit_sequence, started_at_ms, ended_at_ms,
        source_text, translated_text, is_final, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      text(row.session_id, "segment.session_id"),
      text(row.id, "segment.id"),
      integer(row.position, "segment.position"),
      row.commit_sequence === null || row.commit_sequence === undefined
        ? null
        : integer(row.commit_sequence, "segment.commit_sequence"),
      integer(row.started_at_ms, "segment.started_at_ms"),
      row.ended_at_ms === null || row.ended_at_ms === undefined
        ? null
        : integer(row.ended_at_ms, "segment.ended_at_ms"),
      text(row.source_text, "segment.source_text"),
      text(row.translated_text, "segment.translated_text"),
      bit(row.is_final, "segment.is_final"),
      text(row.created_at, "segment.created_at"),
      text(row.updated_at, "segment.updated_at")
    ));
  }

  await db.batch(statements);
  const imported = {
    courses: await count(db, "courses"),
    metadata: await count(db, "app_metadata"),
    sessions: await count(db, "sessions"),
    segments: await count(db, "transcript_segments")
  };
  if (
    imported.courses !== courseRows.length ||
    imported.sessions !== sessionRows.length ||
    imported.segments !== segmentRows.length
  ) {
    throw new Error("D1 migration row-count verification failed");
  }
  return imported;
}

async function count(db: D1Database, table: "courses" | "app_metadata" | "sessions" | "transcript_segments") {
  const result = await db.prepare(`SELECT COUNT(1) AS value FROM ${table}`).first<{ value: number }>();
  return result?.value ?? 0;
}

function rows(value: unknown, name: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`Invalid ${name} export`);
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${name}`);
  return value;
}

function nullableText(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, name);
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function bit(value: unknown, name: string): 0 | 1 {
  const resolved = integer(value, name);
  if (resolved !== 0 && resolved !== 1) throw new Error(`Invalid ${name}`);
  return resolved;
}
