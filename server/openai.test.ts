// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRealtimeClientSecret } from "./openai.js";

describe("OpenAI client secrets", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the translation client secret endpoint for realtime translation mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(clientSecretResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createRealtimeClientSecret({
        apiKey: "sk_test",
        mode: "realtime-translate",
        safetyIdentifier: "teacher"
      })
    ).resolves.toEqual({ clientSecret: "ek_test", expiresAt: 123 });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/translations/client_secrets",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"model":"gpt-realtime-translate"')
      })
    );
  });

  it("uses the regular realtime client secret endpoint for transcription mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(clientSecretResponse());
    vi.stubGlobal("fetch", fetchMock);

    await createRealtimeClientSecret({
      apiKey: "sk_test",
      mode: "transcribe-then-translate",
      safetyIdentifier: "teacher"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/client_secrets",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"type":"transcription"')
      })
    );
  });
});

function clientSecretResponse(): Response {
  return new Response(JSON.stringify({ value: "ek_test", expires_at: 123 }), {
    status: 200,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
