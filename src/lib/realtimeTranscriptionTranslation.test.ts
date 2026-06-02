import { beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeTranscriptionTranslationClient } from "./realtimeTranscriptionTranslation";
import type { RealtimeClientCallbacks } from "../types";

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

  it("streams Korean deltas first, then adds Chinese to the same subtitle line and commits it", async () => {
    const client = new RealtimeTranscriptionTranslationClient(async () => "ek_test", "tr-test", "txt-test", callbacks);

    await client.start();
    onMessage?.(JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "여기", elapsed_ms: 1200 }));
    onMessage?.(JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "서", elapsed_ms: 1300 }));
    onMessage?.(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "여기서",
        elapsed_ms: 1400
      })
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(callbacks.onDelta).toHaveBeenNthCalledWith(1, { channel: "source", delta: "여기", elapsedMs: 1200 });
    expect(callbacks.onDelta).toHaveBeenNthCalledWith(2, { channel: "source", delta: "서", elapsedMs: 1300 });
    expect(mocks.translateKoreanText).toHaveBeenCalledWith({
      model: "txt-test",
      text: "여기서",
      context: []
    });
    expect(callbacks.onSegment).toHaveBeenCalledWith({
      sourceText: "여기서",
      translatedText: "这里是上课内容。",
      elapsedMs: 1400,
      replaceActive: true
    });
  });

  it("filters transient replacement glyphs from partial transcription deltas", async () => {
    const client = new RealtimeTranscriptionTranslationClient(async () => "ek_test", "tr-test", "txt-test", callbacks);

    await client.start();
    onMessage?.(JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "여�기", elapsed_ms: 1200 }));
    onMessage?.(JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "□서", elapsed_ms: 1300 }));
    onMessage?.(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "여기서",
        elapsed_ms: 1400
      })
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(callbacks.onDelta).toHaveBeenNthCalledWith(1, { channel: "source", delta: "여기", elapsedMs: 1200 });
    expect(callbacks.onDelta).toHaveBeenNthCalledWith(2, { channel: "source", delta: "서", elapsedMs: 1300 });
    expect(callbacks.onSegment).toHaveBeenCalledWith({
      sourceText: "여기서",
      translatedText: "这里是上课内容。",
      elapsedMs: 1400,
      replaceActive: true
    });
  });

  it("configures realtime transcription without unsupported turn detection", async () => {
    const client = new RealtimeTranscriptionTranslationClient(async () => "ek_test", "tr-test", "txt-test", callbacks);

    await client.start();
    currentRms = 0.002;
    await vi.advanceTimersByTimeAsync(120);
    currentRms = 0;
    await vi.advanceTimersByTimeAsync(960);

    expect(sentEvents).toContainEqual(
      expect.objectContaining({
        type: "session.update"
      })
    );
    expect(sentEvents).toContainEqual(
      expect.objectContaining({
        session: expect.objectContaining({
          audio: expect.objectContaining({
            input: expect.objectContaining({
              noise_reduction: {
                type: "far_field"
              },
              transcription: expect.objectContaining({
                model: "tr-test",
                language: "ko"
              })
            })
          })
        })
      })
    );
    expect(JSON.stringify(sentEvents)).not.toContain("turn_detection");
    expect(sentEvents).not.toContainEqual({ type: "input_audio_buffer.commit" });
  });
});

function createStream(): MediaStream {
  return {
    getAudioTracks: vi.fn(() => [{ enabled: true }]),
    getTracks: vi.fn(() => [{ stop: vi.fn() }])
  } as unknown as MediaStream;
}
