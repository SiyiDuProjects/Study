export type ConnectionStatus = "idle" | "connecting" | "recording" | "paused" | "closing" | "error";

export type TranscriptChannel = "translation" | "source";

export const TEXT_TRANSLATION_MODELS = ["gpt-5.4-mini", "gpt-5.4-nano"] as const;
export const TRANSLATION_MODES = ["transcribe-then-translate", "realtime-translate"] as const;
export const LECTURE_SESSION_STATUSES = ["recording", "ready", "failed", "archived"] as const;
export const COURSE_MATCH_STATUSES = ["matched", "daily", "legacy_unmatched"] as const;

export type TextTranslationModel = (typeof TEXT_TRANSLATION_MODELS)[number];
export type TranslationMode = (typeof TRANSLATION_MODES)[number];
export type TranslationModel = "gpt-realtime-translate" | TextTranslationModel;
export type LectureSessionStatus = (typeof LECTURE_SESSION_STATUSES)[number];
export type CourseMatchStatus = (typeof COURSE_MATCH_STATUSES)[number];

export interface TranscriptSegment {
  id: string;
  commitSequence?: number;
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

export interface LectureModels {
  translation: TranslationModel;
  transcription: "gpt-realtime-whisper";
  mode?: TranslationMode;
}

export interface ClassSession {
  id: string;
  title: string;
  courseId: string;
  courseCode: string;
  courseName: string;
  courseTerm: string;
  courseFolderName: string;
  courseMatchStatus: CourseMatchStatus;
  finalizationWarning: string | null;
  revision: number;
  status: LectureSessionStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  sourceLanguage: "ko";
  targetLanguage: "zh";
  models: LectureModels;
  segments: TranscriptSegment[];
  savedAt: string | null;
  updatedAt: string;
}

export type ClassSessionSummary = Omit<ClassSession, "segments"> & {
  segmentCount: number;
};

export interface CreateLectureSessionRequest {
  courseId: string;
  startedAt: string;
  models: LectureModels;
}

export interface LectureCheckpointRequest {
  durationMs: number;
  segments: TranscriptSegment[];
  writerLeaseToken: string;
  expectedRevision: number;
}

export interface FailedLectureSessionRequest extends LectureCheckpointRequest {
  finalizationWarning: string;
}

export interface CompleteLectureSessionRequest extends LectureCheckpointRequest {
  endedAt: string;
  acceptIncomplete?: boolean;
}

export interface WriterLease {
  token: string;
}

export type ResumeLectureSessionRequest =
  | { takeover: true; expectedRevision: number }
  | ({ takeover: false } & Pick<LectureCheckpointRequest, "writerLeaseToken" | "expectedRevision">);

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
  commitSequence?: number;
}

export interface RealtimeClientCallbacks {
  onOpen: () => void;
  onDelta: (delta: RealtimeTranscriptDelta) => void;
  onSegment?: (segment: RealtimeTranscriptSegment) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

export interface LiveSubtitleClient {
  start: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  stopAndFlush: (timeoutMs?: number) => Promise<void>;
}
