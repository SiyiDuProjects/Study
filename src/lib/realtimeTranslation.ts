import type { RealtimeClientCallbacks } from "../types";
import { createRealtimeWebRtcTransport, type RealtimeWebRtcTransport } from "./realtimeWebRtc";

const TRANSLATION_CALL_URL = "https://api.openai.com/v1/realtime/translations/calls";

export class RealtimeTranslationClient {
  private transport: RealtimeWebRtcTransport | null = null;
  private stream: MediaStream | null = null;
  private isStreaming = false;
  private hasConnectionError = false;
  private hasClosed = false;

  constructor(
    private readonly getClientSecret: () => Promise<string>,
    private readonly callbacks: RealtimeClientCallbacks
  ) {}

  async start(): Promise<void> {
    this.hasConnectionError = false;
    this.hasClosed = false;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    try {
      const clientSecret = await this.getClientSecret();
      this.transport = await createRealtimeWebRtcTransport({
        callUrl: TRANSLATION_CALL_URL,
        clientSecret,
        stream: this.stream,
        onOpen: (transport) => this.handleTransportOpen(transport),
        onMessage: (data) => this.handleMessage(data),
        onError: (message) => this.handleTransportError(message),
        onClose: () => this.handleTransportClose()
      });
    } catch (error) {
      this.hasConnectionError = true;
      this.hasClosed = true;
      this.transport = null;
      this.stopLocalAudio();
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

  stop(): void {
    this.isStreaming = false;
    this.setAudioEnabled(false);
    this.sendRealtimeEvent({ type: "session.close" });
    window.setTimeout(() => this.closeTransport(), 500);
  }

  private handleTransportOpen(transport: RealtimeWebRtcTransport): void {
    this.transport = transport;
    this.isStreaming = true;
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

    let event: { type?: string; delta?: string; elapsed_ms?: number; error?: { message?: string } };
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    if (event.type === "session.output_transcript.delta" && event.delta) {
      this.callbacks.onDelta({ channel: "translation", delta: event.delta, elapsedMs: event.elapsed_ms });
      return;
    }

    if (event.type === "session.input_transcript.delta" && event.delta) {
      this.callbacks.onDelta({ channel: "source", delta: event.delta, elapsedMs: event.elapsed_ms });
      return;
    }

    if (event.type === "error") {
      this.hasConnectionError = true;
      this.callbacks.onError(event.error?.message ?? "Realtime 返回错误。");
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

    if (!this.hasConnectionError) {
      this.callbacks.onClose();
    }
  }

  private sendRealtimeEvent(event: unknown): boolean {
    return this.transport?.sendEvent(event) ?? false;
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
}
