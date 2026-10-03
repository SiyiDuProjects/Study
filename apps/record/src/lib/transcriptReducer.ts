import type { RealtimeTranscriptDelta, RealtimeTranscriptSegment, TranscriptSegment, TranscriptState } from "../types";
import { createId } from "./id";

const HARD_SEGMENT_LIMIT = 260;

export function createTranscriptState(): TranscriptState {
  return {
    segments: [],
    activeSegment: null
  };
}

export function applyTranscriptDelta(
  state: TranscriptState,
  event: RealtimeTranscriptDelta,
  nowIso = new Date().toISOString()
): TranscriptState {
  const delta = event.delta;
  if (!delta) {
    return state;
  }

  const activeSegment = state.activeSegment ?? createSegment(event.elapsedMs ?? inferNextStartMs(state), nowIso);
  const nextActive: TranscriptSegment = {
    ...activeSegment,
    sourceText: event.channel === "source" ? activeSegment.sourceText + delta : activeSegment.sourceText,
    translatedText: event.channel === "translation" ? activeSegment.translatedText + delta : activeSegment.translatedText,
    updatedAt: nowIso
  };

  if (nextActive.translatedText.length >= HARD_SEGMENT_LIMIT && hasSoftBoundary(nextActive.translatedText)) {
    return commitActiveSegment({ ...state, activeSegment: nextActive }, nowIso);
  }

  return {
    ...state,
    activeSegment: nextActive
  };
}

export function commitActiveSegment(state: TranscriptState, nowIso = new Date().toISOString()): TranscriptState {
  const active = state.activeSegment;
  if (!active || isBlankSegment(active)) {
    return {
      ...state,
      activeSegment: null
    };
  }

  const endedAtMs = Math.max(active.startedAtMs, inferSegmentEndMs(active));
  return {
    segments: [
      ...state.segments,
      {
        ...active,
        endedAtMs,
        isFinal: true,
        updatedAt: nowIso
      }
    ],
    activeSegment: null
  };
}

export function appendTranscriptSegment(
  state: TranscriptState,
  segment: RealtimeTranscriptSegment,
  nowIso = new Date().toISOString()
): TranscriptState {
  const sourceText = segment.sourceText.trim();
  let translatedText = segment.translatedText.trim();
  if (!sourceText && !translatedText) {
    return state;
  }

  const committedState = commitActiveSegment(state, nowIso);
  // A transcription and its later translation share one audio commit. Keep
  // the persisted ID so checkpoint retries update that row instead of adding it.
  const previous = segment.commitSequence === undefined ? undefined
    : committedState.segments.find(item => item.commitSequence === segment.commitSequence);
  translatedText ||= previous?.translatedText ?? "";
  const startedAtMs = previous?.startedAtMs ?? segment.elapsedMs ?? inferNextStartMs(committedState);
  const nextSegment: TranscriptSegment = {
    id: previous?.id ?? createId("seg"),
    commitSequence: segment.commitSequence,
    startedAtMs,
    endedAtMs: startedAtMs + Math.max(1200, Math.max(sourceText.length, translatedText.length) * 90),
    sourceText,
    translatedText,
    isFinal: true,
    createdAt: previous?.createdAt ?? nowIso,
    updatedAt: nowIso
  };

  return {
    ...committedState,
    segments: previous
      ? committedState.segments.map(item => item === previous ? nextSegment : item)
      : sortCommittedSegments([...committedState.segments, nextSegment]),
    activeSegment: null
  };
}

function sortCommittedSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments
    .map((segment, index) => ({ segment, index }))
    .sort((left, right) => {
      const leftSequence = left.segment.commitSequence;
      const rightSequence = right.segment.commitSequence;
      if (leftSequence !== undefined && rightSequence !== undefined && leftSequence !== rightSequence) {
        return leftSequence - rightSequence;
      }
      return left.index - right.index;
    })
    .map(({ segment }) => segment);
}

export function getDisplaySegments(state: TranscriptState, count = 3): TranscriptSegment[] {
  const all = state.activeSegment ? [...state.segments, state.activeSegment] : state.segments;
  return all.slice(Math.max(0, all.length - count));
}

export function getAllSegments(state: TranscriptState): TranscriptSegment[] {
  return state.activeSegment ? [...state.segments, state.activeSegment] : state.segments;
}

function createSegment(startedAtMs: number, nowIso: string): TranscriptSegment {
  return {
    id: createId("seg"),
    startedAtMs,
    sourceText: "",
    translatedText: "",
    isFinal: false,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

function inferNextStartMs(state: TranscriptState): number {
  const last = state.segments.at(-1);
  return last?.endedAtMs ?? last?.startedAtMs ?? 0;
}

function inferSegmentEndMs(segment: TranscriptSegment): number {
  if (segment.endedAtMs !== undefined) {
    return segment.endedAtMs;
  }

  const readableLength = Math.max(segment.sourceText.length, segment.translatedText.length);
  return segment.startedAtMs + Math.max(1200, readableLength * 90);
}

function isBlankSegment(segment: TranscriptSegment): boolean {
  return !segment.sourceText.trim() && !segment.translatedText.trim();
}

function hasSoftBoundary(text: string): boolean {
  return /[。！？!?.\n]\s*$/.test(text);
}
