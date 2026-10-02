import type { CourseOption } from "../shared/courses";
import {
  lectureSessionSummarySchema,
  lectureSearchHitSchema,
  transcriptSegmentSchema,
  type GetLectureSessionResponse,
  type LectureSearchHit,
  type ListLectureSessionsResponse,
  type SearchLectureTranscriptsResponse,
} from "../../core/src/lecture/types";
import { InvalidLectureCursor, InvalidLectureRecord, readCursor, validatedPage } from "./read-pages";
import type {
  ClassSession,
  ClassSessionSummary,
  CompleteLectureSessionRequest,
  CourseMatchStatus,
  FailedLectureSessionRequest,
  LectureCheckpointRequest,
  LectureModels,
  LectureSessionStatus,
  TranscriptSegment
} from "../src/types";

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
  last_seen_at: string;
  archived_at: string | null;
}

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
  translation_model: string;
  transcription_model: string;
  translation_mode: string | null;
  saved_at: string;
  updated_at: string;
  revision: number;
  segment_count?: number;
  source_json?: string | null;
}

interface SegmentRow {
  id: string;
  position: number;
  sequence: number;
  commit_sequence: number | null;
  started_at_ms: number;
  ended_at_ms: number | null;
  source_text: string;
  translated_text: string;
  is_final: 0 | 1;
  created_at: string;
  updated_at: string;
}

interface WritableSessionRow {
  status: LectureSessionStatus;
  finalization_warning: string | null;
  writer_lease_hash: string;
  revision: number;
}

interface SearchRow {
  position: number;
  sequence: number;
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

export interface LectureReadOptions {
  courseId?: string;
  status?: LectureSessionStatus | "all";
  startAt?: string;
  endAt?: string;
  cursor?: string;
  limit?: number;
}

export interface TranscriptReadOptions {
  startMs?: number;
  endMs?: number;
  cursor?: string;
  limit?: number;
}

export const RECOVERED_SESSION_WARNING =
  "这条课堂记录由另一台设备或刷新后的页面接管；接管前的最后一段字幕无法确认，记录可能不完整。";

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

export class SessionNotWritableError extends Error {
  constructor() { super("Lecture session is no longer writable"); }
}

export function createD1CourseRepository(db: D1Database) {
  async function upsertCourses(courses: CourseOption[], syncedAt: string): Promise<void> {
    const statements = courses
      .filter((course) => course.source === "canvas")
      .map((course) =>
        db.prepare(`
          INSERT INTO courses(
            id, code, name, term, folder_name, label, source, workflow_state,
            start_at, end_at, is_archived, first_seen_at, last_seen_at, archived_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'canvas', ?, ?, ?, ?, ?, ?, ?, ?)
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
        `).bind(
          course.id,
          course.code,
          course.name,
          course.term,
          course.folderName,
          course.label,
          course.workflowState,
          course.startAt,
          course.endAt,
          course.isArchived ? 1 : 0,
          syncedAt,
          course.lastSeenAt ?? syncedAt,
          course.archivedAt ?? (course.isArchived ? syncedAt : null),
          syncedAt
        )
      );
    statements.push(
      db.prepare(`
        INSERT INTO app_metadata(key, value) VALUES ('courses_synced_at', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).bind(syncedAt)
    );
    await db.batch(statements);
  }

  async function listCourses(includeArchived = false): Promise<CourseOption[]> {
    const query = `SELECT * FROM courses ${includeArchived ? "" : "WHERE is_archived = 0"} ORDER BY term DESC, name ASC`;
    const result = await db.prepare(query).all<CourseRow>();
    return result.results.map(rowToCourse);
  }

  async function getCourse(id: string): Promise<CourseOption | null> {
    const row = await db.prepare("SELECT * FROM courses WHERE id = ?").bind(id).first<CourseRow>();
    return row ? rowToCourse(row) : null;
  }

  async function syncedAt(): Promise<string | null> {
    const row = await db
      .prepare("SELECT value FROM app_metadata WHERE key = 'courses_synced_at'")
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  return { upsertCourses, listCourses, getCourse, syncedAt };
}

export function createD1SessionRepository(db: D1Database) {
  async function createSession({
    id,
    course,
    startedAt,
    models,
    writerLeaseToken,
    title: suppliedTitle,
    now
  }: {
    id: string;
    course: CourseOption;
    startedAt: string;
    models: LectureModels;
    writerLeaseToken: string;
    title?: string;
    now: string;
  }): Promise<ClassSession> {
    const matchStatus: CourseMatchStatus = course.source === "daily" ? "daily" : "matched";
    const title = suppliedTitle ?? `${course.source === "daily" ? "日常" : course.name} ${formatTitleDate(startedAt)}`;
    const leaseHash = await hashWriterLeaseToken(writerLeaseToken);
    const result = await db.prepare(`
      INSERT INTO sessions(
        id, title, course_id, course_code, course_name, course_term, course_folder_name,
        course_match_status, finalization_warning, status, started_at, ended_at, duration_ms,
        source_language, target_language, translation_model, transcription_model,
        translation_mode, created_by_email, saved_at, updated_at, revision,
        writer_lease_hash, writer_epoch
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'recording', ?, '', 0,
             'ko', 'zh', ?, ?, ?, NULL, '', ?, 0, ?, 1
      WHERE NOT EXISTS (
        SELECT 1 FROM sessions WHERE status IN ('recording', 'failed') AND source_json IS NULL
      )
    `).bind(
      id,
      title,
      course.id,
      course.code,
      course.name,
      course.term,
      course.folderName,
      matchStatus,
      startedAt,
      models.translation,
      models.transcription,
      models.mode ?? null,
      now,
      leaseHash
    ).run();
    if ((result.meta.changes ?? 0) !== 1) {
      const unfinished = await db
        .prepare("SELECT id FROM sessions WHERE status IN ('recording', 'failed') AND source_json IS NULL ORDER BY started_at DESC LIMIT 1")
        .first<{ id: string }>();
      throw new UnfinishedLectureConflict(unfinished?.id ?? "unknown");
    }
    return requireSession(id);
  }

  async function checkpointSession(
    id: string,
    input: LectureCheckpointRequest,
    now = new Date().toISOString()
  ): Promise<ClassSession | null> {
    const row = await writableSessionRow(db, id);
    if (!row) return null;
    const leaseHash = await assertWriterLease(row, input);
    assertUnfinished(row.status);
    await upsertSegmentsAndUpdate(db, id, input, leaseHash, db.prepare(`
      UPDATE sessions
      SET duration_ms = MAX(duration_ms, ?), updated_at = ?, revision = revision + 1
      WHERE id = ? AND revision = ? AND writer_lease_hash = ? AND status IN ('recording', 'failed')
    `).bind(Math.round(input.durationMs), now, id, input.expectedRevision, leaseHash));
    return requireSession(id);
  }

  async function failSession(
    id: string,
    input: FailedLectureSessionRequest,
    now = new Date().toISOString()
  ): Promise<ClassSession | null> {
    const row = await writableSessionRow(db, id);
    if (!row) return null;
    const leaseHash = await assertWriterLease(row, input);
    assertUnfinished(row.status);
    await upsertSegmentsAndUpdate(db, id, input, leaseHash, db.prepare(`
      UPDATE sessions
      SET status = 'failed', finalization_warning = COALESCE(finalization_warning, ?),
          duration_ms = MAX(duration_ms, ?), updated_at = ?, revision = revision + 1
      WHERE id = ? AND revision = ? AND writer_lease_hash = ? AND status IN ('recording', 'failed')
    `).bind(
      input.finalizationWarning,
      Math.round(input.durationMs),
      now,
      id,
      input.expectedRevision,
      leaseHash
    ));
    return requireSession(id);
  }

  async function completeSession(
    id: string,
    input: CompleteLectureSessionRequest,
    now = new Date().toISOString()
  ): Promise<ClassSession | null> {
    const row = await writableSessionRow(db, id);
    if (!row) return null;
    const leaseHash = await assertWriterLease(row, input);
    assertUnfinished(row.status);
    if (row.finalization_warning && input.acceptIncomplete !== true) {
      throw new IncompleteFinalizationConflict(row.finalization_warning);
    }
    await upsertSegmentsAndUpdate(db, id, input, leaseHash, db.prepare(`
      UPDATE sessions
      SET status = 'ready', ended_at = ?, duration_ms = MAX(duration_ms, ?),
          saved_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND revision = ? AND writer_lease_hash = ? AND status IN ('recording', 'failed')
    `).bind(
      input.endedAt,
      Math.round(input.durationMs),
      now,
      now,
      id,
      input.expectedRevision,
      leaseHash
    ));
    return requireSession(id);
  }

  async function takeoverSession(
    id: string,
    writerLeaseToken: string,
    expectedRevision: number,
    now = new Date().toISOString()
  ): Promise<ClassSession | null> {
    const row = await writableSessionRow(db, id);
    if (!row) return null;
    assertUnfinished(row.status);
    if (row.revision !== expectedRevision) throw new WriterLeaseConflict(row.revision);
    const leaseHash = await hashWriterLeaseToken(writerLeaseToken);
    const result = await db.prepare(`
      UPDATE sessions
      SET status = 'recording', finalization_warning = COALESCE(finalization_warning, ?),
          writer_lease_hash = ?, writer_epoch = writer_epoch + 1,
          updated_at = ?, revision = revision + 1
      WHERE id = ? AND revision = ? AND status IN ('recording', 'failed')
    `).bind(RECOVERED_SESSION_WARNING, leaseHash, now, id, expectedRevision).run();
    await assertMutation(result, db, id);
    return requireSession(id);
  }

  async function resumeSession(
    id: string,
    writerLeaseToken: string,
    expectedRevision: number,
    now = new Date().toISOString()
  ): Promise<ClassSession | null> {
    const row = await writableSessionRow(db, id);
    if (!row) return null;
    const leaseHash = await assertWriterLease(row, { writerLeaseToken, expectedRevision });
    assertUnfinished(row.status);
    const result = await db.prepare(`
      UPDATE sessions SET status = 'recording', updated_at = ?, revision = revision + 1
      WHERE id = ? AND revision = ? AND writer_lease_hash = ? AND status IN ('recording', 'failed')
    `).bind(now, id, expectedRevision, leaseHash).run();
    await assertMutation(result, db, id);
    return requireSession(id);
  }

  async function listSessions(options: LectureReadOptions = {}): Promise<ListLectureSessionsResponse> {
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
    addDateWindow(conditions, values, options);
    const scope = JSON.stringify(["sessions", options.courseId ?? null, options.status ?? "active", options.startAt ?? null, options.endAt ?? null]);
    const cursor = readCursor(options.cursor, scope);
    if (cursor) {
      if (cursor.length !== 2 || cursor.some((key) => typeof key !== "string")) throw new InvalidLectureCursor();
      conditions.push("(sessions.started_at, sessions.id) < (?, ?)");
      values.push(...cursor);
    }
    const limit = options.limit ?? 100;
    values.push(limit + 1);
    const result = await db.prepare(`
      SELECT sessions.*, COUNT(transcript_segments.id) AS segment_count
      FROM sessions
      LEFT JOIN transcript_segments ON transcript_segments.session_id = sessions.id
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      GROUP BY sessions.id
      ORDER BY sessions.started_at DESC, sessions.id DESC
      LIMIT ?
    `).bind(...values).all<SessionRow>();
    return validatedPage({
      rows: result.results, limit, scope,
      key: row => [row.started_at, row.id], id: row => row.id,
      map: rowToSummary, schema: lectureSessionSummarySchema,
    });
  }

  async function getTranscriptPage(id: string, options: TranscriptReadOptions = {}): Promise<GetLectureSessionResponse | null> {
    const row = await db.prepare(`
      SELECT sessions.*, (SELECT COUNT(*) FROM transcript_segments WHERE session_id = sessions.id) AS segment_count
      FROM sessions WHERE id = ?
    `).bind(id).first<SessionRow>();
    if (!row) return null;
    const parsed = lectureSessionSummarySchema.safeParse(rowToSummary(row));
    if (!parsed.success) throw new InvalidLectureRecord();
    const scope = JSON.stringify(["transcript", id, row.revision, options.startMs ?? null, options.endMs ?? null]);
    const cursor = readCursor(options.cursor, scope);
    const conditions = ["session_id = ?"];
    const values: Array<string | number> = [id];
    let priorWarnings = 0;
    if (options.startMs !== undefined) { conditions.push("started_at_ms >= ?"); values.push(options.startMs); }
    if (options.endMs !== undefined) { conditions.push("started_at_ms < ?"); values.push(options.endMs); }
    if (cursor) {
      if (cursor.length !== 4 || typeof cursor[0] !== "number" || typeof cursor[1] !== "number" || typeof cursor[2] !== "string" || typeof cursor[3] !== "number" || cursor[3] < 0) throw new InvalidLectureCursor();
      priorWarnings = cursor[3];
      conditions.push("(COALESCE(commit_sequence, position), position, id) > (?, ?, ?)");
      values.push(cursor[0], cursor[1], cursor[2]);
    }
    const limit = options.limit ?? 20;
    values.push(limit + 1);
    const result = await db.prepare(`
      SELECT *, COALESCE(commit_sequence, position) AS sequence FROM transcript_segments
      WHERE ${conditions.join(" AND ")}
      ORDER BY sequence ASC, position ASC, id ASC LIMIT ?
    `).bind(...values).all<SegmentRow>();
    const page = validatedPage({
      rows: result.results, limit, scope,
      key: (segment, skipped) => [segment.sequence, segment.position, segment.id, priorWarnings + skipped], id: segment => segment.id,
      map: rowToSegment, schema: transcriptSegmentSchema,
    });
    return { session: parsed.data, ...page, rangeComplete: page.nextCursor === null && priorWarnings + page.warnings.length === 0 };
  }

  async function getSession(id: string): Promise<ClassSession | null> {
    const sessionRow = await db.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
    if (!sessionRow) return null;
    const segmentResult = await db.prepare(`
      SELECT * FROM transcript_segments WHERE session_id = ?
      ORDER BY COALESCE(commit_sequence, position) ASC, position ASC
    `).bind(id).all<SegmentRow>();
    return rowToSession(sessionRow, segmentResult.results.map(rowToSegment));
  }

  async function getSchoolLive(courseId: string): Promise<GetLectureSessionResponse | null> {
    const row = await db.prepare(`SELECT sessions.*, (SELECT COUNT(*) FROM transcript_segments WHERE session_id=sessions.id) AS segment_count
      FROM sessions WHERE course_id=? AND source_json IS NOT NULL AND status<>'archived'
      ORDER BY started_at DESC,id DESC LIMIT 1`).bind(courseId).first<SessionRow>();
    if (!row) return null;
    const result = await db.prepare(`SELECT * FROM transcript_segments WHERE session_id=?
      ORDER BY COALESCE(commit_sequence,position) DESC,position DESC,id DESC LIMIT 3`).bind(row.id).all<SegmentRow>();
    return { session: lectureSessionSummarySchema.parse(rowToSummary(row)),
      items: result.results.reverse().map(segment => transcriptSegmentSchema.parse(rowToSegment(segment))),
      nextCursor: null, warnings: [], rangeComplete: false };
  }

  async function archiveSession(id: string, now = new Date().toISOString()): Promise<boolean> {
    const result = await db.prepare(`
      UPDATE sessions SET status = 'archived', updated_at = ?, revision = revision + 1
      WHERE id = ? AND status = 'ready'
    `).bind(now, id).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async function searchSessions(options: LectureReadOptions & { query: string; sessionId?: string }): Promise<SearchLectureTranscriptsResponse> {
    const { query, courseId, status = "ready", limit = 20 } = options;
    const normalized = query.trim();
    if (!normalized) return { query, items: [], nextCursor: null, warnings: [] };
    const conditions = [
      "(transcript_segments.source_text LIKE ? ESCAPE '\\' OR transcript_segments.translated_text LIKE ? ESCAPE '\\')"
    ];
    const like = `%${escapeLike(normalized)}%`;
    const values: Array<string | number> = [like, like];
    if (courseId) {
      conditions.push("sessions.course_id = ?");
      values.push(courseId);
    }
    if (status !== "all") {
      conditions.push("sessions.status = ?");
      values.push(status);
    }
    if (options.sessionId) { conditions.push("sessions.id = ?"); values.push(options.sessionId); }
    addDateWindow(conditions, values, options);
    const scope = JSON.stringify(["search", normalized, courseId ?? null, status, options.sessionId ?? null, options.startAt ?? null, options.endAt ?? null]);
    const cursor = readCursor(options.cursor, scope);
    if (cursor) {
      const [started, session, sequence, position, segment] = cursor;
      if (cursor.length !== 5 || typeof started !== "string" || typeof session !== "string" || typeof sequence !== "number" || typeof position !== "number" || typeof segment !== "string") throw new InvalidLectureCursor();
      conditions.push(`(
        (sessions.started_at, sessions.id) < (?, ?)
        OR ((sessions.started_at, sessions.id) = (?, ?) AND
          (COALESCE(transcript_segments.commit_sequence, transcript_segments.position), transcript_segments.position, transcript_segments.id) > (?, ?, ?))
      )`);
      values.push(started, session, started, session, sequence, position, segment);
    }
    values.push(limit + 1);
    const result = await db.prepare(`
      SELECT sessions.id AS session_id, sessions.title AS session_title,
             sessions.status AS session_status, sessions.finalization_warning,
             sessions.started_at AS session_started_at,
             sessions.course_id, sessions.course_code, sessions.course_name,
             transcript_segments.id AS segment_id, transcript_segments.started_at_ms,
             transcript_segments.ended_at_ms, transcript_segments.source_text,
             transcript_segments.translated_text, transcript_segments.position,
             COALESCE(transcript_segments.commit_sequence, transcript_segments.position) AS sequence
      FROM transcript_segments
      JOIN sessions ON sessions.id = transcript_segments.session_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY sessions.started_at DESC, sessions.id DESC, sequence ASC,
               transcript_segments.position ASC, transcript_segments.id ASC
      LIMIT ?
    `).bind(...values).all<SearchRow>();
    return { query: normalized, ...validatedPage({
      rows: result.results, limit, scope,
      key: row => [row.session_started_at, row.session_id, row.sequence, row.position, row.segment_id],
      id: row => row.segment_id, map: rowToSearchHit, schema: lectureSearchHitSchema,
    }) };
  }

  async function requireSession(id: string): Promise<ClassSession> {
    const session = await getSession(id);
    if (!session) throw new Error("Lecture session was not found after write");
    return session;
  }

  return {
    createSession,
    checkpointSession,
    failSession,
    completeSession,
    takeoverSession,
    resumeSession,
    listSessions,
    getSession,
    getSchoolLive,
    getTranscriptPage,
    archiveSession,
    searchSessions
  };
}

async function upsertSegmentsAndUpdate(
  db: D1Database,
  sessionId: string,
  input: LectureCheckpointRequest,
  leaseHash: string,
  updateStatement: D1PreparedStatement
): Promise<void> {
  const payload = input.segments.map((segment, position) => ({
    id: segment.id,
    position,
    commitSequence: segment.commitSequence ?? null,
    startedAtMs: Math.round(segment.startedAtMs),
    endedAtMs: segment.endedAtMs === undefined ? null : Math.round(segment.endedAtMs),
    sourceText: segment.sourceText,
    translatedText: segment.translatedText,
    isFinal: segment.isFinal ? 1 : 0,
    createdAt: segment.createdAt,
    updatedAt: segment.updatedAt
  }));
  const writablePredicate = `
    EXISTS (
      SELECT 1 FROM sessions
      WHERE id = ? AND revision = ? AND writer_lease_hash = ?
        AND status IN ('recording', 'failed')
    )
  `;
  const results = await db.batch([
    db.prepare(`
      WITH base AS (
        SELECT COALESCE(MAX(position), -1) AS last_position FROM transcript_segments WHERE session_id = ?
      )
      INSERT INTO transcript_segments(
        session_id, id, position, commit_sequence, started_at_ms, ended_at_ms,
        source_text, translated_text, is_final, created_at, updated_at
      )
      SELECT ?,
             json_extract(value, '$.id'),
             COALESCE((SELECT position FROM transcript_segments WHERE session_id = ? AND id = json_extract(value, '$.id')), base.last_position + CAST(key AS INTEGER) + 1),
             json_extract(value, '$.commitSequence'),
             json_extract(value, '$.startedAtMs'),
             json_extract(value, '$.endedAtMs'),
             json_extract(value, '$.sourceText'),
             json_extract(value, '$.translatedText'),
             json_extract(value, '$.isFinal'),
             json_extract(value, '$.createdAt'),
             json_extract(value, '$.updatedAt')
      FROM json_each(?), base
      WHERE ${writablePredicate}
      ON CONFLICT(session_id, id) DO UPDATE SET
        commit_sequence = COALESCE(excluded.commit_sequence, transcript_segments.commit_sequence),
        started_at_ms = excluded.started_at_ms,
        ended_at_ms = excluded.ended_at_ms,
        source_text = excluded.source_text,
        translated_text = excluded.translated_text,
        is_final = excluded.is_final,
        updated_at = excluded.updated_at
    `).bind(
      sessionId,
      sessionId,
      sessionId,
      JSON.stringify(payload),
      sessionId,
      input.expectedRevision,
      leaseHash
    ),
    updateStatement
  ]);
  await assertMutation(results.at(-1), db, sessionId);
}

async function writableSessionRow(db: D1Database, id: string): Promise<WritableSessionRow | null> {
  return db.prepare(`
    SELECT status, finalization_warning, writer_lease_hash, revision FROM sessions WHERE id = ? AND source_json IS NULL
  `).bind(id).first<WritableSessionRow>();
}

function assertUnfinished(status: LectureSessionStatus): void {
  if (status !== "recording" && status !== "failed") {
    throw new SessionNotWritableError();
  }
}

async function assertWriterLease(
  row: WritableSessionRow,
  input: { writerLeaseToken: string; expectedRevision: number }
): Promise<string> {
  const suppliedHash = await hashWriterLeaseToken(input.writerLeaseToken);
  if (suppliedHash !== row.writer_lease_hash || input.expectedRevision !== row.revision) {
    throw new WriterLeaseConflict(row.revision);
  }
  return suppliedHash;
}

async function assertMutation(
  result: D1Result<unknown> | undefined,
  db: D1Database,
  id: string
): Promise<void> {
  if ((result?.meta.changes ?? 0) === 1) return;
  const current = await writableSessionRow(db, id);
  if (!current || (current.status !== "recording" && current.status !== "failed")) {
    throw new SessionNotWritableError();
  }
  throw new WriterLeaseConflict(current.revision);
}

async function hashWriterLeaseToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
    isArchived: Boolean(row.is_archived),
    lastSeenAt: row.last_seen_at,
    archivedAt: row.archived_at
  };
}

function rowToSummary(row: SessionRow): ClassSessionSummary {
  return {
    ...(row.source_json ? { source: JSON.parse(row.source_json) } : {}),
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
  return { ...rowToSummary({ ...row, segment_count: segments.length }), segments };
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

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function addDateWindow(conditions: string[], values: Array<string | number>, options: LectureReadOptions): void {
  if (options.startAt) { conditions.push("sessions.started_at >= ?"); values.push(new Date(options.startAt).toISOString()); }
  if (options.endAt) { conditions.push("sessions.started_at < ?"); values.push(new Date(options.endAt).toISOString()); }
}

function formatTitleDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul"
  }).format(new Date(value));
}
