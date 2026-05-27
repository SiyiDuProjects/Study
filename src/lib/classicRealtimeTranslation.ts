import type { RealtimeClientCallbacks } from "../types";
import { floatToPcm16, pcm16ToBase64, resampleTo24k, SAMPLES_PER_FRAME } from "./audio";
import { startMicrophoneLevelMonitor, type MicrophoneLevelMonitor } from "./microphoneLevel";

const TRANSLATION_WEBSOCKET_URL = "wss://api.openai.com/v1/realtime/translations";
const STOP_CLOSE_GRACE_MS = 500;

export class ClassicRealtimeTranslationClient {
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private microphoneLevelMonitor: MicrophoneLevelMonitor | null = null;
  private pendingSamples: number[] = [];
  private isStreaming = false;
  private hasConnectionError = false;
  private hasClosed = false;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly getClientSecret: () => Promise<string>,
    private readonly realtimeTranslationModel: string,
    private readonly realtimeTranscriptionModel: string,
    private readonly callbacks: RealtimeClientCallbacks
  ) {}

  async start(): Promise<void> {
    this.hasConnectionError = false;
    this.hasClosed = false;
    this.stopPromise = null;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true
      }
    });

    try {
      const clientSecret = await this.getClientSecret();
      const url = new URL(TRANSLATION_WEBSOCKET_URL);
      url.searchParams.set("model", this.realtimeTranslationModel);
      this.socket = new WebSocket(url.toString(), ["realtime", `openai-insecure-api-key.${clientSecret}`]);
      this.socket.onopen = () => this.handleSocketOpen();
      this.socket.onmessage = (message) => this.handleMessage(message.data);
      this.socket.onerror = () => this.handleSocketError();
      this.socket.onclose = () => this.handleSocketClose();
    } catch (error) {
      this.hasConnectionError = true;
      this.stopLocalAudio();
      throw error;
    }
  }

  pause(): void {
    this.isStreaming = false;
  }

  resume(): void {
    this.isStreaming = true;
  }

  stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopPromise = this.flushAndClose();
    }

    return this.stopPromise;
  }

  private async flushAndClose(): Promise<void> {
    this.isStreaming = false;
    this.sendRealtimeEvent({ type: "session.close" });
    await delay(STOP_CLOSE_GRACE_MS);
    this.closeSocket();
  }

  private handleSocketOpen(): void {
    this.emitConnection("open");
    this.configureSession();
    this.startAudioPump();
    if (this.stream) {
      this.microphoneLevelMonitor = startMicrophoneLevelMonitor(this.stream, this.callbacks.onDiagnostic);
    }
    this.callbacks.onOpen();
  }

  private configureSession(): void {
    this.sendRealtimeEvent({
      type: "session.update",
      session: {
        audio: {
          input: {
            transcription: {
              model: this.realtimeTranscriptionModel
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

  private startAudioPump(): void {
    if (!this.stream) {
      return;
    }

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContextCtor();
    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.isStreaming = true;

    this.processorNode.onaudioprocess = (event) => {
      if (!this.isStreaming || this.socket?.readyState !== WebSocket.OPEN || !this.audioContext) {
        return;
      }

      const input = event.inputBuffer.getChannelData(0);
      const resampled = resampleTo24k(input, this.audioContext.sampleRate);
      const pcm = floatToPcm16(resampled);
      for (const sample of pcm) {
        this.pendingSamples.push(sample);
      }

      while (this.pendingSamples.length >= SAMPLES_PER_FRAME) {
        const frame = Int16Array.from(this.pendingSamples.splice(0, SAMPLES_PER_FRAME));
        this.sendRealtimeEvent({
          type: "session.input_audio_buffer.append",
          audio: pcm16ToBase64(frame)
        });
      }
    };

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.audioContext.destination);
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
    if (event.type) {
      this.callbacks.onDiagnostic?.({
        kind: "event",
        eventType: event.type,
        at: Date.now()
      });
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
      this.callbacks.onError(event.error?.message ?? "经典低延迟模式返回错误。");
    }
  }

  private handleSocketError(): void {
    if (this.hasConnectionError || this.hasClosed) {
      return;
    }

    this.hasConnectionError = true;
    this.emitConnection("error");
    this.callbacks.onError("经典低延迟连接失败，请检查网络、服务器配置或模型权限。");
  }

  private handleSocketClose(): void {
    if (this.hasClosed) {
      return;
    }

    this.hasClosed = true;
    this.isStreaming = false;
    this.emitConnection("closed");
    this.stopLocalAudio();

    if (!this.hasConnectionError) {
      this.callbacks.onClose();
    }
  }

  private sendRealtimeEvent(event: unknown): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }

    this.socket.send(JSON.stringify(event));
    return true;
  }

  private closeSocket(): void {
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
    this.socket = null;
    this.handleSocketClose();
  }

  private stopLocalAudio(): void {
    this.microphoneLevelMonitor?.stop();
    this.microphoneLevelMonitor = null;
    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      this.processorNode.disconnect();
    }
    this.sourceNode?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.audioContext?.close().catch(() => undefined);

    this.processorNode = null;
    this.sourceNode = null;
    this.stream = null;
    this.audioContext = null;
    this.pendingSamples = [];
  }

  private emitConnection(state: string): void {
    this.callbacks.onDiagnostic?.({
      kind: "connection",
      connection: "webSocket",
      state,
      at: Date.now()
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
