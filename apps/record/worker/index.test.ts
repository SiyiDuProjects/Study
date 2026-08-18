import { describe, expect, it, vi } from "vitest";
import { handleRequest, type SitesEnv } from "./index";

function createEnv(overrides: Partial<SitesEnv> = {}): SitesEnv {
  return {
    ASSETS: {
      fetch: vi.fn(async () => new Response("asset"))
    } as unknown as Fetcher,
    DB: {} as D1Database,
    ...overrides
  };
}

describe("Sites Worker API", () => {
  it("serves health and model configuration without caching", async () => {
    const env = createEnv({
      OPENAI_REALTIME_TRANSCRIPTION_MODEL: "rt-transcribe-test",
      OPENAI_TEXT_TRANSLATION_MODELS: "text-a,text-b"
    });

    const health = await handleRequest(new Request("https://example.test/api/health"), env);
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(await health.json()).toEqual({ ok: true });

    const config = await handleRequest(new Request("https://example.test/api/config"), env);
    expect(await config.json()).toEqual({
      config: {
        realtimeTranslationModel: "gpt-realtime-translate",
        realtimeTranscriptionModel: "rt-transcribe-test",
        defaultTextTranslationModel: "text-a",
        textTranslationModels: ["text-a", "text-b"]
      }
    });
  });

  it("delegates non-API requests to the static asset binding", async () => {
    const env = createEnv();
    const response = await handleRequest(new Request("https://example.test/records"), env);

    expect(await response.text()).toBe("asset");
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
  });

  it("returns a clear error when the OpenAI secret is not configured", async () => {
    const response = await handleRequest(
      new Request("https://example.test/api/realtime/client-secret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "transcribe-then-translate" })
      }),
      createEnv()
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "OPENAI_API_KEY is not configured on the server." });
  });

  it("rejects oversized JSON before touching D1", async () => {
    const response = await handleRequest(
      new Request("https://example.test/api/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(2 * 1024 * 1024 + 1)
        },
        body: "{}"
      }),
      createEnv()
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Request payload is too large." });
  });

  it("rejects state-changing requests that are not JSON", async () => {
    const response = await handleRequest(
      new Request("https://example.test/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "{}"
      }),
      createEnv()
    );

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "Content-Type must be application/json." });
  });
});
