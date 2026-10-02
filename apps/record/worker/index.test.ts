import { describe, expect, it, vi } from "vitest";
import { handleRequest, type SitesEnv } from "./index";

function createEnv(overrides: Partial<SitesEnv> = {}): SitesEnv {
  return {
    ASSETS: {
      fetch: vi.fn(async () => new Response("asset"))
    } as unknown as Fetcher,
    DB: {} as D1Database,
    STUDY_OWNER_EMAIL: "student@example.com",
    ...overrides
  };
}

function browserHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set("oai-authenticated-user-id", "user_test");
  headers.set("oai-authenticated-user-email", "student@example.com");
  return headers;
}

describe("Sites Worker API", () => {
  it("keeps unknown D1 failure text and request values out of public responses and logs", async () => {
    const sink = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const marker = "synthetic-private-database-fragment";
      const env = createEnv({ DB: { prepare: () => { throw new Error(`${marker} no longer writable`); } } as unknown as D1Database });
      const response = await handleRequest(new Request("https://record.example/api/sessions/" + marker, {
        headers: browserHeaders(),
      }), env);
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain(marker);
      expect(sink).toHaveBeenCalledOnce();
      expect(JSON.stringify(sink.mock.calls)).not.toContain(marker);
      expect(JSON.parse(String(sink.mock.calls[0]?.[0]))).toMatchObject({
        event: "api_request_failed", routeFamily: "api", error: { kind: "exception", status: null },
      });
    } finally { sink.mockRestore(); }
  });

  it("rejects another signed-in account before reading private transcripts", async () => {
    const response = await handleRequest(new Request("https://record.example/api/sessions", { headers: browserHeaders() }), createEnv({ STUDY_OWNER_EMAIL: "owner@example.com" }));
    expect(response.status).toBe(403);
  });
  it("serves health without caching", async () => {
    const response = await handleRequest(new Request("https://record.example/api/health"), createEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, service: "study-record" });
  });

  it("delegates non-API requests to the static asset binding", async () => {
    const env = createEnv();
    const response = await handleRequest(new Request("https://record.example/records"), env);
    expect(await response.text()).toBe("asset");
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
  });

  it("fails closed when a browser request has no Sites identity", async () => {
    const response = await handleRequest(new Request("https://record.example/api/sessions"), createEnv());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Sign in to access Study Record." });
  });

  it("rejects cross-origin browser writes", async () => {
    const response = await handleRequest(new Request("https://record.example/api/sessions", {
      method: "POST",
      headers: browserHeaders({
        Origin: "https://evil.example",
        "Content-Type": "application/json"
      }),
      body: "{}"
    }), createEnv());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Cross-origin state changes are not allowed." });
  });

  it("returns a clear error when the OpenAI secret is not configured", async () => {
    const response = await handleRequest(
      new Request("https://record.example/api/realtime/client-secret", {
        method: "POST",
        headers: browserHeaders({
          Origin: "https://record.example",
          "Content-Type": "application/json"
        }),
        body: JSON.stringify({ mode: "realtime-translate" })
      }),
      createEnv()
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Realtime transcription is not configured." });
  });

  it("rejects oversized JSON before touching D1", async () => {
    const response = await handleRequest(
      new Request("https://record.example/api/sessions", {
        method: "POST",
        headers: browserHeaders({
          Origin: "https://record.example",
          "Content-Type": "application/json",
          "Content-Length": String(2 * 1024 * 1024 + 1)
        }),
        body: "{}"
      }),
      createEnv()
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Request payload is too large." });
  });

  it("rejects internal requests with the wrong service token", async () => {
    const response = await handleRequest(
      new Request("https://record.example/internal/mcp/lecture/sessions", {
        headers: { Authorization: "Bearer wrong" }
      }),
      createEnv({ LECTURE_SERVICE_TOKEN: "correct-service-token-that-is-long-enough" })
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid lecture service token." });
  });
});
