import { z } from "zod";

export const writeId = z.string().regex(/^[1-9]\d*$/).max(30);
export const requestId = z.string().uuid().describe("Stable ID for this user-authorized operation. Preserve on retries; never retry an unknown outcome with a new ID.");
export const fileReferenceSchema = z.object({
  download_url: z.string().url().max(12000),
  file_id: z.string().min(1).max(300),
  mime_type: z.string().max(200).optional(),
  file_name: z.string().max(255).optional(),
}).strict();
export const filenameSchema = z.string().min(1).max(255).regex(/^[^/\\\x00-\x1f\x7f]+$/).refine(name => name !== "." && name !== "..");
export const uploadFileSchema = z.object({
  request_id: requestId, file: fileReferenceSchema,
  filename: filenameSchema.describe("User-selected filename including its extension; preserve the original name."),
  purpose: z.enum(["message", "assignment"]),
  course_id: writeId.optional(), assignment_id: writeId.optional(),
}).strict().refine(input => input.purpose === "assignment" ? Boolean(input.course_id && input.assignment_id) : !input.course_id && !input.assignment_id,
  "Assignment uploads need both course and assignment; message uploads accept neither.");
export const fileIdsSchema = z.array(writeId).min(1).max(10).refine(ids => new Set(ids).size === ids.length);
export const submitAssignmentSchema = z.object({
  request_id: requestId, course_id: writeId, assignment_id: writeId,
  expected_attempt: z.number().int().min(0).describe("Current attempt from a fresh own-submission read, zero only if never submitted. A changed attempt blocks this request."),
  submission_type: z.enum(["online_upload", "online_text_entry"]),
  file_ids: fileIdsSchema.optional(),
  text: z.string().trim().min(1).max(100000).optional().describe("Plain text for a text-entry assignment."),
  comment: z.string().trim().min(1).max(20000).optional().describe("Textual comment accompanying the submission, including file submissions."),
}).strict().refine(input => input.submission_type === "online_upload" ? Boolean(input.file_ids && !input.text) : Boolean(input.text && !input.file_ids),
  "Choose files or text according to the submission type.");
export const uploadReceiptSchema = z.object({
  status: z.literal("uploaded"), requestId, fileId: writeId, filename: filenameSchema,
  size: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  canvasUserId: writeId, purpose: z.enum(["message", "assignment"]), courseId: writeId.nullable(), assignmentId: writeId.nullable(),
}).strict();
export const submissionReceiptSchema = z.object({
  status: z.literal("submitted"), requestId, courseId: writeId, assignmentId: writeId,
  userId: writeId, attempt: z.number().int().positive(), submittedAt: z.string().datetime({ offset: true }),
  submissionType: z.enum(["online_upload", "online_text_entry"]), fileIds: z.array(writeId),
  commentIncluded: z.boolean(),
}).strict();
