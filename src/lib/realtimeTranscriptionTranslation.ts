import type { RealtimeClientCallbacks, TextTranslationModel } from "../types";
import { floatToPcm16, pcm16ToBase64, resampleTo24k, SAMPLES_PER_FRAME } from "./audio";
import { translateKoreanText } from "./api";

const TRANSCRIPTION_URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime-whisper";
const SPEECH_RMS_THRESHOLD = 0.006;
const MIN_COMMIT_MS = 800;
const SILENCE_COMMIT_MS = 900;
const MAX_COMMIT_MS = 3600;

interface TranscriptionCompletedEvent {
  type?: string;
  transcript?: string;
  elapsed_ms?: number;
  error?: { message?: string };
}

export class RealtimeTranscriptionTranslationClient {
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private pendingSamples: number[] = [];
  private isStreaming = false;
  private hasAudioToCommit = false;
  private bufferStartedAt = 0;
  private lastSpeechAt = 0;
  private sessionStartedAt = 0;
  private stopped = false;
  private translationQueue: Promise<void> = Promise.resolve();
  private recentSegments: Array<{ sourceText: string; translatedText: string }> = [];

  constructor(
    private readonly getClientSecret: () => Promise<string>,
    private readonly textModel: TextTranslationModel,
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
    this.ws = new WebSocket(TRANSCRIPTION_URL, ["realtime", `openai-insecure-api-key.${clientSecret}`]);
    this.ws.onopen = () => {
      this.configureSession();
      this.startAudioPump();
      this.callbacks.onOpen();
    };
    this.ws.onmessage = (message) => this.handleMessage(message.data);
    this.ws.onerror = () => this.callbacks.onError("Realtime 转录连接失败，请检查服务器配置、网络或模型权限。");
    this.ws.onclose = () => {
      this.stopLocalAudio();
      this.callbacks.onClose();
    };
  }

  pause(): void {
    this.commitInputBuffer();
    this.isStreaming = false;
  }

  resume(): void {
    this.isStreaming = true;
  }

  stop(): void {
    this.stopped = true;
    this.isStreaming = false;
    this.commitInputBuffer();

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
          type: "transcription",
          audio: {
            input: {
              format: {
                type: "audio/pcm",
                rate: 24000
              },
              transcription: {
                model: "gpt-realtime-whisper",
                language: "ko",
                delay: "low"
              },
              turn_detection: null
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
    this.sessionStartedAt = performance.now();
    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.isStreaming = true;

    this.processorNode.onaudioprocess = (event) => {
      if (!this.isStreaming || this.ws?.readyState !== WebSocket.OPEN || !this.audioContext) {
        return;
      }

      const input = event.inputBuffer.getChannelData(0);
      const resampled = resampleTo24k(input, this.audioContext.sampleRate);
      const rms = calculateRms(resampled);
      const now = Date.now();
      const shouldSendFrame = rms >= SPEECH_RMS_THRESHOLD || this.hasAudioToCommit;
      if (!shouldSendFrame) {
        return;
      }

      if (rms >= SPEECH_RMS_THRESHOLD) {
        this.lastSpeechAt = now;
        if (!this.hasAudioToCommit) {
          this.hasAudioToCommit = true;
          this.bufferStartedAt = now;
        }
      }

      const pcm = floatToPcm16(resampled);
      for (const sample of pcm) {
        this.pendingSamples.push(sample);
      }

      while (this.pendingSamples.length >= SAMPLES_PER_FRAME) {
        const frame = Int16Array.from(this.pendingSamples.splice(0, SAMPLES_PER_FRAME));
        this.ws?.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: pcm16ToBase64(frame)
          })
        );
      }

      this.maybeCommitInputBuffer(now);
    };

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.audioContext.destination);
  }

  private maybeCommitInputBuffer(now: number): void {
    if (!this.hasAudioToCommit) {
      return;
    }

    const bufferAge = now - this.bufferStartedAt;
    const silenceAge = now - this.lastSpeechAt;
    if (bufferAge >= MAX_COMMIT_MS || (bufferAge >= MIN_COMMIT_MS && silenceAge >= SILENCE_COMMIT_MS)) {
      this.commitInputBuffer();
    }
  }

  private commitInputBuffer(): void {
    if (!this.hasAudioToCommit || this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    this.hasAudioToCommit = false;
    this.bufferStartedAt = 0;
    this.lastSpeechAt = 0;
    this.pendingSamples = [];
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") {
      return;
    }

    let event: TranscriptionCompletedEvent;
    try {
      event = JSON.parse(raw) as TranscriptionCompletedEvent;
    } catch {
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript?.trim()) {
      this.enqueueTranslation(event.transcript, event.elapsed_ms);
      return;
    }

    if (event.type === "error") {
      this.callbacks.onError(event.error?.message ?? "Realtime 转录返回错误。");
    }
  }

  private enqueueTranslation(sourceText: string, elapsedMs?: number): void {
    const normalizedSource = sourceText.trim();
    if (!normalizedSource) {
      return;
    }

    const segmentStartMs = elapsedMs ?? Math.max(0, performance.now() - this.sessionStartedAt);
    this.translationQueue = this.translationQueue
      .then(async () => {
        const translatedText = await translateKoreanText({
          model: this.textModel,
          text: normalizedSource,
          context: this.recentSegments
        });

        if (this.stopped) {
          return;
        }

        const normalizedTranslation = translatedText.trim();
        this.callbacks.onSegment?.({
          sourceText: normalizedSource,
          translatedText: normalizedTranslation,
          elapsedMs: segmentStartMs
        });
        this.recentSegments = [...this.recentSegments, { sourceText: normalizedSource, translatedText: normalizedTranslation }].slice(-4);
      })
      .catch((error: unknown) => {
        this.callbacks.onError(error instanceof Error ? error.message : "文本翻译失败。");
      });
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

function calculateRms(input: Float32Array): number {
  if (input.length === 0) {
    return 0;
  }

  let sum = 0;
  for (const sample of input) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / input.length);
}
