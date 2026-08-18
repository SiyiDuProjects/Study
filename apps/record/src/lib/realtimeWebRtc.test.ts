import { afterEach, describe, expect, it, vi } from "vitest";
import { createRealtimeWebRtcTransport } from "./realtimeWebRtc";

describe("createRealtimeWebRtcTransport cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts a deferred SDP request, closes WebRTC resources, and ignores a late response", async () => {
    const peer = installFakePeerConnection();
    const sdp = deferred<Response>();
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchSignal = init?.signal as AbortSignal | undefined;
      return sdp.promise;
    }));
    const controller = new AbortController();
    const onOpen = vi.fn();
    const connecting = connect(peer.stream, onOpen, controller.signal);
    const rejected = expect(connecting).rejects.toMatchObject({ name: "AbortError" });

    await flushMicrotasks();
    expect(fetchSignal).toBeDefined();
    controller.abort();
    await rejected;

    expect(fetchSignal?.aborted).toBe(true);
    expect(peer.close).toHaveBeenCalledOnce();
    expect(peer.dataChannel.close).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();

    sdp.resolve(new Response("late-answer", { status: 200 }));
    await flushMicrotasks();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("cancels the data-channel readiness wait and prevents a late open callback", async () => {
    const peer = installFakePeerConnection();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("answer-sdp", { status: 200 })));
    const controller = new AbortController();
    const onOpen = vi.fn();
    const connecting = connect(peer.stream, onOpen, controller.signal);
    const rejected = expect(connecting).rejects.toMatchObject({ name: "AbortError" });

    await waitForCall(peer.setRemoteDescription);
    const lateOpen = peer.dataChannel.onopen;
    controller.abort();
    await rejected;

    peer.dataChannel.readyState = "open";
    lateOpen?.(new Event("open"));
    expect(onOpen).not.toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalledOnce();
  });

  it("times out deterministically when the data channel never opens", async () => {
    vi.useFakeTimers();
    const peer = installFakePeerConnection();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("answer-sdp", { status: 200 })));
    const onOpen = vi.fn();
    const connecting = connect(peer.stream, onOpen, undefined, 100);
    const rejected = expect(connecting).rejects.toThrow("data channel did not open");

    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    const lateOpen = peer.dataChannel.onopen;
    await vi.advanceTimersByTimeAsync(101);
    await rejected;

    peer.dataChannel.readyState = "open";
    lateOpen?.(new Event("open"));
    expect(onOpen).not.toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(peer.dataChannel.close).toHaveBeenCalledOnce();
  });
});

function connect(
  stream: MediaStream,
  onOpen: () => void,
  signal?: AbortSignal,
  dataChannelOpenTimeoutMs = 5_000
) {
  return createRealtimeWebRtcTransport({
    callUrl: "https://api.openai.com/v1/realtime/calls",
    clientSecret: "ephemeral-test-secret",
    stream,
    signal,
    sdpTimeoutMs: 5_000,
    dataChannelOpenTimeoutMs,
    onOpen,
    onMessage: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn()
  });
}

function installFakePeerConnection() {
  const dataChannel = {
    readyState: "connecting" as RTCDataChannelState,
    onopen: null as ((event: Event) => void) | null,
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    onclose: null as ((event: Event) => void) | null,
    send: vi.fn(),
    close: vi.fn(function (this: { readyState: RTCDataChannelState }) {
      this.readyState = "closed";
    })
  };
  const audioTrack = { stop: vi.fn(), enabled: true };
  const stream = {
    getAudioTracks: () => [audioTrack],
    getTracks: () => [audioTrack]
  } as unknown as MediaStream;
  const peer = {
    dataChannel,
    stream,
    connectionState: "new" as RTCPeerConnectionState,
    localDescription: null as RTCSessionDescription | null,
    onconnectionstatechange: null as ((event: Event) => void) | null,
    createDataChannel: vi.fn(() => dataChannel as unknown as RTCDataChannel),
    addTrack: vi.fn(),
    createOffer: vi.fn(async () => ({ type: "offer" as RTCSdpType, sdp: "offer-sdp" })),
    setLocalDescription: vi.fn(async function (this: { localDescription: RTCSessionDescription | null }, description: RTCSessionDescriptionInit) {
      this.localDescription = { type: description.type ?? "offer", sdp: description.sdp ?? "" } as RTCSessionDescription;
    }),
    setRemoteDescription: vi.fn(async () => undefined),
    close: vi.fn(function (this: { connectionState: RTCPeerConnectionState }) {
      this.connectionState = "closed";
    })
  };

  class FakeRTCPeerConnection {
    constructor() {
      return peer as unknown as RTCPeerConnection;
    }
  }
  vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
  return peer;
}

async function waitForCall(mock: ReturnType<typeof vi.fn>): Promise<void> {
  for (let index = 0; index < 20 && mock.mock.calls.length === 0; index += 1) {
    await Promise.resolve();
  }
  expect(mock).toHaveBeenCalled();
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
