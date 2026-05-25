import { afterEach, describe, expect, it, vi } from "vitest";
import { createRealtimeClientSecret, listRemoteSessions, saveRemoteSession } from "./api";
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

    await expect(createRealtimeClientSecret("realtime-translate")).resolves.toEqual({ clientSecret: "ek_test", expiresAt: 123 });
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
      translation: "gpt-realtime-translate",
      transcription: "gpt-realtime-whisper"
    },
    segments: []
  };
}
