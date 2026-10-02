// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getLectureSessionResponseSchema, listLectureSessionsResponseSchema, searchLectureTranscriptsResponseSchema } from "../../core/src/lecture/types";
import { DAILY_COURSE } from "../shared/courses";
import { createD1SessionRepository } from "./db";
import { handleRequest, type SitesEnv } from "./index";
import { createTestD1 } from "./test-d1";

const token = "synthetic-lecture-read-token-000000000000";
const writer = "synthetic-writer-token-00000000000000000";
const startedAt = "2026-09-01T00:00:00.000Z";
function segment(id: string, sequence = 0, text = "과제 homework") {
  return { id, commitSequence: sequence, startedAtMs: sequence * 1000, sourceText: text, translatedText: text,
    isFinal: true, createdAt: startedAt, updatedAt: startedAt };
}

async function seed(db: D1Database, id: string, segments = [segment("s1")], at = startedAt) {
  const repo = createD1SessionRepository(db);
  await repo.createSession({ id, course: DAILY_COURSE, startedAt: at,
    models: { translation: "gpt-realtime-translate", transcription: "gpt-realtime-whisper" },
    writerLeaseToken: writer, now: at });
  await repo.completeSession(id, { durationMs: 10000, endedAt: at, segments, writerLeaseToken: writer, expectedRevision: 0 });
}

function read(db: D1Database, path: string, contract: string | null = "paged-v1") {
  return handleRequest(new Request(`https://record.example/internal/mcp/lecture/${path}`, {
    headers: { Authorization: `Bearer ${token}`, ...(contract ? { "X-Study-Lecture-Contract": contract } : {}) },
  }), { DB: db, LECTURE_SERVICE_TOKEN: token } as SitesEnv);
}

describe("shared lecture read contract through the Worker routes", () => {
  it("serves old Core and paged Core concurrently through an explicit contract header", async () => {
    const db = createTestD1();
    await seed(db, "transition", Array.from({ length: 55 }, (_, i) => segment(`s${i}`, i)));
    const legacyList = await (await read(db, "sessions?course_id=daily", null)).json() as { sessions: unknown[] };
    expect(Object.keys(legacyList)).toEqual(["sessions"]);
    expect(legacyList.sessions).toHaveLength(1);
    const legacyDetail = await (await read(db, "sessions/transition", null)).json() as { session: { segments: unknown[] } };
    expect(Object.keys(legacyDetail)).toEqual(["session"]);
    expect(legacyDetail.session.segments).toHaveLength(55);
    const legacySearch = await (await read(db, "search?q=homework&limit=2", null)).json() as { query: string; hits: unknown[] };
    expect(Object.keys(legacySearch).sort()).toEqual(["hits", "query"]);
    expect(legacySearch.query).toBe("homework");
    expect(legacySearch.hits).toHaveLength(2);
    const page = getLectureSessionResponseSchema.parse(await (await read(db, "sessions/transition?limit=2")).json());
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    expect((await read(db, "sessions", "future-version")).status).toBe(426);
    const unauthorized = await handleRequest(new Request("https://record.example/internal/mcp/lecture/sessions", {
      headers: { "X-Study-Lecture-Contract": "paged-v1" },
    }), { DB: db, LECTURE_SERVICE_TOKEN: token } as SitesEnv);
    expect(unauthorized.status).toBe(401);
  });
  it("normalizes fractional recording timing before list, transcript and search reads", async () => {
    const db = createTestD1();
    const env = { DB: db, STUDY_OWNER_EMAIL: "owner@example.com" } as SitesEnv;
    const write = (path: string, body: unknown) => handleRequest(new Request(`https://record.example/api/${path}`, {
      method: "POST",
      headers: { "oai-authenticated-user-id": "owner", "oai-authenticated-user-email": "owner@example.com",
        Origin: "https://record.example", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), env);
    const create = await write("sessions", { courseId: "daily", startedAt,
      models: { translation: "gpt-realtime-translate", transcription: "gpt-realtime-whisper" } });
    expect(create.status).toBe(201);
    const created = await create.json() as { session: { id: string }; writerLease: { token: string } };
    const saved = await write(`sessions/${created.session.id}/complete`, {
      writerLeaseToken: created.writerLease.token, expectedRevision: 0, endedAt: startedAt, durationMs: 456.567,
      segments: [{ ...segment("fractional"), startedAtMs: 123.456, endedAtMs: 345.789 }],
    });
    expect(saved.status).toBe(200);
    const listed = listLectureSessionsResponseSchema.parse(await (await read(db, "sessions?course_id=daily")).json());
    expect(listed.items).toMatchObject([{ id: created.session.id, durationMs: 457, segmentCount: 1 }]);
    expect(listed.warnings).toEqual([]);
    const transcript = getLectureSessionResponseSchema.parse(await (await read(db, `sessions/${created.session.id}`)).json());
    expect(transcript.items).toMatchObject([{ id: "fractional", startedAtMs: 123, endedAtMs: 346 }]);
    expect(transcript.warnings).toEqual([]);
    expect(transcript.rangeComplete).toBe(true);
    const found = searchLectureTranscriptsResponseSchema.parse(await (await read(db, `search?q=homework&session_id=${created.session.id}`)).json());
    expect(found.items).toMatchObject([{ segmentId: "fractional", startedAtMs: 123, endedAtMs: 346 }]);
    expect(found.warnings).toEqual([]);
  });

  it("reads historical models, daily records and isolates one invalid saved row", async () => {
    const db = createTestD1();
    await seed(db, "legacy");
    await seed(db, "corrupt");
    await db.prepare("UPDATE sessions SET transcription_model = 'gpt-4o-mini-transcribe', translation_model = 'retired-model', translation_mode = 'retired-mode' WHERE id = 'legacy'").run();
    await db.prepare("UPDATE sessions SET duration_ms = 'broken' WHERE id = 'corrupt'").run();
    const response = await read(db, "sessions?course_id=daily&status=all");
    expect(response.status).toBe(200);
    const page = listLectureSessionsResponseSchema.parse(await response.json());
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.models).toEqual({ transcription: "gpt-4o-mini-transcribe", translation: "retired-model", mode: "retired-mode" });
    expect(page.warnings).toMatchObject([{ code: "invalid_record", recordId: "corrupt" }]);
    expect(page.nextCursor).toBeNull();
    await db.prepare("UPDATE sessions SET course_id = '202610HY20215', course_match_status = 'legacy_unmatched' WHERE id = 'legacy'").run();
    const legacyCourse = listLectureSessionsResponseSchema.parse(await (await read(db, "sessions?course_id=202610HY20215")).json());
    expect(legacyCourse.items.map(item => item.id)).toEqual(["legacy"]);
  });

  it("continues beyond 100 sessions with stable ties and applies date windows", async () => {
    const db = createTestD1();
    for (let index = 0; index < 103; index++) await seed(db, `session_${String(index).padStart(3, "0")}`);
    const first = listLectureSessionsResponseSchema.parse(await (await read(db, "sessions?limit=100&course_id=daily")).json());
    expect(first.items).toHaveLength(100);
    const next = listLectureSessionsResponseSchema.parse(await (await read(db, `sessions?limit=100&course_id=daily&cursor=${encodeURIComponent(first.nextCursor!)}`)).json());
    expect(next.items).toHaveLength(3);
    expect(new Set([...first.items, ...next.items].map(item => item.id)).size).toBe(103);
    expect(next.nextCursor).toBeNull();
    const wrongScope = await read(db, `sessions?status=ready&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(wrongScope.status).toBe(400);
    const before = listLectureSessionsResponseSchema.parse(await (await read(db, "sessions?end_at=2026-09-01T00:00:00Z")).json());
    expect(before.items).toEqual([]);
    expect((await read(db, "sessions?start_at=2026-09-02T00:00:00Z&end_at=2026-09-01T00:00:00Z")).status).toBe(400);
  });

  it("paginates Korean substring searches by session, date and stable segment order", async () => {
    const db = createTestD1();
    await seed(db, "target", [segment("s2", 2), segment("s0", 0), segment("s1", 1)]);
    await seed(db, "other", [segment("other")]);
    const query = `search?q=${encodeURIComponent("과제")}&session_id=target&course_id=daily&limit=2&start_at=2026-08-31T15:00:00-09:00&end_at=2026-09-02T00:00:00Z`;
    const first = searchLectureTranscriptsResponseSchema.parse(await (await read(db, query)).json());
    expect(first.items.map(item => item.segmentId)).toEqual(["s0", "s1"]);
    const second = searchLectureTranscriptsResponseSchema.parse(await (await read(db, `${query}&cursor=${encodeURIComponent(first.nextCursor!)}`)).json());
    expect(second.items.map(item => item.segmentId)).toEqual(["s2"]);
    expect(second.nextCursor).toBeNull();
    expect(searchLectureTranscriptsResponseSchema.parse(await (await read(db, "search?q=%25")).json()).items).toEqual([]);
  });

  it("reads a transcript larger than 2 MiB through bounded resumable pages", async () => {
    const db = createTestD1();
    const text = "한".repeat(40000);
    await seed(db, "large", Array.from({ length: 15 }, (_, index) => segment(`s${index}`, index, text)));
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await read(db, `sessions/large?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      const bytes = await response.text();
      expect(Buffer.byteLength(bytes)).toBeLessThan(900_000);
      const page = getLectureSessionResponseSchema.parse(JSON.parse(bytes));
      ids.push(...page.items.map(item => item.id));
      cursor = page.nextCursor;
      expect(page.rangeComplete).toBe(cursor === null);
    } while (cursor);
    expect(ids).toHaveLength(15);
    expect(new Set(ids).size).toBe(15);
    const range = getLectureSessionResponseSchema.parse(await (await read(db, "sessions/large?start_ms=2000&end_ms=4000")).json());
    expect(range.items.map(item => item.id)).toEqual(["s2", "s3"]);
    expect(range.rangeComplete).toBe(true);
  });

  it("reports corrupted segments across continuation and rejects stale-revision cursors", async () => {
    const db = createTestD1();
    await seed(db, "partial", [segment("bad", 0), segment("good", 1)]);
    await db.prepare("UPDATE transcript_segments SET updated_at = 'bad-date' WHERE id = 'bad'").run();
    const first = getLectureSessionResponseSchema.parse(await (await read(db, "sessions/partial?limit=1")).json());
    expect(first.items).toEqual([]);
    expect(first.warnings).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const next = getLectureSessionResponseSchema.parse(await (await read(db, `sessions/partial?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)).json());
    expect(next.items.map(item => item.id)).toEqual(["good"]);
    expect(next.rangeComplete).toBe(false);
    await db.prepare("UPDATE sessions SET revision = revision + 1 WHERE id = 'partial'").run();
    expect((await read(db, `sessions/partial?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)).status).toBe(400);
  });
});
