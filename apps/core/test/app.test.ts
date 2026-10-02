import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplication, type ApplicationRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPatCipher, hashOpaqueToken } from "../src/crypto/index.js";
import { createFileDownloadLink } from "../src/fileLinks.js";

const runtimes: ApplicationRuntime[] = [];

function runtime(options: {
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string>;
} = {}): ApplicationRuntime {
  const config = loadConfig({
    PUBLIC_ORIGIN: "http://localhost:8794",
    PORT: "8794",
    DATABASE_PATH: ":memory:",
    MASTER_KEY_BASE64: Buffer.alloc(32, 9).toString("base64"),
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_RP_NAME: "Canvas Test",
    COOKIE_SECURE: "false",
    TRUST_PROXY: "0",
    STUDY_SERVICE_TOKEN: "study-service-token-for-tests-123456",
    ...options.env,
  } as NodeJS.ProcessEnv);
  const fetch = options.fetch ?? vi.fn<typeof globalThis.fetch>(async () =>
    new Response(JSON.stringify({ id: 101, name: "Test Student", login_id: "student" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const created = createApplication({ config, fetch });
  runtimes.push(created);
  return created;
}

function seedCanvasConnection(created: ApplicationRuntime): void {
  const now = 1_900_000_000_000;
  created.database.prepare(
    "INSERT INTO users(id, display_name, institution, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("owner", "Student", "hanyang", now, now);
  const encrypted = createPatCipher(created.config.masterKey).encrypt(
    "test-pat",
    "canvas-pat:v1:owner:hanyang",
  );
  created.database.prepare(
    `INSERT INTO canvas_connections(
       user_id, institution, base_url, canvas_user_id, canvas_name, pat_version,
       pat_iv, pat_ciphertext, pat_auth_tag, pat_hash, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "owner",
    "hanyang",
    "https://learning.hanyang.ac.kr",
    "42",
    "Student",
    encrypted.version,
    encrypted.iv,
    encrypted.ciphertext,
    encrypted.authTag,
    "hash",
    now,
    now,
  );
}

afterEach(() => {
  while (runtimes.length) runtimes.pop()?.close();
});

describe("application HTTP boundary", () => {
  it.each([
    "upload_canvas_file", "submit_assignment", "send_message", "reply_message",
  ])("uses the existing Study authorization for %s while retaining authentication", async name => {
    const fetcher = vi.fn<typeof fetch>();
    const created = runtime({ fetch: fetcher, env: { CANVAS_MESSAGES_ENABLED: "true", CANVAS_COURSEWORK_WRITES_ENABLED: "true" } });
    seedCanvasConnection(created);
    const now = Date.now();
    created.database.prepare("INSERT INTO oauth_clients(client_id,client_name,redirect_uris_json,grant_types_json,response_types_json,token_endpoint_auth_method,created_at) VALUES('write-client','Test','[]','[\"authorization_code\"]','[\"code\"]','none',?)").run(now);
    created.database.prepare("INSERT INTO oauth_tokens(token_hash,token_type,family_id,user_id,client_id,resource,scope,expires_at,created_at) VALUES(?,'access','write-family','owner','write-client',?,?,?,?)")
      .run(hashOpaqueToken("scoped-write-test"), created.config.oauthResource, "canvas.read", now + 60000, now);
    const dispatched = await request(created.app).post("/mcp")
      .set("Authorization", "Bearer scoped-write-test").set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }).expect(200);
    expect(dispatched.text).not.toContain("insufficient_scope");
    created.database.prepare("UPDATE oauth_tokens SET scope='offline_access'").run();
    await request(created.app).post("/mcp")
      .set("Authorization", "Bearer scoped-write-test").set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: {} } }).expect(403);
    expect(fetcher).not.toHaveBeenCalled();
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM canvas_write_receipts").get()).toEqual({ count: 0 });
  });

  it("keeps coursework writes and their scopes disabled by default", () => {
    const created = runtime();
    expect(created.config.canvasCourseworkWritesEnabled).toBe(false);
    expect(created.config.oauthScopes).not.toContain("canvas.files.write");
    expect(created.config.oauthScopes).not.toContain("canvas.submissions.write");
  });
  it("keeps rejected JSON body fragments out of both responses and error logs", async () => {
    const sink = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const marker = "synthetic-private-request-fragment";
      const response = await request(runtime().app).post("/mcp")
        .set("Content-Type", "application/json").send(marker).expect(400);
      expect(response.text).not.toContain(marker);
      expect(sink).toHaveBeenCalledOnce();
      expect(JSON.stringify(sink.mock.calls)).not.toContain(marker);
      expect(JSON.parse(String(sink.mock.calls[0]?.[0]))).toMatchObject({
        event: "http_request_failed", status: 400, error: { kind: "syntax_error", status: 400 },
      });
    } finally { sink.mockRestore(); }
  });

  it("serves health, static account pages, and hardened headers", async () => {
    const app = runtime().app;
    const health = await request(app).get("/healthz").expect(200);
    expect(health.body).toMatchObject({ ok: true, service: "canvas" });
    expect(health.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(health.headers["permissions-policy"]).toContain("publickey-credentials-get=(self)");

    const setup = await request(app).get("/setup").expect(200);
    expect(setup.headers["cache-control"]).toBe("no-store");
    expect(setup.text).toContain("Connect your school to Study");
  });

  it("publishes OAuth discovery and challenges unauthenticated MCP requests", async () => {
    const app = runtime().app;
    const metadata = await request(app)
      .get("/.well-known/oauth-protected-resource")
      .expect(200);
    expect(metadata.body).toMatchObject({
      resource: "http://localhost:8794/mcp",
      authorization_servers: ["http://localhost:8794"],
    });

    const denied = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      .expect(401);
    expect(denied.headers["www-authenticate"]).toContain(
      'resource_metadata="http://localhost:8794/.well-known/oauth-protected-resource"',
    );
    expect(denied.body.error).toBe("invalid_token");
  });

  it("relays bytes only for a valid short-lived file capability", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/files/52") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-pat");
        return new Response(
          JSON.stringify({
            id: 52,
            display_name: "Course notes.pdf",
            filename: "course-notes.pdf",
            "content-type": "application/pdf",
            size: 4,
            url: "https://learning.hanyang.ac.kr/files/52/download?verifier=secret",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      expect(url.pathname).toBe("/files/52/download");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return new Response(Uint8Array.from([37, 80, 68, 70]), {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "4" },
      });
    }) as unknown as typeof globalThis.fetch;
    const created = runtime({ fetch });
    seedCanvasConnection(created);
    const link = createFileDownloadLink({
      publicOrigin: created.config.publicOrigin,
      masterKey: created.config.masterKey,
      userId: "owner",
      fileId: "52",
    });
    const path = new URL(link.uri).pathname;

    const accepted = await request(created.app).get(path).expect(200);

    expect(accepted.headers["cache-control"]).toBe("private, no-store");
    expect(accepted.headers["content-type"]).toContain("application/pdf");
    expect(accepted.headers["content-disposition"]).toContain('attachment; filename="course-notes.pdf"');
    expect([...accepted.body]).toEqual([37, 80, 68, 70]);
    expect(fetch).toHaveBeenCalledTimes(2);
    await request(created.app).get("/files/not-a-valid-token").expect(404);
  });

  it("keeps the legacy gaid.studio MCP host only for the canonical Study origin", async () => {
    const canonical = runtime({
      env: {
        PUBLIC_ORIGIN: "https://study.siyidu.com",
        WEBAUTHN_RP_ID: "study.siyidu.com",
        COOKIE_SECURE: "true",
      },
    }).app;

    await request(canonical)
      .get("/readyz")
      .set("Host", "canvas.gaid.studio")
      .expect(200);
    await request(canonical)
      .get("/readyz")
      .set("Host", "untrusted.example")
      .expect(403);

    await request(runtime().app)
      .get("/readyz")
      .set("Host", "canvas.gaid.studio")
      .expect(403);
  });

  it("sends an unauthenticated account page to login instead of looping", async () => {
    const app = runtime().app;
    const session = await request(app).get("/auth/session").expect(200);
    expect(session.body).toMatchObject({
      authenticated: false,
      returnTo: "/account",
      redirectTo: "/login",
    });
  });

  it("accepts only allowlisted ChatGPT redirect URIs during dynamic registration", async () => {
    const app = runtime().app;
    const accepted = await request(app)
      .post("/oauth/register")
      .send({
        client_name: "Canvas test",
        redirect_uris: ["https://chatgpt.com/connector/oauth/canvas-test"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      })
      .expect(201);
    expect(accepted.body.client_id).toMatch(/^client_/);

    await request(app)
      .post("/oauth/register")
      .send({ redirect_uris: ["https://attacker.example/callback"] })
      .expect(400);
  });

  it("serves the sole Hanyang course catalog only to the dedicated Lecture token", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const body = url.searchParams.get("enrollment_state") === "active"
        ? [{
            id: 7,
            name: "Accounting",
            course_code: "ACC-7",
            start_at: "2026-09-01T00:00:00Z",
            end_at: "2026-12-20T00:00:00Z",
            term: { id: 9, name: "2026 Fall" },
          }]
        : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const created = runtime({
      fetch,
      env: { COURSE_SYNC_MIN_INTERVAL_SECONDS: "0" },
    });
    seedCanvasConnection(created);

    await request(created.app)
      .get("/internal/lecture/courses")
      .set("Host", "canvas:8794")
      .expect(401);
    const accepted = await request(created.app)
      .get("/internal/lecture/courses")
      .set("Host", "canvas:8794")
      .set("Authorization", "Bearer study-service-token-for-tests-123456")
      .expect(200);

    expect(accepted.headers["cache-control"]).toBe("no-store");
    expect(accepted.body).toMatchObject({
      stale: false,
      syncedAt: expect.any(String),
      courses: [{
        id: "7",
        code: "ACC-7",
        name: "Accounting",
        term: "2026 Fall",
        status: "active",
        source: "canvas",
        archivedAt: null,
      }],
    });
  });

  it("lets the existing Study grant discover and dispatch Lecture tools", async () => {
    const created = runtime({
      env: {
        LECTURE_API_URL: "http://lecture:8091",
        LECTURE_SERVICE_TOKEN: "lecture-service-token-for-tests-1234",
      },
    });
    seedCanvasConnection(created);
    const now = Date.now();
    created.database.prepare(
      `INSERT INTO oauth_clients(
         client_id, client_name, redirect_uris_json, grant_types_json,
         response_types_json, token_endpoint_auth_method, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "client-1",
      "Old client",
      "[]",
      '["authorization_code"]',
      '["code"]',
      "none",
      now,
    );
    created.database.prepare(
      `INSERT INTO oauth_tokens(
         token_hash, token_type, family_id, user_id, client_id, resource,
         scope, expires_at, created_at
       ) VALUES (?, 'access', ?, ?, ?, ?, 'canvas.read', ?, ?)`,
    ).run(
      hashOpaqueToken("old-canvas-access-token"),
      "family-1",
      "owner",
      "client-1",
      created.config.oauthResource,
      now + 60_000,
      now,
    );

    const discovered = await request(created.app)
      .post("/mcp")
      .set("Authorization", "Bearer old-canvas-access-token")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      .expect(200);
    const discoveryPayload = `${JSON.stringify(discovered.body)}\n${discovered.text}`;
    expect(discoveryPayload).toContain("connection_status");
    expect(discoveryPayload).toContain("list_lecture_sessions");

    const denied = await request(created.app)
      .post("/mcp")
      .set("Authorization", "Bearer old-canvas-access-token")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_lecture_sessions", arguments: {} },
      })
      .expect(200);

    expect(denied.text).not.toContain("insufficient_scope");
  });
  it("lets the existing Study grant dispatch message tools", async () => {
    const created = runtime({
      env: {
        CANVAS_MESSAGES_ENABLED: "true",

      },
    });
    seedCanvasConnection(created);
    const now = Date.now();
    created.database.prepare(
      `INSERT INTO oauth_clients(
         client_id, client_name, redirect_uris_json, grant_types_json,
         response_types_json, token_endpoint_auth_method, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "client-1",
      "Old client",
      "[]",
      '["authorization_code"]',
      '["code"]',
      "none",
      now,
    );
    created.database.prepare(
      `INSERT INTO oauth_tokens(
         token_hash, token_type, family_id, user_id, client_id, resource,
         scope, expires_at, created_at
       ) VALUES (?, 'access', ?, ?, ?, ?, 'canvas.read', ?, ?)`,
    ).run(
      hashOpaqueToken("old-canvas-access-token"),
      "family-1",
      "owner",
      "client-1",
      created.config.oauthResource,
      now + 60_000,
      now,
    );

    const discovered = await request(created.app)
      .post("/mcp")
      .set("Authorization", "Bearer old-canvas-access-token")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      .expect(200);
    const discoveryPayload = `${JSON.stringify(discovered.body)}\n${discovered.text}`;
    expect(discoveryPayload).toContain("connection_status");
    expect(discoveryPayload).toContain("send_message");

    const denied = await request(created.app)
      .post("/mcp")
      .set("Authorization", "Bearer old-canvas-access-token")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "send_message", arguments: {} },
      })
      .expect(200);

    expect(denied.text).not.toContain("insufficient_scope");
  });
});
