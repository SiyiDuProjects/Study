import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type AppDatabase } from "../src/db/index.js";
import { chatGptFileSource } from "../src/canvas/fileSources.js";
import { CanvasWriteService } from "../src/canvas/writes.js";
import type { CanvasConnection } from "../src/domain.js";

const fileId = "file-generated-pdf";
const signedUrl = `https://chatgpt.com/backend-api/estuary/content?id=${fileId}&ts=123&sig=test-only-signature&v=0`;
const cdnOrigins = ["https://files.oaiusercontent.com", "https://sdmntprwestus3.oaiusercontent.com"];
const databases: AppDatabase[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

describe("ChatGPT generated file handoff", () => {
  it("accepts the observed signed endpoint without broadening the configured CDN origins", () => {
    expect(chatGptFileSource(signedUrl, fileId, cdnOrigins).toString()).toBe(signedUrl);
    for (const origin of cdnOrigins) expect(chatGptFileSource(`${origin}/file?sig=cdn`, fileId, cdnOrigins).origin).toBe(origin);
  });

  it.each([
    signedUrl.replace("chatgpt.com/", "chatgpt.com.evil.test/"),
    signedUrl.replace("chatgpt.com/", "chatgpt.com:8443/"),
    signedUrl.replace("https:", "http:"),
    signedUrl.replace("https://", "https://user:password@"),
    `${signedUrl}#fragment`,
    signedUrl.replace("/backend-api/estuary/content", "/backend-api/me"),
    signedUrl.replace("/content?", "/content/?"),
    signedUrl.replace("/content?", "/%63ontent?"),
    signedUrl.replace(`id=${fileId}`, "id=file-other"),
    `${signedUrl}&id=${fileId}`,
    signedUrl.replace("sig=test-only-signature", "sig="),
    signedUrl.replace("&sig=test-only-signature", ""),
    `${signedUrl}&sig=another-signature`,
    "sandbox:/mnt/data/homework.pdf",
  ])("rejects an untrusted or mismatched file reference (%#)", raw => {
    expect(() => chatGptFileSource(raw, fileId, [...cdnOrigins, "https://chatgpt.com"])).toThrow();
    try { chatGptFileSource(raw, fileId, cdnOrigins); }
    catch (error) { expect(String(error)).not.toContain("test-only-signature"); }
  });

  function setup(school: "hanyang" | "berkeley", sourceStatus = 200) {
    const db = openDatabase(":memory:"); databases.push(db);
    db.prepare("INSERT INTO users(id,display_name,institution,created_at,updated_at) VALUES('u','Student',?,1,1)").run(school);
    const baseUrl = school === "hanyang" ? "https://learning.hanyang.ac.kr" : "https://bcourses.berkeley.edu";
    const connection: CanvasConnection = { userId: "u", institution: school, baseUrl, accessToken: "test-only-pat", canvasUserId: "42", canvasName: "Student" };
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.origin === "https://chatgpt.com") {
        expect(init?.headers).toBeUndefined();
        expect(init?.credentials).toBe("omit");
        expect(init?.redirect).toBe("manual");
        return sourceStatus === 200 ? new Response("%PDF-test", { headers: { "Content-Type": "application/pdf" } })
          : new Response(null, { status: sourceStatus, headers: { Location: "https://evil.test/download" } });
      }
      if (parsed.pathname === "/api/v1/courses/123/assignments/456") return Response.json({ id: 456, course_id: 123, published: true, locked_for_user: false, submission_types: ["online_upload"], allowed_extensions: ["pdf"] });
      if (parsed.pathname.endsWith("/submissions/self/files")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toMatchObject({ name: "homework.pdf", submit_assignment: false });
        return Response.json({ upload_url: `${baseUrl}/upload`, upload_params: { key: "test-only-storage-key" } });
      }
      if (parsed.pathname === "/upload") {
        expect(init?.headers).toBeUndefined();
        expect(await ((init?.body as FormData).get("file") as File).text()).toBe("%PDF-test");
        return Response.json({ id: 88, size: 9 });
      }
      throw new Error("Unexpected request");
    });
    const writes = new CanvasWriteService(db, () => connection, fetcher, {}, cdnOrigins);
    const input = { request_id: "d9aa433a-976a-44e3-8519-e2a615f1950c", filename: "homework.pdf", purpose: "assignment" as const, course_id: "123", assignment_id: "456", file: { file_id: fileId, download_url: signedUrl, mime_type: "application/pdf" } };
    return { db, writes, input, fetcher };
  }

  it.each(["hanyang", "berkeley"] as const)("%s transfers the generated PDF once, without submitting it or persisting its URL", async school => {
    const { db, writes, input, fetcher } = setup(school);
    await expect(writes.upload("u", input)).resolves.toMatchObject({ status: "uploaded", fileId: "88", size: 9 });
    const calls = fetcher.mock.calls.length;
    await writes.upload("u", { ...input, file: { ...input.file, download_url: signedUrl.replace("test-only-signature", "renewed") } });
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(fetcher.mock.calls.some(([url]) => new URL(String(url)).pathname.endsWith("/submissions"))).toBe(false);
    const stored = JSON.stringify(db.prepare("SELECT * FROM canvas_write_receipts").all());
    for (const value of ["test-only-signature", "chatgpt.com", "%PDF-test", "test-only-pat"]) expect(stored).not.toContain(value);
  });

  it.each([302, 401, 403])("rejects a failed/redirected file download (%s) before any LMS write", async status => {
    const { db, writes, input, fetcher } = setup("hanyang", status);
    await expect(writes.upload("u", input)).rejects.toThrow("selected ChatGPT file is unavailable");
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(fetcher.mock.calls.some(([url]) => new URL(String(url)).hostname === "evil.test")).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canvas_write_receipts").get()).toEqual({ count: 0 });
  });
});
