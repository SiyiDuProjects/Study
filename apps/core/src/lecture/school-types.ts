import { z } from "zod";

export const schoolIdSchema = z.string().regex(/^\d{1,20}$/);
export const schoolSourceSchema = z.object({
  kind: z.literal("hanyang-translive"),
  viewerId: schoolIdSchema,
  viewerUrl: z.string().regex(/^https:\/\/learning\.hanyang\.ac\.kr\/translive\/v\/\d{1,20}$/),
  moduleItemId: schoolIdSchema.nullable(),
  recordingStatus: z.string().max(80),
  lastSyncedAt: z.string().datetime(),
}).strict();

export const schoolCourseSchema = z.object({
  courseId: schoolIdSchema,
  enabled: z.boolean(),
  lastCheckedAt: z.string().datetime().nullable(),
  sessionCount: z.number().int().nonnegative(),
  error: z.string().max(300).nullable(),
}).strict();
export const schoolCoursesSchema = z.object({ courses: z.array(schoolCourseSchema).max(100) }).strict();
export type SchoolCourse = z.infer<typeof schoolCourseSchema>;

export const schoolImportSchema = z.object({
  courseId: schoolIdSchema,
  viewerId: schoolIdSchema,
  moduleItemId: schoolIdSchema.nullable(),
  title: z.string().min(1).max(500),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  recordingStatus: z.string().max(80),
  segments: z.array(z.object({
    order: z.number().int().min(0).max(1_000_000),
    startedAtMs: z.number().int().nonnegative(),
    endedAtMs: z.number().int().nonnegative().nullable(),
    sourceText: z.string().max(40_000),
    translatedText: z.string().max(40_000),
    isFinal: z.boolean().default(true),
  }).strict()).max(250),
}).strict();
export type SchoolImport = z.infer<typeof schoolImportSchema>;

export const schoolStatusSchema = z.object({
  courseId: schoolIdSchema,
  sessionCount: z.number().int().min(0).max(1000),
  error: z.string().max(300).nullable(),
}).strict();
