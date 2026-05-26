// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionRepository, openDatabase, type SqliteDatabase } from "./db.js";
import type { ClassSession } from "../src/types.js";

describe("session repository", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("initializes schema and saves, lists, reads, and deletes sessions", () => {
    const repository = createSessionRepository(db);
    const saved = repository.saveSession(createSampleSession(), "teacher@example.com");

    expect(saved.createdByEmail).toBe("teacher@example.com");
    expect(saved.segments).toHaveLength(1);

    const summaries = repository.listSessions();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].segmentCount).toBe(1);
    expect(summaries[0].courseId).toBe("202610HY20215");

    const byCourse = repository.listSessions("202610HY20215");
    expect(byCourse).toHaveLength(1);
    expect(repository.listSessions("daily")).toHaveLength(0);

    const loaded = repository.getSession("class_test");
    expect(loaded?.segments[0].translatedText).toBe("今天讨论语法。");

    expect(repository.deleteSession("class_test")).toBe(true);
    expect(repository.getSession("class_test")).toBeNull();
  });
});

function createSampleSession(): ClassSession {
  return {
    id: "class_test",
    title: "아카데믹한국어듣기말하기 2026/05/24 18:00",
    courseId: "202610HY20215",
    courseCode: "202610HY20215",
    courseName: "아카데믹한국어듣기말하기",
    courseTerm: "2026년 1학기",
    courseFolderName: "202610HY20215_아카데믹한국어듣기말하기",
    startedAt: "2026-05-24T18:00:00.000Z",
    endedAt: "2026-05-24T18:30:00.000Z",
    durationMs: 30 * 60 * 1000,
    sourceLanguage: "ko",
    targetLanguage: "zh",
    models: {
      translation: "rt-test",
      transcription: "tr-test"
    },
    segments: [
      {
        id: "seg_1",
        startedAtMs: 0,
        endedAtMs: 3000,
        translatedText: "今天讨论语法。",
        sourceText: "오늘은 문법을 이야기합니다.",
        isFinal: true,
        createdAt: "2026-05-24T18:00:00.000Z",
        updatedAt: "2026-05-24T18:00:03.000Z"
      }
    ]
  };
}
