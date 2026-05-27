export interface OpenAIModelConfig {
  realtimeTranslationModel: string;
  realtimeTranscriptionModel: string;
  defaultTextTranslationModel: string;
  textTranslationModels: string[];
}

const FALLBACK_REALTIME_TRANSLATION_MODEL = "gpt-realtime-translate";
const FALLBACK_REALTIME_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const FALLBACK_TEXT_TRANSLATION_MODELS = ["gpt-5.4-mini", "gpt-5.4-nano"];

export function loadOpenAIModelConfig(env: NodeJS.ProcessEnv = process.env): OpenAIModelConfig {
  const textTranslationModels = parseModelList(env.OPENAI_TEXT_TRANSLATION_MODELS, FALLBACK_TEXT_TRANSLATION_MODELS);
  const defaultTextTranslationModel =
    env.OPENAI_TEXT_TRANSLATION_MODEL && textTranslationModels.includes(env.OPENAI_TEXT_TRANSLATION_MODEL)
      ? env.OPENAI_TEXT_TRANSLATION_MODEL
      : textTranslationModels[0];

  return {
    realtimeTranslationModel: env.OPENAI_REALTIME_TRANSLATION_MODEL || FALLBACK_REALTIME_TRANSLATION_MODEL,
    realtimeTranscriptionModel: env.OPENAI_REALTIME_TRANSCRIPTION_MODEL || FALLBACK_REALTIME_TRANSCRIPTION_MODEL,
    defaultTextTranslationModel,
    textTranslationModels
  };
}

function parseModelList(value: string | undefined, fallback: string[]): string[] {
  const models =
    value
      ?.split(",")
      .map((model) => model.trim())
      .filter(Boolean) ?? [];

  return models.length > 0 ? Array.from(new Set(models)) : fallback;
}
