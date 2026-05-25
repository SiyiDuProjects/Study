// @vitest-environment node
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerApp } from "./app.js";
import { openDatabase, type SqliteDatabase } from "./db.js";
import type { ClassSession } from "../src/types.js";

describe("server app", () => {
  let db: SqliteDatabase;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    server = createServer(
      createServerApp({
        db,
        openAiApiKey: "test",
        staticDir: null,
        translateText: async ({ model, text }) => `${model}:${text}:中文`
      })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    db.close();
  });

  it("serves courses and rejects payloads with raw audio fields", async () => {
    const coursesResponse = await fetch(`${baseUrl}/api/courses`);
    const coursesBody = (await coursesResponse.json()) as { courses: unknown[] };
    expect(coursesBody.courses.length).toBeGreaterThan(1);

    const invalidResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...createSampleSession(), rawAudio: "not allowed" })
    });
    expect(invalidResponse.status).toBe(400);
  });

  it("saves sessions through the API and returns shared summaries", async () => {
    const session = createSampleSession();
    const saveResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-access-authenticated-user-email": "teacher@example.com"
      },
      body: JSON.stringify(session)
    });
    expect(saveResponse.status).toBe(201);

    const listResponse = await fetch(`${baseUrl}/api/sessions`);
    const listBody = (await listResponse.json()) as { sessions: Array<{ id: string; segmentCount: number }> };
    expect(listBody.sessions).toHaveLength(1);
    expect(listBody.sessions[0]).toMatchObject({ id: "class_api", segmentCount: 1 });

    const detailResponse = await fetch(`${baseUrl}/api/sessions/class_api`);
    const detailBody = (await detailResponse.json()) as { session: ClassSession };
    expect(detailBody.session.createdByEmail).toBe("teacher@example.com");
    expect(detailBody.session.segments[0].sourceText).toBe("오늘은 문법을 이야기합니다.");

    const deleteResponse = await fetch(`${baseUrl}/api/sessions/class_api`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(204);
  });

  it("translates Korean through the configured text model", async () => {
    const response = await fetch(`${baseUrl}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        text: "오늘은 문법을 이야기합니다."
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      translatedText: "gpt-5.4-mini:오늘은 문법을 이야기합니다.:中文"
    });
  });
});

function createSampleSession(): ClassSession {
  return {
    id: "class_api",
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
      translation: "gpt-realtime-translate",
      transcription: "gpt-realtime-whisper"
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
