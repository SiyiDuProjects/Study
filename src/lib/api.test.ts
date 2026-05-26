import { afterEach, describe, expect, it, vi } from "vitest";
import { createRealtimeClientSecret, fetchAppConfig, listRemoteSessions, saveRemoteSession, translateKoreanText } from "./api";
import type { ClassSession } from "../types";

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads realtime client secrets from the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ clientSecret: "ek_test", expiresAt: 123 }))
    );

    await expect(createRealtimeClientSecret("classic-websocket-translate")).resolves.toEqual({
      clientSecret: "ek_test",
      expiresAt: 123
    });
  });

  it("loads app model config from the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          config: {
            realtimeTranslationModel: "rt-test",
            realtimeTranscriptionModel: "tr-test",
            defaultTextTranslationModel: "txt-test",
            textTranslationModels: ["txt-test"]
          }
        })
      )
    );

    await expect(fetchAppConfig()).resolves.toMatchObject({
      defaultTextTranslationModel: "txt-test",
      textTranslationModels: ["txt-test"]
    });
  });

  it("omits the text model when the server default should be used", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ translatedText: "今天讨论语法。" }));
    vi.stubGlobal("fetch", fetchMock);

    await translateKoreanText({ text: "오늘은 문법을 이야기합니다." });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/translate",
      expect.objectContaining({
        body: expect.not.stringContaining('"model"')
      })
    );
  });

  it("returns remote session summaries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ sessions: [{ id: "class_1", segmentCount: 2 }] }))
    );

    const sessions = await listRemoteSessions();
    expect(sessions).toEqual([{ id: "class_1", segmentCount: 2 }]);
  });

  it("throws server errors while saving", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "Invalid session payload." }, 400))
    );

    await expect(saveRemoteSession(createSampleSession())).rejects.toThrow("Invalid session payload.");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function createSampleSession(): ClassSession {
  return {
    id: "class_test",
    title: "日常 2026/05/24 18:00",
    courseId: "daily",
    courseCode: "daily",
    courseName: "日常 / 不选课程",
    courseTerm: "",
    courseFolderName: "daily",
    startedAt: "2026-05-24T18:00:00.000Z",
    endedAt: "2026-05-24T18:10:00.000Z",
    durationMs: 10 * 60 * 1000,
    sourceLanguage: "ko",
    targetLanguage: "zh",
    models: {
      translation: "rt-test",
      transcription: "tr-test"
    },
    segments: []
  };
}
