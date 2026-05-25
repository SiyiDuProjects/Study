import type { CourseOption } from "../../shared/courses";
import type { ClassSession, ClassSessionSummary, TextTranslationModel, TranslationMode } from "../types";

interface CoursesResponse {
  courses: CourseOption[];
}

interface RealtimeClientSecretResponse {
  clientSecret: string;
  expiresAt: number;
}

interface SessionsResponse {
  sessions: ClassSessionSummary[];
}

interface SessionResponse {
  session: ClassSession;
}

interface TranslateResponse {
  translatedText: string;
}

export async function fetchCourses(): Promise<CourseOption[]> {
  const data = await requestJson<CoursesResponse>("/api/courses");
  return data.courses;
}

export async function createRealtimeClientSecret(mode: TranslationMode): Promise<RealtimeClientSecretResponse> {
  return requestJson<RealtimeClientSecretResponse>("/api/realtime/client-secret", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ mode })
  });
}

export async function translateKoreanText({
  model,
  text,
  context
}: {
  model: TextTranslationModel;
  text: string;
  context?: Array<{ sourceText: string; translatedText: string }>;
}): Promise<string> {
  const data = await requestJson<TranslateResponse>("/api/translate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, text, context })
  });
  return data.translatedText;
}

export async function listRemoteSessions(courseId?: string): Promise<ClassSessionSummary[]> {
  const params = courseId ? `?courseId=${encodeURIComponent(courseId)}` : "";
  const data = await requestJson<SessionsResponse>(`/api/sessions${params}`);
  return data.sessions;
}

export async function getRemoteSession(id: string): Promise<ClassSession> {
  const data = await requestJson<SessionResponse>(`/api/sessions/${encodeURIComponent(id)}`);
  return data.session;
}

export async function saveRemoteSession(session: ClassSession): Promise<ClassSession> {
  const data = await requestJson<SessionResponse>("/api/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(session)
  });
  return data.session;
}

export async function deleteRemoteSession(id: string): Promise<void> {
  await requestJson<void>(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);

  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    const message = typeof body === "object" && body && "error" in body ? String(body.error) : "服务器请求失败。";
    throw new Error(message);
  }

  return body as T;
}
