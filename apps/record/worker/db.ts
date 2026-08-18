import type { ClassSession, ClassSessionSummary, TranscriptSegment, TranslationModel } from "../src/types";

interface SessionRow {
  id: string;
  title: string;
  course_id: string;
  course_code: string;
  course_name: string;
  course_term: string;
  course_folder_name: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  source_language: "ko";
  target_language: "zh";
  translation_model: TranslationModel;
  transcription_model: string;
  created_by_email: string | null;
  saved_at: string;
  segment_count?: number;
}

interface SegmentRow {
  id: string;
  started_at_ms: number;
  ended_at_ms: number | null;
  source_text: string;
  translated_text: string;
  is_final: number;
  created_at: string;
  updated_at: string;
}

export function createD1SessionRepository(db: D1Database) {
  async function listSessions(courseId?: string): Promise<ClassSessionSummary[]> {
    const query = `
      SELECT
        sessions.*,
        COUNT(transcript_segments.id) AS segment_count
      FROM sessions
      LEFT JOIN transcript_segments ON transcript_segments.session_id = sessions.id
      ${courseId ? "WHERE sessions.course_id = ?" : ""}
      GROUP BY sessions.id
      ORDER BY sessions.started_at DESC
    `;
    const statement = courseId ? db.prepare(query).bind(courseId) : db.prepare(query);
    const result = await statement.all<SessionRow>();
    return result.results.map(rowToSummary);
  }

  async function getSession(id: string): Promise<ClassSession | null> {
    const sessionRow = await db.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
    if (!sessionRow) {
      return null;
    }

    const segmentResult = await db
      .prepare("SELECT * FROM transcript_segments WHERE session_id = ? ORDER BY position ASC")
      .bind(id)
      .all<SegmentRow>();

    return rowToSession(sessionRow, segmentResult.results.map(rowToSegment));
  }

  async function saveSession(session: ClassSession, requesterEmail: string | null): Promise<ClassSession> {
    const savedAt = new Date().toISOString();
    const createdByEmail = requesterEmail ?? session.createdByEmail ?? null;
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `
            INSERT INTO sessions (
              id, title, course_id, course_code, course_name, course_term, course_folder_name,
              started_at, ended_at, duration_ms, source_language, target_language,
              translation_model, transcription_model, created_by_email, saved_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              course_id = excluded.course_id,
              course_code = excluded.course_code,
              course_name = excluded.course_name,
              course_term = excluded.course_term,
              course_folder_name = excluded.course_folder_name,
              started_at = excluded.started_at,
              ended_at = excluded.ended_at,
              duration_ms = excluded.duration_ms,
              source_language = excluded.source_language,
              target_language = excluded.target_language,
              translation_model = excluded.translation_model,
              transcription_model = excluded.transcription_model,
              created_by_email = excluded.created_by_email,
              saved_at = excluded.saved_at
          `
        )
        .bind(
          session.id,
          session.title,
          session.courseId,
          session.courseCode,
          session.courseName,
          session.courseTerm,
          session.courseFolderName,
          session.startedAt,
          session.endedAt,
          session.durationMs,
          session.sourceLanguage,
          session.targetLanguage,
          session.models.translation,
          session.models.transcription,
          createdByEmail,
          savedAt
        ),
      db.prepare("DELETE FROM transcript_segments WHERE session_id = ?").bind(session.id)
    ];

    if (session.segments.length > 0) {
      const segmentPayload = session.segments.map((segment, position) => ({
        id: segment.id,
        position,
        startedAtMs: segment.startedAtMs,
        endedAtMs: segment.endedAtMs ?? null,
        sourceText: segment.sourceText,
        translatedText: segment.translatedText,
        isFinal: segment.isFinal,
        createdAt: segment.createdAt,
        updatedAt: segment.updatedAt
      }));
      statements.push(
        db
          .prepare(
            `
              INSERT INTO transcript_segments (
                session_id, id, position, started_at_ms, ended_at_ms,
                source_text, translated_text, is_final, created_at, updated_at
              )
              SELECT
                ?,
                json_extract(value, '$.id'),
                json_extract(value, '$.position'),
                json_extract(value, '$.startedAtMs'),
                json_extract(value, '$.endedAtMs'),
                json_extract(value, '$.sourceText'),
                json_extract(value, '$.translatedText'),
                json_extract(value, '$.isFinal'),
                json_extract(value, '$.createdAt'),
                json_extract(value, '$.updatedAt')
              FROM json_each(?)
            `
          )
          .bind(session.id, JSON.stringify(segmentPayload))
      );
    }

    await db.batch(statements);
    const savedSession = await getSession(session.id);
    if (!savedSession) {
      throw new Error("Session save failed");
    }
    return savedSession;
  }

  async function deleteSession(id: string): Promise<boolean> {
    const result = await db.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
    return result.meta.changes > 0;
  }

  return {
    listSessions,
    getSession,
    saveSession,
    deleteSession
  };
}

function rowToSummary(row: SessionRow): ClassSessionSummary {
  return {
    id: row.id,
    title: row.title,
    courseId: row.course_id,
    courseCode: row.course_code,
    courseName: row.course_name,
    courseTerm: row.course_term,
    courseFolderName: row.course_folder_name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    sourceLanguage: row.source_language,
    targetLanguage: row.target_language,
    models: {
      translation: row.translation_model,
      transcription: row.transcription_model
    },
    segmentCount: row.segment_count ?? 0,
    createdByEmail: row.created_by_email,
    savedAt: row.saved_at
  };
}

function rowToSession(row: SessionRow, segments: TranscriptSegment[]): ClassSession {
  return {
    ...rowToSummary(row),
    segments
  };
}

function rowToSegment(row: SegmentRow): TranscriptSegment {
  return {
    id: row.id,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms ?? undefined,
    sourceText: row.source_text,
    translatedText: row.translated_text,
    isFinal: Boolean(row.is_final),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
