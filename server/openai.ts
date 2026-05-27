import { createHash } from "node:crypto";
import type { TextTranslationModel, TranslationMode } from "../src/types.js";
import { loadOpenAIModelConfig, type OpenAIModelConfig } from "./modelConfig.js";

const OPENAI_REALTIME_CLIENT_SECRET_URL = "https://api.openai.com/v1/realtime/client_secrets";
const OPENAI_TRANSLATION_CLIENT_SECRET_URL = "https://api.openai.com/v1/realtime/translations/client_secrets";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

interface OpenAIClientSecretResponse {
  value?: string;
  expires_at?: number;
  client_secret?: {
    value?: string;
    expires_at?: number;
  };
  session?: {
    client_secret?: {
      value?: string;
      expires_at?: number;
    };
  };
}

export interface RealtimeClientSecret {
  clientSecret: string;
  expiresAt: number;
}

export async function createRealtimeClientSecret({
  apiKey,
  mode,
  safetyIdentifier,
  modelConfig = loadOpenAIModelConfig()
}: {
  apiKey: string;
  mode: TranslationMode;
  safetyIdentifier: string;
  modelConfig?: OpenAIModelConfig;
}): Promise<RealtimeClientSecret> {
  const response = await fetch(realtimeClientSecretUrlForMode(mode), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": safetyIdentifier
    },
    body: JSON.stringify({
      expires_after: {
        anchor: "created_at",
        seconds: 600
      },
      session: realtimeSessionForMode(mode, modelConfig)
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI client secret request failed: ${response.status} ${detail}`);
  }

  const data = (await response.json()) as OpenAIClientSecretResponse;
  const clientSecret = data.value ?? data.client_secret?.value ?? data.session?.client_secret?.value;
  const expiresAt = data.expires_at ?? data.client_secret?.expires_at ?? data.session?.client_secret?.expires_at;

  if (!clientSecret || !expiresAt) {
    throw new Error("OpenAI client secret response did not include a usable secret");
  }

  return { clientSecret, expiresAt };
}

export async function translateKoreanToChinese({
  apiKey,
  model,
  text,
  context,
  safetyIdentifier
}: {
  apiKey: string;
  model: TextTranslationModel;
  text: string;
  context?: Array<{ sourceText: string; translatedText: string }>;
  safetyIdentifier: string;
}): Promise<string> {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": safetyIdentifier
    },
    body: JSON.stringify({
      model,
      instructions:
        "You translate live Korean class transcripts into natural Simplified Chinese subtitles. Return only the Chinese translation. Preserve names, class terms, numbers, and quoted phrases. Do not add explanations.",
      input: buildTranslationInput(text, context),
      max_output_tokens: 700
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI translation request failed: ${response.status} ${detail}`);
  }

  const data = (await response.json()) as OpenAIResponse;
  const outputText = extractResponseText(data).trim();
  if (!outputText) {
    throw new Error("OpenAI translation response did not include text");
  }

  return outputText;
}

export function safetyIdentifierFromEmail(email: string | null): string {
  return createHash("sha256").update(email?.toLowerCase().trim() || "jiahuan-internal").digest("hex");
}

function realtimeSessionForMode(mode: TranslationMode, modelConfig: OpenAIModelConfig) {
  if (mode === "transcribe-then-translate") {
    return {
      type: "transcription",
      audio: {
        input: {
          transcription: {
            model: modelConfig.realtimeTranscriptionModel,
            language: "ko"
          },
          turn_detection: null
        }
      }
    };
  }

  return {
    model: modelConfig.realtimeTranslationModel,
    audio: {
      input: {
        transcription: {
          model: modelConfig.realtimeTranscriptionModel
        },
        noise_reduction: {
          type: "far_field"
        }
      },
      output: {
        language: "zh"
      }
    }
  };
}

function realtimeClientSecretUrlForMode(mode: TranslationMode): string {
  return mode === "transcribe-then-translate" ? OPENAI_REALTIME_CLIENT_SECRET_URL : OPENAI_TRANSLATION_CLIENT_SECRET_URL;
}

function buildTranslationInput(text: string, context?: Array<{ sourceText: string; translatedText: string }>): string {
  const contextLines =
    context
      ?.slice(-4)
      .map((segment) => `韩文：${segment.sourceText}\n中文：${segment.translatedText}`)
      .join("\n\n") || "无";

  return `最近上下文：\n${contextLines}\n\n请翻译这一段韩文课堂转录为简体中文字幕，只返回译文：\n${text}`;
}

interface OpenAIResponse {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
}

function extractResponseText(data: OpenAIResponse): string {
  if (typeof data.output_text === "string") {
    return data.output_text;
  }

  return (
    data.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => content.text ?? "")
      .join("") ?? ""
  );
}
