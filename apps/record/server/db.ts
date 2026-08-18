import Database from "better-sqlite3";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CourseOption } from "../shared/courses.js";
import type {
  ClassSession,
  ClassSessionSummary,
  CompleteLectureSessionRequest,
  CourseMatchStatus,
  FailedLectureSessionRequest,
  LectureCheckpointRequest,
  LectureModels,
  LectureSessionStatus,
  TranscriptSegment,
  TranslationMode,
  TranslationModel
} from "../src/types.js";

export type SqliteDatabase = Database.Database;

interface SessionRow {
  id: string;
  title: string;
  course_id: string;
  course_code: string;
  course_name: string;
  course_term: string;
  course_folder_name: string;
  course_match_status: CourseMatchStatus;
  finalization_warning: string | null;
  status: LectureSessionStatus;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  source_language: "ko";
  target_language: "zh";
  translation_model: TranslationModel;
  transcription_model: "gpt-realtime-whisper";
  translation_mode: TranslationMode | null;
  saved_at: string | null;
  updated_at: string;
  revision: number;
  segment_count?: number;
}

interface SegmentRow {
  id: string;
  commit_sequence: number | null;
  started_at_ms: number;
  ended_at_ms: number | null;
  source_text: string;
  translated_text: string;
  is_final: 0 | 1;
  created_at: string;
  updated_at: string;
}

interface CourseRow {
  id: string;
  code: string;
  name: string;
  term: string;
  folder_name: string;
  label: string;
  source: "canvas";
  workflow_state: string | null;
  start_at: string | null;
  end_at: string | null;
  is_archived: 0 | 1;
}

export interface LectureSearchHit {
  sessionId: string;
  sessionTitle: string;
  sessionStatus: LectureSessionStatus;
  finalizationWarning: string | null;
  sessionStartedAt: string;
  courseId: string;
  courseCode: string;
  courseName: string;
  segmentId: string;
  startedAtMs: number;
  endedAtMs?: number;
  sourceText: string;
  translatedText: string;
}

export const RECOVERED_SESSION_WARNING =
  "课堂记录由另一设备或刷新后的页面接管，接管前最后一段字幕无法确认，记录可能不完整。";

export function openDatabase(
  dbPath = process.env.LECTURE_DB_PATH ?? process.env.JIAHUAN_DB_PATH ?? defaultDatabasePath()
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

export function defaultDatabasePath(): string {
  // Keep the historical filename so the first branded release opens the
  // existing database instead of appearing to lose every saved transcript.
  return process.env.NODE_ENV === "production" ? "/data/jiahuan.sqlite" : "data/jiahuan.sqlite";
}

export function migrateDatabase(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      term TEXT NOT NULL,
      folder_name TEXT NOT NULL,
      label TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source = 'canvas'),
      workflow_state TEXT,
      start_at TEXT,
      end_at TEXT,
      is_archived INTEGER NOT NULL CHECK(is_archived IN (0, 1)),
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      archived_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      course_id TEXT NOT NULL,
      course_code TEXT NOT NULL,
      course_name TEXT NOT NULL,
      course_term TEXT NOT NULL,
      course_folder_name TEXT NOT NULL,
      course_match_status TEXT NOT NULL DEFAULT 'legacy_unmatched',
      finalization_warning TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER NOT NULL,
      source_language TEXT NOT NULL,
      target_language TEXT NOT NULL,
      translation_model TEXT NOT NULL,
      transcription_model TEXT NOT NULL,
      translation_mode TEXT,
      created_by_email TEXT,
      saved_at TEXT,
      updated_at TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 0,
      writer_lease_hash TEXT NOT NULL DEFAULT '',
      writer_epoch INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS transcript_segments (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      position INTEGER NOT NULL,
      commit_sequence INTEGER,
      started_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER,
      source_text TEXT NOT NULL,
      translated_text TEXT NOT NULL,
      is_final INTEGER NOT NULL CHECK (is_final IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_courses_archived_name ON courses(is_archived, name);
    CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_course_started ON sessions(course_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_segments_session_position ON transcript_segments(session_id, position);
  `);

  // Existing Jiahuan databases are upgraded in place. SQLite cannot add a
  // nullable constraint change cheaply, so recording rows use an empty
  // ended_at value until completion.
  addColumnIfMissing(db, "sessions", "course_match_status", "TEXT NOT NULL DEFAULT 'legacy_unmatched'");
  addColumnIfMissing(db, "sessions", "finalization_warning", "TEXT");
  addColumnIfMissing(db, "sessions", "status", "TEXT NOT NULL DEFAULT 'ready'");
  addColumnIfMissing(db, "sessions", "translation_mode", "TEXT");
  addColumnIfMissing(db, "sessions", "updated_at", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "sessions", "revision", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "sessions", "writer_lease_hash", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "sessions", "writer_epoch", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "transcript_segments", "commit_sequence", "INTEGER");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_status_started ON sessions(status, started_at DESC)");
  db.exec(`
    UPDATE sessions SET course_match_status = 'daily' WHERE course_id = 'daily';
    UPDATE sessions
      SET course_match_status = 'legacy_unmatched'
      WHERE course_id <> 'daily' AND (course_match_status IS NULL OR course_match_status = '');
    UPDATE sessions SET status = 'ready' WHERE status IS NULL OR status = '';
    UPDATE sessions SET updated_at = COALESCE(NULLIF(saved_at, ''), started_at) WHERE updated_at = '';
    UPDATE transcript_segments SET commit_sequence = position WHERE commit_sequence IS NULL;
  `);
  // Older deployments may already contain more than one unfinished session.
  // Never rewrite or archive that history during startup. New creates are
  // serialized and rejected by createSessionTx while any unfinished row exists.
  db.exec("DROP INDEX IF EXISTS idx_sessions_single_unfinished");

  ensureFtsTable(db);
  rebuildTranscriptSearchIndex(db);
}

function addColumnIfMissing(db: SqliteDatabase, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureFtsTable(db: SqliteDatabase): void {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_segments_fts USING fts5(
        session_id UNINDEXED,
        segment_id UNINDEXED,
        source_text,
        translated_text,
        tokenize='trigram'
      );
    `);
  } catch {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_segments_fts USING fts5(
        session_id UNINDEXED,
        segment_id UNINDEXED,
        source_text,
        translated_text,
        tokenize='unicode61'
      );
    `);
  }
}

function rebuildTranscriptSearchIndex(db: SqliteDatabase): void {
  db.exec(`
    DELETE FROM transcript_segments_fts;
    INSERT INTO transcript_segments_fts(session_id, segment_id, source_text, translated_text)
      SELECT session_id, id, source_text, translated_text FROM transcript_segments;
  `);
}

export function createCourseRepository(db: SqliteDatabase) {
  const upsertCoursesTx = db.transaction((courses: CourseOption[], syncedAt: string) => {
    const statement = db.prepare(`
      INSERT INTO courses(
        id, code, name, term, folder_name, label, source, workflow_state,
        start_at, end_at, is_archived, first_seen_at, last_seen_at, archived_at, updated_at
      ) VALUES (
        @id, @code, @name, @term, @folderName, @label, 'canvas', @workflowState,
        @startAt, @endAt, @isArchived, @firstSeenAt, @lastSeenAt, @archivedAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        code = excluded.code,
        name = excluded.name,
        term = excluded.term,
        folder_name = excluded.folder_name,
        label = excluded.label,
        workflow_state = excluded.workflow_state,
        start_at = excluded.start_at,
        end_at = excluded.end_at,
        is_archived = excluded.is_archived,
        last_seen_at = excluded.last_seen_at,
        archived_at = excluded.archived_at,
        updated_at = excluded.updated_at
    `);

    for (const course of courses) {
      if (course.source !== "canvas") {
        continue;
      }
      statement.run({
        ...course,
        isArchived: course.isArchived ? 1 : 0,
        firstSeenAt: syncedAt,
        lastSeenAt: course.lastSeenAt ?? syncedAt,
        archivedAt: course.archivedAt ?? (course.isArchived ? syncedAt : null),
        updatedAt: syncedAt
      });
    }
    const updated = db.prepare(
      `INSERT INTO app_metadata(key, value) VALUES ('courses_synced_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(syncedAt);
  });

  function upsertCourses(courses: CourseOption[], syncedAt: string): void {
    upsertCoursesTx(courses, syncedAt);
  }

  function listCourses(includeArchived = false): CourseOption[] {
    const rows = db
      .prepare(`SELECT * FROM courses ${includeArchived ? "" : "WHERE is_archived = 0"} ORDER BY term DESC, name ASC`)
      .all() as CourseRow[];
    return rows.map(rowToCourse);
  }

  function getCourse(id: string): CourseOption | null {
    const row = db.prepare("SELECT * FROM courses WHERE id = ?").get(id) as CourseRow | undefined;
    return row ? rowToCourse(row) : null;
  }

  function syncedAt(): string | null {
    const row = db.prepare("SELECT value FROM app_metadata WHERE key = 'courses_synced_at'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  return { upsertCourses, listCourses, getCourse, syncedAt };
}

export function createSessionRepository(db: SqliteDatabase) {
  const createSessionTx = db.transaction(({
    id,
    course,
    startedAt,
    models,
    writerLeaseToken,
    now
  }: {
    id: string;
    course: CourseOption;
    startedAt: string;
    models: LectureModels;
    writerLeaseToken: string;
    now: string;
  }) => {
    const unfinished = db
      .prepare("SELECT id FROM sessions WHERE status IN ('recording', 'failed') LIMIT 1")
      .get() as { id: string } | undefined;
    if (unfinished) {
      throw new UnfinishedLectureConflict(unfinished.id);
    }
    const matchStatus: CourseMatchStatus = course.source === "daily" ? "daily" : "matched";
    const title = `${course.source === "daily" ? "日常" : course.name} ${formatTitleDate(startedAt)}`;
    db.prepare(
      `INSERT INTO sessions(
        id, title, course_id, course_code, course_name, course_term, course_folder_name,
        course_match_status, finalization_warning, status, started_at, ended_at, duration_ms,
        source_language, target_language, translation_model, transcription_model,
        translation_mode, created_by_email, saved_at, updated_at, revision,
        writer_lease_hash, writer_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'recording', ?, '', 0, 'ko', 'zh', ?, ?, ?, NULL, '', ?, 0, ?, ?)`
    ).run(
      id, title, course.id, course.code, course.name, course.term, course.folderName, matchStatus,
      startedAt, models.translation, models.transcription, models.mode ?? null, now,
      hashWriterLeaseToken(writerLeaseToken), 1
    );
    return id;
  });

  const checkpointTx = db.transaction((id: string, checkpoint: LectureCheckpointRequest, now: string) => {
    const row = writableSessionRow(db, id);
    if (!row) {
      return false;
    }
    assertWriterLease(row, checkpoint);
    assertUnfinished(row.status);

    upsertSegments(db, id, checkpoint.segments);
    const updated = db.prepare(
      `UPDATE sessions
       SET duration_ms = MAX(duration_ms, ?), updated_at = ?, revision = revision + 1
       WHERE id = ? AND revision = ?`
    ).run(Math.round(checkpoint.durationMs), now, id, checkpoint.expectedRevision);
    if (updated.changes !== 1) throw new WriterLeaseConflict(row.revision);
    return true;
  });

  function createSession({
    id,
    course,
    startedAt,
    models,
    writerLeaseToken,
    now
  }: {
    id: string;
    course: CourseOption;
    startedAt: string;
    models: LectureModels;
    writerLeaseToken: string;
    now: string;
  }): ClassSession {
    createSessionTx({ id, course, startedAt, models, writerLeaseToken, now });
    return requireSession(id);
  }

  function checkpointSession(id: string, checkpoint: LectureCheckpointRequest, now = new Date().toISOString()): ClassSession | null {
    const found = checkpointTx(id, checkpoint, now);
    return found ? requireSession(id) : null;
  }

  const takeoverTx = db.transaction((
    id: string,
    writerLeaseToken: string,
    expectedRevision: number,
    now: string
  ) => {
    const row = writableSessionRow(db, id);
    if (!row) return false;
    assertUnfinished(row.status);
    if (row.revision !== expectedRevision) throw new WriterLeaseConflict(row.revision);
    const updated = db.prepare(
      `UPDATE sessions
       SET status = 'recording',
           finalization_warning = COALESCE(finalization_warning, ?),
           writer_lease_hash = ?, writer_epoch = writer_epoch + 1,
           updated_at = ?, revision = revision + 1
       WHERE id = ? AND revision = ?`
    ).run(RECOVERED_SESSION_WARNING, hashWriterLeaseToken(writerLeaseToken), now, id, expectedRevision);
    if (updated.changes !== 1) throw new WriterLeaseConflict(row.revision);
    return true;
  });

  function takeoverSession(
    id: string,
    writerLeaseToken: string,
    expectedRevision: number,
    now = new Date().toISOString()
  ): ClassSession | null {
    const found = takeoverTx(id, writerLeaseToken, expectedRevision, now);
    return found ? requireSession(id) : null;
  }

  const resumeTx = db.transaction((
    id: string,
    writerLeaseToken: string,
    expectedRevision: number,
    now: string
  ) => {
    const row = writableSessionRow(db, id);
    if (!row) return false;
    assertWriterLease(row, { writerLeaseToken, expectedRevision });
    assertUnfinished(row.status);
    const updated = db.prepare(
      `UPDATE sessions SET status = 'recording', updated_at = ?, revision = revision + 1
       WHERE id = ? AND revision = ?`
    ).run(now, id, expectedRevision);
    if (updated.changes !== 1) throw new WriterLeaseConflict(row.revision);
    return true;
  });

  function resumeSession(
    id: string,
    writerLeaseToken: string,
    expectedRevision: number,
    now = new Date().toISOString()
  ): ClassSession | null {
    const found = resumeTx(id, writerLeaseToken, expectedRevision, now);
    return found ? requireSession(id) : null;
  }

  const completeTx = db.transaction((id: string, input: CompleteLectureSessionRequest, now: string) => {
    const row = writableSessionRow(db, id);
    if (!row) {
      return false;
    }
    assertWriterLease(row, input);
    assertUnfinished(row.status);
    if (row.finalization_warning && input.acceptIncomplete !== true) {
      throw new IncompleteFinalizationConflict(row.finalization_warning);
    }
    upsertSegments(db, id, input.segments);
    const updated = db.prepare(
      `UPDATE sessions SET status = 'ready', ended_at = ?, duration_ms = MAX(duration_ms, ?),
       saved_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?`
    ).run(input.endedAt, Math.round(input.durationMs), now, now, id, input.expectedRevision);
    if (updated.changes !== 1) throw new WriterLeaseConflict(row.revision);
    return true;
  });

  function completeSession(
    id: string,
    input: CompleteLectureSessionRequest,
    now = new Date().toISOString()
  ): ClassSession | null {
    const found = completeTx(id, input, now);
    return found ? requireSession(id) : null;
  }

  const failTx = db.transaction((id: string, checkpoint: FailedLectureSessionRequest, now: string) => {
    const row = writableSessionRow(db, id);
    if (!row) return false;
    assertWriterLease(row, checkpoint);
    assertUnfinished(row.status);
    upsertSegments(db, id, checkpoint.segments);
    const updated = db.prepare(
      `UPDATE sessions
       SET status = 'failed', finalization_warning = COALESCE(finalization_warning, ?), duration_ms = MAX(duration_ms, ?),
           updated_at = ?, revision = revision + 1
       WHERE id = ? AND revision = ? AND status IN ('recording', 'failed')`
    ).run(checkpoint.finalizationWarning, Math.round(checkpoint.durationMs), now, id, checkpoint.expectedRevision);
    if (updated.changes !== 1) throw new WriterLeaseConflict(row.revision);
    return true;
  });

  function failSession(
    id: string,
    checkpoint: FailedLectureSessionRequest,
    now = new Date().toISOString()
  ): ClassSession | null {
    const found = failTx(id, checkpoint, now);
    return found ? requireSession(id) : null;
  }

  function listSessions(options: {
    courseId?: string;
    status?: LectureSessionStatus | "all";
    limit?: number;
  } = {}): ClassSessionSummary[] {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (options.courseId) {
      conditions.push("sessions.course_id = ?");
      values.push(options.courseId);
    }
    if (options.status && options.status !== "all") {
      conditions.push("sessions.status = ?");
      values.push(options.status);
    } else if (options.status !== "all") {
      conditions.push("sessions.status <> 'archived'");
    }
    values.push(options.limit ?? 100);
    const rows = db
      .prepare(
        `SELECT sessions.*, COUNT(transcript_segments.id) AS segment_count
         FROM sessions
         LEFT JOIN transcript_segments ON transcript_segments.session_id = sessions.id
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
         GROUP BY sessions.id
         ORDER BY sessions.started_at DESC
         LIMIT ?`
      )
      .all(...values) as SessionRow[];
    return rows.map(rowToSummary);
  }

  function getSession(id: string): ClassSession | null {
    const sessionRow = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!sessionRow) {
      return null;
    }
    const segmentRows = db
      .prepare(
        `SELECT * FROM transcript_segments WHERE session_id = ?
         ORDER BY COALESCE(commit_sequence, position) ASC, position ASC`
      )
      .all(id) as SegmentRow[];
    return rowToSession(sessionRow, segmentRows.map(rowToSegment));
  }

  function requireSession(id: string): ClassSession {
    const session = getSession(id);
    if (!session) {
      throw new Error("Lecture session was not found after write");
    }
    return session;
  }

  function archiveSession(id: string, now = new Date().toISOString()): boolean {
    const result = db
      .prepare("UPDATE sessions SET status = 'archived', updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'ready'")
      .run(now, id);
    return result.changes > 0;
  }

  function searchSessions({
    query,
    courseId,
    status = "ready",
    limit = 20
  }: {
    query: string;
    courseId?: string;
    status?: LectureSessionStatus | "all";
    limit?: number;
  }): LectureSearchHit[] {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const conditions = ["1 = 1"];
    const values: Array<string | number> = [];
    if (courseId) {
      conditions.push("sessions.course_id = ?");
      values.push(courseId);
    }
    if (status !== "all") {
      conditions.push("sessions.status = ?");
      values.push(status);
    }

    let rows: SearchRow[];
    if (normalizedQuery.length >= 3) {
      try {
        rows = db
          .prepare(
            `SELECT sessions.id AS session_id, sessions.title AS session_title,
                    sessions.status AS session_status, sessions.finalization_warning,
                    sessions.started_at AS session_started_at,
                    sessions.course_id, sessions.course_code, sessions.course_name,
                    transcript_segments.id AS segment_id, transcript_segments.started_at_ms,
                    transcript_segments.ended_at_ms, transcript_segments.source_text,
                    transcript_segments.translated_text
             FROM transcript_segments_fts
             JOIN transcript_segments
               ON transcript_segments.session_id = transcript_segments_fts.session_id
              AND transcript_segments.id = transcript_segments_fts.segment_id
             JOIN sessions ON sessions.id = transcript_segments.session_id
             WHERE transcript_segments_fts MATCH ? AND ${conditions.join(" AND ")}
             ORDER BY bm25(transcript_segments_fts), sessions.started_at DESC
             LIMIT ?`
          )
          .all(ftsQuery(normalizedQuery), ...values, limit) as SearchRow[];
      } catch {
        rows = searchWithLike(db, normalizedQuery, conditions, values, limit);
      }
    } else {
      rows = searchWithLike(db, normalizedQuery, conditions, values, limit);
    }
    return rows.map(rowToSearchHit);
  }

  return {
    createSession,
    checkpointSession,
    takeoverSession,
    resumeSession,
    completeSession,
    failSession,
    listSessions,
    getSession,
    archiveSession,
    searchSessions
  };
}

export class UnfinishedLectureConflict extends Error {
  constructor(public readonly sessionId: string) {
    super("An unfinished lecture session already exists");
  }
}

export class IncompleteFinalizationConflict extends Error {
  constructor(public readonly warning: string) {
    super("Lecture session has an incomplete finalization warning");
  }
}

export class WriterLeaseConflict extends Error {
  constructor(public readonly currentRevision: number) {
    super("The lecture writer lease or revision is no longer current");
  }
}

interface WritableSessionRow {
  status: LectureSessionStatus;
  finalization_warning: string | null;
  writer_lease_hash: string;
  revision: number;
}

function writableSessionRow(db: SqliteDatabase, id: string): WritableSessionRow | undefined {
  return db.prepare(
    `SELECT status, finalization_warning, writer_lease_hash, revision FROM sessions WHERE id = ?`
  ).get(id) as WritableSessionRow | undefined;
}

function assertUnfinished(status: LectureSessionStatus): void {
  if (status !== "recording" && status !== "failed") {
    throw new Error("Lecture session is no longer writable");
  }
}

function assertWriterLease(
  row: WritableSessionRow,
  input: { writerLeaseToken: string; expectedRevision: number }
): void {
  const suppliedHash = hashWriterLeaseToken(input.writerLeaseToken);
  const currentHash = row.writer_lease_hash;
  const hashesMatch = currentHash.length === suppliedHash.length && timingSafeEqual(
    Buffer.from(currentHash, "utf8"),
    Buffer.from(suppliedHash, "utf8")
  );
  if (!hashesMatch || input.expectedRevision !== row.revision) {
    throw new WriterLeaseConflict(row.revision);
  }
}

function hashWriterLeaseToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function upsertSegments(db: SqliteDatabase, sessionId: string, segments: TranscriptSegment[]): void {
  const currentMax = db
    .prepare("SELECT COALESCE(MAX(position), -1) AS max_position FROM transcript_segments WHERE session_id = ?")
    .get(sessionId) as { max_position: number };
  let nextPosition = currentMax.max_position + 1;
  const findPosition = db.prepare("SELECT position FROM transcript_segments WHERE session_id = ? AND id = ?");
  const upsert = db.prepare(`
    INSERT INTO transcript_segments(
      session_id, id, position, commit_sequence, started_at_ms, ended_at_ms,
      source_text, translated_text, is_final, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, id) DO UPDATE SET
      started_at_ms = excluded.started_at_ms,
      commit_sequence = COALESCE(excluded.commit_sequence, transcript_segments.commit_sequence),
      ended_at_ms = excluded.ended_at_ms,
      source_text = excluded.source_text,
      translated_text = excluded.translated_text,
      is_final = excluded.is_final,
      updated_at = excluded.updated_at
  `);
  const deleteFts = db.prepare("DELETE FROM transcript_segments_fts WHERE session_id = ? AND segment_id = ?");
  const insertFts = db.prepare(
    "INSERT INTO transcript_segments_fts(session_id, segment_id, source_text, translated_text) VALUES (?, ?, ?, ?)"
  );

  for (const segment of segments) {
    const existing = findPosition.get(sessionId, segment.id) as { position: number } | undefined;
    const position = existing?.position ?? nextPosition++;
    upsert.run(
      sessionId,
      segment.id,
      position,
      segment.commitSequence ?? position,
      Math.round(segment.startedAtMs),
      segment.endedAtMs === undefined ? null : Math.round(segment.endedAtMs),
      segment.sourceText,
      segment.translatedText,
      segment.isFinal ? 1 : 0,
      segment.createdAt,
      segment.updatedAt
    );
    deleteFts.run(sessionId, segment.id);
    insertFts.run(sessionId, segment.id, segment.sourceText, segment.translatedText);
  }
}

function rowToCourse(row: CourseRow): CourseOption {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    term: row.term,
    folderName: row.folder_name,
    label: row.label,
    source: "canvas",
    workflowState: row.workflow_state,
    startAt: row.start_at,
    endAt: row.end_at,
    isArchived: Boolean(row.is_archived)
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
    courseMatchStatus: row.course_match_status,
    finalizationWarning: row.finalization_warning,
    revision: row.revision,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at || null,
    durationMs: row.duration_ms,
    sourceLanguage: row.source_language,
    targetLanguage: row.target_language,
    models: {
      translation: row.translation_model,
      transcription: row.transcription_model,
      mode: row.translation_mode ?? undefined
    },
    segmentCount: row.segment_count ?? 0,
    savedAt: row.saved_at || null,
    updatedAt: row.updated_at
  };
}

function rowToSession(row: SessionRow, segments: TranscriptSegment[]): ClassSession {
  return { ...rowToSummary(row), segments };
}

function rowToSegment(row: SegmentRow): TranscriptSegment {
  return {
    id: row.id,
    commitSequence: row.commit_sequence ?? undefined,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms ?? undefined,
    sourceText: row.source_text,
    translatedText: row.translated_text,
    isFinal: Boolean(row.is_final),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

interface SearchRow {
  session_id: string;
  session_title: string;
  session_status: LectureSessionStatus;
  finalization_warning: string | null;
  session_started_at: string;
  course_id: string;
  course_code: string;
  course_name: string;
  segment_id: string;
  started_at_ms: number;
  ended_at_ms: number | null;
  source_text: string;
  translated_text: string;
}

function rowToSearchHit(row: SearchRow): LectureSearchHit {
  return {
    sessionId: row.session_id,
    sessionTitle: row.session_title,
    sessionStatus: row.session_status,
    finalizationWarning: row.finalization_warning,
    sessionStartedAt: row.session_started_at,
    courseId: row.course_id,
    courseCode: row.course_code,
    courseName: row.course_name,
    segmentId: row.segment_id,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms ?? undefined,
    sourceText: row.source_text,
    translatedText: row.translated_text
  };
}

function searchWithLike(
  db: SqliteDatabase,
  query: string,
  conditions: string[],
  values: Array<string | number>,
  limit: number
): SearchRow[] {
  const like = `%${escapeLike(query)}%`;
  return db
    .prepare(
      `SELECT sessions.id AS session_id, sessions.title AS session_title,
              sessions.status AS session_status, sessions.finalization_warning,
              sessions.started_at AS session_started_at,
              sessions.course_id, sessions.course_code, sessions.course_name,
              transcript_segments.id AS segment_id, transcript_segments.started_at_ms,
              transcript_segments.ended_at_ms, transcript_segments.source_text,
              transcript_segments.translated_text
       FROM transcript_segments
       JOIN sessions ON sessions.id = transcript_segments.session_id
       WHERE (transcript_segments.source_text LIKE ? ESCAPE '\\'
              OR transcript_segments.translated_text LIKE ? ESCAPE '\\')
         AND ${conditions.join(" AND ")}
       ORDER BY sessions.started_at DESC, COALESCE(transcript_segments.commit_sequence, transcript_segments.position) ASC
       LIMIT ?`
    )
    .all(like, like, ...values, limit) as SearchRow[];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function ftsQuery(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function formatTitleDate(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul"
  }).format(date);
}
