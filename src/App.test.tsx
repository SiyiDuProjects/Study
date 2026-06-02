import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COURSES } from "../shared/courses";
import App from "./App";
import type { ClassSession, ClassSessionSummary, RealtimeClientCallbacks } from "./types";

const clipboardWrite = vi.fn();

const mocks = vi.hoisted(() => ({
  createRealtimeClientSecret: vi.fn(),
  deleteRemoteSession: vi.fn(),
  fetchAppConfig: vi.fn(),
  fetchCourses: vi.fn(),
  getRemoteSession: vi.fn(),
  listRemoteSessions: vi.fn(),
  saveRemoteSession: vi.fn(),
  classicAudioBoost: vi.fn(),
  realtimeAudioBoost: vi.fn(),
  transcriptionAudioBoost: vi.fn(),
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
      private readonly callbacks: RealtimeClientCallbacks,
      audioBoostEnabled = true
    ) {
      mocks.classicAudioBoost(audioBoostEnabled);
    }

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
      private readonly callbacks: RealtimeClientCallbacks,
      audioBoostEnabled = true
    ) {
      mocks.realtimeAudioBoost(audioBoostEnabled);
    }

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
      private readonly callbacks: RealtimeClientCallbacks,
      audioBoostEnabled = true
    ) {
      mocks.transcriptionAudioBoost(audioBoostEnabled);
    }

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
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: clipboardWrite },
      configurable: true
    });
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

  it("shows a clear start workflow before a course is selected", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "选择本节课" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "先选择课程" }));

    expect(await screen.findByText("请选择本节课对应课程或日常，然后再开始录音。")).toBeTruthy();
  });

  it("starts recording from the main workflow after selecting a course", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /日常/ }));
    fireEvent.click(screen.getByRole("button", { name: "开始录音" }));

    expect(await screen.findByText("录音中")).toBeTruthy();
  });

  it("renders live subtitles as a continuous flow of aligned bilingual sentence pairs", async () => {
    window.localStorage.setItem(
      "korean-class-subtitler-settings",
      JSON.stringify({
        version: 6,
        subtitleScale: 1,
        showKoreanInline: false,
        translationMode: "transcribe-then-translate",
        textTranslationModel: "",
        audioBoostEnabled: false
      })
    );
    mocks.realtimeStart.mockImplementationOnce(async (callbacks: RealtimeClientCallbacks) => {
      callbacks.onOpen();
      callbacks.onSegment?.({
        sourceText: "첫 문장입니다.",
        translatedText: "第一句。",
        elapsedMs: 0
      });
      callbacks.onSegment?.({
        sourceText: "두 번째입니다.",
        translatedText: "第二句。",
        elapsedMs: 1200
      });
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /日常/ }));
    fireEvent.click(screen.getByRole("button", { name: "开始录音" }));

    expect(await screen.findByText("첫 문장입니다.")).toBeTruthy();
    expect(screen.getByText("第一句。")).toBeTruthy();
    expect(screen.getByText("두 번째입니다.")).toBeTruthy();
    expect(screen.getByText("第二句。")).toBeTruthy();
    expect(screen.getByText("첫 문장입니다.").closest(".subtitle-pair")?.textContent).toContain("第一句。");
    expect(screen.getByText("두 번째입니다.").closest(".subtitle-pair")?.textContent).toContain("第二句。");
    expect(document.querySelectorAll(".subtitle-pair")).toHaveLength(2);
    expect(document.querySelector(".subtitle-pair")?.tagName).toBe("SPAN");
  });

  it("keeps Korean subtitles visible when Chinese translation has not returned", async () => {
    mocks.realtimeStart.mockImplementationOnce(async (callbacks: RealtimeClientCallbacks) => {
      callbacks.onOpen();
      callbacks.onSegment?.({
        sourceText: "첫 문장입니다.",
        translatedText: "",
        elapsedMs: 0,
        translationStatus: "translating"
      });
      callbacks.onSegment?.({
        sourceText: "두 번째입니다.",
        translatedText: "",
        elapsedMs: 1200,
        translationStatus: "queued"
      });
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /日常/ }));
    fireEvent.click(screen.getByRole("button", { name: "开始录音" }));

    expect(await screen.findByText("첫 문장입니다.")).toBeTruthy();
    expect(screen.getByText("두 번째입니다.")).toBeTruthy();
    expect(screen.getByText("正在请求 /api/translate...")).toBeTruthy();
    expect(screen.getByText("等待翻译队列（前一句完成后发送）...")).toBeTruthy();
    expect(screen.getByText("첫 문장입니다.").closest(".subtitle-pair")?.textContent).toContain("正在请求 /api/translate...");
    expect(screen.getByText("두 번째입니다.").closest(".subtitle-pair")?.textContent).toContain(
      "等待翻译队列（前一句完成后发送）..."
    );
    expect(document.querySelectorAll(".subtitle-pair")).toHaveLength(2);
  });

  it("selects a course and surfaces a start failure", async () => {
    mocks.realtimeStart.mockRejectedValueOnce(new Error("麦克风被拒绝"));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /日常/ }));
    fireEvent.click(screen.getByTitle("开始录音"));

    expect(await screen.findByText(/麦克风被拒绝/)).toBeTruthy();
  });

  it("defaults to realtime transcription plus translation mode", async () => {
    render(<App />);

    fireEvent.click(await screen.findByTitle("设置"));

    expect(screen.getByDisplayValue("实时转录 + 翻译")).toBeTruthy();
  });

  it("defaults far-field audio boost off and uses the saved value for a new recording", async () => {
    render(<App />);

    fireEvent.click(await screen.findByTitle("设置"));
    const audioBoostToggle = screen.getByRole("checkbox", { name: "远距离收音增强（低音量时再开）" }) as HTMLInputElement;
    expect(audioBoostToggle.checked).toBe(false);

    fireEvent.click(audioBoostToggle);
    expect(audioBoostToggle.checked).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: /日常/ }));
    fireEvent.click(screen.getByRole("button", { name: "开始录音" }));

    await screen.findByText("录音中");
    expect(mocks.transcriptionAudioBoost).toHaveBeenCalledWith(true);
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
    fireEvent.click(screen.getByTitle("开始录音"));
    await screen.findByText("录音中");
    fireEvent.click(screen.getByTitle("结束"));

    await waitFor(() => expect(mocks.saveRemoteSession).toHaveBeenCalledTimes(1));
    const savedSession = mocks.saveRemoteSession.mock.calls[0][0] as ClassSession;
    expect(savedSession.models).toMatchObject({
      translation: "txt-test",
      transcription: "tr-test",
      mode: "transcribe-then-translate"
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
    fireEvent.click(screen.getByTitle("开始录音"));
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

    fireEvent.click(await screen.findByTitle("资料库"));
    await screen.findByText(summary.title);
    fireEvent.click(screen.getByTitle("删除"));

    expect(confirmSpy).toHaveBeenCalledWith(`删除记录「${summary.title}」？`);
    await waitFor(() => expect(mocks.deleteRemoteSession).toHaveBeenCalledWith(summary.id));
  });

  it("copies a single class record as AI context", async () => {
    const summary = createSummary();
    mocks.listRemoteSessions.mockResolvedValue([summary]);
    render(<App />);

    fireEvent.click(await screen.findByTitle("资料库"));
    await screen.findByText(summary.title);
    fireEvent.click(screen.getByTitle("复制本节课给 AI"));

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    expect(clipboardWrite.mock.calls[0][0]).toContain("中文：今天讨论语法。");
    expect(clipboardWrite.mock.calls[0][0]).toContain("韩文：오늘은 문법을 이야기합니다.");
    expect(await screen.findByText(/已复制给 AI/)).toBeTruthy();
  });

  it("shows all courses in the library even when a course has no sessions", async () => {
    render(<App />);

    fireEvent.click(await screen.findByTitle("资料库"));

    expect(await screen.findByText("课程目录")).toBeTruthy();
    expect((await screen.findAllByText("日常 / 不选课程")).length).toBeGreaterThan(0);
    expect(await screen.findByText("这门课还没有内容")).toBeTruthy();
    expect((screen.getByTitle("复制整门课给 AI") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows one selected course at a time in the library", async () => {
    const firstCourse = createSession({ id: "class_first", title: "第一门课记录" });
    const secondCourse = createSession({
      id: "class_second",
      title: "第二门课记录",
      courseId: "202610HY20235",
      courseCode: "202610HY20235",
      courseName: "한국어듣기말하기",
      courseTerm: "2026년 1학기",
      courseFolderName: "202610HY20235_한국어듣기말하기"
    });
    mocks.listRemoteSessions.mockResolvedValue([createSummary(firstCourse), createSummary(secondCourse)]);
    render(<App />);

    fireEvent.click(await screen.findByTitle("资料库"));

    expect(await screen.findByText("课程目录")).toBeTruthy();
    expect(await screen.findByText("第一门课记录")).toBeTruthy();
    expect(screen.queryByText("第二门课记录")).toBeNull();

    fireEvent.click(screen.getByTitle("查看课程：한국어듣기말하기"));

    expect(await screen.findByText("第二门课记录")).toBeTruthy();
    expect(screen.queryByText("第一门课记录")).toBeNull();
  });

  it("copies all saved course records from oldest to newest", async () => {
    const older = createSession({ id: "class_old", title: "第一课", startedAt: "2026-05-01T10:00:00.000Z" });
    const newer = createSession({ id: "class_new", title: "第二课", startedAt: "2026-05-08T10:00:00.000Z" });
    mocks.listRemoteSessions.mockResolvedValue([createSummary(newer), createSummary(older)]);
    mocks.getRemoteSession.mockImplementation(async (id: string) => (id === "class_old" ? older : newer));
    render(<App />);

    fireEvent.click(await screen.findByTitle("资料库"));
    fireEvent.click(await screen.findByTitle("复制整门课给 AI"));

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    const copiedText = clipboardWrite.mock.calls[0][0] as string;
    expect(copiedText.indexOf("## 第一课")).toBeLessThan(copiedText.indexOf("## 第二课"));
    expect(copiedText).toContain("- 课次数：2");
  });
});

function createSummary(session: ClassSession = createSession()): ClassSessionSummary {
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
