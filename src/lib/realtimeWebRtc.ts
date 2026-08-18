export interface RealtimeWebRtcTransport {
  peerConnection: RTCPeerConnection;
  dataChannel: RTCDataChannel;
  sendEvent: (event: unknown) => boolean;
  close: () => void;
}

interface RealtimeWebRtcOptions {
  callUrl: string;
  clientSecret: string;
  stream: MediaStream;
  onOpen: (transport: RealtimeWebRtcTransport) => void;
  onMessage: (data: unknown) => void;
  onError: (message: string) => void;
  onClose: () => void;
  signal?: AbortSignal;
  sdpTimeoutMs?: number;
  dataChannelOpenTimeoutMs?: number;
}

const DEFAULT_SDP_TIMEOUT_MS = 15_000;
const DEFAULT_DATA_CHANNEL_OPEN_TIMEOUT_MS = 10_000;

export async function createRealtimeWebRtcTransport({
  callUrl,
  clientSecret,
  stream,
  onOpen,
  onMessage,
  onError,
  onClose,
  signal,
  sdpTimeoutMs = DEFAULT_SDP_TIMEOUT_MS,
  dataChannelOpenTimeoutMs = DEFAULT_DATA_CHANNEL_OPEN_TIMEOUT_MS
}: RealtimeWebRtcOptions): Promise<RealtimeWebRtcTransport> {
  throwIfAborted(signal);

  const peerConnection = new RTCPeerConnection();
  const dataChannel = peerConnection.createDataChannel("oai-events");
  const setupController = new AbortController();
  const unlinkExternalAbort = forwardAbort(signal, setupController);
  let closed = false;
  let channelOpened = dataChannel.readyState === "open";
  let openNotified = false;
  let setupFailure: Error | null = null;
  let resolveChannelOpen: (() => void) | null = null;
  let rejectChannelOpen: ((error: Error) => void) | null = null;

  const channelOpenPromise = new Promise<void>((resolve, reject) => {
    resolveChannelOpen = resolve;
    rejectChannelOpen = reject;
  });
  // A connection failure can arrive while offer/answer negotiation is still
  // awaiting another promise. Keep the deferred rejection handled until the
  // setup path reaches the explicit readiness wait below.
  void channelOpenPromise.catch(() => undefined);

  const sendEvent = (event: unknown) => {
    if (closed || dataChannel.readyState !== "open") {
      return false;
    }

    dataChannel.send(JSON.stringify(event));
    return true;
  };

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    dataChannel.onopen = null;
    dataChannel.onmessage = null;
    dataChannel.onerror = null;
    dataChannel.onclose = null;
    peerConnection.onconnectionstatechange = null;
    if (dataChannel.readyState !== "closed") {
      dataChannel.close();
    }
    if (peerConnection.connectionState !== "closed") {
      peerConnection.close();
    }
  };

  const transport: RealtimeWebRtcTransport = {
    peerConnection,
    dataChannel,
    sendEvent,
    close
  };

  const failBeforeOpen = (message: string) => {
    const error = new Error(message);
    if (!openNotified) {
      setupFailure ??= error;
      rejectChannelOpen?.(error);
      setupController.abort(error);
      return;
    }
    if (!closed && openNotified) {
      onError(message);
    }
  };

  dataChannel.onopen = () => {
    if (closed || setupController.signal.aborted) {
      close();
      return;
    }
    channelOpened = true;
    resolveChannelOpen?.();
  };
  dataChannel.onmessage = (message) => {
    if (!closed && openNotified) {
      onMessage(message.data);
    }
  };
  dataChannel.onerror = () => failBeforeOpen("Realtime WebRTC data channel failed. Check the network connection.");
  dataChannel.onclose = () => {
    if (closed) {
      return;
    }
    if (!channelOpened || !openNotified) {
      failBeforeOpen("Realtime WebRTC data channel closed before it became ready.");
      return;
    }
    close();
    onClose();
  };

  peerConnection.onconnectionstatechange = () => {
    if (closed) {
      return;
    }
    if (peerConnection.connectionState === "failed") {
      failBeforeOpen("Realtime WebRTC connection failed. Check the network connection.");
      return;
    }

    if (peerConnection.connectionState === "closed") {
      if (!channelOpened || !openNotified) {
        failBeforeOpen("Realtime WebRTC connection closed before it became ready.");
      } else {
        close();
        onClose();
      }
    }
  };

  for (const track of stream.getAudioTracks()) {
    peerConnection.addTrack(track, stream);
  }

  let sdpTimedOut = false;
  const sdpTimeout = globalThis.setTimeout(() => {
    sdpTimedOut = true;
    setupController.abort(createAbortError("Realtime WebRTC SDP negotiation timed out."));
  }, Math.max(1, sdpTimeoutMs));

  try {
    const offer = await awaitAbortable(peerConnection.createOffer(), setupController.signal);
    throwIfAborted(setupController.signal);
    await awaitAbortable(peerConnection.setLocalDescription(offer), setupController.signal);
    throwIfAborted(setupController.signal);

    if (!peerConnection.localDescription?.sdp) {
      throw new Error("The browser did not create a Realtime WebRTC offer.");
    }

    const response = await awaitAbortable(fetch(callUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        "Content-Type": "application/sdp"
      },
      body: peerConnection.localDescription.sdp,
      redirect: "error",
      signal: setupController.signal
    }), setupController.signal, (lateResponse) => {
      void lateResponse.body?.cancel().catch(() => undefined);
    });
    throwIfAborted(setupController.signal);

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throwIfAborted(setupController.signal);
      throw new Error(`Realtime WebRTC connection failed with status ${response.status}`);
    }

    const answerSdp = await readTextWithLimit(response, 1_000_000, setupController.signal);
    throwIfAborted(setupController.signal);
    await awaitAbortable(
      peerConnection.setRemoteDescription({ type: "answer", sdp: answerSdp }),
      setupController.signal
    );
    throwIfAborted(setupController.signal);
    globalThis.clearTimeout(sdpTimeout);

    await waitForDataChannelOpen(channelOpenPromise, setupController.signal, dataChannelOpenTimeoutMs);
    throwIfAborted(setupController.signal);
    if (setupFailure) {
      throw setupFailure;
    }
    if (closed) {
      throw createAbortError("Realtime WebRTC transport was closed before it became ready.");
    }

    openNotified = true;
    onOpen(transport);
    throwIfAborted(setupController.signal);
    if (closed) {
      throw createAbortError("Realtime WebRTC transport was closed while opening.");
    }
    return transport;
  } catch (error) {
    close();
    if (sdpTimedOut) {
      throw new Error("Realtime WebRTC SDP negotiation timed out.");
    }
    throw error;
  } finally {
    globalThis.clearTimeout(sdpTimeout);
    unlinkExternalAbort();
  }
}

export function createAbortError(message = "The operation was cancelled."): DOMException {
  return new DOMException(message, "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function awaitAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onLateResolve?: (value: T) => void
): Promise<T> {
  if (signal.aborted) {
    void promise.then((value) => onLateResolve?.(value)).catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", handleAbort);
    const handleAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(abortReason(signal));
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    void promise.then(
      (value) => {
        if (settled) {
          try {
            onLateResolve?.(value);
          } catch {
            // Cancellation cleanup must not create an unhandled rejection.
          }
          return;
        }
        settled = true;
        cleanup();
        if (signal.aborted) {
          onLateResolve?.(value);
          reject(abortReason(signal));
          return;
        }
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

function forwardAbort(source: AbortSignal | undefined, destination: AbortController): () => void {
  if (!source) {
    return () => undefined;
  }
  const abort = () => destination.abort(abortReason(source));
  if (source.aborted) {
    abort();
    return () => undefined;
  }
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? createAbortError();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

async function waitForDataChannelOpen(
  channelOpenPromise: Promise<void>,
  signal: AbortSignal,
  timeoutMs: number
): Promise<void> {
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    await Promise.race([
      awaitAbortable(channelOpenPromise, signal),
      new Promise<never>((_resolve, reject) => {
        timeout = globalThis.setTimeout(
          () => reject(new Error("Realtime WebRTC data channel did not open before the timeout.")),
          Math.max(1, timeoutMs)
        );
      })
    ]);
    throwIfAborted(signal);
  } finally {
    if (timeout !== undefined) {
      globalThis.clearTimeout(timeout);
    }
  }
}

async function readTextWithLimit(response: Response, maximumBytes: number, signal: AbortSignal): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throwIfAborted(signal);
    throw new Error("Realtime WebRTC answer exceeded the allowed size");
  }
  if (!response.body) {
    throw new Error("Realtime WebRTC answer did not include SDP");
  }
  const reader = response.body.getReader();
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  const decoder = new TextDecoder();
  let result = "";
  let total = 0;
  try {
    while (true) {
      const { done, value } = await awaitAbortable(reader.read(), signal);
      throwIfAborted(signal);
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throwIfAborted(signal);
        throw new Error("Realtime WebRTC answer exceeded the allowed size");
      }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    signal.removeEventListener("abort", cancelReader);
  }
}
