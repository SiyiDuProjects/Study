import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppDatabase } from "../db/index.js";
import { INSTITUTIONS, type CanvasConnection } from "../domain.js";
import { log } from "../logger.js";
import { CanvasRestClient } from "./client.js";
import { CanvasApiError } from "./errors.js";
import { type CanvasWriteService, readBytes } from "./writes.js";
import { fileIdsSchema } from "./writeContracts.js";
import { requireCanvasConnection } from "./connection.js";

const id = z.string().regex(/^[1-9]\d*$/).max(30);
const common = {
  request_id: z.string().uuid().describe("Stable idempotency ID for this explicit user send request. Reuse on every retry."),
  recipient_id: id.describe("Exact teacher or conversation participant Canvas user ID; never infer from a name alone."),
  body: z.string().trim().min(1).max(20000),
  attachment_ids: fileIdsSchema.optional().describe("Optional message-purpose file IDs returned by upload_canvas_file for this account."),
};
export const sendMessageSchema = z.object({ ...common, course_id: id, subject: z.string().trim().min(1).max(255) }).strict();
export const replyMessageSchema = z.object({ ...common, conversation_id: id }).strict();
export type MessageInput = z.infer<typeof sendMessageSchema> | z.infer<typeof replyMessageSchema>;
export const receiptSchema = z.object({ conversationIds: z.array(id).min(1), recipientId: id, requestId: z.string().uuid(), status: z.literal("sent"), attachmentIds: z.array(id).optional() }).strict();

/** No raw message text or credentials are persisted in the delivery ledger. */
export class CanvasMessageService {
  constructor(private readonly db: AppDatabase, private readonly getConnection: (userId: string) => CanvasConnection | null | Promise<CanvasConnection | null>, private readonly fetcher: typeof fetch = fetch, private readonly files?: CanvasWriteService) {}

  async deliver(userId: string, kind: "send" | "reply", raw: MessageInput) {
    const parsed = kind === "send" ? sendMessageSchema.parse(raw) : replyMessageSchema.parse(raw);
    const { attachment_ids, ...input } = parsed;
    if (attachment_ids && !this.files) throw new CanvasApiError("permission_denied", "Attachment sending is not enabled.");
    return this.deliverInternal(userId, kind, input, attachment_ids);
  }

  private async deliverInternal(userId: string, kind: "send" | "reply", raw: MessageInput, attachmentIds?: string[]) {
    const input = kind === "send" ? sendMessageSchema.parse(raw) : replyMessageSchema.parse(raw);
    const connection = requireCanvasConnection(await this.getConnection(userId), userId);
    const fingerprint = createHash("sha256").update(JSON.stringify({ kind, input, canvasUserId: connection.canvasUserId, ...(attachmentIds ? { attachmentIds } : {}) })).digest("hex");
    const previous = this.db.prepare("SELECT fingerprint,status,result_json FROM canvas_message_receipts WHERE user_id=? AND request_id=?").get(userId, input.request_id) as {fingerprint:string;status:string;result_json:string|null}|undefined;
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new CanvasApiError("invalid_argument", "This request ID was already used with different content. Do not resend automatically.");
      if (previous.status === "sent" && previous.result_json) return receiptSchema.parse(JSON.parse(previous.result_json));
      throw new CanvasApiError("canvas_error", `Delivery is ${previous.status}. Inspect Sent messages before considering a new request; do not retry automatically.`);
    }
    if (input.recipient_id === connection.canvasUserId) throw new CanvasApiError("invalid_argument", "Select a recipient other than yourself.");
    const reader = new CanvasRestClient(connection, { fetch: this.fetcher });
    const previousMessageIds = new Set<string>();
    if ("course_id" in input) {
      const course = await reader.getCourse(input.course_id);
      if (!course.teachers.some(teacher => teacher.id === input.recipient_id)) throw new CanvasApiError("permission_denied", "Recipient must be a verified teacher of the selected course.");
    } else {
      const conversation = await reader.getConversation(input.conversation_id);
      for (const message of conversation.messages) previousMessageIds.add(message.id);
      if (!conversation.participants.some(participant => participant.id === input.recipient_id)) throw new CanvasApiError("permission_denied", "Recipient must be an existing participant in this conversation.");
    }
    if (attachmentIds) await this.files!.verifyFiles(userId, attachmentIds, "message");
    // Atomically claim before POST. A crash or competing request cannot send twice.
    const claim = this.db.prepare("INSERT OR IGNORE INTO canvas_message_receipts(user_id,request_id,fingerprint,status,created_at) VALUES(?,?,?,'pending',?)").run(userId,input.request_id,fingerprint,Date.now());
    if (!claim.changes) throw new CanvasApiError("canvas_error", "This send request is already being processed. Inspect its result before retrying.");
    const update = (status: string, result: unknown = null) => this.db.prepare("UPDATE canvas_message_receipts SET status=?,result_json=? WHERE user_id=? AND request_id=?").run(status,result ? JSON.stringify(result) : null,userId,input.request_id);
    const payload: Record<string, unknown> = { recipients: [input.recipient_id], body: input.body };
    if (attachmentIds) payload.attachment_ids = attachmentIds;
    const path = "course_id" in input ? "/api/v1/conversations" : `/api/v1/conversations/${input.conversation_id}/add_message`;
    if ("course_id" in input) Object.assign(payload, { subject: input.subject, context_code: `course_${input.course_id}`, force_new: true, group_conversation: false, mode: "sync" });
    let rejectionRecorded = false;
    let stage: "post" | "read_back" = "post";
    try {
      const response = await this.fetcher(new URL(path, INSTITUTIONS[connection.institution].baseUrl), {
        method: "POST", headers: { Authorization: `Bearer ${connection.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload), redirect: "manual", signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        update(response.status >= 400 && response.status < 500 && response.status !== 408 ? "failed" : "unknown");
        rejectionRecorded = true;
        throw new CanvasApiError("canvas_error", "Canvas did not confirm message delivery. Inspect Sent before another send.", { status: response.status });
      }
      const text = (await readBytes(response, 1_000_000)).toString("utf8");
      const data: unknown = JSON.parse(text);
      const rows = Array.isArray(data) ? data : [data];
      const conversationIds = rows.map(row => id.parse(String((row as {id?: unknown})?.id)));
      if (attachmentIds) {
        if (conversationIds.length !== 1) throw new Error("Unexpected recipient result");
        stage = "read_back";
        const confirmed = await this.fetcher(new URL(`/api/v1/conversations/${conversationIds[0]}?auto_mark_as_read=false`, connection.baseUrl), {
          headers: { Authorization: `Bearer ${connection.accessToken}` }, redirect: "manual", signal: AbortSignal.timeout(15000),
        });
        if (!confirmed.ok) throw new Error("Unconfirmed message");
        const detail = JSON.parse((await readBytes(confirmed, 1_000_000)).toString("utf8")) as { audience?: unknown[]; messages?: { id?: unknown; author_id?: unknown; body?: unknown; attachments?: { id?: unknown }[] }[] };
        if (!detail.audience?.some(recipient => String(recipient) === input.recipient_id) || !detail.messages?.slice(0, 1).some(message =>
          /^[1-9]\d*$/.test(String(message.id)) && !previousMessageIds.has(String(message.id)) && String(message.author_id) === connection.canvasUserId && message.body === input.body &&
          JSON.stringify(message.attachments?.map(file => String(file.id)).sort()) === JSON.stringify([...attachmentIds].sort()))) throw new Error("Attachments unconfirmed");
      }
      const result = receiptSchema.parse({ conversationIds, recipientId: input.recipient_id, requestId: input.request_id, status: "sent", ...(attachmentIds ? { attachmentIds } : {}) });
      update("sent", result);
      return result;
    } catch (error) {
      const diagnostic = { error, stage, kind, userId, requestId: input.request_id, institution: connection.institution };
      if (rejectionRecorded && error instanceof CanvasApiError) {
        log("warn", "canvas_message_rejected", diagnostic);
        throw error;
      }
      update("unknown");
      log("error", "canvas_message_outcome_unknown", diagnostic);
      throw new CanvasApiError("network_error", "Delivery outcome is unknown. Do not resend automatically; inspect Sent messages first.");
    }
  }
}
