import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDatabase, type AppDatabase } from "../src/db/index.js";
import { CanvasWriteService, readBytes, visibleText } from "../src/canvas/writes.js";
import { listUnresolvedWriteReceipts, resolveWriteReceipt, RESOLVE_MIN_PENDING_AGE_MS, WriteLedger } from "../src/canvas/writeLedger.js";
import { CanvasMessageService } from "../src/canvas/messages.js";
import { createCanvasMcpServer } from "../src/mcp/server.js";
import type { CanvasConnection } from "../src/domain.js";

const connection: CanvasConnection = { userId: "u", institution: "hanyang", baseUrl: "https://learning.hanyang.ac.kr", accessToken: "test-only-pat", canvasUserId: "42", canvasName: "Student" };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const file = { file_id: "file-test", download_url: "https://files.oaiusercontent.com/test?secret=signed", mime_type: "application/pdf", file_name: "이수증.pdf" };
const upload = { request_id: uuid(1), purpose: "assignment" as const, course_id: "123", assignment_id: "456", filename: "이수증.pdf", file };
const submission = { request_id: uuid(2), course_id: "123", assignment_id: "456", expected_attempt: 0, submission_type: "online_upload" as const, file_ids: ["88"], comment: "Completion certificate" };
const databases: AppDatabase[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

type SetupOptions = { assignment?: Record<string, unknown>; current?: Record<string, unknown>; outcome?: "transport" | "bad_files" | "bad_comment" | "redirect"; uploadDestination?: string; confirmation?: string; school?: "hanyang" | "berkeley"; storedBody?: (sent: string) => string; ticketStatus?: number };
function setup(options: SetupOptions = {}) {
  const db = openDatabase(":memory:"); databases.push(db);
  db.prepare("INSERT INTO users(id,display_name,institution,created_at,updated_at) VALUES('u','Student',?,1,1)").run(options.school ?? 'hanyang');
  const identity = { ...connection, ...(options.school === "berkeley" ? { institution: "berkeley" as const, baseUrl: "https://bcourses.berkeley.edu" } : {}) };
  let submitted: Record<string, unknown> | undefined;
  let sent = false;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const parsed = new URL(String(url)), path = parsed.pathname;
    if (parsed.hostname === "files.oaiusercontent.com") {
      expect(init?.headers).toBeUndefined();
      return new Response("%PDF-test");
    }
    if (path === "/upload") {
      expect(init?.headers).toBeUndefined();
      expect(init?.redirect).toBe("manual");
      const form = init?.body as FormData;
      expect([...form.keys()]).toEqual(["key", "file"]);
      expect(await (form.get("file") as File).text()).toBe("%PDF-test");
      return new Response(null, { status: 302, headers: { Location: options.confirmation ?? `${identity.baseUrl}/api/v1/files/88/create_success?uuid=secret` } });
    }
    if (path.endsWith("/files") && init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toMatchObject({ name: "이수증.pdf", size: 9, on_duplicate: "rename" });
      if (path.includes("/submissions/")) expect(JSON.parse(String(init.body)).submit_assignment).toBe(false);
      if (options.ticketStatus) return Response.json({ errors: [] }, { status: options.ticketStatus });
      return Response.json({ upload_url: options.uploadDestination ?? `${identity.baseUrl}/upload`, upload_params: { key: "signed-key" } });
    }
    if (path.includes("/files/88")) return Response.json({ id: 88, size: 9, hidden: true, locked_for_user: false });
    if (path.endsWith("/submissions") && init?.method === "POST") {
      if (options.outcome === "transport") throw new Error("secret-network-error");
      if (options.outcome === "redirect") return new Response(null, { status: 302, headers: { Location: "https://evil.test" } });
      const payload = JSON.parse(String(init.body));
      submitted = { user_id: 42, assignment_id: 456, attempt: 1, workflow_state: "submitted", submitted_at: "2026-09-21T01:00:00Z", submission_type: payload.submission.submission_type, body: payload.submission.body && options.storedBody ? options.storedBody(payload.submission.body) : payload.submission.body,
        attachments: [{ id: options.outcome === "bad_files" ? 89 : 88 }], submission_comments: options.outcome === "bad_comment" ? [] : [{ id: 17, author_id: 42, comment: payload.comment?.text_comment }] };
      return Response.json(submitted);
    }
    if (path.endsWith("/submissions/self")) return Response.json(submitted ?? { user_id: 42, assignment_id: 456, attempt: null, workflow_state: "unsubmitted", ...options.current });
    if (path.includes("/assignments/")) return Response.json({ id: 456, course_id: 123, published: true, locked_for_user: false, allowed_attempts: 3, submission_types: ["online_upload", "online_text_entry"], allowed_extensions: ["pdf"], ...options.assignment });
    if (path.includes("/conversations")) {
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({ attachment_ids: ["88"], recipients: ["7"], body: "Certificate attached" });
        sent = true; return Response.json([{ id: 99 }]);
      }
      expect(parsed.searchParams.get("auto_mark_as_read")).toBe("false");
      return Response.json({ id: 99, audience: [7], participants: [{ id: 7, name: "Teacher" }], messages: sent ? [{ id: 555, author_id: 42, body: "Certificate attached", attachments: [{ id: 88 }] }] : [] });
    }
    return Response.json({ id: 123, name: "Course", teachers: [{ id: 7, display_name: "Teacher" }] });
  });
  const writes = new CanvasWriteService(db, () => identity, fetcher);
  const messages = new CanvasMessageService(db, () => identity, fetcher, writes);
  return { db, fetcher, writes, messages, identity };
}

describe("selected file uploads and explicit assignment submissions", () => {
  it("supports inspected client file origins without allowing lookalikes or exposing signed URLs", async () => {
    const {db, identity, fetcher}=setup();
    const original=fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async(url, init)=>new URL(String(url)).origin==='https://work-files.example.test' ? new Response('%PDF-test') : original(url,init));
    const writes=new CanvasWriteService(db,()=>identity,fetcher,{},['https://work-files.example.test']);
    await expect(writes.upload('u',{...upload,file:{...file,download_url:'https://work-files.example.test/private?signature=do-not-disclose'}})).resolves.toMatchObject({status:'uploaded'});
    const rejected=setup();
    await expect(rejected.writes.upload('u',{...upload,file:{...file,download_url:'https://work-files.example.test/private?signature=do-not-disclose'}})).rejects.toThrow('origin is not enabled: https://work-files.example.test. Rejected before any LMS upload.');
    expect(rejected.fetcher.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false);
  });
  it("enforces the streaming limit even without Content-Length", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); },
      cancel,
    });
    await expect(readBytes(new Response(stream), 8)).rejects.toThrow("size");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each(["hanyang", "berkeley"] as const)("%s uploads then submits a PDF and preserves receipts on retries", async school => {
    const { writes, fetcher, db } = setup({ school });
    expect(await writes.upload("u", upload)).toMatchObject({ status: "uploaded", fileId: "88", filename: "이수증.pdf", size: 9 });
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/submissions"))).toBe(false);
    expect(await writes.submit("u", submission)).toMatchObject({ status: "submitted", fileIds: ["88"], commentIncluded: true, attempt: 1 });
    const calls = fetcher.mock.calls.length;
    await writes.upload("u", { ...upload, file: { ...file, download_url: "https://files.oaiusercontent.com/refreshed" } });
    await writes.submit("u", submission);
    expect(fetcher).toHaveBeenCalledTimes(calls);
    const stored = JSON.stringify(db.prepare("SELECT * FROM canvas_write_receipts").all());
    for (const secret of ["signed-key", "secret=signed", connection.accessToken, submission.comment, "%PDF-test"]) expect(stored).not.toContain(secret);
  });
  it("supports escaped plain text entries", async () => {
    const { writes } = setup();
    expect(await writes.submit("u", { ...submission, submission_type: "online_text_entry", file_ids: undefined, text: "A < B\nC & D" })).toMatchObject({ status: "submitted", fileIds: [] });
  });
  it("confirms text that Canvas re-serialized with decoded quotes and spacing", async () => {
    // Canvas sanitizes submission HTML; quotes come back unescaped and spacing can change.
    const storedBody = (sent: string) => sent.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("<br>", "<br />\n").replace("<p>", '<p dir="ltr">');
    const { writes, db } = setup({ storedBody });
    const text = `I'm done — "final" draft\nA < B & C\n다 했습니다`;
    expect(await writes.submit("u", { ...submission, submission_type: "online_text_entry", file_ids: undefined, text })).toMatchObject({ status: "submitted" });
    expect(db.prepare("SELECT status FROM canvas_write_receipts").get()).toEqual({ status: "complete" });
  });
  it("still reports unknown when the stored text differs", async () => {
    const { writes } = setup({ storedBody: () => "<p>Something else</p>" });
    await expect(writes.submit("u", { ...submission, submission_type: "online_text_entry", file_ids: undefined, text: "My answer" })).rejects.toThrow("outcome is unknown");
  });
  it("normalizes visible text without trusting markup", () => {
    expect(visibleText("<p>I&#39;m &quot;ok&quot; &amp; A &lt;b&gt;<br/>next&#x21;&nbsp;</p>")).toBe(`I'm "ok" & A <b> next!`);
    expect(visibleText("&bogus; &#0; &#x110000;")).toBe("&bogus; &#0; &#x110000;");
  });
  it("releases an upload that failed before any bytes were sent", async () => {
    const options: SetupOptions = { uploadDestination: "https://evil.test/upload" };
    const { writes, fetcher, db } = setup(options);
    await expect(writes.upload("u", upload)).rejects.toThrow("destination is not approved");
    expect(db.prepare("SELECT COUNT(*) AS count FROM canvas_write_receipts").get()).toEqual({ count: 0 });
    delete options.uploadDestination;
    await expect(writes.upload("u", upload)).resolves.toMatchObject({ status: "uploaded", fileId: "88" });
    expect(fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/upload")).toHaveLength(1);
    const rejectedTicket = setup({ ticketStatus: 500 });
    await expect(rejectedTicket.writes.upload("u", upload)).rejects.toThrow("no file bytes were sent");
    expect(rejectedTicket.db.prepare("SELECT COUNT(*) AS count FROM canvas_write_receipts").get()).toEqual({ count: 0 });
  });
  it("logs unknown outcomes without message text, errors or credentials", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { writes } = setup({ outcome: "transport" });
      await writes.upload("u", upload);
      await expect(writes.submit("u", submission)).rejects.toThrow("outcome is unknown");
      const line = errors.mock.calls.map(call => String(call[0])).find(text => text.includes("canvas_submission_outcome_unknown"))!;
      expect(JSON.parse(line)).toMatchObject({ level: "error", stage: "post", requestId: submission.request_id, institution: "hanyang" });
      for (const secret of [submission.comment, connection.accessToken, "secret-network-error", "signed-key"]) expect(line).not.toContain(secret);
    } finally { errors.mockRestore(); }
  });
  it.each(["transport", "bad_files", "bad_comment", "redirect"] as const)("never resubmits after %s uncertainty", async outcome => {
    const { writes, fetcher } = setup({ outcome });
    await writes.upload("u", upload);
    await expect(writes.submit("u", submission)).rejects.toThrow("outcome is unknown");
    await expect(writes.submit("u", submission)).rejects.toThrow("unknown");
    await expect(writes.submit("u", { ...submission, request_id: uuid(3), expected_attempt: outcome === "bad_files" || outcome === "bad_comment" ? 1 : 0 })).rejects.toThrow();
    expect(fetcher.mock.calls.filter(([url, init]) => String(url).endsWith("/submissions") && init?.method === "POST")).toHaveLength(1);
  });
  it.each([{ locked_for_user: true }, { locked_for_user: null }, { group_category_id: 9 }, { is_quiz_assignment: true }, { submission_types: ["external_tool"] }, { unlock_at: "2099-01-01T00:00:00Z" }, { lock_at: "2020-01-01T00:00:00Z" }, { allowed_extensions: ["docx"] }])("rejects ineligible assignment before uploading: %j", async assignment => {
    const { writes, fetcher } = setup({ assignment });
    await expect(writes.upload("u", upload)).rejects.toThrow();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
  it("blocks changed attempts, exhausted attempts and unverified file IDs", async () => {
    for (const options of [{ current: { attempt: 1 } }, { assignment: { allowed_attempts: 0 } }]) {
      const { writes, fetcher } = setup(options);
      await writes.upload("u", upload);
      await expect(writes.submit("u", submission)).rejects.toThrow();
      expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith("/submissions") && init?.method === "POST")).toBe(false);
    }
    await expect(setup().writes.submit("u", submission)).rejects.toThrow("not uploaded by this account");
  });
  it("does not leak credentials or files through arbitrary source, storage or confirmation URLs", async () => {
    for (const download_url of ["http://files.oaiusercontent.com/f", "https://files.oaiusercontent.com.evil.test/f", "https://127.0.0.1/f", "https://user:pass@files.oaiusercontent.com/f"]) {
      const { writes, fetcher } = setup();
      await expect(writes.upload("u", { ...upload, file: { ...file, download_url } })).rejects.toThrow();
      expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    }
    for (const [options, error] of [[{ uploadDestination: "https://evil.test/upload" }, "destination is not approved"], [{ confirmation: "https://evil.test/api/v1/files/88/create_success" }, "outcome is unknown"], [{ confirmation: `${connection.baseUrl}/api/v1/conversations/mark_all_as_read` }, "outcome is unknown"]] as const) {
      const { writes, fetcher } = setup(options);
      await expect(writes.upload("u", upload)).rejects.toThrow(error);
      expect(fetcher.mock.calls.some(([url]) => String(url).includes("evil.test") || String(url).includes("mark_all_as_read"))).toBe(false);
    }
  });
  it("rejects oversized downloads before creating an LMS file", async () => {
    const { writes, fetcher } = setup();
    fetcher.mockImplementation(async () => new Response("x", { headers: { "content-length": String(21 * 1024 * 1024) } }));
    await expect(writes.upload("u", { ...upload, purpose: "message", course_id: undefined, assignment_id: undefined })).rejects.toThrow("size");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("prevents duplicate concurrent submissions", async () => {
    const { writes, fetcher } = setup(); await writes.upload("u", upload);
    await Promise.allSettled([writes.submit("u", submission), writes.submit("u", { ...submission, request_id: uuid(3) })]);
    expect(fetcher.mock.calls.filter(([url, init]) => String(url).endsWith("/submissions") && init?.method === "POST")).toHaveLength(1);
  });
  it("binds file receipts to their account, school and assignment purpose", async () => {
    const { writes, identity, fetcher } = setup(); await writes.upload("u", upload);
    await expect(writes.verifyFiles("u", ["88"], "message")).rejects.toThrow("not uploaded");
    await expect(writes.verifyFiles("u", ["88"], "assignment", "123", "999")).rejects.toThrow("not uploaded");
    identity.canvasUserId = "43";
    await expect(writes.verifyFiles("u", ["88"], "assignment", "123", "456")).rejects.toThrow("not uploaded");
    const other = setup({ school: "berkeley" });
    other.identity.baseUrl = connection.baseUrl;
    await expect(other.writes.upload("u", upload)).rejects.toThrow("school account");
    expect(other.fetcher).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalled();
  });
  it.each([["hanyang", "send"], ["hanyang", "reply"], ["berkeley", "send"], ["berkeley", "reply"]] as const)("%s uploads a message attachment and verifies %s receipt", async (school, kind) => {
    const { writes, messages, fetcher } = setup({ school });
    await writes.upload("u", { ...upload, purpose: "message", course_id: undefined, assignment_id: undefined });
    const input = { request_id: uuid(4), recipient_id: "7", body: "Certificate attached", attachment_ids: ["88"], ...(kind === "send" ? { course_id: "123", subject: "Certificate" } : { conversation_id: "99" }) };
    expect(await messages.deliver("u", kind, input as never)).toMatchObject({ status: "sent", attachmentIds: ["88"] });
    const calls = fetcher.mock.calls.length;
    await messages.deliver("u", kind, input as never);
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });
  it("does not report attachment delivery from a POST alone, or resend after failed read-back", async () => {
    const { writes, messages, fetcher, db } = setup();
    await writes.upload("u", { ...upload, purpose: "message", course_id: undefined, assignment_id: undefined });
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => {
      if (String(url).includes("/conversations/99") && init?.method !== "POST") return Response.json({ id: 99, audience: [7], messages: [] });
      return original(url, init);
    });
    const input = { request_id: uuid(4), recipient_id: "7", body: "Certificate attached", attachment_ids: ["88"], course_id: "123", subject: "Certificate" };
    await expect(messages.deliver("u", "send", input)).rejects.toThrow("unknown");
    await expect(messages.deliver("u", "send", input)).rejects.toThrow("unknown");
    expect(fetcher.mock.calls.filter(([url, init]) => String(url).endsWith("/conversations") && init?.method === "POST")).toHaveLength(1);
    expect(db.prepare("SELECT status FROM canvas_message_receipts").get()).toEqual({ status: "unknown" });
  });
  it.each(["hanyang", "berkeley"] as const)("%s discovers the shared file and message contracts", async school => {
    const { writes, messages, fetcher } = setup();
    const server = createCanvasMcpServer({ userId: "u", getConnection: () => connection, fetch: fetcher, writeService: writes, messageService: messages });
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const list = await client.listTools();
      const tool = list.tools.find(tool => tool.name === "upload_canvas_file")!;
      expect(tool._meta?.["openai/fileParams"]).toEqual(["file"]);
      const schema = tool.inputSchema.properties?.file as { required: string[]; properties: Record<string, unknown> };
      expect(schema.required).toEqual(["download_url", "file_id"]);
      expect(Object.keys(schema.properties).sort()).toEqual(["download_url", "file_id", "file_name", "mime_type"]);
      expect(list.tools.find(tool => tool.name === "submit_assignment")?._meta?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["canvas.read"] }]);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  });
});

describe("administrative reconciliation of unknown writes", () => {
  const old = (db: AppDatabase) => db.prepare("UPDATE canvas_write_receipts SET created_at = created_at - ?").run(RESOLVE_MIN_PENDING_AGE_MS + 1);
  const posts = (fetcher: ReturnType<typeof setup>["fetcher"]) => fetcher.mock.calls.filter(([url, init]) => String(url).endsWith("/submissions") && init?.method === "POST").length;

  it("unlocks a target only after the LMS record is reconciled as not applied", async () => {
    const options: SetupOptions = { outcome: "transport" };
    const { writes, fetcher, db } = setup(options);
    await writes.upload("u", upload);
    await expect(writes.submit("u", submission)).rejects.toThrow("outcome is unknown");
    await expect(writes.submit("u", { ...submission, request_id: uuid(3) })).rejects.toThrow("pending or unknown");
    expect(listUnresolvedWriteReceipts(db)).toEqual([expect.objectContaining({ userId: "u", requestId: submission.request_id, kind: "submit", status: "unknown" })]);
    expect(resolveWriteReceipt(db, "u", submission.request_id, "not_applied")).toEqual({ requestId: submission.request_id, kind: "submit", outcome: "not_applied" });
    delete options.outcome;
    await expect(writes.submit("u", { ...submission, request_id: uuid(3) })).resolves.toMatchObject({ status: "submitted" });
    expect(posts(fetcher)).toBe(2);
    expect(listUnresolvedWriteReceipts(db)).toEqual([]);
  });

  it("keeps an applied operation answered without inventing a receipt", async () => {
    const options: SetupOptions = { confirmation: "https://evil.test/api/v1/files/88/create_success" };
    const { writes, db } = setup(options);
    await expect(writes.upload("u", upload)).rejects.toThrow("outcome is unknown");
    resolveWriteReceipt(db, "u", upload.request_id, "applied");
    await expect(writes.upload("u", upload)).rejects.toThrow("administrator confirmed");
    expect(() => resolveWriteReceipt(db, "u", upload.request_id, "not_applied")).toThrow("already complete");
    // The same file can be uploaded again under a new request, and receipt-less rows are never treated as verified files.
    delete options.confirmation;
    await writes.upload("u", { ...upload, request_id: uuid(5) });
    await expect(writes.submit("u", submission)).resolves.toMatchObject({ status: "submitted", fileIds: ["88"] });
  });

  it("refuses to resolve a possibly running operation or a missing receipt", () => {
    const { db } = setup();
    new WriteLedger(db).claim("u", uuid(6), "submit", "f", "42:123:456");
    expect(() => resolveWriteReceipt(db, "u", uuid(6), "not_applied")).toThrow("may still be running");
    old(db);
    expect(resolveWriteReceipt(db, "u", uuid(6), "not_applied")).toMatchObject({ outcome: "not_applied" });
    expect(() => resolveWriteReceipt(db, "u", uuid(6), "applied")).toThrow("No write receipt");
  });
});
