import { describe, expect, it } from "vitest";
import type { ClassSession } from "../types";
import { buildMarkdownTranscript } from "./markdown";

describe("markdown export", () => {
  it("exports course metadata, Chinese main transcript, and Korean source details", () => {
    const session: ClassSession = {
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
      ]
    };

    const markdown = buildMarkdownTranscript(session);

    expect(markdown).toContain("# 아카데믹한국어듣기말하기");
    expect(markdown).toContain("- 课程：아카데믹한국어듣기말하기");
    expect(markdown).toContain("- 文件夹：202610HY20215\\_아카데믹한국어듣기말하기");
    expect(markdown).toContain("今天我们讨论语法。");
    expect(markdown).toContain("<summary>韩文原文</summary>");
    expect(markdown).toContain("오늘은 문법을 이야기합니다.");
    expect(markdown).toContain("rt-test + tr-test");
  });
});
