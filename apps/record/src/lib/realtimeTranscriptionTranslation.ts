import type { RealtimeClientCallbacks, TextTranslationModel } from "../types";
import { translateKoreanText } from "./api";
import {
  awaitAbortable,
  createAbortError,
  createRealtimeWebRtcTransport,
  isAbortError,
  type RealtimeWebRtcTransport
} from "./realtimeWebRtc";

const TRANSCRIPTION_CALL_URL = "https://api.openai.com/v1/realtime/calls";
const SPEECH_RMS_THRESHOLD = 0.006;
const MIN_COMMIT_MS = 800;
const SILENCE_COMMIT_MS = 900;
const MAX_COMMIT_MS = 3600;

interface TranscriptionCompletedEvent {
  type?: string;
  transcript?: string;
  item_id?: string;
  error?: { message?: string };
}

interface PendingAudioCommit {
  sequence: number;
  startedAtMs: number;
  itemId?: string;
  state: "pending" | "completed" | "failed" | "processed";
  transcript: string;
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
  private bufferStartedElapsedMs = 0;
  private lastSpeechAt = 0;
  private sessionStartedAt = 0;
  private hasConnectionError = false;
  private hasClosed = false;
  private closeRequested = false;
  private translationQueue: Promise<void> = Promise.resolve();
  private recentSegments: Array<{ sourceText: string; translatedText: string }> = [];
  private stopPromise: Promise<void> | null = null;
  private readonly commits = new Map<number, PendingAudioCommit>();
  private readonly initialCommitSequence: number;
  private nextCommitSequence: number;
  private nextSequenceToProcess: number;
  private finalizationFailure: string | null = null;
  private lifecycleGeneration = 0;
  private startupAbortController: AbortController | null = null;
  private stopRequested = false;
  private hasOpened = false;

  constructor(
    private readonly getClientSecret: (signal?: AbortSignal) => Promise<string>,
    private readonly textModel: TextTranslationModel,
    private readonly callbacks: RealtimeClientCallbacks,
    initialCommitSequence = 0
  ) {
    this.initialCommitSequence = initialCommitSequence;
    this.nextCommitSequence = initialCommitSequence;
    this.nextSequenceToProcess = initialCommitSequence;
  }

  async start(): Promise<void> {
    this.startupAbortController?.abort(createAbortError("A newer Realtime transcription start replaced this one."));
    this.transport?.close();
    this.transport = null;
    this.stopLocalAudio();
    const generation = ++this.lifecycleGeneration;
    const startupAbortController = new AbortController();
    this.startupAbortController = startupAbortController;
    this.stopRequested = false;
    this.hasOpened = false;
    this.stopPromise = null;
    this.finalizationFailure = null;
    this.hasConnectionError = false;
    this.hasClosed = false;
    this.closeRequested = false;
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
        callUrl: TRANSCRIPTION_CALL_URL,
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
    this.commitInputBuffer();
    this.isStreaming = false;
    this.setAudioEnabled(false);
  }

  resume(): void {
    this.isStreaming = true;
    this.setAudioEnabled(true);
  }

  stopAndFlush(timeoutMs = 5_000): Promise<void> {
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
              model: "gpt-realtime-whisper",
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

      if (rms >= SPEECH_RMS_THRESHOLD) {
        this.lastSpeechAt = now;
        if (!this.hasAudioToCommit) {
          this.hasAudioToCommit = true;
          this.bufferStartedAt = now;
          this.bufferStartedElapsedMs = Math.max(0, performance.now() - this.sessionStartedAt);
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
    if (!this.hasAudioToCommit) {
      return false;
    }

    const sequence = this.nextCommitSequence;
    const commit: PendingAudioCommit = {
      sequence,
      startedAtMs: this.bufferStartedElapsedMs || this.fallbackStartMs(sequence),
      state: "pending",
      transcript: ""
    };
    this.commits.set(sequence, commit);
    if (!this.sendRealtimeEvent({ type: "input_audio_buffer.commit", event_id: `lecture_commit_${sequence}` })) {
      this.commits.delete(sequence);
      return false;
    }

    this.nextCommitSequence += 1;
    this.hasAudioToCommit = false;
    this.bufferStartedAt = 0;
    this.bufferStartedElapsedMs = 0;
    this.lastSpeechAt = 0;
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

    if (event.type === "input_audio_buffer.committed") {
      this.bindCommittedItem(event.item_id);
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const commit = this.commitForResult(event.item_id);
      if (!commit || commit.state !== "pending") return;
      commit.state = "completed";
      commit.transcript = event.transcript ?? "";
      this.drainCompletedCommits();
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.failed") {
      const commit = this.commitForResult(event.item_id);
      if (!commit || commit.state !== "pending") return;
      commit.state = "failed";
      this.latchFinalizationFailure("最后一段韩文转录失败，已保留此前字幕。");
      this.hasConnectionError = true;
      this.callbacks.onError(event.error?.message ?? this.finalizationFailure ?? "最后一段韩文转录失败。");
      this.drainCompletedCommits();
      this.closeTransport();
      return;
    }

    if (event.type === "error") {
      this.hasConnectionError = true;
      this.latchFinalizationFailure("Realtime 转录连接异常，最后一段可能没有保存。");
      this.callbacks.onError(event.error?.message ?? "Realtime 转录返回错误。");
      this.closeTransport();
      return;
    }

    if (event.type === "session.closed") {
      if (!this.closeRequested) {
        this.hasConnectionError = true;
        this.latchFinalizationFailure("Realtime 转录会话由服务器意外关闭，最后一段字幕可能没有保存。");
        this.callbacks.onError(this.finalizationFailure ?? "Realtime 转录会话意外关闭。");
      }
      this.closeTransport();
    }
  }

  private bindCommittedItem(itemId?: string): void {
    if (!itemId || this.findCommitByItemId(itemId)) return;
    const commit = this.firstPendingCommit((candidate) => !candidate.itemId);
    if (commit) commit.itemId = itemId;
  }

  private commitForResult(itemId?: string): PendingAudioCommit | null {
    if (itemId) {
      const existing = this.findCommitByItemId(itemId);
      if (existing) return existing;
    }
    const pending = this.firstPendingCommit();
    if (pending) {
      if (itemId) pending.itemId = itemId;
      return pending;
    }
    return null;
  }

  private findCommitByItemId(itemId: string): PendingAudioCommit | undefined {
    return Array.from(this.commits.values()).find((commit) => commit.itemId === itemId);
  }

  private firstPendingCommit(predicate: (commit: PendingAudioCommit) => boolean = () => true): PendingAudioCommit | undefined {
    return Array.from(this.commits.values()).find((commit) => commit.state === "pending" && predicate(commit));
  }

  private drainCompletedCommits(): void {
    while (true) {
      const commit = this.commits.get(this.nextSequenceToProcess);
      if (!commit || commit.state === "pending" || commit.state === "processed") return;
      if (commit.state === "completed" && commit.transcript.trim()) {
        this.enqueueTranslation(commit.transcript, commit.startedAtMs, commit.sequence);
      }
      commit.state = "processed";
      this.nextSequenceToProcess += 1;
    }
  }

  private enqueueTranslation(sourceText: string, startedAtMs: number, commitSequence: number): void {
    const normalizedSource = sourceText.trim();
    if (!normalizedSource) {
      return;
    }

    this.translationQueue = this.translationQueue
      .then(async () => {
        const translatedText = await translateKoreanText({
          model: this.textModel,
          text: normalizedSource,
          context: this.recentSegments
        });

        const normalizedTranslation = translatedText.trim();
        this.callbacks.onSegment?.({
          sourceText: normalizedSource,
          translatedText: normalizedTranslation,
          elapsedMs: startedAtMs,
          commitSequence
        });
        this.recentSegments = [...this.recentSegments, { sourceText: normalizedSource, translatedText: normalizedTranslation }].slice(-4);
      })
      .catch((error: unknown) => {
        this.callbacks.onSegment?.({
          sourceText: normalizedSource,
          translatedText: "",
          elapsedMs: startedAtMs,
          commitSequence
        });
        this.latchFinalizationFailure("最后一段韩文已保存，但中文翻译未完成。");
        this.hasConnectionError = true;
        this.callbacks.onError(error instanceof Error ? error.message : "文本翻译失败。");
        this.closeTransport();
      });
  }

  private latchFinalizationFailure(message: string): void {
    this.finalizationFailure ??= message;
  }

  private hasPendingTranscriptions(): boolean {
    return Array.from(this.commits.values()).some((commit) => commit.state === "pending");
  }

  private fallbackStartMs(sequence: number): number {
    if (this.sessionStartedAt > 0) {
      return Math.max(0, performance.now() - this.sessionStartedAt);
    }
    return Math.max(0, (sequence - this.initialCommitSequence) * MIN_COMMIT_MS);
  }

  private handleTransportError(message: string): void {
    if (this.hasConnectionError || this.hasClosed) {
      return;
    }

    this.hasConnectionError = true;
    this.latchFinalizationFailure("Realtime 转录连接异常，最后一段可能没有保存。");
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

    if (!this.closeRequested && !this.hasConnectionError) {
      this.hasConnectionError = true;
      this.latchFinalizationFailure("Realtime 转录连接意外关闭，最后一段字幕可能没有保存。");
      this.callbacks.onError(this.finalizationFailure ?? "Realtime 转录连接意外关闭。");
    } else if (!this.hasConnectionError) {
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

  private cancelPendingStart(): boolean {
    const startupAbortController = this.startupAbortController;
    if (!startupAbortController) {
      return false;
    }
    this.startupAbortController = null;
    startupAbortController.abort(createAbortError("Realtime transcription start was cancelled."));
    return true;
  }

  private isStartActive(generation: number, signal: AbortSignal): boolean {
    return this.lifecycleGeneration === generation && !this.stopRequested && !signal.aborted;
  }

  private assertStartActive(generation: number, signal: AbortSignal): void {
    if (!this.isStartActive(generation, signal)) {
      throw createAbortError("Realtime transcription start was cancelled.");
    }
  }

  private async flushAndClose(timeoutMs: number): Promise<void> {
    this.isStreaming = false;
    this.setAudioEnabled(false);
    if (this.hasClosed) {
      if (this.closeRequested && !this.hasConnectionError) return;
      throw new Error(this.finalizationFailure ?? "Realtime connection ended before the final transcript was confirmed");
    }
    const hadBufferedAudio = this.hasAudioToCommit;
    if (hadBufferedAudio && !this.commitInputBuffer()) {
      this.latchFinalizationFailure("最后一段音频未能提交，当前字幕可能不完整。");
      this.hasConnectionError = true;
      this.closeTransport();
      throw new Error(this.finalizationFailure ?? "Realtime transcription tail commit failed");
    }
    const startedAt = Date.now();
    const transcriptionBudget = Math.max(500, timeoutMs - 500);
    const transcriptsDrained = await waitUntil(() => !this.hasPendingTranscriptions(), transcriptionBudget);
    if (!transcriptsDrained) {
      this.latchFinalizationFailure("最后一段韩文转录超时，当前字幕可能不完整。");
      this.hasConnectionError = true;
      this.closeTransport();
      throw new Error(this.finalizationFailure ?? "Realtime transcription final segment timed out");
    }
    const translationsDrained = await withTimeout(
      this.translationQueue,
      Math.max(250, timeoutMs - (Date.now() - startedAt) - 350)
    );
    if (!translationsDrained) {
      this.latchFinalizationFailure("最后一段中文翻译超时，当前字幕可能不完整。");
      this.hasConnectionError = true;
      this.closeTransport();
      throw new Error(this.finalizationFailure ?? "Final Korean-to-Chinese translation timed out");
    }
    if (this.finalizationFailure) {
      this.hasConnectionError = true;
      this.closeTransport();
      throw new Error(this.finalizationFailure);
    }
    // Realtime transcription sessions do not support translation-session
    // `session.close`. The manually committed tail is complete once every
    // transcription and queued text translation above has drained.
    this.closeRequested = true;
    this.closeTransport();
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

async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) {
    return false;
  }
  return Promise.race([
    promise.then(() => true).catch(() => false),
    new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), timeoutMs))
  ]);
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

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
