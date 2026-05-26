import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COURSES } from "../shared/courses";
import App from "./App";
import type { ClassSession, ClassSessionSummary, RealtimeClientCallbacks } from "./types";

const mocks = vi.hoisted(() => ({
  createRealtimeClientSecret: vi.fn(),
  deleteRemoteSession: vi.fn(),
  fetchAppConfig: vi.fn(),
  fetchCourses: vi.fn(),
  getRemoteSession: vi.fn(),
  listRemoteSessions: vi.fn(),
  saveRemoteSession: vi.fn(),
  realtimeStart: vi.fn(),
  realtimeStop: vi.fn()
}));

vi.mock("./lib/api", () => ({
  createRealtimeClientSecret: mocks.createRealtimeClientSecret,
  deleteRemoteSession: mocks.deleteRemoteSession,
  fetchAppConfig: mocks.fetchAppConfig,
  fetchCourses: mocks.fetchCourses,
  getRemoteSession: mocks.getRemoteSession,
  listRemoteSessions: mocks.listRemoteSessions,
  saveRemoteSession: mocks.saveRemoteSession
}));

vi.mock("./lib/classicRealtimeTranslation", () => ({
  ClassicRealtimeTranslationClient: class {
    constructor(
      _getClientSecret: () => Promise<string>,
      _realtimeTranslationModel: string,
      _realtimeTranscriptionModel: string,
      private readonly callbacks: RealtimeClientCallbacks
    ) {}

    start() {
      return mocks.realtimeStart(this.callbacks);
    }

    pause() {}

    resume() {}

    stop() {
      return mocks.realtimeStop();
    }
  }
}));

vi.mock("./lib/realtimeTranslation", () => ({
  RealtimeTranslationClient: class {
    constructor(
      _getClientSecret: () => Promise<string>,
      private readonly callbacks: RealtimeClientCallbacks
    ) {}

    start() {
      return mocks.realtimeStart(this.callbacks);
    }

    pause() {}

    resume() {}

    stop() {
      return mocks.realtimeStop();
    }
  }
}));

vi.mock("./lib/realtimeTranscriptionTranslation", () => ({
  RealtimeTranscriptionTranslationClient: class {
    constructor(
      _getClientSecret: () => Promise<string>,
      _textModel: string,
      private readonly callbacks: RealtimeClientCallbacks
    ) {}

    start() {
      return mocks.realtimeStart(this.callbacks);
    }

    pause() {}

    resume() {}

    stop() {
      return mocks.realtimeStop();
    }
  }
}));

describe("App classroom workflow", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.fetchAppConfig.mockResolvedValue({
      realtimeTranslationModel: "rt-test",
      realtimeTranscriptionModel: "tr-test",
      defaultTextTranslationModel: "txt-test",
      textTranslationModels: ["txt-test"]
    });
    mocks.fetchCourses.mockResolvedValue(COURSES);
    mocks.listRemoteSessions.mockResolvedValue([]);
    mocks.createRealtimeClientSecret.mockResolvedValue({ clientSecret: "ek_test", expiresAt: 123 });
    mocks.saveRemoteSession.mockImplementation(async (session: ClassSession) => ({
      ...session,
      savedAt: "2026-05-26T12:00:00.000Z"
    }));
    mocks.getRemoteSession.mockImplementation(async (id: string) => createSession({ id }));
    mocks.deleteRemoteSession.mockResolvedValue(undefined);
    mocks.realtimeStart.mockImplementation(async (callbacks: RealtimeClientCallbacks) => {
      callbacks.onOpen();
    });
    mocks.realtimeStop.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("selects a course and surfaces a start failure", async () => {
    mocks.realtimeStart.mockRejectedValueOnce(new Error("麦克风被拒绝"));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /日常/ }));
    fireEvent.click(screen.getByRole("button", { name: /开始/ }));

    expect(await screen.findByText(/麦克风被拒绝/)).toBeTruthy();
  });

  it("defaults to classic low-latency mode", async () => {
    render(<App />);

    fireEvent.click(await screen.findByTitle("设置"));

    expect(screen.getByDisplayValue("经典低延迟")).toBeTruthy();
  });

  it("flushes, saves, and opens the generated class record on end", async () => {
    mocks.realtimeStart.mockImplementationOnce(async (callbacks: RealtimeClientCallbacks) => {
      callbacks.onOpen();
      callbacks.onDelta({
        channel: "source",
        delta: "오늘은 문법을 이야기합니다.",
        elapsedMs: 0
      });
      callbacks.onDelta({
        channel: "translation",
        delta: "今天讨论语法。",
        elapsedMs: 0
      });
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /日常/ }));
    fireEvent.click(screen.getByRole("button", { name: /开始/ }));
    await screen.findByText("录音中");
    fireEvent.click(screen.getByTitle("结束"));

    await waitFor(() => expect(mocks.saveRemoteSession).toHaveBeenCalledTimes(1));
    const savedSession = mocks.saveRemoteSession.mock.calls[0][0] as ClassSession;
    expect(savedSession.models).toMatchObject({
      translation: "rt-test",
      transcription: "tr-test",
      mode: "classic-websocket-translate"
    });
    expect(savedSession.segments[0]).toMatchObject({
      sourceText: "오늘은 문법을 이야기합니다.",
      translatedText: "今天讨论语法。",
      isFinal: true
    });
    expect(await screen.findByText("Markdown")).toBeTruthy();
  });

  it("queues the record locally when server save fails", async () => {
    mocks.saveRemoteSession.mockRejectedValueOnce(new Error("database unavailable"));
    mocks.realtimeStart.mockImplementationOnce(async (callbacks: RealtimeClientCallbacks) => {
      callbacks.onOpen();
      callbacks.onSegment?.({
        sourceText: "안녕하세요.",
        translatedText: "你好。",
        elapsedMs: 0
      });
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /日常/ }));
    fireEvent.click(screen.getByRole("button", { name: /开始/ }));
    await screen.findByText("录音中");
    fireEvent.click(screen.getByTitle("结束"));

    expect(await screen.findByText(/待同步队列/)).toBeTruthy();
    expect(await screen.findByText(/1 条记录待同步/)).toBeTruthy();
  });

  it("confirms before deleting a saved record", async () => {
    const summary = createSummary();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.listRemoteSessions.mockResolvedValue([summary]);
    render(<App />);

    fireEvent.click(await screen.findByTitle("记录"));
    await screen.findByText(summary.title);
    fireEvent.click(screen.getByTitle("删除"));

    expect(confirmSpy).toHaveBeenCalledWith(`删除记录「${summary.title}」？`);
    await waitFor(() => expect(mocks.deleteRemoteSession).toHaveBeenCalledWith(summary.id));
  });
});

function createSummary(): ClassSessionSummary {
  const session = createSession();
  return {
    ...session,
    segmentCount: session.segments.length
  };
}

function createSession(overrides: Partial<ClassSession> = {}): ClassSession {
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
      translation: "txt-test",
      transcription: "tr-test",
      mode: "classic-websocket-translate"
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
    ],
    ...overrides
  };
}
