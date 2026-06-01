// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenAIModelConfig } from "./modelConfig.js";
import { createRealtimeClientSecret } from "./openai.js";

const modelConfig: OpenAIModelConfig = {
  realtimeTranslationModel: "rt-test",
  realtimeTranscriptionModel: "tr-test",
  defaultTextTranslationModel: "txt-test",
  textTranslationModels: ["txt-test"]
};

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
        safetyIdentifier: "teacher",
        modelConfig
      })
    ).resolves.toEqual({ clientSecret: "ek_test", expiresAt: 123 });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/translations/client_secrets",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"model":"rt-test"')
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"model":"tr-test"')
      })
    );
  });

  it("uses the translation client secret endpoint for classic low-latency mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(clientSecretResponse());
    vi.stubGlobal("fetch", fetchMock);

    await createRealtimeClientSecret({
      apiKey: "sk_test",
      mode: "classic-websocket-translate",
      safetyIdentifier: "teacher",
      modelConfig
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/translations/client_secrets",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"model":"rt-test"')
      })
    );
  });

  it("uses the regular realtime client secret endpoint for transcription mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(clientSecretResponse());
    vi.stubGlobal("fetch", fetchMock);

    await createRealtimeClientSecret({
      apiKey: "sk_test",
      mode: "transcribe-then-translate",
      safetyIdentifier: "teacher",
      modelConfig
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/client_secrets",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"model":"tr-test"')
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"language":"ko"')
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"noise_reduction":{"type":"far_field"}')
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"turn_detection":{"type":"server_vad","threshold":0.5,"prefix_padding_ms":300,"silence_duration_ms":400}')
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
