// @vitest-environment node
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CourseOption } from "../shared/courses.js";
import {
  createCourseRepository,
  createSessionRepository,
  defaultDatabasePath,
  migrateDatabase,
  openDatabase,
  RECOVERED_SESSION_WARNING,
  WriterLeaseConflict,
  type SqliteDatabase
} from "./db.js";

describe("Study Lecture database", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("caches courses and saves idempotent recording checkpoints", () => {
    const courseRepository = createCourseRepository(db);
    const sessionRepository = createSessionRepository(db);
    const writerLeaseToken = "writer-a-000000000000000000000000";
    courseRepository.upsertCourses([course()], "2026-08-18T00:00:00.000Z");

    const created = sessionRepository.createSession({
      id: "lecture_test",
      course: course(),
      startedAt: "2026-08-18T01:00:00.000Z",
      models: { translation: "gpt-realtime-translate", transcription: "gpt-realtime-whisper" },
      writerLeaseToken,
      now: "2026-08-18T01:00:00.000Z"
    });
    expect(created.status).toBe("recording");
    expect(created.courseMatchStatus).toBe("matched");
    expect(created.finalizationWarning).toBeNull();
    expect(() => sessionRepository.createSession({
      id: "lecture_second_device",
      course: course(),
      startedAt: "2026-08-18T01:01:00.000Z",
      models: { translation: "gpt-realtime-translate", transcription: "gpt-realtime-whisper" },
      writerLeaseToken: "writer-b-000000000000000000000000",
      now: "2026-08-18T01:01:00.000Z"
    })).toThrow("unfinished lecture session");

    const checkpoint = { durationMs: 3_000, segments: [segment("seg_1", "과제 설명", "作业说明")] };
    const firstCheckpoint = sessionRepository.checkpointSession(created.id, {
      ...checkpoint,
      writerLeaseToken,
      expectedRevision: created.revision
    }, "2026-08-18T01:00:03.000Z");
    const secondCheckpoint = sessionRepository.checkpointSession(created.id, {
      ...checkpoint,
      writerLeaseToken,
      expectedRevision: firstCheckpoint!.revision
    }, "2026-08-18T01:00:04.000Z");
    expect(sessionRepository.getSession(created.id)?.segments).toHaveLength(1);

    const completed = sessionRepository.completeSession(
      created.id,
      {
        endedAt: "2026-08-18T01:10:00.000Z",
        durationMs: 600_000,
        segments: [],
        writerLeaseToken,
        expectedRevision: secondCheckpoint!.revision
      },
      "2026-08-18T01:10:00.000Z"
    );
    expect(completed?.status).toBe("ready");
    expect(sessionRepository.searchSessions({ query: "作业", limit: 5 })).toMatchObject([
      { sessionId: "lecture_test", segmentId: "seg_1", courseId: "canvas_123" }
    ]);
    expect(sessionRepository.archiveSession(created.id)).toBe(true);
    expect(sessionRepository.listSessions()).toHaveLength(0);
    expect(sessionRepository.listSessions({ status: "all" })[0].status).toBe("archived");
  });

  it("keeps the historical production database filename", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(defaultDatabasePath()).toBe("/data/jiahuan.sqlite");
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it("preserves duplicate unfinished rows and warnings during a compatible migration", () => {
    const repository = createSessionRepository(db);
    repository.createSession({
      id: "older", course: course(), startedAt: "2026-08-18T01:00:00.000Z",
      models: { translation: "gpt-realtime-translate", transcription: "gpt-realtime-whisper" },
      writerLeaseToken: "writer-old-00000000000000000000000",
      now: "2026-08-18T01:00:00.000Z"
    });
    db.prepare("UPDATE sessions SET status = 'ready' WHERE id = 'older'").run();
    repository.createSession({
      id: "newer", course: course(), startedAt: "2026-08-18T02:00:00.000Z",
      models: { translation: "gpt-realtime-translate", transcription: "gpt-realtime-whisper" },
      writerLeaseToken: "writer-new-00000000000000000000000",
      now: "2026-08-18T02:00:00.000Z"
    });
    db.prepare("UPDATE sessions SET status = 'failed', finalization_warning = ? WHERE id = 'older'")
      .run("preserve this warning");

    migrateDatabase(db);
    expect(repository.getSession("newer")?.status).toBe("recording");
    expect(repository.getSession("older")).toMatchObject({
      status: "failed",
      finalizationWarning: "preserve this warning"
    });
  });

  it("requires an explicit revision-bound takeover and rejects stale writers", () => {
    const repository = createSessionRepository(db);
    const writerA = "writer-a-lease-000000000000000000";
    const writerB = "writer-b-lease-000000000000000000";
    const created = repository.createSession({
      id: "leased",
      course: course(),
      startedAt: "2026-08-18T01:00:00.000Z",
      models: { translation: "gpt-realtime-translate", transcription: "gpt-realtime-whisper" },
      writerLeaseToken: writerA,
      now: "2026-08-18T01:00:00.000Z"
    });

    const firstWrite = repository.checkpointSession(created.id, {
      durationMs: 1_000,
      segments: [],
      writerLeaseToken: writerA,
      expectedRevision: created.revision
    });
    expect(firstWrite?.revision).toBe(1);
    expect(() => repository.takeoverSession(created.id, writerB, created.revision))
      .toThrow(WriterLeaseConflict);

    const beforeRead = repository.getSession(created.id);
    const afterRead = repository.getSession(created.id);
    expect(afterRead).toMatchObject({
      status: beforeRead!.status,
      revision: beforeRead!.revision,
      finalizationWarning: beforeRead!.finalizationWarning
    });

    const takenOver = repository.takeoverSession(created.id, writerB, firstWrite!.revision);
    expect(takenOver).toMatchObject({
      status: "recording",
      revision: 2,
      finalizationWarning: RECOVERED_SESSION_WARNING
    });
    expect(() => repository.checkpointSession(created.id, {
      durationMs: 2_000,
      segments: [],
      writerLeaseToken: writerA,
      expectedRevision: takenOver!.revision
    })).toThrow(WriterLeaseConflict);
    expect(() => repository.checkpointSession(created.id, {
      durationMs: 2_000,
      segments: [],
      writerLeaseToken: writerB,
      expectedRevision: firstWrite!.revision
    })).toThrow(WriterLeaseConflict);

    const currentWrite = repository.checkpointSession(created.id, {
      durationMs: 2_000,
      segments: [],
      writerLeaseToken: writerB,
      expectedRevision: takenOver!.revision
    });
    expect(currentWrite?.revision).toBe(3);
    expect(() => repository.failSession(created.id, {
      durationMs: 2_000,
      segments: [],
      finalizationWarning: "old writer cannot fail",
      writerLeaseToken: writerA,
      expectedRevision: currentWrite!.revision
    })).toThrow(WriterLeaseConflict);
    expect(() => repository.completeSession(created.id, {
      endedAt: "2026-08-18T01:01:00.000Z",
      durationMs: 60_000,
      segments: [],
      acceptIncomplete: true,
      writerLeaseToken: writerA,
      expectedRevision: currentWrite!.revision
    })).toThrow(WriterLeaseConflict);
    expect(repository.archiveSession(created.id)).toBe(false);

    const failed = repository.failSession(created.id, {
      durationMs: 2_000,
      segments: [],
      finalizationWarning: RECOVERED_SESSION_WARNING,
      writerLeaseToken: writerB,
      expectedRevision: currentWrite!.revision
    });
    expect(failed).toMatchObject({ status: "failed", revision: 4 });
    expect(repository.archiveSession(created.id)).toBe(false);
    const ready = repository.completeSession(created.id, {
      endedAt: "2026-08-18T01:01:00.000Z",
      durationMs: 60_000,
      segments: [],
      acceptIncomplete: true,
      writerLeaseToken: writerB,
      expectedRevision: failed!.revision
    });
    expect(ready).toMatchObject({ status: "ready", revision: 5 });
    expect(repository.archiveSession(created.id)).toBe(true);
  });

  it("requires explicit acceptance before completing a session with an integrity warning", () => {
    const repository = createSessionRepository(db);
    const writerLeaseToken = "writer-incomplete-00000000000000000";
    const created = repository.createSession({
      id: "incomplete", course: course(), startedAt: "2026-08-18T01:00:00.000Z",
      models: { translation: "gpt-realtime-translate", transcription: "gpt-realtime-whisper" },
      writerLeaseToken,
      now: "2026-08-18T01:00:00.000Z"
    });
    const failed = repository.failSession(created.id, {
      durationMs: 10_000,
      segments: [],
      finalizationWarning: "最后一段字幕可能缺失。",
      writerLeaseToken,
      expectedRevision: created.revision
    });
    expect(failed).toMatchObject({ status: "failed", finalizationWarning: "最后一段字幕可能缺失。" });
    expect(() => repository.completeSession(created.id, {
      endedAt: "2026-08-18T01:01:00.000Z",
      durationMs: 60_000,
      segments: [],
      writerLeaseToken,
      expectedRevision: failed!.revision
    })).toThrow("incomplete finalization warning");
    const accepted = repository.completeSession(created.id, {
      endedAt: "2026-08-18T01:01:00.000Z",
      durationMs: 60_000,
      segments: [],
      acceptIncomplete: true,
      writerLeaseToken,
      expectedRevision: failed!.revision
    });
    expect(accepted).toMatchObject({ status: "ready", finalizationWarning: "最后一段字幕可能缺失。" });
  });

  it("returns transcript segments in persisted commit order rather than checkpoint arrival order", () => {
    const repository = createSessionRepository(db);
    const writerLeaseToken = "writer-ordered-0000000000000000000";
    const created = repository.createSession({
      id: "ordered", course: course(), startedAt: "2026-08-18T01:00:00.000Z",
      models: { translation: "gpt-5.4-mini", transcription: "gpt-realtime-whisper" },
      writerLeaseToken,
      now: "2026-08-18T01:00:00.000Z"
    });
    repository.checkpointSession(created.id, {
      durationMs: 4_000,
      segments: [
        { ...segment("second", "둘째", "第二"), commitSequence: 1, startedAtMs: 2_000 },
        { ...segment("first", "첫째", "第一"), commitSequence: 0, startedAtMs: 0 }
      ],
      writerLeaseToken,
      expectedRevision: created.revision
    });
    expect(repository.getSession(created.id)?.segments.map((item) => item.id)).toEqual(["first", "second"]);
  });
});

describe("legacy Jiahuan migration", () => {
  it("preserves old course fields and marks old academic rows unmatched", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, course_id TEXT NOT NULL, course_code TEXT NOT NULL,
        course_name TEXT NOT NULL, course_term TEXT NOT NULL, course_folder_name TEXT NOT NULL,
        started_at TEXT NOT NULL, ended_at TEXT NOT NULL, duration_ms INTEGER NOT NULL,
        source_language TEXT NOT NULL, target_language TEXT NOT NULL, translation_model TEXT NOT NULL,
        transcription_model TEXT NOT NULL, created_by_email TEXT, saved_at TEXT NOT NULL
      );
      CREATE TABLE transcript_segments (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, id TEXT NOT NULL,
        position INTEGER NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER,
        source_text TEXT NOT NULL, translated_text TEXT NOT NULL, is_final INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(session_id, id)
      );
      INSERT INTO sessions VALUES (
        'old_1', '旧课堂', '202610HY20215', '202610HY20215', '旧课程名', '2026년 1학기',
        '202610HY20215_旧课程名', '2026-05-24T18:00:00.000Z', '2026-05-24T18:30:00.000Z',
        1800000, 'ko', 'zh', 'gpt-realtime-translate', 'gpt-realtime-whisper', NULL,
        '2026-05-24T18:30:00.000Z'
      );
      INSERT INTO transcript_segments VALUES (
        'old_1', 'old_seg', 0, 0, 1000, '기존 자막', '旧字幕', 1,
        '2026-05-24T18:00:00.000Z', '2026-05-24T18:00:01.000Z'
      );
    `);
    migrateDatabase(db);
    const migrated = createSessionRepository(db).getSession("old_1");
    expect(migrated).toMatchObject({
      courseId: "202610HY20215",
      courseCode: "202610HY20215",
      courseName: "旧课程名",
      courseMatchStatus: "legacy_unmatched",
      status: "ready"
    });
    expect(migrated?.segments[0]).toMatchObject({ id: "old_seg", commitSequence: 0, translatedText: "旧字幕" });
    db.close();
  });
});

function course(): CourseOption {
  return {
    id: "canvas_123",
    code: "CUL123",
    name: "한국어",
    term: "2026년 2학기",
    folderName: "CUL123_한국어",
    label: "CUL123 한국어",
    source: "canvas",
    workflowState: "active",
    startAt: null,
    endAt: null,
    isArchived: false
  };
}

function segment(id: string, sourceText: string, translatedText: string) {
  return {
    id,
    startedAtMs: 0,
    endedAtMs: 3_000,
    sourceText,
    translatedText,
    isFinal: true,
    createdAt: "2026-08-18T01:00:00.000Z",
    updatedAt: "2026-08-18T01:00:03.000Z"
  };
}
