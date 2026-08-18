import { z } from "zod";

import {
  getLectureSessionResponseSchema,
  listLectureSessionsResponseSchema,
  searchLectureTranscriptsResponseSchema,
} from "../lecture/types.js";

const lectureErrorSchema = z
  .object({
    code: z.enum([
      "configuration_error",
      "invalid_argument",
      "authentication_failed",
      "permission_denied",
      "not_found",
      "rate_limited",
      "canvas_error",
      "upstream_error",
      "timeout",
      "network_error",
      "invalid_response",
      "unsafe_pagination",
    ]),
    message: z.string(),
    status: z.number().int().nullable(),
    retryable: z.boolean(),
    requestId: z.string().nullable(),
    retryAfterSeconds: z.number().nonnegative().nullable(),
  })
  .strict();

const ENVELOPE_BRANCHES = [
  {
    properties: {
      ok: { const: true },
      result: { not: { type: "null" } },
      error: { type: "null" },
    },
    required: ["ok", "result", "error"],
  },
  {
    properties: {
      ok: { const: false },
      result: { type: "null" },
      error: { not: { type: "null" } },
    },
    required: ["ok", "result", "error"],
  },
] as const;

function envelopeSchema(resultSchema: z.ZodType<unknown>) {
  return z
    .object({
      ok: z.boolean(),
      result: resultSchema.nullable(),
      error: lectureErrorSchema.nullable(),
    })
    .strict()
    .meta({ oneOf: ENVELOPE_BRANCHES })
    .superRefine((envelope, context) => {
      const success = envelope.ok && envelope.result !== null && envelope.error === null;
      const failure = !envelope.ok && envelope.result === null && envelope.error !== null;
      if (!success && !failure) {
        context.addIssue({ code: "custom", message: "Lecture tool envelope is inconsistent." });
      }
    });
}

export const lectureToolOutputSchemas = {
  list_lecture_sessions: envelopeSchema(listLectureSessionsResponseSchema),
  get_lecture_transcript: envelopeSchema(getLectureSessionResponseSchema),
  search_lecture_transcripts: envelopeSchema(searchLectureTranscriptsResponseSchema),
} as const;

export type LectureToolName = keyof typeof lectureToolOutputSchemas;
