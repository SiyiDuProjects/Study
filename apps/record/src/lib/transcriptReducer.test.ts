import { describe, expect, it } from "vitest";
import { nextCommitSequence } from "./sessionTimeline";
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

  it("sorts finalized transcribe-then-translate segments by commit sequence", () => {
    let state = createTranscriptState();
    state = appendTranscriptSegment(state, {
      sourceText: "둘째", translatedText: "第二", elapsedMs: 2_000, commitSequence: 1
    });
    state = appendTranscriptSegment(state, {
      sourceText: "첫째", translatedText: "第一", elapsedMs: 0, commitSequence: 0
    });
    expect(state.segments.map((segment) => [segment.translatedText, segment.commitSequence])).toEqual([
      ["第一", 0], ["第二", 1]
    ]);
  });

  it("updates a transcribed segment in place when its translation arrives or is replayed", () => {
    const original = { sourceText: "마지막 문장", translatedText: "", elapsedMs: 700, commitSequence: 0 };
    let state = appendTranscriptSegment(createTranscriptState(), original, "2026-10-02T00:00:00.000Z");
    const first = state.segments[0];
    expect(nextCommitSequence(state.segments)).toBe(1);
    const translated = { ...original, translatedText: "最后一句" };
    state = appendTranscriptSegment(state, translated, "2026-10-02T00:00:01.000Z");
    state = appendTranscriptSegment(state, translated, "2026-10-02T00:00:02.000Z");
    // A delayed source-only replay must not erase an already known translation.
    state = appendTranscriptSegment(state, original, "2026-10-02T00:00:03.000Z");
    expect(state.segments).toHaveLength(1);
    expect(state.segments[0]).toMatchObject({
      id: first.id, createdAt: first.createdAt, startedAtMs: 700,
      sourceText: original.sourceText, translatedText: "最后一句", commitSequence: 0
    });
    expect(nextCommitSequence(state.segments)).toBe(1);
    // Identical spoken text in a different audio commit is a separate sentence.
    state = appendTranscriptSegment(state, { ...translated, commitSequence: 1, elapsedMs: 2000 });
    expect(state.segments).toHaveLength(2);
  });
});
