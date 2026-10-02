import type { CourseOption } from "../../shared/courses";
import { timetableSchema, type Timetable } from "../../shared/timetable";
import { getLectureSessionResponseSchema, listLectureSessionsResponseSchema } from "../../../core/src/lecture/types";
import { schoolCoursesSchema, type SchoolCourse } from "../../../core/src/lecture/school-types";
import type {
  ClassSession,
  ClassSessionSummary,
  CompleteLectureSessionRequest,
  CreateLectureSessionRequest,
  FailedLectureSessionRequest,
  LectureCheckpointRequest,
  LectureSessionStatus,
  ResumeLectureSessionRequest,
  TextTranslationModel,
  TranslationMode,
  WriterLease
} from "../types";

export interface CoursesResponse {
  courses: CourseOption[];
  syncedAt: string | null;
  stale: boolean;
  source: "study" | "cache";
  warning?: string;
}

interface RealtimeClientSecretResponse {
  clientSecret: string;
  expiresAt: number;
}

interface SessionResponse {
  session: ClassSession;
}

export interface WritableSessionResponse extends SessionResponse {
  writerLease: WriterLease;
}

interface TranslateResponse {
  translatedText: string;
}

export const BROWSER_API_TIMEOUT_MS = 8_000;

export async function fetchSchoolCourses(): Promise<SchoolCourse[]> {
  return schoolCoursesSchema.parse(await requestJson<unknown>("/api/school-captions")).courses;
}

export async function fetchSchoolLive(courseId: string): Promise<ClassSession | null> {
  const raw = await requestJson<unknown>(`/api/school-captions/${encodeURIComponent(courseId)}/live`);
  if (raw === null) return null;
  const page = getLectureSessionResponseSchema.parse(raw);
  return { ...page.session, segments: page.items };
}

export async function setSchoolCourse(courseId: string, enabled: boolean): Promise<SchoolCourse[]> {
  return schoolCoursesSchema.parse(await requestJson<unknown>(`/api/school-captions/${encodeURIComponent(courseId)}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }),
  })).courses;
}

export async function fetchTimetable(): Promise<Timetable> {
  return timetableSchema.parse(await requestJson<unknown>("/api/timetable"));
}

export async function fetchCourses(includeArchived = false): Promise<CoursesResponse> {
  return requestJson<CoursesResponse>(
    `/api/courses?includeArchived=${includeArchived ? "true" : "false"}&refresh=true`
  );
}

export async function createRealtimeClientSecret(
  mode: TranslationMode,
  signal?: AbortSignal
): Promise<RealtimeClientSecretResponse> {
  return requestJson<RealtimeClientSecretResponse>("/api/realtime/client-secret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
    signal
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, text, context })
  });
  return data.translatedText;
}

export async function listRemoteSessions(options: {
  courseId?: string;
  status?: LectureSessionStatus | "all";
  limit?: number;
  onWarning?: (message: string) => void;
} = {}): Promise<ClassSessionSummary[]> {
  const params = new URLSearchParams();
  if (options.courseId) params.set("courseId", options.courseId);
  if (options.status) params.set("status", options.status);
  if (options.limit) params.set("limit", String(options.limit));
  const items: ClassSessionSummary[] = [];
  const cursors = new Set<string>();
  let invalidCount = 0;
  for (;;) {
    const data = listLectureSessionsResponseSchema.parse(await requestJson<unknown>(`/api/sessions?${params}`));
    items.push(...data.items);
    invalidCount += data.warnings.length;
    if (!data.nextCursor) break;
    if (cursors.has(data.nextCursor)) throw new ApiRequestError("记录分页未能继续，请刷新后重试。", 502);
    cursors.add(data.nextCursor);
    params.set("cursor", data.nextCursor);
  }
  if (invalidCount) options.onWarning?.(`已跳过 ${invalidCount} 条字段损坏的历史记录，其余记录仍可读取。`);
  return items;
}

export async function getRemoteSession(id: string): Promise<ClassSession> {
  // A background writer may advance the revision between transcript pages.
  for (let attempt = 0; ; attempt += 1) {
    try { return await getRemoteSessionPages(id); }
    catch (error) {
      if (!(error instanceof ApiRequestError) || error.code !== "invalid_cursor" || attempt >= 2) throw error;
    }
  }
}

async function getRemoteSessionPages(id: string): Promise<ClassSession> {
  const params = new URLSearchParams({ limit: "50" });
  const segments: ClassSession["segments"] = [];
  const cursors = new Set<string>();
  let invalidCount = 0;
  for (;;) {
    const data = getLectureSessionResponseSchema.parse(await requestJson<unknown>(`/api/sessions/${encodeURIComponent(id)}?${params}`));
    segments.push(...data.items);
    invalidCount += data.warnings.length;
    if (!data.nextCursor) {
      return {
        ...data.session,
        segments,
        finalizationWarning: invalidCount
          ? [data.session.finalizationWarning, `有 ${invalidCount} 段字幕字段损坏，读取结果可能不完整。`].filter(Boolean).join(" ")
          : data.session.finalizationWarning,
      };
    }
    if (cursors.has(data.nextCursor)) throw new ApiRequestError("字幕分页未能继续，请刷新后重试。", 502);
    cursors.add(data.nextCursor);
    params.set("cursor", data.nextCursor);
  }
}

export async function createRemoteSession(input: CreateLectureSessionRequest): Promise<WritableSessionResponse> {
  return requestJson<WritableSessionResponse>("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export async function checkpointRemoteSession(id: string, input: LectureCheckpointRequest): Promise<ClassSession> {
  return postSessionAction(id, "checkpoint", input);
}

export async function failRemoteSession(id: string, input: FailedLectureSessionRequest): Promise<ClassSession> {
  return postSessionAction(id, "fail", input);
}

export async function resumeRemoteSession(
  id: string,
  input: ResumeLectureSessionRequest
): Promise<WritableSessionResponse> {
  return requestJson<WritableSessionResponse>(`/api/sessions/${encodeURIComponent(id)}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export async function completeRemoteSession(
  id: string,
  input: CompleteLectureSessionRequest
): Promise<ClassSession> {
  return postSessionAction(id, "complete", input);
}

export async function archiveRemoteSession(id: string): Promise<void> {
  await requestJson<void>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

async function postSessionAction(id: string, action: string, input: unknown): Promise<ClassSession> {
  return (
    await requestJson<SessionResponse>(`/api/sessions/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    })
  ).session;
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const upstreamSignal = init?.signal;
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) abortFromUpstream();
  else upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  let timedOut = false;
  let timeoutId: number | undefined;
  const timeoutError = new ApiRequestError("服务器请求超时，请检查网络后重试。", 408, "client_timeout");
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
      reject(timeoutError);
    }, BROWSER_API_TIMEOUT_MS);
  });

  try {
    const operation = (async () => {
      const response = await fetch(input, { ...init, signal: controller.signal });
      if (response.status === 204) return undefined as T;
      const contentType = response.headers.get("content-type") ?? "";
      const body = contentType.includes("application/json") ? await response.json() : await response.text();
      if (!response.ok) {
        const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : null;
        const message = record && typeof record.error === "string" ? record.error : "服务器请求失败。";
        throw new ApiRequestError(
          message,
          response.status,
          record && typeof record.code === "string" ? record.code : undefined,
          record && typeof record.currentRevision === "number" ? record.currentRevision : undefined
        );
      }
      return body as T;
    })();
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly currentRevision?: number
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}
