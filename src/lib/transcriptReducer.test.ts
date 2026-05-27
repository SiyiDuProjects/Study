import { describe, expect, it } from "vitest";
import {
  appendTranscriptSegment,
  applyTranscriptDelta,
  commitActiveSegment,
  createTranscriptState,
  getDisplaySegments
} from "./transcriptReducer";

describe("transcript reducer", () => {
  it("merges Korean source and Chinese translation into the active segment", () => {
    let state = createTranscriptState();

    state = applyTranscriptDelta(state, { channel: "translation", delta: "今天我们学习", elapsedMs: 0 }, "2026-05-24T00:00:00.000Z");
    state = applyTranscriptDelta(state, { channel: "source", delta: "오늘 우리는 공부합니다", elapsedMs: 0 }, "2026-05-24T00:00:01.000Z");
    state = applyTranscriptDelta(state, { channel: "translation", delta: "韩语发音。", elapsedMs: 400 }, "2026-05-24T00:00:02.000Z");

    expect(state.activeSegment?.translatedText).toBe("今天我们学习韩语发音。");
    expect(state.activeSegment?.sourceText).toBe("오늘 우리는 공부합니다");
  });

  it("commits the active segment and keeps final text stable", () => {
    let state = createTranscriptState();

    state = applyTranscriptDelta(state, { channel: "translation", delta: "请看黑板。", elapsedMs: 2500 });
    state = commitActiveSegment(state);

    expect(state.activeSegment).toBeNull();
    expect(state.segments).toHaveLength(1);
    expect(state.segments[0].isFinal).toBe(true);
    expect(state.segments[0].translatedText).toBe("请看黑板。");
    expect(state.segments[0].endedAtMs).toBeGreaterThanOrEqual(2500);
  });

  it("returns only the latest display segments", () => {
    let state = createTranscriptState();
    for (const text of ["一", "二", "三", "四"]) {
      state = applyTranscriptDelta(state, { channel: "translation", delta: text });
      state = commitActiveSegment(state);
    }

    expect(getDisplaySegments(state, 2).map((segment) => segment.translatedText)).toEqual(["三", "四"]);
  });

  it("appends a finalized source and translation segment", () => {
    let state = createTranscriptState();

    state = appendTranscriptSegment(
      state,
      {
        sourceText: "오늘은 문법을 이야기합니다.",
        translatedText: "今天讨论语法。",
        elapsedMs: 1200
      },
      "2026-05-24T00:00:00.000Z"
    );

    expect(state.activeSegment).toBeNull();
    expect(state.segments).toHaveLength(1);
    expect(state.segments[0].sourceText).toBe("오늘은 문법을 이야기합니다.");
    expect(state.segments[0].translatedText).toBe("今天讨论语法。");
    expect(state.segments[0].startedAtMs).toBe(1200);
  });

  it("can replace an active streaming Korean line with the finalized bilingual segment", () => {
    let state = createTranscriptState();

    state = applyTranscriptDelta(state, { channel: "source", delta: "여기서" });
    state = appendTranscriptSegment(state, {
      sourceText: "여기서",
      translatedText: "在这里",
      elapsedMs: 900,
      replaceActive: true
    });

    expect(state.activeSegment).toBeNull();
    expect(state.segments).toHaveLength(1);
    expect(state.segments[0].sourceText).toBe("여기서");
    expect(state.segments[0].translatedText).toBe("在这里");
  });
});
