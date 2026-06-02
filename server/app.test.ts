// @vitest-environment node
import { EventEmitter } from "node:events";
import { createRequest, createResponse } from "node-mocks-http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerApp } from "./app.js";
import { openDatabase, type SqliteDatabase } from "./db.js";
import type { OpenAIModelConfig } from "./modelConfig.js";
import type { ClassSession } from "../src/types.js";

describe("server app", () => {
  let db: SqliteDatabase;
  let app: ReturnType<typeof createServerApp>;

  const modelConfig: OpenAIModelConfig = {
    realtimeTranslationModel: "rt-test",
    realtimeTranscriptionModel: "tr-test",
    defaultTextTranslationModel: "txt-test",
    textTranslationModels: ["txt-test", "txt-fast"]
  };

  beforeEach(async () => {
    db = openDatabase(":memory:");
    app = createServerApp({
      db,
      openAiApiKey: "test",
      staticDir: null,
      modelConfig,
      translateText: async ({ model, text }) => `${model}:${text}:中文`
    });
  });

  afterEach(async () => {
    db.close();
  });

  it("serves courses and rejects payloads with raw audio fields", async () => {
    const coursesResponse = await injectApp("GET", "/api/courses");
    expect(coursesResponse.status).toBe(200);
    expect(coursesResponse.body.courses.length).toBeGreaterThan(1);

    const invalidResponse = await injectApp("POST", "/api/sessions", {
      body: { ...createSampleSession(), rawAudio: "not allowed" }
    });
    expect(invalidResponse.status).toBe(400);
  });

  it("serves model config from the server", async () => {
    const response = await injectApp("GET", "/api/config");
    expect(response.status).toBe(200);
    expect(response.body.config).toMatchObject({
      realtimeTranslationModel: "rt-test",
      realtimeTranscriptionModel: "tr-test",
      defaultTextTranslationModel: "txt-test",
      textTranslationModels: ["txt-test", "txt-fast"]
    });
  });

  it("defaults realtime client secrets to classic low-latency mode", async () => {
    let requestedMode = "";
    app = createServerApp({
      db,
      openAiApiKey: "test",
      staticDir: null,
      modelConfig,
      createClientSecret: async ({ mode }) => {
        requestedMode = mode;
        return { clientSecret: "ek_test", expiresAt: 123 };
      },
      translateText: async ({ model, text }) => `${model}:${text}:中文`
    });

    const response = await injectApp("POST", "/api/realtime/client-secret", {
      body: {}
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ clientSecret: "ek_test", expiresAt: 123 });
    expect(requestedMode).toBe("classic-websocket-translate");
  });

  it("returns a clear error when realtime client secrets cannot be issued", async () => {
    app = createServerApp({
      db,
      openAiApiKey: "test",
      staticDir: null,
      modelConfig,
      createClientSecret: async () => {
        throw new Error("Realtime not supported");
      },
      translateText: async ({ model, text }) => `${model}:${text}:中文`
    });

    const response = await injectApp("POST", "/api/realtime/client-secret", {
      body: { mode: "transcribe-then-translate" }
    });

    expect(response.status).toBe(502);
    expect(response.body.error).toContain("OpenAI Realtime");
    expect(response.body.error).toContain("文字模型");
  });

  it("saves sessions through the API and returns shared summaries", async () => {
    const session = createSampleSession();
    const saveResponse = await injectApp("POST", "/api/sessions", {
      headers: { "cf-access-authenticated-user-email": "teacher@example.com" },
      body: session
    });
    expect(saveResponse.status).toBe(201);

    const listResponse = await injectApp("GET", "/api/sessions");
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.sessions).toHaveLength(1);
    expect(listResponse.body.sessions[0]).toMatchObject({ id: "class_api", segmentCount: 1 });

    const detailResponse = await injectApp("GET", "/api/sessions/class_api");
    expect(detailResponse.status).toBe(200);
    const detailBody = detailResponse.body as { session: ClassSession };
    expect(detailBody.session.createdByEmail).toBe("teacher@example.com");
    expect(detailBody.session.segments[0].sourceText).toBe("오늘은 문법을 이야기합니다.");

    const deleteResponse = await injectApp("DELETE", "/api/sessions/class_api");
    expect(deleteResponse.status).toBe(204);
  });

  it("translates Korean through the configured text model", async () => {
    const response = await injectApp("POST", "/api/translate", {
      body: {
        model: "txt-fast",
        text: "오늘은 문법을 이야기합니다."
      }
    });
    expect(response.status).toBe(200);

    expect(response.body).toEqual({
      translatedText: "txt-fast:오늘은 문법을 이야기합니다.:中文"
    });
  });

  it("rejects text models that are not enabled on the server", async () => {
    const response = await injectApp("POST", "/api/translate", {
      body: {
        model: "not-enabled",
        text: "오늘은 문법을 이야기합니다."
      }
    });
    expect(response.status).toBe(400);
  });

  async function injectApp(
    method: "DELETE" | "GET" | "POST",
    url: string,
    options: { body?: unknown; headers?: Record<string, string> } = {}
  ) {
    const response = createResponse({ eventEmitter: EventEmitter });
    const request = createRequest({
      method,
      url,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers
      },
      body: options.body
    });

    await new Promise<void>((resolve, reject) => {
      response.on("end", resolve);
      response.on("error", reject);
      app.handle(request, response);
    });

    const rawBody = response._getData();
    return {
      status: response.statusCode,
      body: rawBody ? JSON.parse(rawBody) : undefined
    };
  }
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
