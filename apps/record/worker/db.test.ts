import { createTestD1 } from "./test-d1";


import { describe, expect, it } from "vitest";
import { DAILY_COURSE } from "../shared/courses";
import {
  createD1CourseRepository,
  createD1SessionRepository,
  UnfinishedLectureConflict,
  WriterLeaseConflict
} from "./db";

describe("D1 Study Record repositories", () => {
  it("caches Hanyang courses without inventing local academic courses", async () => {
    const database = createTestD1();
    const courses = createD1CourseRepository(database);
    const syncedAt = "2026-08-18T12:00:00.000Z";
    await courses.upsertCourses([
      {
        id: "101",
        code: "CSE101",
        name: "테스트 과목",
        term: "2026-2",
        folderName: "CSE101_테스트 과목",
        label: "CSE101 · 테스트 과목",
        source: "canvas",
        workflowState: "active",
        startAt: null,
        endAt: null,
        isArchived: false,
        lastSeenAt: syncedAt,
        archivedAt: null
      }
    ], syncedAt);

    expect(await courses.listCourses()).toMatchObject([{ id: "101", source: "canvas", isArchived: false }]);
    expect(await courses.syncedAt()).toBe(syncedAt);
  });

  it("preserves writer lease and revision semantics through checkpoint and completion", async () => {
    const database = createTestD1();
    const sessions = createD1SessionRepository(database);
    const token = "writer-lease-token-that-is-long-enough-for-tests";
    const startedAt = "2026-08-18T01:00:00.000Z";
    const created = await sessions.createSession({
      id: "lecture_test",
      course: DAILY_COURSE,
      startedAt,
      models: {
        translation: "gpt-realtime-translate",
        transcription: "gpt-realtime-whisper",
        mode: "realtime-translate"
      },
      writerLeaseToken: token,
      now: startedAt
    });
    expect(created).toMatchObject({ status: "recording", revision: 0, segments: [] });

    const segment = {
      id: "segment_1",
      commitSequence: 0,
      startedAtMs: 0,
      endedAtMs: 900,
      sourceText: "안녕하세요",
      translatedText: "你好",
      isFinal: true,
      createdAt: startedAt,
      updatedAt: "2026-08-18T01:00:01.000Z"
    };
    const checkpointed = await sessions.checkpointSession("lecture_test", {
      durationMs: 1_000,
      segments: [segment],
      writerLeaseToken: token,
      expectedRevision: 0
    });
    expect(checkpointed).toMatchObject({ revision: 1, status: "recording", segmentCount: 1 });
    expect(checkpointed?.segments).toEqual([segment]);

    await expect(sessions.checkpointSession("lecture_test", {
      durationMs: 2_000,
      segments: [segment],
      writerLeaseToken: token,
      expectedRevision: 0
    })).rejects.toBeInstanceOf(WriterLeaseConflict);

    const completed = await sessions.completeSession("lecture_test", {
      durationMs: 2_000,
      endedAt: "2026-08-18T01:00:02.000Z",
      segments: [segment],
      writerLeaseToken: token,
      expectedRevision: 1
    });
    expect(completed).toMatchObject({ revision: 2, status: "ready" });
    expect((await sessions.searchSessions({ query: "你好" })).items).toHaveLength(1);
    expect(await sessions.archiveSession("lecture_test")).toBe(true);
  });

  it("atomically rejects a second unfinished lecture", async () => {
    const database = createTestD1();
    const sessions = createD1SessionRepository(database);
    const input = {
      course: DAILY_COURSE,
      startedAt: "2026-08-18T01:00:00.000Z",
      models: {
        translation: "gpt-realtime-translate" as const,
        transcription: "gpt-realtime-whisper" as const,
        mode: "realtime-translate" as const
      },
      writerLeaseToken: "writer-lease-token-that-is-long-enough-for-tests",
      now: "2026-08-18T01:00:00.000Z"
    };
    await sessions.createSession({ ...input, id: "lecture_first" });
    await expect(sessions.createSession({ ...input, id: "lecture_second" })).rejects.toBeInstanceOf(
      UnfinishedLectureConflict
    );
  });
});
