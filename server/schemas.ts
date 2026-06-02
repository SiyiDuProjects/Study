import { z } from "zod";
import { COURSES } from "../shared/courses.js";
import { TRANSLATION_MODES } from "../src/types.js";

const courseIds = COURSES.map((course) => course.id);

export const transcriptSegmentSchema = z
  .object({
    id: z.string().min(1),
    startedAtMs: z.number().finite().nonnegative(),
    endedAtMs: z.number().finite().nonnegative().optional(),
    sourceText: z.string(),
    translatedText: z.string(),
    translationStatus: z.enum(["queued", "translating", "translated", "failed"]).optional(),
    translationError: z.string().max(1000).optional(),
    isFinal: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export const classSessionSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(240),
    courseId: z.string().refine((courseId) => courseIds.includes(courseId), "Unknown course"),
    courseCode: z.string().min(1),
    courseName: z.string().min(1),
    courseTerm: z.string(),
    courseFolderName: z.string().min(1),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    durationMs: z.number().finite().nonnegative(),
    sourceLanguage: z.literal("ko"),
    targetLanguage: z.literal("zh"),
    models: z
      .object({
        translation: z.string().trim().min(1).max(120),
        transcription: z.string().trim().min(1).max(120),
        mode: z.enum(TRANSLATION_MODES).optional()
      })
      .strict(),
    segments: z.array(transcriptSegmentSchema).max(20000)
  })
  .strict();

export const courseQuerySchema = z
  .object({
    courseId: z.string().optional()
  })
  .strict()
  .refine((query) => !query.courseId || courseIds.includes(query.courseId), "Unknown course");

export const realtimeClientSecretRequestSchema = z
  .object({
    mode: z.enum(TRANSLATION_MODES).default("transcribe-then-translate")
  })
  .strict();

export const translateRequestSchema = z
  .object({
    model: z.string().trim().min(1).max(120).optional(),
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
