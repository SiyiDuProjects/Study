import { describe, expect, it } from "vitest";
import type { ClassSession } from "../types";
import { buildAiCourseContext, buildAiSessionContext, buildMarkdownTranscript } from "./markdown";

describe("markdown export", () => {
  it("exports course metadata, Chinese main transcript, and Korean source details", () => {
    const session = createSession();

    const markdown = buildMarkdownTranscript(session);

    expect(markdown).toContain("# 아카데믹한국어듣기말하기");
    expect(markdown).toContain("- 课程：아카데믹한국어듣기말하기");
    expect(markdown).toContain("- 文件夹：202610HY20215\\_아카데믹한국어듣기말하기");
    expect(markdown).toContain("今天我们讨论语法。");
    expect(markdown).toContain("<summary>韩文原文</summary>");
    expect(markdown).toContain("오늘은 문법을 이야기합니다.");
    expect(markdown).toContain("rt-test + tr-test");
  });

  it("builds AI context for one session with Chinese and Korean text", () => {
    const markdown = buildAiSessionContext(createSession());

    expect(markdown).toContain("# 아카데믹한국어듣기말하기");
    expect(markdown).toContain("## 中韩转录");
    expect(markdown).toContain("中文：今天我们讨论语法。");
    expect(markdown).toContain("韩文：오늘은 문법을 이야기합니다.");
  });

  it("builds course AI context from oldest to newest session", () => {
    const older = createSession({ id: "class_old", title: "第一课", startedAt: "2026-05-01T10:00:00.000Z" });
    const newer = createSession({ id: "class_new", title: "第二课", startedAt: "2026-05-08T10:00:00.000Z" });

    const markdown = buildAiCourseContext([newer, older]);

    expect(markdown).toContain("# 아카데믹한국어듣기말하기 课程上下文");
    expect(markdown.indexOf("## 第一课")).toBeLessThan(markdown.indexOf("## 第二课"));
    expect(markdown).toContain("- 课次数：2");
  });
});

function createSession(overrides: Partial<ClassSession> = {}): ClassSession {
  return {
    id: "class_1",
    title: "아카데믹한국어듣기말하기",
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
        translatedText: "今天我们讨论语法。",
        sourceText: "오늘은 문법을 이야기합니다.",
        isFinal: true,
        createdAt: "2026-05-24T18:00:00.000Z",
        updatedAt: "2026-05-24T18:00:03.000Z"
      }
    ],
    ...overrides
  };
}
