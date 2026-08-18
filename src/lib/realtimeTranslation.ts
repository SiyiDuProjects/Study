import type { RealtimeClientCallbacks } from "../types";
import {
  awaitAbortable,
  createAbortError,
  createRealtimeWebRtcTransport,
  isAbortError,
  type RealtimeWebRtcTransport
} from "./realtimeWebRtc";

const TRANSLATION_CALL_URL = "https://api.openai.com/v1/realtime/translations/calls";

export class RealtimeTranslationClient {
  private transport: RealtimeWebRtcTransport | null = null;
  private stream: MediaStream | null = null;
  private isStreaming = false;
  private hasConnectionError = false;
  private hasClosed = false;
  private stopPromise: Promise<void> | null = null;
  private sessionClosed = false;
  private closeRequested = false;
  private sessionStartedAt = 0;
  private lifecycleGeneration = 0;
  private startupAbortController: AbortController | null = null;
  private stopRequested = false;
  private hasOpened = false;

  constructor(
    private readonly getClientSecret: (signal?: AbortSignal) => Promise<string>,
    private readonly callbacks: RealtimeClientCallbacks
  ) {}

  async start(): Promise<void> {
    this.startupAbortController?.abort(createAbortError("A newer Realtime translation start replaced this one."));
    this.transport?.close();
    this.transport = null;
    this.stopLocalAudio();
    const generation = ++this.lifecycleGeneration;
    const startupAbortController = new AbortController();
    this.startupAbortController = startupAbortController;
    this.stopRequested = false;
    this.hasOpened = false;
    this.hasConnectionError = false;
    this.hasClosed = false;
    this.sessionClosed = false;
    this.closeRequested = false;
    this.stopPromise = null;
    let acquiredStream: MediaStream | null = null;
    try {
      const mediaPromise = navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      const stream = await awaitAbortable(mediaPromise, startupAbortController.signal, stopMediaStream);
      acquiredStream = stream;
      this.assertStartActive(generation, startupAbortController.signal);
      this.stream = stream;

      const clientSecret = await awaitAbortable(
        this.getClientSecret(startupAbortController.signal),
        startupAbortController.signal
      );
      this.assertStartActive(generation, startupAbortController.signal);

      const transportPromise = createRealtimeWebRtcTransport({
        callUrl: TRANSLATION_CALL_URL,
        clientSecret,
        stream,
        signal: startupAbortController.signal,
        onOpen: (transport) => {
          if (!this.isStartActive(generation, startupAbortController.signal)) {
            transport.close();
            return;
          }
          this.handleTransportOpen(transport);
        },
        onMessage: (data) => {
          if (this.lifecycleGeneration === generation) this.handleMessage(data);
        },
        onError: (message) => {
          if (this.lifecycleGeneration === generation) this.handleTransportError(message);
        },
        onClose: () => {
          if (this.lifecycleGeneration === generation) this.handleTransportClose();
        }
      });
      const transport = await awaitAbortable(
        transportPromise,
        startupAbortController.signal,
        (lateTransport) => lateTransport.close()
      );
      this.assertStartActive(generation, startupAbortController.signal);
      this.transport = transport;
      if (this.startupAbortController === startupAbortController) {
        this.startupAbortController = null;
      }
    } catch (error) {
      const cancelled = isAbortError(error) || !this.isStartActive(generation, startupAbortController.signal);
      if (this.startupAbortController === startupAbortController) {
        this.startupAbortController = null;
      }
      if (this.lifecycleGeneration === generation) {
        this.hasClosed = true;
        this.transport?.close();
        this.transport = null;
        this.stopLocalAudio();
      } else if (acquiredStream) {
        stopMediaStream(acquiredStream);
      }
      if (!cancelled) {
        this.hasConnectionError = true;
      }
      throw error;
    }
  }

  pause(): void {
    this.isStreaming = false;
    this.setAudioEnabled(false);
  }

  resume(): void {
    this.isStreaming = true;
    this.setAudioEnabled(true);
  }

  stopAndFlush(timeoutMs = 4_000): Promise<void> {
    this.stopRequested = true;
    if (this.stopPromise) {
      return this.stopPromise;
    }
    const cancelledStartup = this.cancelPendingStart();
    if (cancelledStartup && !this.hasOpened && !this.transport) {
      this.closeRequested = true;
      this.hasClosed = true;
      this.isStreaming = false;
      this.stopLocalAudio();
      this.stopPromise = Promise.resolve();
      return this.stopPromise;
    }
    this.stopPromise = this.flushAndClose(timeoutMs).catch((error: unknown) => {
      this.stopPromise = null;
      throw error;
    });
    return this.stopPromise;
  }

  stop(): void {
    void this.stopAndFlush().catch(() => undefined);
  }

  private handleTransportOpen(transport: RealtimeWebRtcTransport): void {
    if (this.stopRequested) {
      transport.close();
      return;
    }
    this.transport = transport;
    this.hasOpened = true;
    this.isStreaming = true;
    this.sessionStartedAt = performance.now();
    this.configureSession();
    this.callbacks.onOpen();
  }

  private configureSession(): void {
    this.sendRealtimeEvent({
      type: "session.update",
      session: {
        audio: {
          input: {
            transcription: {
              model: "gpt-realtime-whisper"
            },
            noise_reduction: {
              type: "far_field"
            }
          },
          output: {
            language: "zh"
          }
        }
      }
    });
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") {
      return;
    }

    let event: { type?: string; delta?: string; error?: { message?: string } };
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    if (event.type === "session.output_transcript.delta" && event.delta) {
      this.callbacks.onDelta({ channel: "translation", delta: event.delta, elapsedMs: this.currentElapsedMs() });
      return;
    }

    if (event.type === "session.input_transcript.delta" && event.delta) {
      this.callbacks.onDelta({ channel: "source", delta: event.delta, elapsedMs: this.currentElapsedMs() });
      return;
    }

    if (event.type === "session.closed") {
      this.sessionClosed = true;
      if (!this.closeRequested) {
        this.hasConnectionError = true;
        this.callbacks.onError("Realtime 翻译会话由服务器意外关闭，最后一段字幕可能没有保存。");
      }
      this.closeTransport();
      return;
    }

    if (event.type === "error") {
      this.hasConnectionError = true;
      this.callbacks.onError(event.error?.message ?? "Realtime 返回错误。");
      this.closeTransport();
    }
  }

  private handleTransportError(message: string): void {
    if (this.hasConnectionError || this.hasClosed) {
      return;
    }

    this.hasConnectionError = true;
    this.callbacks.onError(message);
    this.closeTransport();
  }

  private handleTransportClose(): void {
    if (this.hasClosed) {
      return;
    }

    this.hasClosed = true;
    this.isStreaming = false;
    this.transport = null;
    this.stopLocalAudio();

    if ((!this.closeRequested || !this.sessionClosed) && !this.hasConnectionError) {
      this.hasConnectionError = true;
      this.callbacks.onError("Realtime 翻译连接意外关闭，最后一段字幕可能没有保存。");
    } else if (!this.hasConnectionError) {
      this.callbacks.onClose();
    }
  }

  private sendRealtimeEvent(event: unknown): boolean {
    return this.transport?.sendEvent(event) ?? false;
  }

  private currentElapsedMs(): number {
    return this.sessionStartedAt > 0 ? Math.max(0, performance.now() - this.sessionStartedAt) : 0;
  }

  private closeTransport(): void {
    this.transport?.close();
    this.transport = null;
    this.handleTransportClose();
  }

  private setAudioEnabled(enabled: boolean): void {
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  private stopLocalAudio(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  private cancelPendingStart(): boolean {
    const startupAbortController = this.startupAbortController;
    if (!startupAbortController) {
      return false;
    }
    this.startupAbortController = null;
    startupAbortController.abort(createAbortError("Realtime translation start was cancelled."));
    return true;
  }

  private isStartActive(generation: number, signal: AbortSignal): boolean {
    return this.lifecycleGeneration === generation && !this.stopRequested && !signal.aborted;
  }

  private assertStartActive(generation: number, signal: AbortSignal): void {
    if (!this.isStartActive(generation, signal)) {
      throw createAbortError("Realtime translation start was cancelled.");
    }
  }

  private async flushAndClose(timeoutMs: number): Promise<void> {
    this.isStreaming = false;
    this.setAudioEnabled(false);
    if (this.hasClosed) {
      if (this.closeRequested && this.sessionClosed && !this.hasConnectionError) return;
      throw new Error("Realtime translation connection ended before session.closed confirmed the final transcript");
    }
    this.closeRequested = true;
    if (!this.sendRealtimeEvent({ type: "session.close" })) {
      this.hasConnectionError = true;
      this.closeTransport();
      throw new Error("Realtime translation connection closed before the final transcript could be flushed");
    }
    const closedCleanly = await waitUntil(() => this.sessionClosed, Math.max(250, timeoutMs));
    if (!closedCleanly) this.hasConnectionError = true;
    this.closeTransport();
    if (!closedCleanly) {
      throw new Error("Realtime translation final transcript timed out before session.closed");
    }
  }
}

function stopMediaStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  return predicate();
}
