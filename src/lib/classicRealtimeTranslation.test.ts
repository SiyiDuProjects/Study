import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClassicRealtimeTranslationClient } from "./classicRealtimeTranslation";

const mockMicrophone = vi.hoisted(() => ({
  monitorStop: vi.fn()
}));

vi.mock("./microphoneLevel", () => ({
  startMicrophoneLevelMonitor: vi.fn(() => ({ stop: mockMicrophone.monitorStop }))
}));

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(
    readonly url: string | URL,
    readonly protocols?: string | string[]
  ) {
    sockets.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new Event("close") as CloseEvent);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  message(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }
}

const sockets: FakeWebSocket[] = [];
let latestProcessor: ScriptProcessorNode | null = null;
let stopTrack: ReturnType<typeof vi.fn>;
let originalMediaDevices: Navigator["mediaDevices"] | undefined;
let originalAudioContext: typeof AudioContext | undefined;

class FakeAudioContext {
  sampleRate = 48_000;
  destination = {};

  createMediaStreamSource() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn()
    };
  }

  createScriptProcessor() {
    latestProcessor = {
      onaudioprocess: null,
      connect: vi.fn(),
      disconnect: vi.fn()
    } as unknown as ScriptProcessorNode;
    return latestProcessor;
  }

  close() {
    return Promise.resolve();
  }
}

describe("ClassicRealtimeTranslationClient", () => {
  beforeEach(() => {
    sockets.length = 0;
    latestProcessor = null;
    mockMicrophone.monitorStop.mockClear();
    stopTrack = vi.fn();
    originalMediaDevices = navigator.mediaDevices;
    originalAudioContext = window.AudioContext;

    const stream = {
      getTracks: vi.fn(() => [{ stop: stopTrack }]),
      getAudioTracks: vi.fn(() => [{ stop: stopTrack, enabled: true }])
    } as unknown as MediaStream;

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(stream)
      }
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: FakeAudioContext
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices
    });
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: originalAudioContext
    });
  });

  it("gets a client secret, opens the translation WebSocket, streams audio frames, and emits deltas", async () => {
    const getClientSecret = vi.fn().mockResolvedValue("ek_test");
    const callbacks = createCallbacks();
    const client = new ClassicRealtimeTranslationClient(getClientSecret, "rt-test", "tr-test", callbacks);

    await client.start();

    expect(getClientSecret).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
    expect(String(sockets[0].url)).toBe("wss://api.openai.com/v1/realtime/translations?model=rt-test");
    expect(sockets[0].protocols).toContain("openai-insecure-api-key.ek_test");

    sockets[0].open();

    expect(callbacks.onOpen).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sockets[0].sent[0])).toMatchObject({
      type: "session.update",
      session: {
        audio: {
          input: {
            transcription: { model: "tr-test" }
          },
          output: { language: "zh" }
        }
      }
    });

    latestProcessor?.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => new Float32Array(9600).fill(0.2)
      }
    } as unknown as AudioProcessingEvent);

    const audioFrame = JSON.parse(sockets[0].sent[1]);
    expect(audioFrame).toMatchObject({
      type: "session.input_audio_buffer.append"
    });
    expect(audioFrame.audio.length).toBeGreaterThan(0);

    sockets[0].message(JSON.stringify({ type: "session.output_transcript.delta", delta: "你好", elapsed_ms: 42 }));
    sockets[0].message(JSON.stringify({ type: "session.input_transcript.delta", delta: "안녕하세요", elapsed_ms: 42 }));

    expect(callbacks.onDelta).toHaveBeenCalledWith({ channel: "translation", delta: "你好", elapsedMs: 42 });
    expect(callbacks.onDelta).toHaveBeenCalledWith({ channel: "source", delta: "안녕하세요", elapsedMs: 42 });
    expect(callbacks.onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "connection", connection: "webSocket", state: "open" })
    );
  });

  it("surfaces WebSocket errors clearly", async () => {
    const callbacks = createCallbacks();
    const client = new ClassicRealtimeTranslationClient(vi.fn().mockResolvedValue("ek_test"), "rt-test", "tr-test", callbacks);

    await client.start();
    sockets[0].fail();

    expect(callbacks.onError).toHaveBeenCalledWith("经典低延迟连接失败，请检查网络、服务器配置或模型权限。");
    expect(callbacks.onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "connection", connection: "webSocket", state: "error" })
    );
  });

  it("sends session.close and releases local audio on stop", async () => {
    const client = new ClassicRealtimeTranslationClient(
      vi.fn().mockResolvedValue("ek_test"),
      "rt-test",
      "tr-test",
      createCallbacks()
    );
    await client.start();
    sockets[0].open();

    await client.stop();

    expect(JSON.parse(sockets[0].sent.at(-1) ?? "{}")).toMatchObject({ type: "session.close" });
    expect(stopTrack).toHaveBeenCalled();
    expect(mockMicrophone.monitorStop).toHaveBeenCalled();
  });
});

function createCallbacks() {
  return {
    onOpen: vi.fn(),
    onDelta: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
    onDiagnostic: vi.fn()
  };
}
