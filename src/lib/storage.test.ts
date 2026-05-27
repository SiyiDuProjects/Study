import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSettings,
  listPendingSessions,
  queuePendingSession,
  removePendingSession,
  updatePendingSessionFailure
} from "./storage";
import type { ClassSession } from "../types";

describe("pending session storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("indexedDB", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queues, updates, lists, and removes pending sessions without raw audio", async () => {
    await queuePendingSession(createSession(), "database unavailable");
    let records = await listPendingSessions();
    expect(records).toHaveLength(1);
    expect(records[0].session.id).toBe("class_pending");
    expect(JSON.stringify(records[0])).not.toContain("rawAudio");

    await updatePendingSessionFailure("class_pending", "still offline");
    records = await listPendingSessions();
    expect(records[0]).toMatchObject({ retryCount: 1, lastError: "still offline" });

    await removePendingSession("class_pending");
    await expect(listPendingSessions()).resolves.toEqual([]);
  });

  it("defaults new and legacy settings to realtime transcription plus translation mode", async () => {
    await expect(loadSettings()).resolves.toMatchObject({
      translationMode: "transcribe-then-translate",
      showKoreanInline: true,
      audioBoostEnabled: false
    });

    window.localStorage.setItem(
      "korean-class-subtitler-settings",
      JSON.stringify({ translationMode: "realtime-translate", textTranslationModel: "txt-test", version: 2 })
    );

    await expect(loadSettings()).resolves.toMatchObject({
      translationMode: "transcribe-then-translate",
      audioBoostEnabled: false
    });
  });

  it("loads persisted far-field audio boost settings", async () => {
    window.localStorage.setItem(
      "korean-class-subtitler-settings",
      JSON.stringify({
        translationMode: "classic-websocket-translate",
        textTranslationModel: "txt-test",
        audioBoostEnabled: true,
        version: 6
      })
    );

    await expect(loadSettings()).resolves.toMatchObject({ audioBoostEnabled: true });
  });
});

function createSession(): ClassSession {
  return {
    id: "class_pending",
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
      translation: "txt-test",
      transcription: "tr-test"
    },
    segments: []
  };
}
