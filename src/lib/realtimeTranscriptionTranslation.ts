import type { RealtimeClientCallbacks, TextTranslationModel } from "../types";
import { translateKoreanText } from "./api";
import { createMicrophoneInput, type MicrophoneInput } from "./microphoneInput";
import { createRealtimeWebRtcTransport, type RealtimeWebRtcTransport } from "./realtimeWebRtc";

const TRANSCRIPTION_CALL_URL = "https://api.openai.com/v1/realtime/calls";
const DIAGNOSTIC_LEVEL_INTERVAL_MS = 500;
const STOP_FLUSH_TIMEOUT_MS = 6000;
const STOP_FLUSH_QUIET_MS = 1000;
const SENTENCE_TIME_OFFSET_MS = 40;
const TRANSIENT_PARTIAL_GLYPH_PATTERN = /[\u25a1\ufffc\ufffd]/g;

interface TranscriptionCompletedEvent {
  type?: string;
  delta?: string;
  transcript?: string;
  item_id?: string;
  elapsed_ms?: number;
  error?: { message?: string };
}

export class RealtimeTranscriptionTranslationClient {
  private transport: RealtimeWebRtcTransport | null = null;
  private microphoneInput: MicrophoneInput | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private audioMonitorInterval: number | null = null;
  private audioSamples: Float32Array<ArrayBuffer> | null = null;
  private isStreaming = false;
  private sessionStartedAt = 0;
  private lastDiagnosticAt = 0;
  private stopped = false;
  private hasConnectionError = false;
  private hasClosed = false;
  private stopPromise: Promise<void> | null = null;
  private translationQueue: Promise<void> = Promise.resolve();
  private pendingTranslationCount = 0;
  private lastTranscriptionAt = 0;
  private lastTranslationSettledAt = 0;
  private recentSegments: Array<{ sourceText: string; translatedText: string }> = [];
  private activeSourceDeltaByItemId = new Map<string, string>();

  constructor(
    private readonly getClientSecret: () => Promise<string>,
    private readonly textModel: TextTranslationModel,
    private readonly callbacks: RealtimeClientCallbacks,
    private readonly audioBoostEnabled = true
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.hasConnectionError = false;
    this.hasClosed = false;
    this.stopPromise = null;
    this.microphoneInput = await createMicrophoneInput(this.audioBoostEnabled);
    this.stream = this.microphoneInput.stream;
    this.emitAudioBoostFallbackWarning();

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
    this.setAudioEnabled(false);
    await this.waitForPendingWork();
    this.stopped = true;
    this.sendRealtimeEvent({ type: "session.close" });
    this.closeTransport();
  }

  private handleTransportOpen(transport: RealtimeWebRtcTransport): void {
    this.transport = transport;
    this.startSpeechMonitor();
    this.callbacks.onOpen();
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
    }, 120);
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

    if (event.type === "conversation.item.input_audio_transcription.delta" && event.delta) {
      const cleanDelta = sanitizeRealtimePartialDelta(event.delta);
      if (!cleanDelta) {
        return;
      }

      const itemId = transcriptionItemId(event);
      this.activeSourceDeltaByItemId.set(itemId, `${this.activeSourceDeltaByItemId.get(itemId) ?? ""}${cleanDelta}`);
      this.callbacks.onDelta({
        channel: "source",
        delta: cleanDelta,
        elapsedMs: event.elapsed_ms ?? Math.max(0, performance.now() - this.sessionStartedAt)
      });
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const itemId = transcriptionItemId(event);
      const streamedSourceText = this.activeSourceDeltaByItemId.get(itemId) ?? "";
      this.activeSourceDeltaByItemId.delete(itemId);
      if (!event.transcript?.trim()) {
        return;
      }
      this.lastTranscriptionAt = Date.now();
      this.handleCompletedTranscription(event.transcript, streamedSourceText, event.elapsed_ms);
      return;
    }

    if (event.type === "error") {
      this.hasConnectionError = true;
      this.callbacks.onError(event.error?.message ?? "Realtime 转录返回错误。");
    }
  }

  private handleCompletedTranscription(sourceText: string, streamedSourceText: string, elapsedMs?: number): void {
    const normalizedSource = sourceText.trim();
    if (!normalizedSource) {
      return;
    }

    const replaceActiveSourceText = sanitizeRealtimePartialDelta(streamedSourceText).trim();
    const sourceSegments = splitTranslationUnits(normalizedSource);
    sourceSegments.forEach((sourceSegment, index) => {
      const segmentElapsedMs = sentenceElapsedMs(elapsedMs, index);
      this.callbacks.onSegment?.({
        sourceText: sourceSegment,
        translatedText: "",
        elapsedMs: segmentElapsedMs,
        replaceActive: index === 0 && Boolean(replaceActiveSourceText),
        replaceActiveSourceText: index === 0 ? replaceActiveSourceText : "",
        translationStatus: "queued"
      });
      this.enqueueTranslation(sourceSegment, segmentElapsedMs);
    });
  }

  private enqueueTranslation(sourceText: string, elapsedMs?: number): void {
    const normalizedSource = sourceText.trim();
    if (!normalizedSource) {
      return;
    }

    this.pendingTranslationCount += 1;
    this.translationQueue = this.translationQueue
      .then(async () => {
        this.callbacks.onSegment?.({
          sourceText: normalizedSource,
          translatedText: "",
          elapsedMs,
          translationStatus: "translating"
        });

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
          elapsedMs,
          translationStatus: "translated"
        });
        this.recentSegments = [...this.recentSegments, { sourceText: normalizedSource, translatedText: normalizedTranslation }].slice(-4);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "文本翻译失败。";
        this.callbacks.onSegment?.({
          sourceText: normalizedSource,
          translatedText: "",
          elapsedMs,
          translationStatus: "failed",
          translationError: message
        });
        this.callbacks.onError(message);
      })
      .finally(() => {
        this.pendingTranslationCount = Math.max(0, this.pendingTranslationCount - 1);
        this.lastTranslationSettledAt = Date.now();
      });
  }

  private async waitForPendingWork(): Promise<void> {
    const startedAt = Date.now();
    const firstQuietReference = Date.now();
    while (Date.now() - startedAt < STOP_FLUSH_TIMEOUT_MS) {
      const quietReference = Math.max(firstQuietReference, this.lastTranscriptionAt, this.lastTranslationSettledAt);
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
    this.microphoneInput?.stop();
    this.audioContext?.close().catch(() => undefined);

    this.analyserNode = null;
    this.sourceNode = null;
    this.stream = null;
    this.microphoneInput = null;
    this.audioContext = null;
    this.audioSamples = null;
  }

  private emitAudioBoostFallbackWarning(): void {
    if (this.audioBoostEnabled && this.microphoneInput && !this.microphoneInput.boostApplied) {
      this.callbacks.onDiagnostic?.({
        kind: "warning",
        message: "远距离收音增强不可用，已使用原始麦克风。",
        at: Date.now()
      });
    }
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

function sanitizeRealtimePartialDelta(delta: string): string {
  return delta.replace(TRANSIENT_PARTIAL_GLYPH_PATTERN, "");
}

function splitTranslationUnits(text: string): string[] {
  const units: string[] = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (!isSentenceTerminator(text, index)) {
      continue;
    }

    const unit = text.slice(start, index + 1).trim();
    if (unit) {
      units.push(unit);
    }
    start = index + 1;
    while (start < text.length && /\s/u.test(text[start])) {
      start += 1;
    }
    index = start - 1;
  }

  const remainder = text.slice(start).trim();
  if (remainder) {
    units.push(remainder);
  }

  return units.length > 0 ? units : [text.trim()].filter(Boolean);
}

function isSentenceTerminator(text: string, index: number): boolean {
  const char = text[index];
  if (char === "。" || char === "！" || char === "？" || char === "!" || char === "?") {
    return true;
  }

  if (char !== ".") {
    return false;
  }

  return !isDigit(text[index - 1]) || !isDigit(text[index + 1]);
}

function isDigit(char: string | undefined): boolean {
  return Boolean(char && /[0-9]/.test(char));
}

function sentenceElapsedMs(elapsedMs: number | undefined, sentenceIndex: number): number | undefined {
  return elapsedMs === undefined ? undefined : elapsedMs + sentenceIndex * SENTENCE_TIME_OFFSET_MS;
}

function transcriptionItemId(event: TranscriptionCompletedEvent): string {
  return event.item_id || "default";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
