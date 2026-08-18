// @vitest-environment node
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CourseOption } from "../shared/courses.js";
import { AuthFailure, createPublicOwnerAuthenticator, type BrowserAuthenticator } from "./auth.js";
import { createServerApp } from "./app.js";
import { openDatabase, RECOVERED_SESSION_WARNING, type SqliteDatabase } from "./db.js";

describe("Study Lecture server", () => {
  let db: SqliteDatabase;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    ({ db, server, baseUrl } = await startTestServer(async () => ({ email: "owner@example.com" })));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    db.close();
  });

  it("serves dynamic Hanyang courses", async () => {
    const response = await fetch(`${baseUrl}/api/courses`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { courses: Array<{ id: string }>; stale: boolean };
    expect(body.courses.map((item) => item.id)).toEqual(["daily", "canvas_123"]);
    expect(body.stale).toBe(false);
  });

  it("accepts zero academic courses as a successful state", async () => {
    const zero = await startTestServer(async () => ({ email: "owner@example.com" }), []);
    try {
      const response = await fetch(`${zero.baseUrl}/api/courses`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { courses: Array<{ id: string }>; stale: boolean };
      expect(body.courses.map((item) => item.id)).toEqual(["daily"]);
      expect(body.stale).toBe(false);
    } finally {
      await new Promise<void>((resolve) => zero.server.close(() => resolve()));
      zero.db.close();
    }
  });

  it("creates server-owned sessions and checkpoints segments idempotently", async () => {
    const created = await createSession(baseUrl, "canvas_123");
    expect(created.courseName).toBe("서버 강의명");
    expect(created.status).toBe("recording");
    const secondDevice = await fetch(`${baseUrl}/api/sessions`, jsonPost({
      courseId: "canvas_123",
      startedAt: "2026-08-18T01:01:00.000Z",
      models: { translation: "gpt-realtime-translate", transcription: "gpt-realtime-whisper" }
    }));
    expect(secondDevice.status).toBe(409);

    const checkpoint = {
      durationMs: 3_000,
      segments: [{
        id: "seg_1", startedAtMs: 0, endedAtMs: 3_000,
        sourceText: "과제 설명", translatedText: "作业说明", isFinal: true,
        createdAt: "2026-08-18T01:00:00.000Z", updatedAt: "2026-08-18T01:00:03.000Z"
      }]
    };
    let revision = created.revision;
    for (let count = 0; count < 2; count += 1) {
      const response = await fetch(`${baseUrl}/api/sessions/${created.id}/checkpoint`, jsonPost({
        ...checkpoint,
        writerLeaseToken: created.writerLeaseToken,
        expectedRevision: revision
      }));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { session: { revision: number } };
      revision = body.session.revision;
    }
    const complete = await fetch(
      `${baseUrl}/api/sessions/${created.id}/complete`,
      jsonPost({
        endedAt: "2026-08-18T01:10:00.000Z",
        durationMs: 600_000,
        segments: [],
        writerLeaseToken: created.writerLeaseToken,
        expectedRevision: revision
      })
    );
    expect(complete.status).toBe(200);

    const detail = await fetch(`${baseUrl}/api/sessions/${created.id}`);
    const detailBody = (await detail.json()) as { session: { status: string; segments: unknown[] } };
    expect(detailBody.session.status).toBe("ready");
    expect(detailBody.session.segments).toHaveLength(1);

    const search = await fetch(`${baseUrl}/internal/mcp/lecture/search?q=${encodeURIComponent("作业")}`, {
      headers: { Authorization: "Bearer lecture-test-token" }
    });
    expect(search.status).toBe(200);
    expect(search.headers.get("cache-control")).toBe("no-store");
    const searchBody = (await search.json()) as { hits: Array<Record<string, unknown>> };
    expect(searchBody.hits[0]).toMatchObject({ sessionId: created.id, translatedText: "作业说明" });
    expect(searchBody.hits[0]).not.toHaveProperty("createdByEmail");
  });

  it("lets the same writer safely recover a response-lost checkpoint before idempotent resend", async () => {
    const created = await createSession(baseUrl, "canvas_123");
    const segment = {
      id: "seg_response_lost", startedAtMs: 0, endedAtMs: 2_000,
      sourceText: "응답 유실", translatedText: "响应丢失", isFinal: true,
      createdAt: "2026-08-18T01:00:00.000Z", updatedAt: "2026-08-18T01:00:02.000Z"
    };
    const committedButUnacknowledged = await fetch(
      `${baseUrl}/api/sessions/${created.id}/checkpoint`,
      jsonPost({
        durationMs: 2_000,
        segments: [segment],
        writerLeaseToken: created.writerLeaseToken,
        expectedRevision: created.revision
      })
    );
    expect(committedButUnacknowledged.status).toBe(200);

    const latest = await fetch(`${baseUrl}/api/sessions/${created.id}`);
    const latestBody = (await latest.json()) as { session: { revision: number } };
    const verified = await fetch(
      `${baseUrl}/api/sessions/${created.id}/resume`,
      jsonPost({
        takeover: false,
        writerLeaseToken: created.writerLeaseToken,
        expectedRevision: latestBody.session.revision
      })
    );
    expect(verified.status).toBe(200);
    const verifiedBody = (await verified.json()) as { session: { revision: number } };

    const resent = await fetch(
      `${baseUrl}/api/sessions/${created.id}/checkpoint`,
      jsonPost({
        durationMs: 2_000,
        segments: [segment],
        writerLeaseToken: created.writerLeaseToken,
        expectedRevision: verifiedBody.session.revision
      })
    );
    expect(resent.status).toBe(200);
    const detail = await fetch(`${baseUrl}/api/sessions/${created.id}`);
    const detailBody = (await detail.json()) as { session: { segments: unknown[] } };
    expect(detailBody.session.segments).toHaveLength(1);
  });

  it("rejects client course metadata and raw audio fields", async () => {
    const response = await fetch(`${baseUrl}/api/sessions`, jsonPost({
      courseId: "canvas_123",
      startedAt: "2026-08-18T01:00:00.000Z",
      models: { translation: "gpt-realtime-translate", transcription: "gpt-realtime-whisper" },
      courseName: "伪造课程",
      rawAudio: "not allowed"
    }));
    expect(response.status).toBe(400);
  });

  it("keeps failed finalization incomplete until the browser explicitly accepts the warning", async () => {
    const created = await createSession(baseUrl, "canvas_123");
    const invalidFailure = await fetch(`${baseUrl}/api/sessions/${created.id}/fail`, jsonPost({
      durationMs: 1_000,
      segments: [],
      writerLeaseToken: created.writerLeaseToken,
      expectedRevision: created.revision
    }));
    expect(invalidFailure.status).toBe(400);

    const warning = "最后一段字幕可能缺失。";
    const failed = await fetch(`${baseUrl}/api/sessions/${created.id}/fail`, jsonPost({
      durationMs: 1_000,
      segments: [],
      finalizationWarning: warning,
      writerLeaseToken: created.writerLeaseToken,
      expectedRevision: created.revision
    }));
    expect(failed.status).toBe(200);
    const failedBody = (await failed.json()) as {
      session: { status: string; finalizationWarning: string; revision: number };
    };
    expect(failedBody).toMatchObject({
      session: { status: "failed", finalizationWarning: warning }
    });

    const blocked = await fetch(`${baseUrl}/api/sessions/${created.id}/complete`, jsonPost({
      endedAt: "2026-08-18T01:01:00.000Z",
      durationMs: 60_000,
      segments: [],
      writerLeaseToken: created.writerLeaseToken,
      expectedRevision: failedBody.session.revision
    }));
    expect(blocked.status).toBe(409);
    expect((await blocked.json()) as unknown).toMatchObject({ finalizationWarning: warning });

    const accepted = await fetch(`${baseUrl}/api/sessions/${created.id}/complete`, jsonPost({
      endedAt: "2026-08-18T01:01:00.000Z",
      durationMs: 60_000,
      segments: [],
      acceptIncomplete: true,
      writerLeaseToken: created.writerLeaseToken,
      expectedRevision: failedBody.session.revision
    }));
    expect(accepted.status).toBe(200);
    expect((await accepted.json()) as unknown).toMatchObject({
      session: { status: "ready", finalizationWarning: warning }
    });

    const internal = await fetch(`${baseUrl}/internal/mcp/lecture/sessions/${created.id}`, {
      headers: { Authorization: "Bearer lecture-test-token" }
    });
    expect((await internal.json()) as unknown).toMatchObject({
      session: { status: "ready", finalizationWarning: warning }
    });
  });

  it("keeps passive reads side-effect free and rejects stale devices after explicit takeover", async () => {
    const created = await createSession(baseUrl, "canvas_123");
    const firstRead = await fetch(`${baseUrl}/api/sessions/${created.id}`);
    const firstBody = (await firstRead.json()) as {
      session: { status: string; revision: number; finalizationWarning: string | null };
    };
    const secondRead = await fetch(`${baseUrl}/api/sessions/${created.id}`);
    const secondBody = (await secondRead.json()) as typeof firstBody;
    expect(secondBody.session).toMatchObject({
      status: firstBody.session.status,
      revision: firstBody.session.revision,
      finalizationWarning: firstBody.session.finalizationWarning
    });
    expect(secondBody.session).toMatchObject({
      status: "recording",
      revision: created.revision,
      finalizationWarning: null
    });

    const missingRevision = await fetch(
      `${baseUrl}/api/sessions/${created.id}/resume`,
      jsonPost({ takeover: true })
    );
    expect(missingRevision.status).toBe(400);
    const staleTakeover = await fetch(
      `${baseUrl}/api/sessions/${created.id}/resume`,
      jsonPost({ takeover: true, expectedRevision: created.revision + 1 })
    );
    await expectWriterConflict(staleTakeover, created.revision);

    const takeover = await fetch(
      `${baseUrl}/api/sessions/${created.id}/resume`,
      jsonPost({ takeover: true, expectedRevision: created.revision })
    );
    expect(takeover.status).toBe(200);
    const takeoverBody = (await takeover.json()) as {
      session: { revision: number; finalizationWarning: string | null };
      writerLease: { token: string };
    };
    expect(takeoverBody.writerLease.token).not.toBe(created.writerLeaseToken);
    expect(takeoverBody.session).toMatchObject({
      revision: created.revision + 1,
      finalizationWarning: RECOVERED_SESSION_WARNING
    });

    const currentRevision = takeoverBody.session.revision;
    const oldCheckpoint = await fetch(
      `${baseUrl}/api/sessions/${created.id}/checkpoint`,
      jsonPost({
        durationMs: 1_000,
        segments: [],
        writerLeaseToken: created.writerLeaseToken,
        expectedRevision: currentRevision
      })
    );
    await expectWriterConflict(oldCheckpoint, currentRevision);
    const oldFailure = await fetch(
      `${baseUrl}/api/sessions/${created.id}/fail`,
      jsonPost({
        durationMs: 1_000,
        segments: [],
        finalizationWarning: "old writer failure",
        writerLeaseToken: created.writerLeaseToken,
        expectedRevision: currentRevision
      })
    );
    await expectWriterConflict(oldFailure, currentRevision);
    const oldCompletion = await fetch(
      `${baseUrl}/api/sessions/${created.id}/complete`,
      jsonPost({
        endedAt: "2026-08-18T01:01:00.000Z",
        durationMs: 60_000,
        segments: [],
        acceptIncomplete: true,
        writerLeaseToken: created.writerLeaseToken,
        expectedRevision: currentRevision
      })
    );
    await expectWriterConflict(oldCompletion, currentRevision);

    const staleCurrentWriter = await fetch(
      `${baseUrl}/api/sessions/${created.id}/checkpoint`,
      jsonPost({
        durationMs: 1_000,
        segments: [],
        writerLeaseToken: takeoverBody.writerLease.token,
        expectedRevision: created.revision
      })
    );
    await expectWriterConflict(staleCurrentWriter, currentRevision);
    const currentWriter = await fetch(
      `${baseUrl}/api/sessions/${created.id}/checkpoint`,
      jsonPost({
        durationMs: 1_000,
        segments: [],
        writerLeaseToken: takeoverBody.writerLease.token,
        expectedRevision: currentRevision
      })
    );
    expect(currentWriter.status).toBe(200);
    const currentWriterBody = (await currentWriter.json()) as {
      session: { revision: number; finalizationWarning: string | null };
    };
    expect(currentWriterBody).toMatchObject({
      session: { revision: currentRevision + 1, finalizationWarning: RECOVERED_SESSION_WARNING }
    });

    const completedByCurrentWriter = await fetch(
      `${baseUrl}/api/sessions/${created.id}/complete`,
      jsonPost({
        endedAt: "2026-08-18T01:01:00.000Z",
        durationMs: 60_000,
        segments: [],
        acceptIncomplete: true,
        writerLeaseToken: takeoverBody.writerLease.token,
        expectedRevision: currentWriterBody.session.revision
      })
    );
    expect(completedByCurrentWriter.status).toBe(200);
    const completedBody = (await completedByCurrentWriter.json()) as { session: { revision: number } };
    const oldHeartbeatAfterCompletion = await fetch(
      `${baseUrl}/api/sessions/${created.id}/checkpoint`,
      jsonPost({
        durationMs: 61_000,
        segments: [],
        writerLeaseToken: created.writerLeaseToken,
        expectedRevision: completedBody.session.revision
      })
    );
    await expectWriterConflict(oldHeartbeatAfterCompletion, completedBody.session.revision);
  });

  it("archives only ready sessions, never recording or failed sessions", async () => {
    const created = await createSession(baseUrl, "canvas_123");
    const recordingDelete = await fetch(`${baseUrl}/api/sessions/${created.id}`, { method: "DELETE" });
    expect(recordingDelete.status).toBe(409);

    const warning = "final segment may be incomplete";
    const failed = await fetch(`${baseUrl}/api/sessions/${created.id}/fail`, jsonPost({
      durationMs: 1_000,
      segments: [],
      finalizationWarning: warning,
      writerLeaseToken: created.writerLeaseToken,
      expectedRevision: created.revision
    }));
    expect(failed.status).toBe(200);
    const failedBody = (await failed.json()) as { session: { revision: number } };
    const failedDelete = await fetch(`${baseUrl}/api/sessions/${created.id}`, { method: "DELETE" });
    expect(failedDelete.status).toBe(409);

    const completed = await fetch(`${baseUrl}/api/sessions/${created.id}/complete`, jsonPost({
      endedAt: "2026-08-18T01:01:00.000Z",
      durationMs: 60_000,
      segments: [],
      acceptIncomplete: true,
      writerLeaseToken: created.writerLeaseToken,
      expectedRevision: failedBody.session.revision
    }));
    expect(completed.status).toBe(200);
    const completedBody = (await completed.json()) as { session: { revision: number } };
    const verifyCompletedWriter = await fetch(
      `${baseUrl}/api/sessions/${created.id}/resume`,
      jsonPost({
        takeover: false,
        writerLeaseToken: created.writerLeaseToken,
        expectedRevision: completedBody.session.revision
      })
    );
    expect(verifyCompletedWriter.status).toBe(409);
    expect((await verifyCompletedWriter.json()) as unknown).toMatchObject({ code: "session_not_writable" });
    const readyDelete = await fetch(`${baseUrl}/api/sessions/${created.id}`, { method: "DELETE" });
    expect(readyDelete.status).toBe(204);
  });

  it("requires the independent token for MCP reads", async () => {
    const response = await fetch(`${baseUrl}/internal/mcp/lecture/sessions`);
    expect(response.status).toBe(401);
  });

  it("rejects the public hostname on internal routes even with the service token", async () => {
    const status = await requestStatusWithHost(
      `${baseUrl}/internal/mcp/lecture/sessions`,
      "lecture.gaid.studio",
      "lecture-test-token"
    );
    expect(status).toBe(421);
  });

  it("rejects DNS-rebinding hosts on the loopback development API", async () => {
    const status = await requestStatusWithHost(
      `${baseUrl}/api/sessions`,
      "evil.example:3001",
      "unused"
    );
    expect(status).toBe(421);
  });

  it("marks temporary OpenAI credentials as no-store", async () => {
    const response = await fetch(`${baseUrl}/api/realtime/client-secret`, jsonPost({ mode: "realtime-translate" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("browser authentication", () => {
  it("fails closed for public APIs while leaving health available", async () => {
    const { db, server, baseUrl } = await startTestServer(async () => {
      throw new AuthFailure("Cloudflare Access assertion is required");
    });
    try {
      expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/api/sessions`)).status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it("keeps production Host and Origin checks in explicit public mode and returns only an ephemeral secret", async () => {
    const publicServer = await startTestServer(
      createPublicOwnerAuthenticator(),
      [course()],
      "https://lecture.gaid.studio"
    );
    try {
      const wrongHost = await rawRequest(`${publicServer.baseUrl}/api/sessions`, {
        host: "evil.example"
      });
      expect(wrongHost.status).toBe(421);

      const allowedRead = await rawRequest(`${publicServer.baseUrl}/api/sessions`, {
        host: "lecture.gaid.studio"
      });
      expect(allowedRead.status).toBe(200);

      const missingOrigin = await rawRequest(`${publicServer.baseUrl}/api/realtime/client-secret`, {
        method: "POST",
        host: "lecture.gaid.studio",
        body: JSON.stringify({ mode: "realtime-translate" })
      });
      expect(missingOrigin.status).toBe(403);

      const allowedSecret = await rawRequest(`${publicServer.baseUrl}/api/realtime/client-secret`, {
        method: "POST",
        host: "lecture.gaid.studio",
        origin: "https://lecture.gaid.studio",
        body: JSON.stringify({ mode: "realtime-translate" })
      });
      expect(allowedSecret.status).toBe(200);
      expect(JSON.parse(allowedSecret.body)).toEqual({ clientSecret: "ephemeral", expiresAt: 123 });
      expect(allowedSecret.body).not.toContain("test");
      expect(allowedSecret.headers["cache-control"]).toBe("no-store");
    } finally {
      await new Promise<void>((resolve) => publicServer.server.close(() => resolve()));
      publicServer.db.close();
    }
  });
});

async function startTestServer(
  authenticateBrowser: BrowserAuthenticator,
  studyCourses: CourseOption[] = [course()],
  publicOrigin?: string
) {
  const db = openDatabase(":memory:");
  const app = createServerApp({
    db,
    studyClient: {
      async listCourses() {
        return { courses: studyCourses, syncedAt: "2026-08-18T00:00:00.000Z", stale: false };
      }
    },
    authenticateBrowser,
    lectureServiceToken: "lecture-test-token",
    internalAllowedHosts: ["127.0.0.1", "localhost"],
    publicOrigin,
    openAiApiKey: "test",
    staticDir: null,
    createClientSecret: async () => ({ clientSecret: "ephemeral", expiresAt: 123 }),
    translateText: async ({ model, text }) => `${model}:${text}:中文`
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { db, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function createSession(baseUrl: string, courseId: string) {
  const response = await fetch(`${baseUrl}/api/sessions`, jsonPost({
    courseId,
    startedAt: "2026-08-18T01:00:00.000Z",
    models: { translation: "gpt-realtime-translate", transcription: "gpt-realtime-whisper" }
  }));
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    session: { id: string; courseName: string; status: string; revision: number };
    writerLease: { token: string };
  };
  return { ...body.session, writerLeaseToken: body.writerLease.token };
}

function jsonPost(body: unknown) {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function expectWriterConflict(response: Response, currentRevision: number) {
  expect(response.status).toBe(409);
  expect((await response.json()) as unknown).toMatchObject({
    code: "writer_lease_conflict",
    currentRevision
  });
}

function requestStatusWithHost(urlValue: string, host: string, token: string): Promise<number | undefined> {
  const url = new URL(urlValue);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "GET",
      headers: { Host: host, Authorization: `Bearer ${token}` }
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
}

function rawRequest(urlValue: string, options: {
  method?: string;
  host: string;
  origin?: string;
  body?: string;
}): Promise<{ status: number | undefined; headers: Record<string, string | string[] | undefined>; body: string }> {
  const url = new URL(urlValue);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: options.host };
    if (options.origin) headers.Origin = options.origin;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(options.body));
    }
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method ?? "GET",
      headers
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

function course(): CourseOption {
  return {
    id: "canvas_123", code: "CUL123", name: "서버 강의명", term: "2026년 2학기",
    folderName: "CUL123_서버 강의명", label: "CUL123 서버 강의명", source: "canvas",
    workflowState: "active", startAt: null, endAt: null, isArchived: false
  };
}
