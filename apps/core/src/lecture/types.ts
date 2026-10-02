import { z } from "zod";
import { schoolSourceSchema } from "./school-types.js";

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
        transcription: z.string().min(1).max(200),
        mode: z.string().max(100).optional(),
      })
      .strict(),
    segmentCount: z.number().int().nonnegative(),
    savedAt: nullableDateTime,
    updatedAt: z.string().datetime({ offset: true }),
    source: schoolSourceSchema.optional(),
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

export const lectureReadWarningSchema = z.object({
  code: z.literal("invalid_record"),
  recordId: z.string().max(160),
  message: z.string().max(500),
}).strict();

const pageFields = {
  nextCursor: z.string().max(4096).nullable(),
  warnings: z.array(lectureReadWarningSchema).max(100),
};

export const listLectureSessionsResponseSchema = z.object({
  items: z.array(lectureSessionSummarySchema).max(100),
  ...pageFields,
}).strict();

export const getLectureSessionResponseSchema = z.object({
  session: lectureSessionSummarySchema,
  items: z.array(transcriptSegmentSchema).max(50),
  ...pageFields,
  rangeComplete: z.boolean(),
}).strict();

export const searchLectureTranscriptsResponseSchema = z.object({
  query: z.string().max(500),
  items: z.array(lectureSearchHitSchema).max(50),
  ...pageFields,
}).strict();

export const lectureCourseIdSchema = z.string().trim().min(1).max(160)
  .describe("Exact courseId returned by the service, including a historical unmatched ID or daily for personal recordings. Never invent a course ID.");
export const lectureSessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
  .describe("Saved session ID returned by a lecture list or search.");
export const lectureCursorSchema = z.string().min(1).max(4096)
  .describe("Opaque nextCursor from the previous page; keep all filters unchanged.");
export const lectureDateWindowFields = {
  start_at: z.string().datetime({ offset: true }).optional()
    .describe("Inclusive session start time as ISO 8601 with offset."),
  end_at: z.string().datetime({ offset: true }).optional()
    .describe("Exclusive session start time as ISO 8601 with offset."),
};

export type LectureReadWarning = z.infer<typeof lectureReadWarningSchema>;

export function validLectureDateWindow(value: { start_at?: string | undefined; end_at?: string | undefined }): boolean {
  return value.start_at === undefined || value.end_at === undefined || Date.parse(value.start_at) < Date.parse(value.end_at);
}

export type LectureStatusFilter = z.infer<typeof lectureStatusFilterSchema>;
export type LectureSessionSummary = z.infer<typeof lectureSessionSummarySchema>;
export type LectureSession = z.infer<typeof lectureSessionSchema>;
export type LectureSearchHit = z.infer<typeof lectureSearchHitSchema>;
export type ListLectureSessionsResponse = z.infer<typeof listLectureSessionsResponseSchema>;
export type GetLectureSessionResponse = z.infer<typeof getLectureSessionResponseSchema>;
export type SearchLectureTranscriptsResponse = z.infer<typeof searchLectureTranscriptsResponseSchema>;
