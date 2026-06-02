import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeClientCallbacks } from "../types";
import { RealtimeTranscriptionTranslationClient } from "./realtimeTranscriptionTranslation";

const mocks = vi.hoisted(() => ({
  createMicrophoneInput: vi.fn(),
  createRealtimeWebRtcTransport: vi.fn(),
  translateKoreanText: vi.fn()
}));

vi.mock("./microphoneInput", () => ({
  createMicrophoneInput: mocks.createMicrophoneInput
}));

vi.mock("./realtimeWebRtc", () => ({
  createRealtimeWebRtcTransport: mocks.createRealtimeWebRtcTransport
}));

vi.mock("./api", () => ({
  translateKoreanText: mocks.translateKoreanText
}));

describe("RealtimeTranscriptionTranslationClient", () => {
  let callbacks: RealtimeClientCallbacks;
  let sentEvents: unknown[];
  let onMessage: ((data: unknown) => void) | null;
  let stream: MediaStream;
  let currentRms: number;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sentEvents = [];
    onMessage = null;
    currentRms = 0;
    stream = createStream();
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: class {
        resume = vi.fn(() => Promise.resolve());
        close = vi.fn(() => Promise.resolve());
        createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
        createAnalyser = vi.fn(() => ({
          fftSize: 0,
          disconnect: vi.fn(),
          getFloatTimeDomainData: (samples: Float32Array) => samples.fill(currentRms)
        }));
      }
    });
    callbacks = {
      onOpen: vi.fn(),
      onDelta: vi.fn(),
      onSegment: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      onDiagnostic: vi.fn()
    };

    mocks.createMicrophoneInput.mockResolvedValue({
      stream,
      boostApplied: true,
      stop: vi.fn()
    });
    mocks.createRealtimeWebRtcTransport.mockImplementation(async (options) => {
      onMessage = options.onMessage;
      options.onOpen({
        sendEvent: (event: unknown) => {
          sentEvents.push(event);
          return true;
        },
        close: vi.fn()
      });
      return {
        sendEvent: (event: unknown) => {
          sentEvents.push(event);
          return true;
        },
        close: vi.fn()
      };
    });
    mocks.translateKoreanText.mockResolvedValue("这里是上课内容。");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("commits Korean transcription before the text translation settles", async () => {
    const translation = deferred<string>();
    mocks.translateKoreanText.mockReturnValue(translation.promise);
    const client = new RealtimeTranscriptionTranslationClient(async () => "ek_test", "txt-test", callbacks);

    await client.start();
    emitRealtimeEvent({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item_1",
      delta: "여기",
      elapsed_ms: 1200
    });
    emitRealtimeEvent({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item_1",
      delta: "서",
      elapsed_ms: 1300
    });
    emitRealtimeEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "여기서",
      elapsed_ms: 1400
    });

    expect(callbacks.onDelta).toHaveBeenNthCalledWith(1, { channel: "source", delta: "여기", elapsedMs: 1200 });
    expect(callbacks.onDelta).toHaveBeenNthCalledWith(2, { channel: "source", delta: "서", elapsedMs: 1300 });
    expect(callbacks.onSegment).toHaveBeenCalledWith({
      sourceText: "여기서",
      translatedText: "",
      elapsedMs: 1400,
      replaceActive: true,
      replaceActiveSourceText: "여기서",
      translationStatus: "queued"
    });

    await Promise.resolve();
    expect(callbacks.onSegment).toHaveBeenCalledWith({
      sourceText: "여기서",
      translatedText: "",
      elapsedMs: 1400,
      translationStatus: "translating"
    });
    expect(mocks.translateKoreanText).toHaveBeenCalledWith({
      model: "txt-test",
      text: "여기서",
      context: []
    });

    translation.resolve("这里是上课内容。");
    await flushPromises();

    expect(callbacks.onSegment).toHaveBeenCalledWith({
      sourceText: "여기서",
      translatedText: "这里是上课内容。",
      elapsedMs: 1400,
      translationStatus: "translated"
    });
  });

  it("simulates streamed Korean and translates each completed sentence separately", async () => {
    mocks.translateKoreanText.mockResolvedValueOnce("这是第一句。").mockResolvedValueOnce("这是第二句。");
    const client = new RealtimeTranscriptionTranslationClient(async () => "ek_test", "txt-test", callbacks);

    await client.start();
    emitRealtimeEvent({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item_1",
      delta: "첫 문장입니다. 두 번째 문장입니다.",
      elapsed_ms: 1000
    });
    emitRealtimeEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "첫 문장입니다. 두 번째 문장입니다.",
      elapsed_ms: 1600
    });
    await flushPromises();

    expect(callbacks.onSegment).toHaveBeenNthCalledWith(1, {
      sourceText: "첫 문장입니다.",
      translatedText: "",
      elapsedMs: 1600,
      replaceActive: true,
      replaceActiveSourceText: "첫 문장입니다. 두 번째 문장입니다.",
      translationStatus: "queued"
    });
    expect(callbacks.onSegment).toHaveBeenNthCalledWith(2, {
      sourceText: "두 번째 문장입니다.",
      translatedText: "",
      elapsedMs: 1640,
      replaceActive: false,
      replaceActiveSourceText: "",
      translationStatus: "queued"
    });
    expect(callbacks.onSegment).toHaveBeenCalledWith({
      sourceText: "첫 문장입니다.",
      translatedText: "",
      elapsedMs: 1600,
      translationStatus: "translating"
    });
    expect(callbacks.onSegment).toHaveBeenCalledWith({
      sourceText: "두 번째 문장입니다.",
      translatedText: "",
      elapsedMs: 1640,
      translationStatus: "translating"
    });
    expect(mocks.translateKoreanText).toHaveBeenNthCalledWith(1, {
      model: "txt-test",
      text: "첫 문장입니다.",
      context: []
    });
    expect(mocks.translateKoreanText).toHaveBeenNthCalledWith(2, {
      model: "txt-test",
      text: "두 번째 문장입니다.",
      context: [{ sourceText: "첫 문장입니다.", translatedText: "这是第一句。" }]
    });
    expect(callbacks.onSegment).toHaveBeenCalledWith({
      sourceText: "첫 문장입니다.",
      translatedText: "这是第一句。",
      elapsedMs: 1600,
      translationStatus: "translated"
    });
    expect(callbacks.onSegment).toHaveBeenCalledWith({
      sourceText: "두 번째 문장입니다.",
      translatedText: "这是第二句。",
      elapsedMs: 1640,
      translationStatus: "translated"
    });
  });

  it("keeps later Korean transcription items independent from unresolved translations", async () => {
    const translation = deferred<string>();
    mocks.translateKoreanText.mockReturnValue(translation.promise);
    const client = new RealtimeTranscriptionTranslationClient(async () => "ek_test", "txt-test", callbacks);

    await client.start();
    emitRealtimeEvent({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item_1",
      delta: "첫 문장",
      elapsed_ms: 1000
    });
    emitRealtimeEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "첫 문장입니다.",
      elapsed_ms: 1300
    });
    emitRealtimeEvent({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item_2",
      delta: "두 번째",
      elapsed_ms: 2200
    });
    emitRealtimeEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_2",
      transcript: "두 번째 문장입니다.",
      elapsed_ms: 2500
    });

    expect(callbacks.onSegment).toHaveBeenNthCalledWith(1, {
      sourceText: "첫 문장입니다.",
      translatedText: "",
      elapsedMs: 1300,
      replaceActive: true,
      replaceActiveSourceText: "첫 문장",
      translationStatus: "queued"
    });
    expect(callbacks.onSegment).toHaveBeenNthCalledWith(2, {
      sourceText: "두 번째 문장입니다.",
      translatedText: "",
      elapsedMs: 2500,
      replaceActive: true,
      replaceActiveSourceText: "두 번째",
      translationStatus: "queued"
    });
  });

  it("filters transient replacement glyphs from partial transcription deltas", async () => {
    const client = new RealtimeTranscriptionTranslationClient(async () => "ek_test", "txt-test", callbacks);

    await client.start();
    emitRealtimeEvent({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item_1",
      delta: "여\ufffd기",
      elapsed_ms: 1200
    });
    emitRealtimeEvent({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item_1",
      delta: "\u25a1서",
      elapsed_ms: 1300
    });
    emitRealtimeEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "여기서",
      elapsed_ms: 1400
    });

    expect(callbacks.onDelta).toHaveBeenNthCalledWith(1, { channel: "source", delta: "여기", elapsedMs: 1200 });
    expect(callbacks.onDelta).toHaveBeenNthCalledWith(2, { channel: "source", delta: "서", elapsedMs: 1300 });
    expect(callbacks.onSegment).toHaveBeenCalledWith({
      sourceText: "여기서",
      translatedText: "",
      elapsedMs: 1400,
      replaceActive: true,
      replaceActiveSourceText: "여기서",
      translationStatus: "queued"
    });
  });

  it("marks a single sentence translation failure with the API error", async () => {
    mocks.translateKoreanText.mockRejectedValue(new Error("OpenAI translation request failed: 500 upstream"));
    const client = new RealtimeTranscriptionTranslationClient(async () => "ek_test", "txt-test", callbacks);

    await client.start();
    emitRealtimeEvent({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item_1",
      delta: "첫 문장입니다.",
      elapsed_ms: 1000
    });
    emitRealtimeEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "첫 문장입니다.",
      elapsed_ms: 1300
    });
    await flushPromises();

    expect(callbacks.onSegment).toHaveBeenCalledWith({
      sourceText: "첫 문장입니다.",
      translatedText: "",
      elapsedMs: 1300,
      translationStatus: "failed",
      translationError: "OpenAI translation request failed: 500 upstream"
    });
    expect(callbacks.onError).toHaveBeenCalledWith("OpenAI translation request failed: 500 upstream");
  });

  it("uses the server-issued transcription session without browser session updates", async () => {
    const client = new RealtimeTranscriptionTranslationClient(async () => "ek_test", "txt-test", callbacks);

    await client.start();
    currentRms = 0.002;
    await vi.advanceTimersByTimeAsync(120);
    currentRms = 0;
    await vi.advanceTimersByTimeAsync(960);

    expect(sentEvents).not.toContainEqual(
      expect.objectContaining({
        type: "session.update"
      })
    );
    expect(sentEvents).not.toContainEqual({ type: "input_audio_buffer.commit" });
  });

  function emitRealtimeEvent(event: unknown): void {
    onMessage?.(JSON.stringify(event));
  }
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });

  return { promise, resolve };
}

async function flushPromises(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function createStream(): MediaStream {
  return {
    getAudioTracks: vi.fn(() => [{ enabled: true }]),
    getTracks: vi.fn(() => [{ stop: vi.fn() }])
  } as unknown as MediaStream;
}
