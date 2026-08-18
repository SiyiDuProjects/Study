import { z } from "zod";

const nullableDateTime = z.string().datetime({ offset: true }).nullable();
const optionalMilliseconds = z.number().int().nonnegative().optional();

export const lectureStatusSchema = z.enum([
  "recording",
  "ready",
  "failed",
  "archived",
]);

export const lectureStatusFilterSchema = z.enum([
  "recording",
  "ready",
  "failed",
  "archived",
  "all",
]);

export const lectureSessionSummarySchema = z
  .object({
    id: z.string().min(1).max(128),
    title: z.string().max(500),
    courseId: z.string().min(1).max(160),
    courseCode: z.string().max(200),
    courseName: z.string().max(500),
    courseTerm: z.string().max(300).nullable(),
    courseFolderName: z.string().max(500),
    courseMatchStatus: z.enum(["matched", "daily", "legacy_unmatched"]),
    finalizationWarning: z.string().max(500).nullable(),
    revision: z.number().int().nonnegative(),
    status: lectureStatusSchema,
    startedAt: z.string().datetime({ offset: true }),
    endedAt: nullableDateTime,
    durationMs: z.number().int().nonnegative(),
    sourceLanguage: z.literal("ko"),
    targetLanguage: z.literal("zh"),
    models: z
      .object({
        translation: z.string().max(200),
        transcription: z.literal("gpt-realtime-whisper"),
        mode: z.string().max(100).optional(),
      })
      .strict(),
    segmentCount: z.number().int().nonnegative(),
    savedAt: nullableDateTime,
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const transcriptSegmentSchema = z
  .object({
    id: z.string().min(1).max(160),
    commitSequence: z.number().int().nonnegative().optional(),
    startedAtMs: z.number().int().nonnegative(),
    endedAtMs: optionalMilliseconds,
    sourceText: z.string().max(40_000),
    translatedText: z.string().max(40_000),
    isFinal: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const lectureSessionSchema = lectureSessionSummarySchema.extend({
  segments: z.array(transcriptSegmentSchema).max(20_000),
});

export const lectureSearchHitSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    sessionTitle: z.string().max(500),
    sessionStatus: lectureStatusSchema,
    finalizationWarning: z.string().max(500).nullable(),
    sessionStartedAt: z.string().datetime({ offset: true }),
    courseId: z.string().min(1).max(160),
    courseCode: z.string().max(200),
    courseName: z.string().max(500),
    segmentId: z.string().min(1).max(160),
    startedAtMs: z.number().int().nonnegative(),
    endedAtMs: optionalMilliseconds,
    sourceText: z.string().max(40_000),
    translatedText: z.string().max(40_000),
  })
  .strict();

export const listLectureSessionsResponseSchema = z
  .object({ sessions: z.array(lectureSessionSummarySchema).max(100) })
  .strict();

export const getLectureSessionResponseSchema = z
  .object({ session: lectureSessionSchema })
  .strict();

export const searchLectureTranscriptsResponseSchema = z
  .object({
    query: z.string().max(500),
    hits: z.array(lectureSearchHitSchema).max(50),
  })
  .strict();

export type LectureStatusFilter = z.infer<typeof lectureStatusFilterSchema>;
export type LectureSessionSummary = z.infer<typeof lectureSessionSummarySchema>;
export type LectureSession = z.infer<typeof lectureSessionSchema>;
export type LectureSearchHit = z.infer<typeof lectureSearchHitSchema>;
export type ListLectureSessionsResponse = z.infer<typeof listLectureSessionsResponseSchema>;
export type GetLectureSessionResponse = z.infer<typeof getLectureSessionResponseSchema>;
export type SearchLectureTranscriptsResponse = z.infer<typeof searchLectureTranscriptsResponseSchema>;
