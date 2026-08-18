import type { TranscriptSegment } from "../types";

export function nextCommitSequence(segments: TranscriptSegment[]): number {
  const highest = segments.reduce((maximum, segment) => Math.max(maximum, segment.commitSequence ?? -1), -1);
  return Math.max(highest + 1, segments.length);
}

export function connectionElapsedBase(segments: TranscriptSegment[], startedAt: Date | null): number {
  const transcriptEnd = segments.reduce(
    (maximum, segment) => Math.max(maximum, segment.endedAtMs ?? segment.startedAtMs),
    0
  );
  const wallClockElapsed = startedAt ? Math.max(0, Date.now() - startedAt.getTime()) : 0;
  return Math.max(transcriptEnd, wallClockElapsed);
}
