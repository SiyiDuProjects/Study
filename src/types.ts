export type ConnectionStatus = "idle" | "connecting" | "recording" | "paused" | "closing" | "error";

export type TranscriptChannel = "translation" | "source";

export const TRANSLATION_MODES = ["classic-websocket-translate", "realtime-translate", "transcribe-then-translate"] as const;

export type TextTranslationModel = string;
export type TranslationMode = (typeof TRANSLATION_MODES)[number];
export type TranslationModel = string;

export interface AppConfig {
  realtimeTranslationModel: string;
  realtimeTranscriptionModel: string;
  defaultTextTranslationModel: string;
  textTranslationModels: string[];
}

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
  courseId: string;
  courseCode: string;
  courseName: string;
  courseTerm: string;
  courseFolderName: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  sourceLanguage: "ko";
  targetLanguage: "zh";
  models: {
    translation: TranslationModel;
    transcription: string;
    mode?: TranslationMode;
  };
  segments: TranscriptSegment[];
  createdByEmail?: string | null;
  savedAt?: string;
}

export type ClassSessionSummary = Omit<ClassSession, "segments"> & {
  segmentCount: number;
};

export interface AppSettings {
  subtitleScale: number;
  showKoreanInline: boolean;
  translationMode: TranslationMode;
  textTranslationModel: TextTranslationModel;
  audioBoostEnabled: boolean;
}

export interface RealtimeTranscriptDelta {
  channel: TranscriptChannel;
  delta: string;
  elapsedMs?: number;
}

export interface RealtimeTranscriptSegment {
  sourceText: string;
  translatedText: string;
  elapsedMs?: number;
}

export interface RealtimeClientDiagnostic {
  kind: "microphone" | "connection" | "event" | "warning";
  at: number;
  level?: number;
  connection?: "dataChannel" | "ice" | "peer" | "webSocket";
  state?: string;
  eventType?: string;
  message?: string;
}

export interface RealtimeClientCallbacks {
  onOpen: () => void;
  onDelta: (delta: RealtimeTranscriptDelta) => void;
  onSegment?: (segment: RealtimeTranscriptSegment) => void;
  onError: (message: string) => void;
  onClose: () => void;
  onDiagnostic?: (event: RealtimeClientDiagnostic) => void;
}
