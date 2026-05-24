import { describe, expect, it } from "vitest";
import type { ClassSession } from "../types";
import { buildMarkdownTranscript } from "./markdown";

describe("markdown export", () => {
  it("exports Chinese main transcript with Korean source details", () => {
    const session: ClassSession = {
      id: "class_1",
      title: "韩语课堂",
      startedAt: "2026-05-24T18:00:00.000Z",
      endedAt: "2026-05-24T18:30:00.000Z",
      durationMs: 30 * 60 * 1000,
      sourceLanguage: "ko",
      targetLanguage: "zh",
      models: {
        translation: "gpt-realtime-translate",
        transcription: "gpt-realtime-whisper"
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

    expect(markdown).toContain("# 韩语课堂");
    expect(markdown).toContain("今天我们讨论语法。");
    expect(markdown).toContain("<summary>韩文原文</summary>");
    expect(markdown).toContain("오늘은 문법을 이야기합니다.");
    expect(markdown).toContain("gpt-realtime-translate + gpt-realtime-whisper");
  });
});
