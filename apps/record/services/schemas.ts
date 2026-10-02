import { z } from "zod";
import { lectureCourseIdSchema, lectureCursorSchema, lectureDateWindowFields, lectureSessionIdSchema, validLectureDateWindow } from "../../core/src/lecture/types";
import {
  LECTURE_SESSION_STATUSES,
  TEXT_TRANSLATION_MODELS,
  TRANSLATION_MODES
} from "../src/types.js";

const lectureModelsSchema = z
  .object({
    translation: z.union([z.literal("gpt-realtime-translate"), z.enum(TEXT_TRANSLATION_MODELS)]),
    transcription: z.literal("gpt-realtime-whisper"),
    mode: z.enum(TRANSLATION_MODES).optional()
  })
  .strict();

export const transcriptSegmentSchema = z
  .object({
    id: z.string().min(1).max(160),
    commitSequence: z.number().int().nonnegative().optional(),
    startedAtMs: z.number().finite().nonnegative(),
    endedAtMs: z.number().finite().nonnegative().optional(),
    sourceText: z.string().max(40_000),
    translatedText: z.string().max(40_000),
    isFinal: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export const createLectureSessionSchema = z
  .object({
    courseId: z.string().trim().min(1).max(160),
    startedAt: z.string().datetime(),
    models: lectureModelsSchema
  })
  .strict();

export const lectureCheckpointSchema = z
  .object({
    durationMs: z.number().finite().nonnegative(),
    segments: z.array(transcriptSegmentSchema).max(500),
    writerLeaseToken: z.string().min(32).max(200),
    expectedRevision: z.number().int().nonnegative()
  })
  .strict();

export const failedLectureSessionSchema = lectureCheckpointSchema.extend({
  finalizationWarning: z.string().trim().min(1).max(500)
});

export const completeLectureSessionSchema = lectureCheckpointSchema.extend({
  endedAt: z.string().datetime(),
  acceptIncomplete: z.boolean().optional()
});

export const resumeLectureSessionSchema = z.discriminatedUnion("takeover", [
  z.object({
    takeover: z.literal(true),
    expectedRevision: z.number().int().nonnegative()
  }).strict(),
  z.object({
    takeover: z.literal(false),
    writerLeaseToken: z.string().min(32).max(200),
    expectedRevision: z.number().int().nonnegative()
  }).strict()
]);

export const courseQuerySchema = z
  .object({
    includeArchived: z.enum(["true", "false"]).optional(),
    refresh: z.enum(["true", "false"]).optional()
  })
  .strict();

export const sessionListQuerySchema = z
  .object({
    courseId: lectureCourseIdSchema.optional(),
    status: z.enum([...LECTURE_SESSION_STATUSES, "all"]).optional(),
    ...lectureDateWindowFields,
    cursor: lectureCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(100)
  })
  .strict().refine(validLectureDateWindow, "end_at must be after start_at");

export const internalSessionListQuerySchema = z
  .object({
    course_id: lectureCourseIdSchema.optional(),
    status: z.enum([...LECTURE_SESSION_STATUSES, "all"]).optional(),
    ...lectureDateWindowFields,
    cursor: lectureCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20)
  })
  .strict().refine(validLectureDateWindow, "end_at must be after start_at");

export const internalSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(500),
    course_id: lectureCourseIdSchema.optional(),
    session_id: lectureSessionIdSchema.optional(),
    status: z.enum([...LECTURE_SESSION_STATUSES, "all"]).default("ready"),
    ...lectureDateWindowFields,
    cursor: lectureCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20)
  })
  .strict().refine(validLectureDateWindow, "end_at must be after start_at");

export const transcriptReadQuerySchema = z.object({
  start_ms: z.coerce.number().int().nonnegative().optional(),
  end_ms: z.coerce.number().int().positive().optional(),
  cursor: lectureCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict().refine(value => value.end_ms === undefined || value.start_ms === undefined || value.end_ms > value.start_ms,
  "end_ms must be after start_ms");

export const realtimeClientSecretRequestSchema = z
  .object({
    mode: z.enum(TRANSLATION_MODES).default("realtime-translate")
  })
  .strict();

export const translateRequestSchema = z
  .object({
    model: z.enum(TEXT_TRANSLATION_MODELS).default("gpt-5.4-mini"),
    text: z.string().trim().min(1).max(8000),
    context: z
      .array(
        z
          .object({
            sourceText: z.string().max(8000),
            translatedText: z.string().max(8000)
          })
          .strict()
      )
      .max(8)
      .optional()
  })
  .strict();
