import type { RealtimeClientCallbacks } from "../types";
import { floatToPcm16, pcm16ToBase64, resampleTo24k, SAMPLES_PER_FRAME } from "./audio";

const TRANSLATION_URL = "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate";

export class RealtimeTranslationClient {
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private pendingSamples: number[] = [];
  private isStreaming = false;

  constructor(
    private readonly getClientSecret: () => Promise<string>,
    private readonly callbacks: RealtimeClientCallbacks
  ) {}

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    const clientSecret = await this.getClientSecret();
    this.ws = new WebSocket(TRANSLATION_URL, ["realtime", `openai-insecure-api-key.${clientSecret}`]);
    this.ws.onopen = () => {
      this.configureSession();
      this.startAudioPump();
      this.callbacks.onOpen();
    };
    this.ws.onmessage = (message) => this.handleMessage(message.data);
    this.ws.onerror = () => this.callbacks.onError("Realtime 连接失败，请检查服务器配置、网络或模型权限。");
    this.ws.onclose = () => {
      this.stopLocalAudio();
      this.callbacks.onClose();
    };
  }

  pause(): void {
    this.isStreaming = false;
  }

  resume(): void {
    this.isStreaming = true;
  }

  stop(): void {
    this.isStreaming = false;

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "session.close" }));
      window.setTimeout(() => this.ws?.close(), 500);
    } else {
      this.ws?.close();
    }

    this.stopLocalAudio();
  }

  private configureSession(): void {
    this.ws?.send(
      JSON.stringify({
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
      })
    );
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
      if (!this.isStreaming || this.ws?.readyState !== WebSocket.OPEN || !this.audioContext) {
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
        this.ws.send(
          JSON.stringify({
            type: "session.input_audio_buffer.append",
            audio: pcm16ToBase64(frame)
          })
        );
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

    if (event.type === "session.output_transcript.delta" && event.delta) {
      this.callbacks.onDelta({ channel: "translation", delta: event.delta, elapsedMs: event.elapsed_ms });
      return;
    }

    if (event.type === "session.input_transcript.delta" && event.delta) {
      this.callbacks.onDelta({ channel: "source", delta: event.delta, elapsedMs: event.elapsed_ms });
      return;
    }

    if (event.type === "error") {
      this.callbacks.onError(event.error?.message ?? "Realtime 返回错误。");
    }
  }

  private stopLocalAudio(): void {
    this.processorNode?.disconnect();
    this.sourceNode?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.audioContext?.close().catch(() => undefined);

    this.processorNode = null;
    this.sourceNode = null;
    this.stream = null;
    this.audioContext = null;
    this.pendingSamples = [];
  }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
