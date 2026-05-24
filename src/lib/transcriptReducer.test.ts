import { describe, expect, it } from "vitest";
import { applyTranscriptDelta, commitActiveSegment, createTranscriptState, getDisplaySegments } from "./transcriptReducer";

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
});
