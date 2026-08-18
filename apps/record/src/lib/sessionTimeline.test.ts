import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptSegment } from "../types";
import { connectionElapsedBase, nextCommitSequence } from "./sessionTimeline";

describe("resumed lecture timeline", () => {
  afterEach(() => vi.useRealTimers());

  it("continues commit sequence and wall-clock time after a page reload", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T01:30:00.000Z"));
    const segments = [segment(3, 1_000, 4_000), segment(4, 4_000, 8_000)];

    expect(nextCommitSequence(segments)).toBe(5);
    expect(connectionElapsedBase(segments, new Date("2026-08-18T01:00:00.000Z"))).toBe(30 * 60_000);
  });

  it("never moves behind the latest saved transcript when the local clock is earlier", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T01:00:05.000Z"));
    const segments = [segment(0, 0, 12_000)];
    expect(connectionElapsedBase(segments, new Date("2026-08-18T01:00:00.000Z"))).toBe(12_000);
  });
});

function segment(commitSequence: number, startedAtMs: number, endedAtMs: number): TranscriptSegment {
  return {
    id: `seg_${commitSequence}`,
    commitSequence,
    startedAtMs,
    endedAtMs,
    sourceText: "원문",
    translatedText: "字幕",
    isFinal: true,
    createdAt: "2026-08-18T01:00:00.000Z",
    updatedAt: "2026-08-18T01:00:01.000Z"
  };
}
