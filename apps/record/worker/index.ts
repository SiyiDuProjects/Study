import { COURSES } from "../shared/courses";
import { loadOpenAIModelConfig } from "../server/modelConfig";
import { createRealtimeClientSecret, safetyIdentifierFromEmail, translateKoreanToChinese } from "../server/openai";
import {
  classSessionSchema,
  courseQuerySchema,
  realtimeClientSecretRequestSchema,
  translateRequestSchema
} from "../server/schemas";
import { createD1SessionRepository } from "./db";

const maxJsonBodyBytes = 2 * 1024 * 1024;

export interface SitesEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  OPENAI_API_KEY?: string;
  OPENAI_REALTIME_TRANSLATION_MODEL?: string;
  OPENAI_REALTIME_TRANSCRIPTION_MODEL?: string;
  OPENAI_TEXT_TRANSLATION_MODEL?: string;
  OPENAI_TEXT_TRANSLATION_MODELS?: string;
}

export async function handleRequest(request: Request, env: SitesEnv): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) {
    return env.ASSETS.fetch(request);
  }

  const modelConfig = loadOpenAIModelConfig({
    OPENAI_REALTIME_TRANSLATION_MODEL: env.OPENAI_REALTIME_TRANSLATION_MODEL,
    OPENAI_REALTIME_TRANSCRIPTION_MODEL: env.OPENAI_REALTIME_TRANSCRIPTION_MODEL,
    OPENAI_TEXT_TRANSLATION_MODEL: env.OPENAI_TEXT_TRANSLATION_MODEL,
    OPENAI_TEXT_TRANSLATION_MODELS: env.OPENAI_TEXT_TRANSLATION_MODELS
  });
  const sessions = createD1SessionRepository(env.DB);

  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/api/courses") {
      return json({ courses: COURSES });
    }

    if (request.method === "GET" && url.pathname === "/api/config") {
      return json({ config: modelConfig });
    }

    if (request.method === "POST" && url.pathname === "/api/realtime/client-secret") {
      requireOpenAiKey(env);
      const parsed = realtimeClientSecretRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, "Invalid realtime client secret request.");
      }

      try {
        const clientSecret = await createRealtimeClientSecret({
          apiKey: env.OPENAI_API_KEY,
          mode: parsed.data.mode,
          safetyIdentifier: safetyIdentifierFromEmail(requesterEmail(request)),
          modelConfig
        });
        return json(clientSecret);
      } catch (error) {
        logError(request, error, "realtime_client_secret_failed");
        return json(
          { error: "实时转录 API 请求失败。请确认 Sites 中已配置支持 OpenAI Realtime 的 API key。" },
          502
        );
      }
    }

    if (request.method === "POST" && url.pathname === "/api/translate") {
      requireOpenAiKey(env);
      const parsed = translateRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, "Invalid translation request.");
      }

      const model = parsed.data.model ?? modelConfig.defaultTextTranslationModel;
      if (!modelConfig.textTranslationModels.includes(model)) {
        throw new HttpError(400, "Unsupported translation model.");
      }

      const translatedText = await translateKoreanToChinese({
        apiKey: env.OPENAI_API_KEY,
        model,
        text: parsed.data.text,
        context: parsed.data.context,
        safetyIdentifier: safetyIdentifierFromEmail(requesterEmail(request))
      });
      return json({ translatedText });
    }

    if (request.method === "GET" && url.pathname === "/api/sessions") {
      const parsed = courseQuerySchema.safeParse({
        courseId: url.searchParams.get("courseId") ?? undefined
      });
      if (!parsed.success) {
        throw new HttpError(400, "Invalid course filter.");
      }
      return json({ sessions: await sessions.listSessions(parsed.data.courseId) });
    }

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const parsed = classSessionSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, "Invalid session payload.");
      }
      const saved = await sessions.saveSession(parsed.data, requesterEmail(request));
      return json({ session: saved }, 201);
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      if (request.method === "GET") {
        const session = await sessions.getSession(sessionId);
        if (!session) {
          throw new HttpError(404, "Session not found.");
        }
        return json({ session });
      }

      if (request.method === "DELETE") {
        const deleted = await sessions.deleteSession(sessionId);
        if (!deleted) {
          throw new HttpError(404, "Session not found.");
        }
        return new Response(null, { status: 204, headers: responseHeaders() });
      }
    }

    return json({ error: "API route not found." }, 404);
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status);
    }

    logError(request, error, "api_request_failed");
    return json({ error: "Server request failed." }, 502);
  }
}

const worker = {
  fetch(request: Request, env: SitesEnv): Promise<Response> {
    return handleRequest(request, env);
  }
} satisfies ExportedHandler<SitesEnv>;

export default worker;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function requireOpenAiKey(env: SitesEnv): asserts env is SitesEnv & { OPENAI_API_KEY: string } {
  if (!env.OPENAI_API_KEY) {
    throw new HttpError(500, "OPENAI_API_KEY is not configured on the server.");
  }
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json.");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxJsonBodyBytes) {
    throw new HttpError(413, "Request payload is too large.");
  }

  if (!request.body) {
    return {};
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxJsonBodyBytes) {
      await reader.cancel();
      throw new HttpError(413, "Request payload is too large.");
    }
    chunks.push(value);
  }

  const payload = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new HttpError(400, "Invalid JSON payload.");
  }
}

function requesterEmail(request: Request): string | null {
  const email =
    request.headers.get("oai-authenticated-user-email") ??
    request.headers.get("cf-access-authenticated-user-email") ??
    request.headers.get("x-authenticated-user-email") ??
    request.headers.get("x-forwarded-email");
  return email?.trim() || null;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: responseHeaders() });
}

function responseHeaders(): HeadersInit {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };
}

function logError(request: Request, error: unknown, event: string): void {
  console.error(
    JSON.stringify({
      event,
      method: request.method,
      path: new URL(request.url).pathname,
      error: error instanceof Error ? error.message : String(error)
    })
  );
}
