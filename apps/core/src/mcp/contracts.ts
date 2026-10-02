import { z } from "zod";
import { CANVAS_ERROR_CODES } from "../canvas/errors.js";

export const toolErrorSchema = z.object({
  code: z.enum(CANVAS_ERROR_CODES),
  message: z.string(),
  status: z.number().int().nullable(),
  retryable: z.boolean(),
  requestId: z.string().nullable(),
  retryAfterSeconds: z.number().nonnegative().nullable(),
}).strict();

/** One envelope for Canvas, LearningX, Lecture and message receipts. */
export function envelopeSchema<T extends z.ZodType>(resultSchema: T) {
  return z.object({
    ok: z.boolean(),
    result: resultSchema.nullable(),
    error: toolErrorSchema.nullable(),
  }).strict().meta({
    oneOf: [
      { properties: { ok: { const: true }, result: { not: { type: "null" } }, error: { type: "null" } }, required: ["ok", "result", "error"] },
      { properties: { ok: { const: false }, result: { type: "null" }, error: { not: { type: "null" } } }, required: ["ok", "result", "error"] },
    ],
  }).superRefine((value, context) => {
    const envelope = value as { ok: boolean; result: unknown; error: unknown };
    if (!(envelope.ok ? envelope.result !== null && envelope.error === null : envelope.result === null && envelope.error !== null)) {
      context.addIssue({ code: "custom", message: "Tool success/error fields are inconsistent." });
    }
  });
}

export function pageSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable().describe("Continue with the same filters and this cursor; null means this collection is exhausted."),
  }).strict();
}
