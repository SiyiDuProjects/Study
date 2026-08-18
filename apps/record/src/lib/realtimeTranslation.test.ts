import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeTranslationClient } from "./realtimeTranslation";

describe("RealtimeTranslationClient stopAndFlush", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("cancels pending microphone permission and stops a stream that resolves after unmount", async () => {
    const microphone = deferred<MediaStream>();
    const track = { stop: vi.fn(), enabled: true };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track]
    } as unknown as MediaStream;
    const getClientSecret = vi.fn(async () => "unused");
    const onOpen = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(() => microphone.promise) }
    });
    const client = new RealtimeTranslationClient(getClientSecret, {
      onOpen, onDelta: vi.fn(), onError: vi.fn(), onClose: vi.fn()
    });

    const starting = client.start();
    const startRejected = expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await client.stopAndFlush();
    microphone.resolve(stream);
    await startRejected;
    await Promise.resolve();

    expect(track.stop).toHaveBeenCalledOnce();
    expect(getClientSecret).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps receiving late transcript deltas until session.closed", async () => {
    vi.useFakeTimers();
    const onDelta = vi.fn();
    const close = vi.fn();
    const sent: Array<{ type?: string }> = [];
    const client = new RealtimeTranslationClient(async () => "unused", {
      onOpen: vi.fn(), onDelta, onError: vi.fn(), onClose: vi.fn()
    });
    Object.assign(client, {
      transport: {
        peerConnection: {}, dataChannel: {},
        sendEvent: (event: { type?: string }) => { sent.push(event); return true; },
        close
      }
    });
    const internals = client as unknown as { handleMessage(raw: string): void };

    const stopping = client.stopAndFlush(3_000);
    expect(sent).toContainEqual({ type: "session.close" });
    await vi.advanceTimersByTimeAsync(900);
    expect(close).not.toHaveBeenCalled();

    internals.handleMessage(JSON.stringify({ type: "session.input_transcript.delta", delta: "마지막" }));
    internals.handleMessage(JSON.stringify({ type: "session.output_transcript.delta", delta: "最后" }));
    await vi.advanceTimersByTimeAsync(700);
    expect(close).not.toHaveBeenCalled();
    internals.handleMessage(JSON.stringify({ type: "session.closed" }));
    await vi.advanceTimersByTimeAsync(100);
    await stopping;

    expect(onDelta).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it("treats transport close before session.closed as incomplete and never makes a retry succeed silently", async () => {
    const onError = vi.fn();
    const client = new RealtimeTranslationClient(async () => "unused", {
      onOpen: vi.fn(), onDelta: vi.fn(), onError, onClose: vi.fn()
    });
    Object.assign(client, {
      transport: { peerConnection: {}, dataChannel: {}, sendEvent: vi.fn(), close: vi.fn() }
    });
    (client as unknown as { handleTransportClose(): void }).handleTransportClose();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("意外关闭"));
    await expect(client.stopAndFlush()).rejects.toThrow("before session.closed");
    await expect(client.stopAndFlush()).rejects.toThrow("before session.closed");
  });

  it("treats unsolicited session.closed as incomplete unless the browser requested close", async () => {
    const onError = vi.fn();
    const client = new RealtimeTranslationClient(async () => "unused", {
      onOpen: vi.fn(), onDelta: vi.fn(), onError, onClose: vi.fn()
    });
    Object.assign(client, {
      transport: { peerConnection: {}, dataChannel: {}, sendEvent: vi.fn(), close: vi.fn() }
    });
    (client as unknown as { handleMessage(raw: string): void }).handleMessage(
      JSON.stringify({ type: "session.closed" })
    );
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("服务器意外关闭"));
    await expect(client.stopAndFlush()).rejects.toThrow("before session.closed");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
