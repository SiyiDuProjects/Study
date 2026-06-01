// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadOpenAIModelConfig } from "./modelConfig.js";

describe("OpenAI model config", () => {
  it("defaults realtime transcription to the low-latency streaming model", () => {
    expect(loadOpenAIModelConfig({} as NodeJS.ProcessEnv).realtimeTranscriptionModel).toBe("gpt-realtime-whisper");
  });
});
