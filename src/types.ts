export type ConnectionStatus = "idle" | "connecting" | "recording" | "paused" | "closing" | "error";

export type TranscriptChannel = "translation" | "source";

export interface TranscriptSegment {
  id: string;
  startedAtMs: number;
  endedAtMs?: number;
  sourceText: string;
  translatedText: string;
  isFinal: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptState {
  segments: TranscriptSegment[];
  activeSegment: TranscriptSegment | null;
}

export interface ClassSession {
  id: string;
  title: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  sourceLanguage: "ko";
  targetLanguage: "zh";
  models: {
    translation: "gpt-realtime-translate";
    transcription: "gpt-realtime-whisper";
  };
  segments: TranscriptSegment[];
}

export interface AppSettings {
  rememberApiKey: boolean;
  apiKey?: string;
  subtitleScale: number;
  showKoreanInline: boolean;
}

export interface RealtimeTranscriptDelta {
  channel: TranscriptChannel;
  delta: string;
  elapsedMs?: number;
}

export interface RealtimeClientCallbacks {
  onOpen: () => void;
  onDelta: (delta: RealtimeTranscriptDelta) => void;
  onError: (message: string) => void;
  onClose: () => void;
}
