import type { CourseOption } from "../shared/courses";
import type { SchoolCourse, SchoolImport } from "../../core/src/lecture/school-types";

export function schoolCaptionRepository(db: D1Database) {
  return {
    async ensureDefaults(courses: CourseOption[]): Promise<void> {
      const active = courses.filter(course => course.source === "canvas" && !course.isArchived);
      if (active.length) await db.batch(active.map(course => db.prepare(`INSERT OR IGNORE INTO school_caption_courses(course_id,enabled,updated_at)
        VALUES(?,1,?)`).bind(course.id, new Date().toISOString())));
    },
    async list(): Promise<SchoolCourse[]> {
      const rows = await db.prepare(`SELECT s.* FROM school_caption_courses s JOIN courses c ON c.id=s.course_id
        WHERE c.is_archived=0 ORDER BY s.course_id`).all<{
          course_id: string; enabled: number; last_checked_at: string | null; session_count: number; error: string | null;
        }>();
      return rows.results.map(row => ({ courseId: row.course_id, enabled: Boolean(row.enabled),
        lastCheckedAt: row.last_checked_at, sessionCount: row.session_count, error: row.error }));
    },
    async configure(courseId: string, enabled: boolean): Promise<void> {
      await db.prepare(`INSERT INTO school_caption_courses(course_id,enabled,updated_at) VALUES(?,?,?)
        ON CONFLICT(course_id) DO UPDATE SET enabled=excluded.enabled,error=NULL,updated_at=excluded.updated_at`)
        .bind(courseId, enabled ? 1 : 0, new Date().toISOString()).run();
    },
    async status(courseId: string, sessionCount: number, error: string | null): Promise<void> {
      await db.prepare(`UPDATE school_caption_courses SET last_checked_at=?,session_count=?,error=? WHERE course_id=? AND enabled=1`)
        .bind(new Date().toISOString(), sessionCount, error, courseId).run();
    },
    async ingest(course: CourseOption, input: SchoolImport): Promise<void> {
      const now = new Date().toISOString();
      const id = `school_${input.viewerId}`;
      const source = JSON.stringify({ kind: "hanyang-translive", viewerId: input.viewerId,
        viewerUrl: `https://learning.hanyang.ac.kr/translive/v/${input.viewerId}`, moduleItemId: input.moduleItemId,
        recordingStatus: input.recordingStatus, lastSyncedAt: now });
      const duration = Math.max(0, ...input.segments.map(segment => segment.endedAtMs ?? segment.startedAtMs));
      // One atomic D1 batch. Both statements recheck opt-in so disabling cannot race a pending import.
      await db.batch([
        db.prepare(`INSERT INTO sessions(id,title,course_id,course_code,course_name,course_term,course_folder_name,
          course_match_status,status,started_at,ended_at,duration_ms,source_language,target_language,
          translation_model,transcription_model,translation_mode,saved_at,updated_at,source_json)
          SELECT ?,?,?,?,?,?,?,'matched',?,?,?,?,'ko','zh','school-provided','school-provided','school-captions',?,?,?
          WHERE EXISTS(SELECT 1 FROM school_caption_courses WHERE course_id=? AND enabled=1)
          ON CONFLICT(id) DO UPDATE SET title=excluded.title,ended_at=excluded.ended_at,
            status=CASE WHEN sessions.status='archived' THEN 'archived' ELSE excluded.status END,
            duration_ms=MAX(sessions.duration_ms,excluded.duration_ms),source_json=excluded.source_json,
            updated_at=excluded.updated_at,revision=sessions.revision+1
          WHERE sessions.source_json IS NOT NULL AND sessions.course_id=excluded.course_id`)
          .bind(id, input.title, course.id, course.code, course.name, course.term, course.folderName,
            input.endedAt ? "ready" : "recording", input.startedAt, input.endedAt ?? "", duration, now, now, source, course.id),
        db.prepare(`INSERT INTO transcript_segments(session_id,id,position,commit_sequence,started_at_ms,ended_at_ms,
            source_text,translated_text,is_final,created_at,updated_at)
          SELECT ?, 'school_'||json_extract(value,'$.order'), json_extract(value,'$.order'),json_extract(value,'$.order'),
            json_extract(value,'$.startedAtMs'),json_extract(value,'$.endedAtMs'),json_extract(value,'$.sourceText'),
            json_extract(value,'$.translatedText'),json_extract(value,'$.isFinal'),?,? FROM json_each(?)
          WHERE EXISTS(SELECT 1 FROM sessions WHERE id=? AND course_id=? AND source_json IS NOT NULL)
            AND EXISTS(SELECT 1 FROM school_caption_courses WHERE course_id=? AND enabled=1)
          ON CONFLICT(session_id,id) DO UPDATE SET started_at_ms=excluded.started_at_ms,ended_at_ms=excluded.ended_at_ms,
            source_text=excluded.source_text,
            translated_text=CASE WHEN excluded.translated_text='' THEN transcript_segments.translated_text ELSE excluded.translated_text END,
            is_final=excluded.is_final,updated_at=excluded.updated_at
          WHERE transcript_segments.source_text<>excluded.source_text OR
            (excluded.translated_text<>'' AND transcript_segments.translated_text<>excluded.translated_text) OR
            transcript_segments.started_at_ms<>excluded.started_at_ms OR transcript_segments.ended_at_ms IS NOT excluded.ended_at_ms OR transcript_segments.is_final<>excluded.is_final`)
          .bind(id, now, now, JSON.stringify(input.segments), id, course.id, course.id),
      ]);
    },
  };
}
