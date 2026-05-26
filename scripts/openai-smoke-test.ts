import { loadOpenAIModelConfig } from "../server/modelConfig.js";
import { createRealtimeClientSecret, safetyIdentifierFromEmail, translateKoreanToChinese } from "../server/openai.js";
import type { TranslationMode } from "../src/types.js";

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.error("OPENAI_API_KEY is required for the OpenAI smoke test.");
  process.exit(1);
}

const modelConfig = loadOpenAIModelConfig();
const safetyIdentifier = safetyIdentifierFromEmail("openai-smoke-test@jiahuan.local");

console.log("Using configured OpenAI models:");
console.log(`- realtime translation: ${modelConfig.realtimeTranslationModel}`);
console.log(`- realtime transcription: ${modelConfig.realtimeTranscriptionModel}`);
console.log(`- text translation default: ${modelConfig.defaultTextTranslationModel}`);

for (const mode of [
  "classic-websocket-translate",
  "realtime-translate",
  "transcribe-then-translate"
] satisfies TranslationMode[]) {
  const secret = await createRealtimeClientSecret({
    apiKey,
    mode,
    safetyIdentifier,
    modelConfig
  });
  console.log(`Issued ${mode} client secret expiring at ${new Date(secret.expiresAt * 1000).toISOString()}.`);
}

const translatedText = await translateKoreanToChinese({
  apiKey,
  model: modelConfig.defaultTextTranslationModel,
  text: "오늘은 문법을 이야기합니다.",
  safetyIdentifier
});

if (!translatedText.trim()) {
  throw new Error("Smoke test translation returned empty text.");
}

console.log("Text translation smoke test succeeded.");
