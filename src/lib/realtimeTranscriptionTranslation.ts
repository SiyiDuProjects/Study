import type { RealtimeClientCallbacks, TextTranslationModel } from "../types";
import { translateKoreanText } from "./api";
import { createRealtimeWebRtcTransport, type RealtimeWebRtcTransport } from "./realtimeWebRtc";

const TRANSCRIPTION_CALL_URL = "https://api.openai.com/v1/realtime/calls";
const SPEECH_RMS_THRESHOLD = 0.003;
const DIAGNOSTIC_LEVEL_INTERVAL_MS = 500;
const MIN_COMMIT_MS = 800;
const SILENCE_COMMIT_MS = 900;
const MAX_COMMIT_MS = 3600;
const STOP_FLUSH_TIMEOUT_MS = 6000;
const STOP_FLUSH_QUIET_MS = 1000;

interface TranscriptionCompletedEvent {
  type?: string;
  transcript?: string;
  elapsed_ms?: number;
  error?: { message?: string };
}

export class RealtimeTranscriptionTranslationClient {
  private transport: RealtimeWebRtcTransport | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private audioMonitorInterval: number | null = null;
  private audioSamples: Float32Array<ArrayBuffer> | null = null;
  private isStreaming = false;
  private hasAudioToCommit = false;
  private bufferStartedAt = 0;
  private lastSpeechAt = 0;
  private sessionStartedAt = 0;
  private lastDiagnosticAt = 0;
  private stopped = false;
  private hasConnectionError = false;
  private hasClosed = false;
  private stopPromise: Promise<void> | null = null;
  private translationQueue: Promise<void> = Promise.resolve();
  private pendingTranslationCount = 0;
  private lastInputCommitAt = 0;
  private lastTranscriptionAt = 0;
  private lastTranslationSettledAt = 0;
  private recentSegments: Array<{ sourceText: string; translatedText: string }> = [];

  constructor(
    private readonly getClientSecret: () => Promise<string>,
    private readonly textModel: TextTranslationModel,
    private readonly callbacks: RealtimeClientCallbacks
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
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
      this.transport = await createRealtimeWebRtcTransport({
        callUrl: TRANSCRIPTION_CALL_URL,
        clientSecret,
        stream: this.stream,
        onOpen: (transport) => this.handleTransportOpen(transport),
        onMessage: (data) => this.handleMessage(data),
        onError: (message) => this.handleTransportError(message),
        onClose: () => this.handleTransportClose(),
        onDiagnostic: (event) => this.callbacks.onDiagnostic?.(event)
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
    this.commitInputBuffer();
    this.isStreaming = false;
    this.setAudioEnabled(false);
  }

  resume(): void {
    this.isStreaming = true;
    this.setAudioEnabled(true);
  }

  stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopPromise = this.flushAndClose();
    }

    return this.stopPromise;
  }

  private async flushAndClose(): Promise<void> {
    this.isStreaming = false;
    const committed = this.commitInputBuffer();
    this.setAudioEnabled(false);
    await this.waitForPendingWork(committed);
    this.stopped = true;
    this.sendRealtimeEvent({ type: "session.close" });
    this.closeTransport();
  }

  private handleTransportOpen(transport: RealtimeWebRtcTransport): void {
    this.transport = transport;
    this.configureSession();
    this.startSpeechMonitor();
    this.callbacks.onOpen();
  }

  private configureSession(): void {
    this.sendRealtimeEvent({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            transcription: {
              language: "ko",
              delay: "low"
            },
            turn_detection: null
          }
        }
      }
    });
  }

  private startSpeechMonitor(): void {
    if (!this.stream) {
      return;
    }

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContextCtor();
    this.audioContext.resume().catch(() => undefined);
    this.sessionStartedAt = performance.now();
    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 2048;
    this.audioSamples = new Float32Array(this.analyserNode.fftSize);
    this.sourceNode.connect(this.analyserNode);
    this.isStreaming = true;

    this.audioMonitorInterval = window.setInterval(() => {
      if (!this.isStreaming || !this.analyserNode || !this.audioSamples) {
        return;
      }

      this.analyserNode.getFloatTimeDomainData(this.audioSamples);
      const rms = calculateRms(this.audioSamples);
      const now = Date.now();
      if (now - this.lastDiagnosticAt >= DIAGNOSTIC_LEVEL_INTERVAL_MS) {
        this.lastDiagnosticAt = now;
        this.callbacks.onDiagnostic?.({
          kind: "microphone",
          level: rms,
          at: now
        });
      }

      if (rms >= SPEECH_RMS_THRESHOLD) {
        this.lastSpeechAt = now;
        if (!this.hasAudioToCommit) {
          this.hasAudioToCommit = true;
          this.bufferStartedAt = now;
        }
      }

      this.maybeCommitInputBuffer(now);
    }, 120);
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

  private commitInputBuffer(): boolean {
    if (!this.hasAudioToCommit || !this.sendRealtimeEvent({ type: "input_audio_buffer.commit" })) {
      return false;
    }

    this.hasAudioToCommit = false;
    this.bufferStartedAt = 0;
    this.lastSpeechAt = 0;
    this.lastInputCommitAt = Date.now();
    return true;
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
    if (event.type) {
      this.callbacks.onDiagnostic?.({
        kind: "event",
        eventType: event.type,
        at: Date.now()
      });
    }

    if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript?.trim()) {
      this.lastTranscriptionAt = Date.now();
      this.enqueueTranslation(event.transcript, event.elapsed_ms);
      return;
    }

    if (event.type === "error") {
      this.hasConnectionError = true;
      this.callbacks.onError(event.error?.message ?? "Realtime 转录返回错误。");
    }
  }

  private enqueueTranslation(sourceText: string, elapsedMs?: number): void {
    const normalizedSource = sourceText.trim();
    if (!normalizedSource) {
      return;
    }

    const segmentStartMs = elapsedMs ?? Math.max(0, performance.now() - this.sessionStartedAt);
    this.pendingTranslationCount += 1;
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
      })
      .finally(() => {
        this.pendingTranslationCount = Math.max(0, this.pendingTranslationCount - 1);
        this.lastTranslationSettledAt = Date.now();
      });
  }

  private async waitForPendingWork(committedInput: boolean): Promise<void> {
    const startedAt = Date.now();
    const firstQuietReference = committedInput ? this.lastInputCommitAt : Date.now();
    while (Date.now() - startedAt < STOP_FLUSH_TIMEOUT_MS) {
      const quietReference = Math.max(
        firstQuietReference,
        this.lastInputCommitAt,
        this.lastTranscriptionAt,
        this.lastTranslationSettledAt
      );
      if (this.pendingTranslationCount === 0 && Date.now() - quietReference >= STOP_FLUSH_QUIET_MS) {
        return;
      }

      await delay(100);
    }

    this.callbacks.onDiagnostic?.({
      kind: "warning",
      message: "结束前仍有转录或翻译未确认，已按超时保存。",
      at: Date.now()
    });
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
    if (this.audioMonitorInterval) {
      window.clearInterval(this.audioMonitorInterval);
      this.audioMonitorInterval = null;
    }

    this.analyserNode?.disconnect();
    this.sourceNode?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.audioContext?.close().catch(() => undefined);

    this.analyserNode = null;
    this.sourceNode = null;
    this.stream = null;
    this.audioContext = null;
    this.audioSamples = null;
    this.hasAudioToCommit = false;
  }
}

function calculateRms(input: ArrayLike<number>): number {
  if (input.length === 0) {
    return 0;
  }

  let sum = 0;
  for (let index = 0; index < input.length; index += 1) {
    const sample = input[index];
    sum += sample * sample;
  }
  return Math.sqrt(sum / input.length);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
