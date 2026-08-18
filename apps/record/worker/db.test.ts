import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    expect(checkpointed).toMatchObject({ revision: 1, status: "recording" });
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
    expect(await sessions.searchSessions({ query: "你好" })).toHaveLength(1);
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

class TestStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: Database.Database,
    private readonly query: string
  ) {}

  bind(...values: unknown[]): TestStatement {
    this.values = values;
    return this;
  }

  async all<T>(): Promise<D1Result<T>> {
    const rows = this.database.prepare(this.query).all(...this.values) as T[];
    return { results: rows, success: true, meta: {} } as D1Result<T>;
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.query).get(...this.values) as T | undefined) ?? null;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.runSync<T>();
  }

  runSync<T = unknown>(): D1Result<T> {
    const result = this.database.prepare(this.query).run(...this.values);
    return {
      results: [],
      success: true,
      meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) }
    } as unknown as D1Result<T>;
  }
}

function createTestD1(): D1Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const migration of ["0000_funny_rictor.sql", "0001_study_record.sql"]) {
    const sql = readFileSync(join(process.cwd(), "drizzle", migration), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  return {
    prepare(query: string) {
      return new TestStatement(sqlite, query) as unknown as D1PreparedStatement;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      return sqlite.transaction(() =>
        statements.map((statement) => (statement as unknown as TestStatement).runSync<T>())
      )();
    }
  } as unknown as D1Database;
}
