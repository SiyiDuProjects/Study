import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ClassSession, ClassSessionSummary, TranscriptSegment, TranslationModel } from "../src/types.js";

export type SqliteDatabase = Database.Database;

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
  is_final: 0 | 1;
  created_at: string;
  updated_at: string;
}

export function openDatabase(
  dbPath = process.env.JIAHUAN_DB_PATH ?? defaultDatabasePath()
): SqliteDatabase {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  if (dbPath !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  migrateDatabase(db);
  return db;
}

function defaultDatabasePath(): string {
  return process.env.NODE_ENV === "production" ? "/data/jiahuan.sqlite" : "data/jiahuan.sqlite";
}

export function migrateDatabase(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      course_id TEXT NOT NULL,
      course_code TEXT NOT NULL,
      course_name TEXT NOT NULL,
      course_term TEXT NOT NULL,
      course_folder_name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      source_language TEXT NOT NULL,
      target_language TEXT NOT NULL,
      translation_model TEXT NOT NULL,
      transcription_model TEXT NOT NULL,
      created_by_email TEXT,
      saved_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transcript_segments (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      position INTEGER NOT NULL,
      started_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER,
      source_text TEXT NOT NULL,
      translated_text TEXT NOT NULL,
      is_final INTEGER NOT NULL CHECK (is_final IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_course_started ON sessions(course_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_segments_session_position ON transcript_segments(session_id, position);
  `);
}

export function createSessionRepository(db: SqliteDatabase) {
  const saveSessionTx = db.transaction((session: ClassSession, createdByEmail: string | null) => {
    const savedAt = new Date().toISOString();

    db.prepare(
      `
        INSERT INTO sessions (
          id, title, course_id, course_code, course_name, course_term, course_folder_name,
          started_at, ended_at, duration_ms, source_language, target_language,
          translation_model, transcription_model, created_by_email, saved_at
        )
        VALUES (
          @id, @title, @courseId, @courseCode, @courseName, @courseTerm, @courseFolderName,
          @startedAt, @endedAt, @durationMs, @sourceLanguage, @targetLanguage,
          @translationModel, @transcriptionModel, @createdByEmail, @savedAt
        )
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
    ).run({
      id: session.id,
      title: session.title,
      courseId: session.courseId,
      courseCode: session.courseCode,
      courseName: session.courseName,
      courseTerm: session.courseTerm,
      courseFolderName: session.courseFolderName,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationMs: session.durationMs,
      sourceLanguage: session.sourceLanguage,
      targetLanguage: session.targetLanguage,
      translationModel: session.models.translation,
      transcriptionModel: session.models.transcription,
      createdByEmail,
      savedAt
    });

    db.prepare("DELETE FROM transcript_segments WHERE session_id = ?").run(session.id);
    const insertSegment = db.prepare(`
      INSERT INTO transcript_segments (
        session_id, id, position, started_at_ms, ended_at_ms,
        source_text, translated_text, is_final, created_at, updated_at
      )
      VALUES (
        @sessionId, @id, @position, @startedAtMs, @endedAtMs,
        @sourceText, @translatedText, @isFinal, @createdAt, @updatedAt
      )
    `);

    session.segments.forEach((segment, position) => {
      insertSegment.run({
        sessionId: session.id,
        id: segment.id,
        position,
        startedAtMs: segment.startedAtMs,
        endedAtMs: segment.endedAtMs ?? null,
        sourceText: segment.sourceText,
        translatedText: segment.translatedText,
        isFinal: segment.isFinal ? 1 : 0,
        createdAt: segment.createdAt,
        updatedAt: segment.updatedAt
      });
    });

    return getSession(session.id);
  });

  function listSessions(courseId?: string): ClassSessionSummary[] {
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
    const rows = (courseId ? db.prepare(query).all(courseId) : db.prepare(query).all()) as SessionRow[];
    return rows.map(rowToSummary);
  }

  function getSession(id: string): ClassSession | null {
    const sessionRow = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!sessionRow) {
      return null;
    }

    const segmentRows = db
      .prepare("SELECT * FROM transcript_segments WHERE session_id = ? ORDER BY position ASC")
      .all(id) as SegmentRow[];

    return rowToSession(sessionRow, segmentRows.map(rowToSegment));
  }

  function saveSession(session: ClassSession, createdByEmail: string | null): ClassSession {
    const savedSession = saveSessionTx(session, createdByEmail) as ClassSession | null;
    if (!savedSession) {
      throw new Error("Session save failed");
    }
    return savedSession;
  }

  function deleteSession(id: string): boolean {
    const result = db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return result.changes > 0;
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
