// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadOpenAIModelConfig } from "./modelConfig.js";

describe("OpenAI model config", () => {
  it("defaults realtime transcription to the server VAD compatible streaming model", () => {
    expect(loadOpenAIModelConfig({} as NodeJS.ProcessEnv).realtimeTranscriptionModel).toBe("gpt-4o-transcribe");
  });
});
