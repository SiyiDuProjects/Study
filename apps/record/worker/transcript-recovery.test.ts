import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest, type SitesEnv } from "./index";
import { createTestD1 } from "./test-d1";
import {
  checkpointRemoteSession, completeRemoteSession, createRemoteSession,
  failRemoteSession, getRemoteSession, resumeRemoteSession
} from "../src/lib/api";
import { RealtimeTranscriptionTranslationClient } from "../src/lib/realtimeTranscriptionTranslation";
import { appendTranscriptSegment, createTranscriptState } from "../src/lib/transcriptReducer";

const at = "2026-10-02T00:00:00.000Z";

describe("transcription client through Worker persistence and shared Core read schema", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("saves the known source text when ending times out waiting for translation", async () => {
    const h = await setup();
    h.transcribe();
    const stopping = h.client.stopAndFlush(1000);
    const rejected = expect(stopping).rejects.toThrow("中文翻译超时");
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    // App persists this state after the flush rejects, before disabling callbacks.
    const failed = await failRemoteSession(h.id, {
      ...h.write(0), finalizationWarning: "中文翻译超时，尾段可能不完整。"
    });
    const saved = await getRemoteSession(h.id);
    expect(saved.status).toBe("failed");
    expect(saved.segments).toHaveLength(1);
    expect(saved.segments[0]).toMatchObject({ sourceText: "마지막 문장", translatedText: "", commitSequence: 0 });
    expect(saved.revision).toBe(failed.revision);
    h.detach();
    h.finishTranslation();
    await h.translationQueue();
    expect((await getRemoteSession(h.id)).segments).toEqual(saved.segments);
    const completion = { ...h.write(failed.revision), segments: [], endedAt: at };
    await expect(completeRemoteSession(h.id, completion)).rejects.toMatchObject({ status: 409 });
    await completeRemoteSession(h.id, { ...completion, acceptIncomplete: true });
    const finished = await getRemoteSession(h.id);
    expect(finished.status).toBe("ready");
    expect(finished.finalizationWarning).toBe(saved.finalizationWarning);
    expect(finished.segments).toEqual(saved.segments);
  });

  it("preserves a later completed source when an earlier transcription never arrives", async () => {
    const h = await setup();
    h.holdEarlierTranscription();
    h.transcribe();
    const stopping = h.client.stopAndFlush(1000);
    const rejected = expect(stopping).rejects.toThrow("韩文转录超时");
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    await failRemoteSession(h.id, {
      ...h.write(0), finalizationWarning: "前一段转录超时，字幕可能不完整。"
    });
    const saved = await getRemoteSession(h.id);
    expect(saved.segments).toHaveLength(1);
    expect(saved.segments[0]).toMatchObject({ sourceText: "마지막 문장", translatedText: "", commitSequence: 1 });
    expect(h.translationCalls()).toBe(0);
  });

  it("keeps one stable segment through a stale checkpoint retry, duplicate events and finalization", async () => {
    const h = await setup();
    h.transcribe();
    const original = h.write(0);
    expect(original.segments).toHaveLength(1);
    const originalId = original.segments[0].id;
    await checkpointRemoteSession(h.id, original);
    // A lost response leads to replay with the old revision, not a duplicate row.
    await expect(checkpointRemoteSession(h.id, original)).rejects.toMatchObject({
      status: 409, code: "writer_lease_conflict", currentRevision: 1
    });
    const latest = await getRemoteSession(h.id);
    const resumed = await resumeRemoteSession(h.id, {
      takeover: false, writerLeaseToken: h.token, expectedRevision: latest.revision
    });
    h.replay();
    h.finishTranslation();
    await h.translationQueue();
    // Replayed item_id after translation has completed must also remain inert.
    h.replay();
    await h.translationQueue();
    const updated = await checkpointRemoteSession(h.id, h.write(resumed.session.revision));
    await completeRemoteSession(h.id, { ...h.write(updated.revision), segments: [], endedAt: at });

    const saved = await getRemoteSession(h.id);
    expect(saved.status).toBe("ready");
    expect(saved.segments).toHaveLength(1);
    expect(saved.segments[0]).toMatchObject({ id: originalId, sourceText: "마지막 문장", translatedText: "最后一句", commitSequence: 0 });
    expect(h.translationCalls()).toBe(1);
    await h.client.stopAndFlush();
  });

  it("rejects a late translated update from the previous writer after takeover", async () => {
    const h = await setup();
    h.transcribe();
    await checkpointRemoteSession(h.id, h.write(0));
    const taken = await resumeRemoteSession(h.id, { takeover: true, expectedRevision: 1 });
    h.finishTranslation();
    await h.translationQueue();
    // Even knowing the latest revision cannot authorize the obsolete lease.
    await expect(checkpointRemoteSession(h.id, h.write(taken.session.revision))).rejects.toMatchObject({
      status: 409, code: "writer_lease_conflict"
    });
    const saved = await getRemoteSession(h.id);
    expect(saved.segments).toHaveLength(1);
    expect(saved.segments[0]).toMatchObject({ sourceText: "마지막 문장", translatedText: "" });
    expect(saved.revision).toBe(taken.session.revision);
    await h.client.stopAndFlush();
  });
});

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at));
  const env = { DB: createTestD1(), STUDY_OWNER_EMAIL: "owner@example.com" } as SitesEnv;
  let resolveTranslation!: (response: Response) => void;
  const translation = new Promise<Response>(resolve => { resolveTranslation = resolve; });
  let translationCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://record.example");
    if (url.pathname === "/api/translate") { translationCalls += 1; return translation; }
    const headers = new Headers(init?.headers);
    headers.set("oai-authenticated-user-id", "owner");
    headers.set("oai-authenticated-user-email", "owner@example.com");
    headers.set("Origin", "https://record.example");
    return handleRequest(new Request(url, { ...init, headers }), env);
  }));
  const created = await createRemoteSession({
    courseId: "daily", startedAt: at,
    models: { transcription: "gpt-realtime-whisper", translation: "gpt-5.4-mini", mode: "transcribe-then-translate" }
  });
  let state = createTranscriptState();
  let attached = true;
  const client = new RealtimeTranscriptionTranslationClient(async () => "unused", "gpt-5.4-mini", {
    onOpen: vi.fn(), onDelta: vi.fn(), onError: vi.fn(), onClose: vi.fn(),
    onSegment: segment => { if (attached) state = appendTranscriptSegment(state, segment); }
  });
  Object.assign(client, { transport: { sendEvent: () => true, close: vi.fn() } });
  const internals = client as unknown as {
    hasAudioToCommit: boolean; commitInputBuffer(): boolean;
    handleMessage(raw: string): void; translationQueue: Promise<void>;
  };
  const emit = (event: unknown) => internals.handleMessage(JSON.stringify(event));
  const result = { type: "conversation.item.input_audio_transcription.completed", item_id: "tail", transcript: "마지막 문장" };
  return {
    client, id: created.session.id, token: created.writerLease.token,
    holdEarlierTranscription() {
      internals.hasAudioToCommit = true;
      expect(internals.commitInputBuffer()).toBe(true);
      emit({ type: "input_audio_buffer.committed", item_id: "earlier" });
    },
    transcribe() {
      internals.hasAudioToCommit = true;
      expect(internals.commitInputBuffer()).toBe(true);
      emit({ type: "input_audio_buffer.committed", item_id: "tail" });
      emit(result);
    },
    replay() { emit(result); },
    write(expectedRevision: number) {
      return { writerLeaseToken: created.writerLease.token, expectedRevision, durationMs: 1000, segments: state.segments };
    },
    finishTranslation() {
      resolveTranslation(new Response(JSON.stringify({ translatedText: "最后一句" }), { headers: { "Content-Type": "application/json" } }));
    },
    translationQueue: () => internals.translationQueue,
    translationCalls: () => translationCalls,
    detach() { attached = false; }
  };
}
