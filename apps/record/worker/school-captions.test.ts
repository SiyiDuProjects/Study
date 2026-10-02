import { describe, expect, it, vi } from "vitest";
import { createTestD1 } from "./test-d1";
import { createD1CourseRepository, createD1SessionRepository } from "./db";
import { schoolCaptionRepository } from "./school-captions";
import { handleRequest, type SitesEnv } from "./index";
import type { CourseOption } from "../shared/courses";
import type { SchoolImport } from "../../core/src/lecture/school-types";
import { DAILY_COURSE } from "../shared/courses";

const course: CourseOption = { id: "7", code: "ESG", name: "Test course", term: "2026-2", folderName: "ESG", label: "ESG",
  source: "canvas", workflowState: "active", startAt: null, endAt: null, isArchived: false, lastSeenAt: "2026-09-08T00:00:00.000Z", archivedAt: null };
const input: SchoolImport = { courseId: "7", viewerId: "123", moduleItemId: "99", title: "Week 2",
  startedAt: "2026-09-08T01:00:00.000Z", endedAt: null, recordingStatus: "recording",
  segments: [{ order: 1, startedAtMs: 1000, endedAtMs: 2000, sourceText: "원문", translatedText: "", isFinal: false }] };
async function setup() {
  const db = createTestD1();
  await createD1CourseRepository(db).upsertCourses([course], "2026-09-08T00:00:00.000Z");
  return { db, school: schoolCaptionRepository(db), sessions: createD1SessionRepository(db) };
}

describe("School caption persistence", () => {
  it("bootstraps course discovery without any browser visit, preserving a later explicit opt-out", async () => {
    const db = createTestD1();
    const now = new Date().toISOString();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      courses: [{ id: "7", code: "ESG", name: "Test course", term: "2026-2", folderName: "ESG", label: "ESG", status: "active",
        source: "canvas", startAt: null, endAt: null, lastSeenAt: now, archivedAt: null }], syncedAt: now, stale: false,
    })));
    try {
      const env = { DB: db, LECTURE_SERVICE_TOKEN: "synthetic-core-token", STUDY_API_URL: "https://study.example", STUDY_SERVICE_TOKEN: "other-token" } as SitesEnv;
      const response = await handleRequest(new Request("https://record.example/internal/school-captions/courses", {
        headers: { Authorization: "Bearer synthetic-core-token" },
      }), env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ courses: [{ courseId: "7", enabled: true, lastCheckedAt: null }] });
      const school = schoolCaptionRepository(db);
      await school.configure("7", false); await school.ensureDefaults([course]);
      expect((await school.list())[0]?.enabled).toBe(false);
    } finally { fetch.mockRestore(); }
  });
  it("requires opt-in, preserves sentence identity and corrections, and keeps source provenance", async () => {
    const { school, sessions } = await setup();
    await school.ingest(course, input);
    expect(await sessions.getSession("school_123")).toBeNull();
    await school.configure("7", true);
    await school.ingest(course, input);
    await school.ingest(course, { ...input, segments: [{ ...input.segments[0]!, sourceText: "수정", translatedText: "修正译文", isFinal: true }] });
    const saved = await sessions.getSession("school_123");
    expect(saved).toMatchObject({ startedAt: input.startedAt, courseId: "7", status: "recording",
      source: { kind: "hanyang-translive", viewerId: "123", moduleItemId: "99" },
      segments: [{ id: "school_1", sourceText: "수정", translatedText: "修正译文", isFinal: true }] });
    expect(saved?.segments).toHaveLength(1);
    // Reconnect can momentarily receive Korean before Chinese: keep the saved translation.
    await school.ingest(course, { ...input, segments: [{ ...input.segments[0]!, sourceText: "수정", isFinal: true }] });
    expect((await sessions.getSession("school_123"))?.segments[0]?.translatedText).toBe("修正译文");
    await school.configure("7", false);
    await school.ingest(course, { ...input, title: "should not apply" });
    expect((await sessions.getSession("school_123"))?.title).toBe("Week 2");
  });

  it("isolates school sessions from microphone writer leases and keeps archived records archived", async () => {
    const { school, sessions } = await setup();
    await school.configure("7", true); await school.ingest(course, input);
    const microphone = await sessions.createSession({ id: "mic", course: DAILY_COURSE, startedAt: input.startedAt,
      models: { transcription: "gpt-realtime-whisper", translation: "gpt-5.4-mini" }, writerLeaseToken: "test-token-long-enough", now: input.startedAt });
    expect(microphone.status).toBe("recording");
    expect(await sessions.resumeSession("school_123", "new-token", 0)).toBeNull();
    await school.ingest(course, { ...input, endedAt: "2026-09-08T02:00:00.000Z", recordingStatus: "end" });
    expect(await sessions.archiveSession("school_123")).toBe(true);
    await school.ingest(course, input);
    expect((await sessions.getSession("school_123"))?.status).toBe("archived");
  });

  it("guards import with the Core token and serves old and new MCP readers during rollback", async () => {
    const { db, school } = await setup();
    const env = { DB: db, LECTURE_SERVICE_TOKEN: "synthetic-core-token", STUDY_OWNER_EMAIL: "owner@example.test" } as SitesEnv;
    const endpoint = "https://record.example/internal/school-captions/import";
    const request = (authorization?: string) => new Request(endpoint, { method: "POST", body: JSON.stringify(input),
      headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) } });
    expect((await handleRequest(request(), env)).status).toBe(401);
    expect((await handleRequest(request("Bearer synthetic-core-token"), env)).status).toBe(409);
    await school.configure("7", true);
    expect((await handleRequest(request("Bearer synthetic-core-token"), env)).status).toBe(200);
    for (const source of [false, true]) {
      const response = await handleRequest(new Request("https://record.example/internal/mcp/lecture/sessions?status=all", {
        headers: { Authorization: "Bearer synthetic-core-token", "X-Study-Lecture-Contract": "paged-v1",
          ...(source ? { "X-Study-Lecture-Source": "school-v1" } : {}) },
      }), env);
      const body = await response.json() as { items: Array<{ source?: unknown }> };
      expect(response.status).toBe(200); expect(Boolean(body.items[0]?.source)).toBe(source);
    }
  });
});
