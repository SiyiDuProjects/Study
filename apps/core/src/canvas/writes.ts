import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppDatabase } from "../db/index.js";
import { INSTITUTIONS, type CanvasConnection } from "../domain.js";
import { log } from "../logger.js";
import { CanvasApiError } from "./errors.js";
import { requireCanvasConnection } from "./connection.js";
import { WriteLedger } from "./writeLedger.js";
import { chatGptFileSource } from "./fileSources.js";
import { submitAssignmentSchema, submissionReceiptSchema, uploadFileSchema, uploadReceiptSchema, writeId } from "./writeContracts.js";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const fail = (message: string): never => { throw new CanvasApiError("invalid_argument", message); };
const object = (data: unknown): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(data);
const numericId = (value: unknown) => writeId.parse(String(value));
const escapeText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const errorCode = (error: unknown) => error instanceof CanvasApiError ? error.code : null;
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Canvas re-serializes sanitized HTML (entities, quotes, spacing); compare the text a reader sees. */
export function visibleText(html: string): string {
  return html
    .replace(/<br\s*\/?>|<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name[0] !== "#") return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
      const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Reads are bounded even when upstream omits or lies about Content-Length. */
export async function readBytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.body || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    return fail("File or response exceeds the supported size.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); return fail("File or response exceeds the supported size."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

export class CanvasWriteService {
  private readonly ledger: WriteLedger;
  constructor(private readonly db: AppDatabase,
    private readonly getConnection: (userId: string) => CanvasConnection | null | Promise<CanvasConnection | null>,
    private readonly fetcher: typeof fetch = fetch,
    private readonly uploadOrigins: Partial<Record<CanvasConnection["institution"], readonly string[]>> = {},
    private readonly fileSourceOrigins: readonly string[] = ["https://files.oaiusercontent.com"],
  ) { this.ledger = new WriteLedger(db); }

  async connection(userId: string): Promise<CanvasConnection> {
    return requireCanvasConnection(await this.getConnection(userId), userId);
  }

  private safeUrl(raw: string, origins: readonly string[]): URL {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || !origins.includes(url.origin)) {
      return fail("File transfer destination is not approved. Do not substitute another URL.");
    }
    return url;
  }

  private async fetch(url: URL, init: RequestInit = {}): Promise<Response> {
    try { return await this.fetcher(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(60000) }); }
    catch { throw new CanvasApiError("network_error", "File or submission request failed. Inspect LMS records; do not retry automatically."); }
  }

  private async json(response: Response): Promise<Record<string, unknown>> {
    if (!response.ok) throw new CanvasApiError("canvas_error", "LMS did not confirm the operation. Inspect LMS records before retrying.", { status: response.status });
    try { return object(JSON.parse((await readBytes(response, 1_000_000)).toString("utf8"))); }
    catch { throw new CanvasApiError("invalid_response", "LMS returned an invalid receipt. Inspect LMS records before retrying."); }
  }

  private async api(connection: CanvasConnection, path: string, payload?: unknown) {
    return this.json(await this.fetch(new URL(path, connection.baseUrl), {
      method: payload === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${connection.accessToken}`, ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }));
  }

  private async assignment(connection: CanvasConnection, courseId: string, assignmentId: string, type: string) {
    const assignment = await this.api(connection, `/api/v1/courses/${courseId}/assignments/${assignmentId}`);
    if (numericId(assignment.id) !== assignmentId || numericId(assignment.course_id) !== courseId || assignment.published !== true || assignment.locked_for_user !== false) {
      return fail("Assignment identity, publication or user-specific availability could not be verified.");
    }
    if (assignment.is_quiz_assignment === true || assignment.quiz_id || assignment.group_category_id || assignment.external_tool_tag_attributes) {
      return fail("Quizzes, group assignments and external-tool submissions are not supported by this release.");
    }
    if (!Array.isArray(assignment.submission_types) || !assignment.submission_types.includes(type)) return fail("This assignment does not allow the requested submission type.");
    for (const key of ["unlock_at", "lock_at"] as const) {
      const raw = assignment[key];
      if (raw != null) {
        const time = typeof raw === "string" ? Date.parse(raw) : NaN;
        if (!Number.isFinite(time) || (key === "unlock_at" ? time > Date.now() : time <= Date.now())) return fail("Assignment is outside its verified submission window.");
      }
    }
    return assignment;
  }

  private checkExtension(assignment: Record<string, unknown>, filename: string) {
    const extensions = assignment.allowed_extensions;
    if (extensions != null && (!Array.isArray(extensions) || extensions.some(ext => typeof ext !== "string"))) return fail("Allowed file formats could not be verified.");
    if (Array.isArray(extensions) && extensions.length && !extensions.map(ext => String(ext).toLowerCase().replace(/^\./, "")).includes(filename.split(".").at(-1)?.toLowerCase() ?? "")) {
      return fail("This filename does not match the assignment's allowed file formats.");
    }
  }

  async upload(userId: string, raw: z.input<typeof uploadFileSchema>) {
    const input = uploadFileSchema.parse(raw);
    const connection = await this.connection(userId);
    // Signed URLs expire. Stable file reference + content name identifies retries, never persist the URL.
    const fingerprint = this.ledger.fingerprint({ ...input, file: { file_id: input.file.file_id, mime_type: input.file.mime_type }, canvasUserId: connection.canvasUserId });
    const previous = this.ledger.previous(userId, input.request_id, "upload", fingerprint);
    if (previous) return uploadReceiptSchema.parse(previous);
    if (input.purpose === "assignment") this.checkExtension(await this.assignment(connection, input.course_id!, input.assignment_id!, "online_upload"), input.filename);
    const source = chatGptFileSource(input.file.download_url, input.file.file_id, this.fileSourceOrigins);
    const downloaded = await this.fetch(source, { credentials: "omit" });
    if (!downloaded.ok) return fail("The selected ChatGPT file is unavailable. Select the file again; never invent a download URL.");
    const bytes = await readBytes(downloaded, MAX_FILE_BYTES);
    if (!bytes.length) return fail("Empty files cannot be uploaded.");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const mime = input.file.mime_type || "application/octet-stream";
    if (/^(audio|video)\//i.test(mime) || /\.(mp3|mp4|m4a|wav|webm|ogg|flac|aac|mov|wma)$/i.test(input.filename)) return fail("Raw audio and video uploads are not supported.");
    if (mime.includes("\r") || mime.includes("\n")) return fail("Invalid media type.");
    const target = `${connection.canvasUserId}:${input.purpose}:${input.course_id ?? ""}:${input.assignment_id ?? ""}:${sha256}`;
    this.ledger.claim(userId, input.request_id, "upload", fingerprint, target);
    // No bytes reach LMS storage before "transfer"; an upload ticket alone creates no visible file.
    let stage: "ticket" | "transfer" | "confirm" = "ticket";
    try {
      const path = input.purpose === "assignment"
        ? `/api/v1/courses/${input.course_id}/assignments/${input.assignment_id}/submissions/self/files`
        : "/api/v1/users/self/files";
      const ticket = await this.api(connection, path, { name: input.filename, size: bytes.length, content_type: mime, on_duplicate: "rename",
        ...(input.purpose === "message" ? { parent_folder_path: "conversation attachments" } : { submit_assignment: false }) });
      const destination = this.safeUrl(z.string().parse(ticket.upload_url), [INSTITUTIONS[connection.institution].baseUrl, ...(this.uploadOrigins[connection.institution] ?? [])]);
      const parameters = z.record(z.string(), z.string()).parse(ticket.upload_params);
      if (Object.keys(parameters).some(key => key.toLowerCase() === "file")) return fail("Invalid LMS upload parameters.");
      const form = new FormData();
      for (const [key, value] of Object.entries(parameters)) form.append(key, value);
      form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), input.filename);
      // Canvas PAT is NEVER sent to the upload destination, even when it shares the Canvas origin.
      stage = "transfer";
      let response = await this.fetch(destination, { method: "POST", body: form });
      stage = "confirm";
      const location = response.headers.get("location");
      if (([301, 302, 303].includes(response.status) || response.status === 201) && location) {
        const confirmation = this.safeUrl(new URL(location, destination).toString(), [connection.baseUrl]);
        if (!/^\/api\/v1\/files\/[1-9]\d*(?:\/create_success)?$/.test(confirmation.pathname)) return fail("Unexpected upload confirmation path.");
        response = await this.fetch(confirmation, { headers: { Authorization: `Bearer ${connection.accessToken}` } });
      }
      const uploaded = await this.json(response);
      if (uploaded.size !== bytes.length) return fail("LMS did not confirm the complete file size.");
      const result = uploadReceiptSchema.parse({ status: "uploaded", requestId: input.request_id, fileId: numericId(uploaded.id),
        filename: input.filename, size: bytes.length, sha256, canvasUserId: connection.canvasUserId, purpose: input.purpose, courseId: input.course_id ?? null, assignmentId: input.assignment_id ?? null });
      this.ledger.finish(userId, input.request_id, result);
      return result;
    } catch (error) {
      const diagnostic = { error, code: errorCode(error), stage, userId, requestId: input.request_id, institution: connection.institution };
      if (stage === "ticket") {
        this.ledger.release(userId, input.request_id);
        log("warn", "canvas_upload_not_started", diagnostic);
        if (error instanceof CanvasApiError && error.code === "invalid_argument") throw error;
        throw new CanvasApiError("canvas_error", "Upload did not start: LMS did not provide a usable upload destination, and no file bytes were sent. The same request_id may be retried.",
          { status: error instanceof CanvasApiError ? error.status : null });
      }
      this.ledger.finish(userId, input.request_id);
      log("error", "canvas_upload_outcome_unknown", diagnostic);
      throw new CanvasApiError("canvas_error", "Upload outcome is unknown. Inspect LMS files before a new upload. No message or assignment was submitted by this operation.");
    }
  }

  async verifyFiles(userId: string, fileIds: string[], purpose: "message" | "assignment", courseId: string | null = null, assignmentId: string | null = null) {
    const connection = await this.connection(userId);
    // Administratively reconciled uploads have no receipt and cannot be reused as verified files.
    const rows = this.db.prepare("SELECT result_json FROM canvas_write_receipts WHERE user_id=? AND kind='upload' AND status='complete' AND result_json IS NOT NULL").all(userId) as {result_json: string}[];
    const receipts = rows.map(row => uploadReceiptSchema.parse(JSON.parse(row.result_json)));
    const matched = [];
    for (const fileId of fileIds) {
      const receipt = receipts.find(file => file.canvasUserId === connection.canvasUserId && file.fileId === fileId && file.purpose === purpose && file.courseId === courseId && file.assignmentId === assignmentId);
      if (!receipt) throw new CanvasApiError("permission_denied", "File was not uploaded by this account for this target. Upload the selected file for the intended operation.");
      const file = await this.api(connection, `/api/v1/files/${fileId}`);
      // Hidden-from-list is normal for submission/Inbox folders, not a denial to the owner.
      if (numericId(file.id) !== fileId || file.size !== receipt.size || file.locked_for_user === true) return fail("Uploaded file is no longer available as expected.");
      matched.push(receipt);
    }
    return matched;
  }

  async submit(userId: string, raw: z.input<typeof submitAssignmentSchema>) {
    const input = submitAssignmentSchema.parse(raw);
    const connection = await this.connection(userId);
    const fingerprint = this.ledger.fingerprint({ input, canvasUserId: connection.canvasUserId });
    const previous = this.ledger.previous(userId, input.request_id, "submit", fingerprint);
    if (previous) return submissionReceiptSchema.parse(previous);
    const assignment = await this.assignment(connection, input.course_id, input.assignment_id, input.submission_type);
    if (input.file_ids) for (const file of await this.verifyFiles(userId, input.file_ids, "assignment", input.course_id, input.assignment_id)) this.checkExtension(assignment, file.filename);
    const path = `/api/v1/courses/${input.course_id}/assignments/${input.assignment_id}/submissions`;
    const current = await this.api(connection, `${path}/self?include[]=submission_comments`);
    if (numericId(current.user_id) !== connection.canvasUserId || numericId(current.assignment_id) !== input.assignment_id || current.excused === true) return fail("Own submission could not be verified or is excused.");
    const attempt = current.attempt == null && current.workflow_state === "unsubmitted" && !current.submitted_at ? 0 : z.number().int().min(0).parse(current.attempt);
    if (attempt !== input.expected_attempt) return fail("Submission attempt changed. Read the latest submission and resolve whether the user wants another attempt.");
    const allowed = z.number().int().min(-1).parse(assignment.allowed_attempts);
    const extra = current.extra_attempts == null ? 0 : z.number().int().min(0).parse(current.extra_attempts);
    if (allowed !== -1 && attempt >= allowed + extra) return fail("No submission attempts remain.");
    const previousComments = new Set(Array.isArray(current.submission_comments) ? current.submission_comments.map(raw => String(object(raw).id)) : []);
    const body = input.text ? `<p>${escapeText(input.text).replaceAll("\n", "<br>")}</p>` : undefined;
    this.ledger.claim(userId, input.request_id, "submit", fingerprint, `${connection.canvasUserId}:${input.course_id}:${input.assignment_id}`);
    let stage: "post" | "verify" | "read_back" = "post";
    try {
      const response = await this.api(connection, path, {
        submission: { submission_type: input.submission_type, ...(input.file_ids ? { file_ids: input.file_ids } : { body }), group_comment: false },
        ...(input.comment ? { comment: { text_comment: input.comment } } : {}),
      });
      const verify = (data: Record<string, unknown>) => {
        if (numericId(data.user_id) !== connection.canvasUserId || numericId(data.assignment_id) !== input.assignment_id || data.attempt !== attempt + 1 ||
            data.submission_type !== input.submission_type || !["submitted", "pending_review", "graded"].includes(String(data.workflow_state))) return fail("Submission receipt does not match the intended attempt.");
        if (input.file_ids) {
          const actual = z.array(z.object({ id: z.union([z.number().int(), z.string()]) })).parse(data.attachments).map(file => String(file.id)).sort();
          if (JSON.stringify(actual) !== JSON.stringify([...input.file_ids].sort())) return fail("LMS did not confirm every submitted file.");
        }
      };
      stage = "verify";
      verify(response);
      stage = "read_back";
      const confirmed = await this.api(connection, `${path}/self?include[]=submission_comments`);
      verify(confirmed);
      if (input.text && (typeof confirmed.body !== "string" || visibleText(confirmed.body) !== visibleText(body!))) return fail("Text submission needs manual verification.");
      if (input.comment && !(Array.isArray(confirmed.submission_comments) && confirmed.submission_comments.some(raw => {
        const comment = object(raw);
        return /^\d+$/.test(String(comment.id)) && !previousComments.has(String(comment.id)) && String(comment.author_id) === connection.canvasUserId && comment.comment === input.comment;
      }))) return fail("Submission comment was not confirmed.");
      const result = submissionReceiptSchema.parse({ status: "submitted", requestId: input.request_id, courseId: input.course_id,
        assignmentId: input.assignment_id, userId: connection.canvasUserId, attempt: confirmed.attempt, submittedAt: confirmed.submitted_at,
        submissionType: input.submission_type, fileIds: input.file_ids ?? [], commentIncluded: Boolean(input.comment) });
      this.ledger.finish(userId, input.request_id, result);
      return result;
    } catch (error) {
      this.ledger.finish(userId, input.request_id);
      log("error", "canvas_submission_outcome_unknown", { error, code: errorCode(error), stage, userId, requestId: input.request_id, institution: connection.institution });
      throw new CanvasApiError("canvas_error", "Submission outcome is unknown. Read the assignment's own submission in LMS; do not submit again automatically.");
    }
  }
}
