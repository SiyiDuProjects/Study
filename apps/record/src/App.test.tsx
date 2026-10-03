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
  startCalls: 0,
  flushError: null as Error | null,
  flushPending: null as Promise<void> | null
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
      if (realtimeState.flushError) throw realtimeState.flushError;
      if (realtimeState.flushPending) await realtimeState.flushPending;
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
import { ApiRequestError } from "./lib/api";

describe("App final transcript persistence", () => {
  let revision = 0;

  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    revision = 0;
    realtimeState.callbacks = undefined;
    realtimeState.emittedTail = false;
    realtimeState.startCalls = 0;
    realtimeState.flushError = null;
    realtimeState.flushPending = null;
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

  it.each(["reject", "resolve"] as const)("keeps End in control after a default-mode flush error even if stop later %ss", async (outcome) => {
    await startRecording();
    act(() => realtimeState.callbacks?.onDelta({ channel: "translation", delta: "已收到的尾句", elapsedMs: 500 }));
    let rejectFlush!: (error: Error) => void;
    let resolveFlush!: () => void;
    realtimeState.flushPending = new Promise<void>((resolve, reject) => { resolveFlush = resolve; rejectFlush = reject; });
    apiMocks.resumeRemoteSession.mockImplementation(async () => ({
      session: session({ revision: ++revision }),
      writerLease: { token: "writer-token-000000000000000000000000" }
    }));

    fireEvent.click(screen.getByRole("button", { name: "结束" }));
    await screen.findAllByText("保存中");
    act(() => realtimeState.callbacks?.onError("network dropped during final flush"));
    // A click must not start another connection while the old End still awaits
    // its flush: that old continuation would invalidate the new callbacks.
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await act(async () => { await Promise.resolve(); });
    const prematureResumes = apiMocks.resumeRemoteSession.mock.calls.length;
    const prematureFailureWrites = apiMocks.failRemoteSession.mock.calls.length;
    const endDisabledWhileFlushing = (screen.getByRole("button", { name: "结束" }) as HTMLButtonElement).disabled;

    await act(async () => {
      if (outcome === "reject") rejectFlush(new Error("final transcript was not confirmed"));
      else resolveFlush();
    });
    await waitFor(() => expect(apiMocks.failRemoteSession).toHaveBeenCalled());
    expect(prematureResumes).toBe(0);
    expect(prematureFailureWrites).toBe(0);
    expect(endDisabledWhileFlushing).toBe(true);
    expect(realtimeState.startCalls).toBe(1);
    expect(apiMocks.completeRemoteSession).not.toHaveBeenCalled();
    expect(apiMocks.failRemoteSession.mock.lastCall?.[1].segments).toEqual(expect.arrayContaining([
      expect.objectContaining({ translatedText: "已收到的尾句" })
    ]));
    expect(screen.getByText("待恢复")).toBeTruthy();
  });

  it.each(["resolve", "reject"] as const)("keeps End locked through a checkpoint lease conflict until flush %ss, then allows takeover", async (outcome) => {
    await startRecording();
    const oldCallbacks = realtimeState.callbacks!;
    let rejectCheckpoint!: (reason: unknown) => void;
    apiMocks.checkpointRemoteSession.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCheckpoint = reject; }));
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(apiMocks.checkpointRemoteSession).toHaveBeenCalledOnce());
    let resolveFlush!: () => void;
    let rejectFlush!: (error: Error) => void;
    realtimeState.flushPending = new Promise<void>((resolve, reject) => { resolveFlush = resolve; rejectFlush = reject; });
    fireEvent.click(screen.getByRole("button", { name: "结束" }));
    await act(async () => rejectCheckpoint(new ApiRequestError("other owner", 409, "writer_lease_conflict", 5)));
    const continueDisabled = (screen.getByRole("button", { name: "继续" }) as HTMLButtonElement).disabled;
    const endDisabled = (screen.getByRole("button", { name: "结束" }) as HTMLButtonElement).disabled;
    // Settle even in the red run so no deferred work escapes the test.
    await act(async () => {
      if (outcome === "reject") rejectFlush(new Error("tail was not confirmed"));
      else resolveFlush();
    });
    await screen.findByText("待恢复");
    expect(continueDisabled).toBe(true);
    expect(endDisabled).toBe(true);
    expect(apiMocks.resumeRemoteSession).not.toHaveBeenCalled();
    expect(apiMocks.failRemoteSession).not.toHaveBeenCalled();
    expect(apiMocks.completeRemoteSession).not.toHaveBeenCalled();
    expect(apiMocks.checkpointRemoteSession).toHaveBeenCalledOnce();
    expect(screen.getByText(/这条记录已被另一台设备或页面接管/)).toBeTruthy();

    realtimeState.flushPending = null;
    apiMocks.resumeRemoteSession.mockResolvedValueOnce({
      session: session({ revision: 6, finalizationWarning: "接管前尾段未确认" }),
      writerLease: { token: "replacement-writer-token-00000000000000" }
    });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认" }));
    await waitFor(() => expect(realtimeState.startCalls).toBe(2));
    expect(apiMocks.resumeRemoteSession).toHaveBeenCalledExactlyOnceWith("lecture_test", { takeover: true, expectedRevision: 5 });
    act(() => realtimeState.callbacks?.onDelta({ channel: "translation", delta: "新连接首句", elapsedMs: 100 }));
    expect(document.querySelector(".subtitle-canvas")?.textContent).toContain("新连接首句");
    act(() => {
      oldCallbacks.onDelta({ channel: "translation", delta: "旧连接字幕", elapsedMs: 200 });
      oldCallbacks.onError("stale error");
      oldCallbacks.onClose();
      realtimeState.callbacks?.onDelta({ channel: "translation", delta: "新连接后续句", elapsedMs: 300 });
    });
    expect(document.querySelector(".subtitle-canvas")?.textContent).toContain("新连接后续句");
    expect(document.body.textContent).not.toContain("旧连接字幕");
    expect(screen.getByRole("button", { name: "暂停" })).toBeTruthy();
  });

  it("unlocks End with the lease conflict when a checkpoint fails after flush has settled", async () => {
    await startRecording();
    let rejectCheckpoint!: (reason: unknown) => void;
    apiMocks.checkpointRemoteSession.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCheckpoint = reject; }));
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(apiMocks.checkpointRemoteSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "结束" }));
    await act(async () => { await Promise.resolve(); });
    expect(realtimeState.emittedTail).toBe(true);
    await act(async () => rejectCheckpoint(new ApiRequestError("other owner", 409, "writer_lease_conflict", 5)));
    await screen.findByText("待恢复");
    expect((screen.getByRole("button", { name: "继续" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/这条记录已被另一台设备或页面接管/)).toBeTruthy();
    expect(apiMocks.checkpointRemoteSession).toHaveBeenCalledOnce();
    expect(apiMocks.failRemoteSession).not.toHaveBeenCalled();
    expect(apiMocks.completeRemoteSession).not.toHaveBeenCalled();
  });

  it.each(["complete", "failed"] as const)("unlocks End and preserves the lease conflict from its final %s write", async (mode) => {
    await startRecording();
    const conflict = new ApiRequestError("other owner", 409, "writer_lease_conflict", 5);
    if (mode === "failed") {
      realtimeState.flushError = new Error("tail was not confirmed");
      apiMocks.failRemoteSession.mockRejectedValueOnce(conflict);
    } else {
      apiMocks.completeRemoteSession.mockRejectedValueOnce(conflict);
    }
    fireEvent.click(screen.getByRole("button", { name: "结束" }));
    await screen.findByText("待恢复");
    expect((screen.getByRole("button", { name: "继续" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/这条记录已被另一台设备或页面接管/)).toBeTruthy();
    expect(apiMocks.resumeRemoteSession).not.toHaveBeenCalled();
    expect(apiMocks.failRemoteSession).toHaveBeenCalledTimes(mode === "failed" ? 1 : 0);
    expect(apiMocks.completeRemoteSession).toHaveBeenCalledTimes(mode === "complete" ? 1 : 0);
  });

  it("handles an unmount flush rejection and ignores late callbacks from the removed recording", async () => {
    await startRecording();
    act(() => realtimeState.callbacks?.onSegment?.({
      sourceText: "저장된 문장", translatedText: "已收到的字幕", elapsedMs: 500
    }));
    const oldCallbacks = realtimeState.callbacks!;
    realtimeState.flushError = new Error("synthetic unmount tail confirmation failure");

    cleanup();
    oldCallbacks.onSegment?.({ sourceText: "늦은 문장", translatedText: "卸载后到达", elapsedMs: 1000 });
    oldCallbacks.onError("late connection error");
    // Let rejected flush promises settle; Vitest also fails this test run on
    // any unhandled rejection raised by React's cleanup path.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(apiMocks.checkpointRemoteSession).toHaveBeenCalledOnce();
    expect(apiMocks.checkpointRemoteSession.mock.calls[0]?.[1].segments.map(
      (segment: { translatedText: string }) => segment.translatedText
    )).toEqual(["已收到的字幕"]);
    expect(apiMocks.failRemoteSession).not.toHaveBeenCalled();
    expect(apiMocks.completeRemoteSession).not.toHaveBeenCalled();
  });

  it("does not let a completed recording's late translation overwrite a new recording's same sequence", async () => {
    await startRecording();
    const previousCallbacks = realtimeState.callbacks!;
    act(() => previousCallbacks.onSegment?.({
      sourceText: "이전 기록", translatedText: "旧记录", elapsedMs: 500, commitSequence: 0
    }));
    fireEvent.click(screen.getByRole("button", { name: "结束" }));
    await screen.findByRole("button", { name: "返回课堂记录" });
    fireEvent.click(screen.getByRole("button", { name: "关闭课堂记录" }));
    apiMocks.createRemoteSession.mockResolvedValueOnce({
      session: session({ id: "lecture_new", revision: 0 }),
      writerLease: { token: "new-writer-token-000000000000000000000" }
    });
    fireEvent.click(await screen.findByRole("button", { name: "开始" }));
    await waitFor(() => expect(realtimeState.startCalls).toBe(2));
    act(() => {
      realtimeState.callbacks?.onSegment?.({
        sourceText: "새 기록", translatedText: "新记录", elapsedMs: 300, commitSequence: 0
      });
      previousCallbacks.onSegment?.({
        sourceText: "이전 기록", translatedText: "旧记录的迟到译文", elapsedMs: 500, commitSequence: 0
      });
      previousCallbacks.onError("old recording failed late");
      previousCallbacks.onClose();
    });
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(apiMocks.checkpointRemoteSession.mock.lastCall?.[0]).toBe("lecture_new"));
    const saved = apiMocks.checkpointRemoteSession.mock.lastCall![1];
    expect(saved.writerLeaseToken).toBe("new-writer-token-000000000000000000000");
    expect(saved.expectedRevision).toBe(0);
    expect(saved.segments).toHaveLength(1);
    expect(saved.segments[0]).toMatchObject({ sourceText: "새 기록", translatedText: "新记录", commitSequence: 0 });
    expect(apiMocks.failRemoteSession).not.toHaveBeenCalled();
  });

  it("keeps a completed session successful when refreshing history fails", async () => {
    await startRecording();
    apiMocks.listRemoteSessions.mockRejectedValueOnce(new Error("history unavailable"));

    fireEvent.click(screen.getByRole("button", { name: "结束" }));
    await waitFor(() => expect(document.querySelector(".records-sheet")?.textContent)
      .toContain("记录已保存，但历史列表刷新失败"));
    expect(apiMocks.completeRemoteSession).toHaveBeenCalledOnce();
    expect(apiMocks.failRemoteSession).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("保存尚未完成");
    expect(document.body.textContent).not.toContain("字幕完整性警告");

    fireEvent.click(screen.getByRole("button", { name: "关闭课堂记录" }));
    expect(screen.getByRole("button", { name: "开始" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("button", { name: "结束" })).toBeNull();
  });

  it.each([500, 502, 503, 504])("recovers an uncertain checkpoint HTTP %i using the same writer lease", async (status) => {
    await startRecording();
    // The write committed, but the gateway failed before its response arrived.
    apiMocks.checkpointRemoteSession.mockImplementationOnce(async () => {
      revision = 1;
      throw new ApiRequestError("gateway unavailable", status);
    });
    apiMocks.getRemoteSession.mockResolvedValue(session({ revision: 1 }));
    apiMocks.resumeRemoteSession.mockImplementationOnce(async () => ({
      session: session({ revision: ++revision }),
      writerLease: { token: "writer-token-000000000000000000000000" }
    }));

    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(apiMocks.checkpointRemoteSession).toHaveBeenCalledTimes(2));
    expect(apiMocks.resumeRemoteSession).toHaveBeenCalledWith("lecture_test", {
      takeover: false, expectedRevision: 1, writerLeaseToken: "writer-token-000000000000000000000000"
    });
    expect(apiMocks.checkpointRemoteSession.mock.calls[1]?.[1].expectedRevision).toBe(2);
    expect(screen.getByRole("button", { name: "继续" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("自动保存暂时失败");
  });

  it("recognizes completion after a gateway timeout without sending a duplicate completion", async () => {
    await startRecording();
    apiMocks.completeRemoteSession.mockRejectedValueOnce(new ApiRequestError("gateway timeout", 504));
    apiMocks.getRemoteSession.mockResolvedValue(session({ status: "ready", revision: 2, endedAt: "2026-08-18T01:10:00.000Z" }));
    apiMocks.resumeRemoteSession.mockRejectedValueOnce(new ApiRequestError("already complete", 409, "session_not_writable"));

    fireEvent.click(screen.getByRole("button", { name: "结束" }));
    await screen.findByRole("button", { name: "关闭课堂记录" });
    expect(apiMocks.completeRemoteSession).toHaveBeenCalledOnce();
    expect(apiMocks.resumeRemoteSession).toHaveBeenCalledWith("lecture_test", expect.objectContaining({ takeover: false, expectedRevision: 2 }));
    expect(apiMocks.failRemoteSession).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("保存尚未完成");
  });

  it("does not retry a checkpoint or take over when the writer lease is rejected", async () => {
    await startRecording();
    apiMocks.checkpointRemoteSession.mockRejectedValueOnce(new ApiRequestError("writer changed", 409, "writer_lease_conflict", 3));

    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await screen.findByText(/这条记录已被另一台设备或页面接管/);
    expect(apiMocks.checkpointRemoteSession).toHaveBeenCalledOnce();
    expect(apiMocks.getRemoteSession).not.toHaveBeenCalled();
    expect(apiMocks.resumeRemoteSession).not.toHaveBeenCalled();
  });

  it("stops uncertain-write recovery when another page now owns the lease", async () => {
    await startRecording();
    apiMocks.checkpointRemoteSession.mockRejectedValueOnce(new ApiRequestError("gateway unavailable", 502));
    apiMocks.getRemoteSession.mockResolvedValue(session({ revision: 3 }));
    apiMocks.resumeRemoteSession.mockRejectedValueOnce(new ApiRequestError("writer changed", 409, "writer_lease_conflict", 3));

    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await screen.findByText(/这条记录已被另一台设备或页面接管/);
    expect(apiMocks.checkpointRemoteSession).toHaveBeenCalledOnce();
    expect(apiMocks.resumeRemoteSession).toHaveBeenCalledExactlyOnceWith("lecture_test", {
      takeover: false, expectedRevision: 3, writerLeaseToken: "writer-token-000000000000000000000000"
    });
  });

  it("bounds recovery to one retry when the gateway stays unavailable", async () => {
    await startRecording();
    apiMocks.checkpointRemoteSession.mockRejectedValue(new ApiRequestError("gateway unavailable", 503));
    apiMocks.getRemoteSession.mockResolvedValue(session({ revision: 0 }));
    apiMocks.resumeRemoteSession.mockResolvedValue({
      session: session({ revision: 1 }),
      writerLease: { token: "writer-token-000000000000000000000000" }
    });

    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await screen.findByText("自动保存暂时失败，将继续重试。");
    expect(apiMocks.checkpointRemoteSession).toHaveBeenCalledTimes(2);
    expect(apiMocks.getRemoteSession).toHaveBeenCalledOnce();
    expect(apiMocks.resumeRemoteSession).toHaveBeenCalledOnce();
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

async function startRecording() {
  render(<App />);
  await waitFor(() => expect((screen.getByRole("button", { name: "开始" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "开始" }));
  await waitFor(() => expect(realtimeState.startCalls).toBe(1));
}

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
