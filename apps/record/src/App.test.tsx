import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAILY_COURSE } from "../shared/courses";
import type { ClassSession, RealtimeClientCallbacks } from "./types";

const apiMocks = vi.hoisted(() => ({
  archiveRemoteSession: vi.fn(),
  checkpointRemoteSession: vi.fn(),
  completeRemoteSession: vi.fn(),
  createRealtimeClientSecret: vi.fn(),
  createRemoteSession: vi.fn(),
  failRemoteSession: vi.fn(),
  fetchCourses: vi.fn(),
  fetchTimetable: vi.fn(),
  getRemoteSession: vi.fn(),
  listRemoteSessions: vi.fn(),
  resumeRemoteSession: vi.fn()
}));

const realtimeState = vi.hoisted(() => ({
  callbacks: undefined as RealtimeClientCallbacks | undefined,
  emittedTail: false,
  startCalls: 0
}));

vi.mock("./lib/api", async () => ({
  ...(await vi.importActual<typeof import("./lib/api")>("./lib/api")),
  ...apiMocks
}));

vi.mock("./lib/realtimeTranslation", () => ({
  RealtimeTranslationClient: class {
    constructor(_getClientSecret: unknown, callbacks: RealtimeClientCallbacks) {
      realtimeState.callbacks = callbacks;
    }
    async start() { realtimeState.startCalls += 1; realtimeState.callbacks?.onOpen(); }
    pause() {}
    resume() {}
    async stopAndFlush() {
      if (!realtimeState.emittedTail) {
        realtimeState.emittedTail = true;
        realtimeState.callbacks?.onSegment?.({
          sourceText: "마지막 문장",
          translatedText: "最后一句",
          elapsedMs: 1_500
        });
      }
    }
  }
}));

vi.mock("./lib/realtimeTranscriptionTranslation", () => ({
  RealtimeTranscriptionTranslationClient: class {}
}));

import App from "./App";

describe("App final transcript persistence", () => {
  let revision = 0;

  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    revision = 0;
    realtimeState.callbacks = undefined;
    realtimeState.emittedTail = false;
    realtimeState.startCalls = 0;
    for (const mock of Object.values(apiMocks)) mock.mockReset();
    apiMocks.fetchCourses.mockResolvedValue({
      courses: [DAILY_COURSE], syncedAt: "2026-08-18T00:00:00.000Z", stale: false, source: "study"
    });
    apiMocks.listRemoteSessions.mockResolvedValue([]);
    apiMocks.fetchTimetable.mockResolvedValue(null);
    apiMocks.createRemoteSession.mockResolvedValue({
      session: session({ status: "recording", revision: 0 }),
      writerLease: { token: "writer-token-000000000000000000000000" }
    });
    apiMocks.checkpointRemoteSession.mockImplementation(async (_id, input) =>
      session({ status: "recording", revision: ++revision, segments: input.segments })
    );
    apiMocks.failRemoteSession.mockImplementation(async (_id, input) =>
      session({ status: "failed", revision: ++revision, finalizationWarning: input.finalizationWarning })
    );
    apiMocks.completeRemoteSession.mockImplementation(async () =>
      session({ status: "ready", revision: ++revision, endedAt: "2026-08-18T01:10:00.000Z" })
    );
    apiMocks.createRealtimeClientSecret.mockResolvedValue({ clientSecret: "ephemeral", expiresAt: 1 });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("accepts a final segment emitted during stopAndFlush before completing", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "更换课程" }));
    const daily = await screen.findByRole("radio", { name: /日常 \/ 不选课程/ });
    fireEvent.click(daily);
    fireEvent.click(screen.getByRole("button", { name: "使用此课程" }));
    fireEvent.click(await screen.findByRole("button", { name: "开始" }));
    await waitFor(() => expect(apiMocks.createRemoteSession).toHaveBeenCalledOnce());
    await waitFor(() => expect((screen.getByRole("button", { name: "结束" }) as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "结束" }));
    await waitFor(() => expect(apiMocks.completeRemoteSession).toHaveBeenCalledOnce());

    const persistedTail = apiMocks.checkpointRemoteSession.mock.calls.some(([, input]) =>
      input.segments.some((segment: { translatedText: string }) => segment.translatedText === "最后一句")
    );
    expect(persistedTail).toBe(true);
  });

  it("does not start a late microphone client after End cancels a deferred resume", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "更换课程" }));
    fireEvent.click(await screen.findByRole("radio", { name: /日常 \/ 不选课程/ }));
    fireEvent.click(screen.getByRole("button", { name: "使用此课程" }));
    fireEvent.click(await screen.findByRole("button", { name: "开始" }));
    await waitFor(() => expect(realtimeState.startCalls).toBe(1));

    act(() => realtimeState.callbacks?.onError("network moved"));
    await waitFor(() => expect(apiMocks.failRemoteSession).toHaveBeenCalled());
    let resolveResume!: (value: unknown) => void;
    apiMocks.resumeRemoteSession.mockImplementationOnce(() => new Promise((resolve) => { resolveResume = resolve; }));


    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await screen.findAllByText("连接中");
    fireEvent.click(screen.getByRole("button", { name: "结束" }));
    await act(async () => resolveResume({
      session: session({ status: "recording", revision: revision + 1, finalizationWarning: "尾段未确认" }),
      writerLease: { token: "writer-token-000000000000000000000000" }
    }));
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.getByText("待恢复")).toBeTruthy());
    expect(realtimeState.startCalls).toBe(1);
  });

  it("returns from a manual choice to the current Seoul course when synced", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T02:30:00Z"));
    const course = { ...DAILY_COURSE, id: "101", name: "한국어", source: "canvas" };
    apiMocks.fetchCourses.mockResolvedValue({ courses: [DAILY_COURSE, course], stale: false });
    apiMocks.fetchTimetable.mockResolvedValue({ timezone: "Asia/Seoul", term: { academicYear: 2026, semester: 2 }, meetings: [{ canvasCourseId: "101", courseNameZh: "韩语", weekdayIso: 1, startTime: "11:00", endTime: "13:00", locationCode: "104" }] });
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更换课程" }).textContent).toContain("한국어"));
    fireEvent.click(screen.getByRole("button", { name: "更换课程" }));
    fireEvent.click(await screen.findByRole("radio", { name: /日常 \/ 不选课程/ }));
    fireEvent.click(screen.getByRole("button", { name: "使用此课程" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "更换课程" }).textContent).toContain("日常"));
    fireEvent.click(screen.getByRole("button", { name: "匹配现在的课程" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "更换课程" }).textContent).toContain("한국어"));
    expect(apiMocks.fetchTimetable).toHaveBeenCalledTimes(2);
    expect(realtimeState.startCalls).toBe(0);
  });

  it("shows a history refresh failure inside the open sheet", async () => {
    render(<App />);
    await waitFor(() => expect(apiMocks.listRemoteSessions).toHaveBeenCalledOnce());
    apiMocks.listRemoteSessions.mockRejectedValueOnce(new Error("记录暂时无法读取"));
    fireEvent.click(screen.getByRole("button", { name: "课堂记录" }));
    await waitFor(() => expect(document.querySelector(".records-sheet")?.textContent).toContain("记录暂时无法读取"));
    expect(realtimeState.startCalls).toBe(0);
  });

  it("keeps the full subtitle canvas and recording alive while settings and history overlays open", async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByRole("button", { name: "开始" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await waitFor(() => expect(realtimeState.startCalls).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByRole("heading", { name: "字幕设置" });
    expect(screen.queryByRole("button", { name: "开始" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "显示韩文原文" }));
    act(() => realtimeState.callbacks?.onSegment?.({ sourceText: "수업을 계속합니다.", translatedText: "课堂继续。", elapsedMs: 1_000 }));
    expect(document.querySelector(".subtitle-canvas")?.textContent).toContain("课堂继续。");
    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    fireEvent.click(await screen.findByRole("button", { name: "课堂记录" }));
    await screen.findByRole("heading", { name: "课堂记录", level: 1 });
    expect(document.querySelector(".subtitle-canvas")?.textContent).toContain("课堂继续。");
    fireEvent.click(await screen.findByRole("button", { name: "关闭课堂记录" }));
    await screen.findByText("课堂继续。");
    expect(realtimeState.startCalls).toBe(1);
    expect(apiMocks.completeRemoteSession).not.toHaveBeenCalled();
  });
});

function session(overrides: Partial<ClassSession> = {}): ClassSession {
  return {
    id: "lecture_test",
    title: "日常 2026-08-18",
    courseId: DAILY_COURSE.id,
    courseCode: DAILY_COURSE.code,
    courseName: DAILY_COURSE.name,
    courseTerm: "",
    courseFolderName: DAILY_COURSE.folderName,
    courseMatchStatus: "daily",
    finalizationWarning: null,
    revision: 0,
    status: "recording",
    startedAt: "2026-08-18T01:00:00.000Z",
    endedAt: null,
    durationMs: 0,
    sourceLanguage: "ko",
    targetLanguage: "zh",
    models: { translation: "gpt-realtime-translate", transcription: "gpt-realtime-whisper" },
    segments: [],
    segmentCount: 0,
    savedAt: null,
    updatedAt: "2026-08-18T01:00:00.000Z",
    ...overrides
  };
}
