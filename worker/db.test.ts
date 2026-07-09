import { describe, expect, it, vi } from "vitest";
import type { ClassSession } from "../src/types";
import { createD1SessionRepository } from "./db";

interface FakeStatement {
  query: string;
  values: unknown[];
  bind: (...values: unknown[]) => FakeStatement;
  all: <T>() => Promise<{ results: T[] }>;
  first: <T>() => Promise<T | null>;
  run: () => Promise<{ meta: { changes: number } }>;
}

function createStatement(query: string, session: ClassSession): FakeStatement {
  const statement: FakeStatement = {
    query,
    values: [],
    bind(...values) {
      statement.values = values;
      return statement;
    },
    async all<T>() {
      if (query.includes("FROM transcript_segments")) {
        return {
          results: session.segments.map((segment) => ({
            id: segment.id,
            started_at_ms: segment.startedAtMs,
            ended_at_ms: segment.endedAtMs ?? null,
            source_text: segment.sourceText,
            translated_text: segment.translatedText,
            is_final: segment.isFinal ? 1 : 0,
            created_at: segment.createdAt,
            updated_at: segment.updatedAt
          })) as T[]
        };
      }
      return { results: [] };
    },
    async first<T>() {
      if (!query.includes("FROM sessions")) {
        return null;
      }
      return {
        id: session.id,
        title: session.title,
        course_id: session.courseId,
        course_code: session.courseCode,
        course_name: session.courseName,
        course_term: session.courseTerm,
        course_folder_name: session.courseFolderName,
        started_at: session.startedAt,
        ended_at: session.endedAt,
        duration_ms: session.durationMs,
        source_language: session.sourceLanguage,
        target_language: session.targetLanguage,
        translation_model: session.models.translation,
        transcription_model: session.models.transcription,
        created_by_email: "student@example.com",
        saved_at: "2026-07-09T19:00:00.000Z"
      } as T;
    },
    async run() {
      return { meta: { changes: 1 } };
    }
  };
  return statement;
}

describe("D1 session repository", () => {
  it("stores the session and its ordered transcript segments in one batch", async () => {
    const session = createSession();
    const prepared: FakeStatement[] = [];
    const batch = vi.fn(async (_statements: D1PreparedStatement[]) => []);
    const db = {
      prepare(query: string) {
        const statement = createStatement(query, session);
        prepared.push(statement);
        return statement;
      },
      batch
    } as unknown as D1Database;

    const repository = createD1SessionRepository(db);
    const saved = await repository.saveSession(session, "student@example.com");

    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0][0]).toHaveLength(3);
    expect(prepared.some((statement) => statement.query.includes("ON CONFLICT(id) DO UPDATE"))).toBe(true);
    const segmentInsert = prepared.find((statement) => statement.query.includes("FROM json_each(?)"));
    expect(segmentInsert).toBeTruthy();
    expect(JSON.parse(String(segmentInsert?.values[1]))).toHaveLength(session.segments.length);
    expect(saved.segments.map((segment) => segment.id)).toEqual(["segment_1", "segment_2"]);
    expect(saved.createdByEmail).toBe("student@example.com");
  });
});

function createSession(): ClassSession {
  return {
    id: "class_sites_test",
    title: "Sites 测试课堂",
    courseId: "daily",
    courseCode: "DAILY",
    courseName: "日常 / 不选课程",
    courseTerm: "",
    courseFolderName: "daily",
    startedAt: "2026-07-09T18:00:00.000Z",
    endedAt: "2026-07-09T18:30:00.000Z",
    durationMs: 1_800_000,
    sourceLanguage: "ko",
    targetLanguage: "zh",
    models: {
      translation: "text-test",
      transcription: "realtime-test"
    },
    segments: [
      {
        id: "segment_1",
        startedAtMs: 0,
        endedAtMs: 900,
        sourceText: "안녕하세요.",
        translatedText: "你好。",
        isFinal: true,
        createdAt: "2026-07-09T18:00:00.000Z",
        updatedAt: "2026-07-09T18:00:01.000Z"
      },
      {
        id: "segment_2",
        startedAtMs: 1000,
        endedAtMs: 1800,
        sourceText: "수업을 시작합니다.",
        translatedText: "开始上课。",
        isFinal: true,
        createdAt: "2026-07-09T18:00:01.000Z",
        updatedAt: "2026-07-09T18:00:02.000Z"
      }
    ]
  };
}
