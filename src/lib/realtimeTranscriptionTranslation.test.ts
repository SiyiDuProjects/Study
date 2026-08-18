import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTranscriptSegment } from "../types";
import { RealtimeTranscriptionTranslationClient } from "./realtimeTranscriptionTranslation";

describe("RealtimeTranscriptionTranslationClient stopAndFlush", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts a deferred client-secret request and closes the microphone without a late open", async () => {
    const secret = deferred<string>();
    const track = { stop: vi.fn(), enabled: true };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track]
    } as unknown as MediaStream;
    let secretSignal: AbortSignal | undefined;
    const getClientSecret = vi.fn((signal?: AbortSignal) => {
      secretSignal = signal;
      return secret.promise;
    });
    const onOpen = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) }
    });
    const client = new RealtimeTranscriptionTranslationClient(
      getClientSecret,
      "gpt-5.4-mini",
      { onOpen, onDelta: vi.fn(), onSegment: vi.fn(), onError: vi.fn(), onClose: vi.fn() }
    );

    const starting = client.start();
    const startRejected = expect(starting).rejects.toMatchObject({ name: "AbortError" });
    for (let index = 0; index < 20 && !secretSignal; index += 1) {
      await Promise.resolve();
    }
    expect(secretSignal).toBeDefined();

    await client.stopAndFlush();
    expect(secretSignal?.aborted).toBe(true);
    secret.resolve("late-secret");
    await startRejected;
    await Promise.resolve();

    expect(track.stop).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("waits for a committed tail transcription arriving after 700ms", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ translatedText: "最后的作业说明" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));
    const onSegment = vi.fn<(segment: RealtimeTranscriptSegment) => void>();
    const events: Array<{ type?: string }> = [];
    const client = clientWithFakeTransport(onSegment, events);
    const internals = client as unknown as {
      hasAudioToCommit: boolean;
      commitInputBuffer(): boolean;
      handleMessage(raw: string): void;
    };
    internals.hasAudioToCommit = true;
    expect(internals.commitInputBuffer()).toBe(true);

    const stopping = client.stopAndFlush(2_500);
    await vi.advanceTimersByTimeAsync(900);
    expect(events.some((event) => event.type === "session.close")).toBe(false);

    internals.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "마지막 과제 설명"
    }));
    await vi.advanceTimersByTimeAsync(150);
    expect(events.some((event) => event.type === "session.close")).toBe(false);
    await stopping;
    expect(onSegment).toHaveBeenCalledWith(expect.objectContaining({ translatedText: "最后的作业说明" }));
    expect(events.some((event) => event.type === "session.close")).toBe(false);
  });

  it("counts an empty completed transcription so flush does not hang", async () => {
    vi.useFakeTimers();
    const onSegment = vi.fn<(segment: RealtimeTranscriptSegment) => void>();
    const events: Array<{ type?: string }> = [];
    const client = clientWithFakeTransport(onSegment, events);
    const internals = client as unknown as {
      hasAudioToCommit: boolean;
      commitInputBuffer(): boolean;
      handleMessage(raw: string): void;
    };
    internals.hasAudioToCommit = true;
    internals.commitInputBuffer();
    const stopping = client.stopAndFlush(2_000);
    await vi.advanceTimersByTimeAsync(900);
    internals.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "   "
    }));
    await vi.advanceTimersByTimeAsync(100);
    await stopping;
    expect(onSegment).not.toHaveBeenCalled();
  });

  it("closes the microphone transport when Realtime reports an error", () => {
    const close = vi.fn();
    const onError = vi.fn();
    const client = new RealtimeTranscriptionTranslationClient(
      async () => "unused",
      "gpt-5.4-mini",
      { onOpen: vi.fn(), onDelta: vi.fn(), onSegment: vi.fn(), onError, onClose: vi.fn() }
    );
    Object.assign(client, {
      transport: { peerConnection: {}, dataChannel: {}, sendEvent: vi.fn(), close }
    });
    (client as unknown as { handleMessage(raw: string): void }).handleMessage(
      JSON.stringify({ type: "error", error: { message: "connection failed" } })
    );
    expect(onError).toHaveBeenCalledWith("connection failed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("latches a failed transcription and keeps retries failed until the UI explicitly accepts incompleteness", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const events: Array<{ type?: string }> = [];
    const client = new RealtimeTranscriptionTranslationClient(
      async () => "unused", "gpt-5.4-mini",
      { onOpen: vi.fn(), onDelta: vi.fn(), onSegment: vi.fn(), onError, onClose: vi.fn() }
    );
    Object.assign(client, {
      transport: {
        peerConnection: {}, dataChannel: {},
        sendEvent: (event: { type?: string }) => { events.push(event); return true; },
        close: vi.fn()
      },
      hasAudioToCommit: true
    });
    const internals = client as unknown as { commitInputBuffer(): boolean; handleMessage(raw: string): void };
    internals.commitInputBuffer();
    const stopping = client.stopAndFlush(2_000);
    const failedStop = expect(stopping).rejects.toThrow("转录失败");
    await vi.advanceTimersByTimeAsync(800);
    internals.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.failed",
      error: { message: "tail failed" }
    }));
    await vi.advanceTimersByTimeAsync(700);
    await failedStop;
    expect(onError).toHaveBeenCalledWith("tail failed");

    const timeoutClient = clientWithFakeTransport(vi.fn<(segment: RealtimeTranscriptSegment) => void>(), []);
    const timeoutInternals = timeoutClient as unknown as { hasAudioToCommit: boolean; commitInputBuffer(): boolean };
    timeoutInternals.hasAudioToCommit = true;
    timeoutInternals.commitInputBuffer();
    const timedOut = timeoutClient.stopAndFlush(600);
    const rejection = expect(timedOut).rejects.toThrow("可能不完整");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    await expect(timeoutClient.stopAndFlush(600)).rejects.toThrow("可能不完整");
  });

  it("emits completed transcriptions in audio commit order even when item results arrive out of order", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text: string };
      return new Response(JSON.stringify({ translatedText: `译:${body.text}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));
    const onSegment = vi.fn<(segment: RealtimeTranscriptSegment) => void>();
    const events: Array<{ type?: string }> = [];
    const client = clientWithFakeTransport(onSegment, events, 7);
    const internals = client as unknown as {
      hasAudioToCommit: boolean;
      commitInputBuffer(): boolean;
      handleMessage(raw: string): void;
      translationQueue: Promise<void>;
    };
    internals.hasAudioToCommit = true;
    internals.commitInputBuffer();
    internals.hasAudioToCommit = true;
    internals.commitInputBuffer();
    internals.handleMessage(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "item_1" }));
    internals.handleMessage(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "item_2" }));
    internals.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed", item_id: "item_2", transcript: "둘째"
    }));
    expect(onSegment).not.toHaveBeenCalled();
    internals.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", transcript: "첫째"
    }));
    await internals.translationQueue;

    expect(onSegment.mock.calls.map(([segment]) => [segment.sourceText, segment.commitSequence])).toEqual([
      ["첫째", 7],
      ["둘째", 8]
    ]);
  });

  it("uses pending commit order as a safe fallback when item_id is absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text: string };
      return new Response(JSON.stringify({ translatedText: body.text }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));
    const onSegment = vi.fn<(segment: RealtimeTranscriptSegment) => void>();
    const client = clientWithFakeTransport(onSegment, []);
    const internals = client as unknown as {
      hasAudioToCommit: boolean;
      commitInputBuffer(): boolean;
      handleMessage(raw: string): void;
      translationQueue: Promise<void>;
    };
    internals.hasAudioToCommit = true;
    internals.commitInputBuffer();
    internals.hasAudioToCommit = true;
    internals.commitInputBuffer();
    internals.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed", transcript: "하나"
    }));
    internals.handleMessage(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed", transcript: "둘"
    }));
    await internals.translationQueue;
    expect(onSegment.mock.calls.map(([segment]) => segment.commitSequence)).toEqual([0, 1]);
  });

  it("rejects when buffered tail audio cannot be committed and never turns a retry into success", async () => {
    const close = vi.fn();
    const client = new RealtimeTranscriptionTranslationClient(
      async () => "unused", "gpt-5.4-mini",
      { onOpen: vi.fn(), onDelta: vi.fn(), onSegment: vi.fn(), onError: vi.fn(), onClose: vi.fn() }
    );
    Object.assign(client, {
      transport: {
        peerConnection: {}, dataChannel: {}, sendEvent: vi.fn(() => false), close
      },
      hasAudioToCommit: true
    });
    await expect(client.stopAndFlush()).rejects.toThrow("未能提交");
    expect(close).toHaveBeenCalledOnce();
    await expect(client.stopAndFlush()).rejects.toThrow("未能提交");
  });
});

function clientWithFakeTransport(
  onSegment: (segment: RealtimeTranscriptSegment) => void,
  events: Array<{ type?: string }>,
  initialCommitSequence = 0
) {
  const client = new RealtimeTranscriptionTranslationClient(
    async () => "unused",
    "gpt-5.4-mini",
    { onOpen: vi.fn(), onDelta: vi.fn(), onSegment, onError: vi.fn(), onClose: vi.fn() },
    initialCommitSequence
  );
  Object.assign(client, {
    transport: {
      peerConnection: {},
      dataChannel: {},
      sendEvent: (event: { type?: string }) => {
        events.push(event);
        return true;
      },
      close: vi.fn()
    }
  });
  return client;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
