export type ConnectionStatus = "idle" | "connecting" | "recording" | "paused" | "closing" | "error";

export type TranscriptChannel = "translation" | "source";

export const TEXT_TRANSLATION_MODELS = ["gpt-5.4-mini", "gpt-5.4-nano"] as const;
export const TRANSLATION_MODES = ["transcribe-then-translate", "realtime-translate"] as const;

export type TextTranslationModel = (typeof TEXT_TRANSLATION_MODELS)[number];
export type TranslationMode = (typeof TRANSLATION_MODES)[number];
export type TranslationModel = "gpt-realtime-translate" | TextTranslationModel;

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
    transcription: "gpt-realtime-whisper";
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

export interface RealtimeClientCallbacks {
  onOpen: () => void;
  onDelta: (delta: RealtimeTranscriptDelta) => void;
  onSegment?: (segment: RealtimeTranscriptSegment) => void;
  onError: (message: string) => void;
  onClose: () => void;
}
