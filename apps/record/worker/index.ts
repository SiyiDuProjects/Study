import { DAILY_COURSE } from "../shared/courses";
import { weekSessionTitle } from "../shared/timetable";
import { createRealtimeClientSecret, safetyIdentifierFromEmail, translateKoreanToChinese } from "../services/openai";
import {
  completeLectureSessionSchema,
  courseQuerySchema,
  createLectureSessionSchema,
  failedLectureSessionSchema,
  internalSearchQuerySchema,
  internalSessionListQuerySchema,
  lectureCheckpointSchema,
  realtimeClientSecretRequestSchema,
  resumeLectureSessionSchema,
  sessionListQuerySchema,
  transcriptReadQuerySchema,
  translateRequestSchema
} from "../services/schemas";
import { createStudyCourseClient } from "../services/study";
import {
  createD1CourseRepository,
  createD1SessionRepository,
  IncompleteFinalizationConflict,
  SessionNotWritableError,
  UnfinishedLectureConflict,
  WriterLeaseConflict
} from "./db";
import { InvalidLectureCursor, InvalidLectureRecord } from "./read-pages";
import { safeErrorDiagnostic } from "../../core/src/logger";
import { schoolCoursesSchema, schoolIdSchema, schoolImportSchema, schoolStatusSchema } from "../../core/src/lecture/school-types";
import { schoolCaptionRepository } from "./school-captions";

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
const rateLimitBuckets = new Map<string, { resetAt: number; count: number }>();

export interface SitesEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  OPENAI_API_KEY?: string;
  STUDY_API_URL?: string;
  STUDY_SERVICE_TOKEN?: string;
  LECTURE_SERVICE_TOKEN?: string;
  STUDY_OWNER_EMAIL?: string;
}

export async function handleRequest(request: Request, env: SitesEnv): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/internal/")) {
    return env.ASSETS.fetch(request);
  }

  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({ ok: true, service: "study-record" });
    }

    const sessions = createD1SessionRepository(env.DB);
    const school = schoolCaptionRepository(env.DB);

    if (url.pathname.startsWith("/internal/school-captions/")) {
      await requireServiceToken(request, env.LECTURE_SERVICE_TOKEN);
      if (request.method === "GET" && url.pathname === "/internal/school-captions/courses") {
        // Background bootstrap: no browser visit or previous course-picker interaction is required.
        const lastRefresh = await env.DB.prepare("SELECT value FROM app_metadata WHERE key='school_catalog_checked_at'").first<{ value: string }>();
        if (!lastRefresh || Date.now() - Date.parse(lastRefresh.value) > 5 * 60_000) {
          try {
            const remote = await createStudyClient(env).listCourses({ includeArchived: true, refresh: true });
            await createD1CourseRepository(env.DB).upsertCourses(remote.courses, remote.syncedAt);
            await school.ensureDefaults(remote.courses);
            await env.DB.prepare("INSERT INTO app_metadata(key,value) VALUES('school_catalog_checked_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
              .bind(new Date().toISOString()).run();
          } catch (error) {
            logError(request, error, "school_course_refresh_failed");
            if (!(await school.list()).length) throw new HttpError(503, "School course discovery is temporarily unavailable.");
          }
        }
        return json(schoolCoursesSchema.parse({ courses: await school.list() }));
      }
      if (request.method === "POST" && url.pathname === "/internal/school-captions/import") {
        const parsed = schoolImportSchema.safeParse(await readJson(request));
        if (!parsed.success) throw new HttpError(400, "Invalid school caption import.");
        const course = await createD1CourseRepository(env.DB).getCourse(parsed.data.courseId);
        const enabled = (await school.list()).some(item => item.courseId === parsed.data.courseId && item.enabled);
        if (!course || course.isArchived || !enabled) throw new HttpError(409, "School caption synchronization is disabled.");
        await school.ingest(course, parsed.data);
        return json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/internal/school-captions/status") {
        const parsed = schoolStatusSchema.safeParse(await readJson(request));
        if (!parsed.success) throw new HttpError(400, "Invalid school caption status.");
        await school.status(parsed.data.courseId, parsed.data.sessionCount, parsed.data.error);
        return json({ ok: true });
      }
      throw new HttpError(404, "Internal API route not found.");
    }

    if (url.pathname.startsWith("/internal/mcp/lecture/")) {
      await requireServiceToken(request, env.LECTURE_SERVICE_TOKEN);
      // An explicit read-contract version keeps old Core working during rollout
      // and rollback. Browser /api responses already use the paged contract.
      const contract = request.headers.get("X-Study-Lecture-Contract");
      if (contract !== null && contract !== "paged-v1") throw new HttpError(426, "Unsupported lecture read contract.");
      const paged = contract === "paged-v1";
      const lectureJson = (body: unknown) => json(request.headers.get("X-Study-Lecture-Source") === "school-v1"
        ? body : JSON.parse(JSON.stringify(body, (key, value) => key === "source" ? undefined : value)));

      if (request.method === "GET" && url.pathname === "/internal/mcp/lecture/sessions") {
        const parsed = internalSessionListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
        if (!parsed.success) throw new HttpError(400, "Invalid lecture session query.");
        const page = await sessions.listSessions({
            courseId: parsed.data.course_id,
            status: parsed.data.status,
            limit: parsed.data.limit,
            startAt: parsed.data.start_at,
            endAt: parsed.data.end_at,
            cursor: parsed.data.cursor,
        });
        return lectureJson(paged ? page : { sessions: page.items });
      }

      const internalSessionMatch = url.pathname.match(/^\/internal\/mcp\/lecture\/sessions\/([^/]+)$/);
      if (request.method === "GET" && internalSessionMatch) {
        if (!paged) {
          const session = await sessions.getSession(routeId(internalSessionMatch[1]));
          if (!session) throw new HttpError(404, "Lecture session not found.");
          return lectureJson({ session });
        }
        const parsed = transcriptReadQuerySchema.safeParse(Object.fromEntries(url.searchParams));
        if (!parsed.success) throw new HttpError(400, "Invalid transcript range query.");
        const page = await sessions.getTranscriptPage(routeId(internalSessionMatch[1]), {
          startMs: parsed.data.start_ms, endMs: parsed.data.end_ms, cursor: parsed.data.cursor, limit: parsed.data.limit,
        });
        if (!page) throw new HttpError(404, "Lecture session not found.");
        return lectureJson(page);
      }

      if (request.method === "GET" && url.pathname === "/internal/mcp/lecture/search") {
        const parsed = internalSearchQuerySchema.safeParse(Object.fromEntries(url.searchParams));
        if (!parsed.success) throw new HttpError(400, "Invalid lecture search query.");
        const page = await sessions.searchSessions({
            query: parsed.data.q,
            courseId: parsed.data.course_id,
            status: parsed.data.status,
            limit: parsed.data.limit,
            sessionId: parsed.data.session_id,
            startAt: parsed.data.start_at,
            endAt: parsed.data.end_at,
            cursor: parsed.data.cursor,
        });
        return lectureJson(paged ? page : { query: page.query, hits: page.items });
      }

      throw new HttpError(404, "Internal API route not found.");
    }

    const identity = requireAuthenticatedUser(request, env);
    requireSameOriginForMutation(request, url);
    const courses = createD1CourseRepository(env.DB);

    if (request.method === "GET" && url.pathname === "/api/school-captions") {
      return json(schoolCoursesSchema.parse({ courses: await school.list() }));
    }
    const schoolLiveMatch = url.pathname.match(/^\/api\/school-captions\/(\d{1,20})\/live$/);
    if (request.method === "GET" && schoolLiveMatch) {
      return json(await sessions.getSchoolLive(schoolIdSchema.parse(schoolLiveMatch[1])));
    }
    const schoolCourseMatch = url.pathname.match(/^\/api\/school-captions\/(\d{1,20})$/);
    if (request.method === "PUT" && schoolCourseMatch) {
      const courseId = schoolIdSchema.parse(schoolCourseMatch[1]);
      const body = await readJson(request) as { enabled?: unknown };
      if (!body || typeof body.enabled !== "boolean") throw new HttpError(400, "Invalid school caption setting.");
      const course = await courses.getCourse(courseId);
      if (!course || course.isArchived) throw new HttpError(409, "Select an active Hanyang course first.");
      await school.configure(courseId, body.enabled);
      return json(schoolCoursesSchema.parse({ courses: await school.list() }));
    }

    if (request.method === "GET" && url.pathname === "/api/timetable") {
      const study = createStudyClient(env);
      return json(await study.getTimetable!());
    }

    if (request.method === "GET" && url.pathname === "/api/courses") {
      const parsed = courseQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) throw new HttpError(400, "Invalid course query.");
      const includeArchived = parsed.data.includeArchived === "true";
      try {
        const study = createStudyClient(env);
        const remote = await study.listCourses({ includeArchived: true, refresh: true });
        await courses.upsertCourses(remote.courses, remote.syncedAt);
        return json({
          courses: [DAILY_COURSE, ...(await courses.listCourses(includeArchived))],
          syncedAt: remote.syncedAt,
          stale: remote.stale,
          source: "study"
        });
      } catch (error) {
        logError(request, error, "course_refresh_failed");
        const cached = await courses.listCourses(includeArchived);
        return json({
          courses: [DAILY_COURSE, ...cached],
          syncedAt: await courses.syncedAt(),
          stale: true,
          source: "cache",
          warning: "Hanyang courses could not be refreshed. Showing the last saved course list."
        }, cached.length > 0 ? 200 : 503);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/realtime/client-secret") {
      enforceRateLimit(`realtime:${identity.id}`, 10 * 60_000, 40);
      const apiKey = requireOpenAiKey(env);
      const parsed = realtimeClientSecretRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) throw new HttpError(400, "Invalid realtime client secret request.");
      const clientSecret = await createRealtimeClientSecret({
        apiKey,
        mode: parsed.data.mode,
        safetyIdentifier: safetyIdentifierFromEmail(identity.email ?? identity.id)
      });
      return json(clientSecret);
    }

    if (request.method === "POST" && url.pathname === "/api/translate") {
      enforceRateLimit(`translate:${identity.id}`, 60_000, 120);
      const apiKey = requireOpenAiKey(env);
      const parsed = translateRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) throw new HttpError(400, "Invalid translation request.");
      const translatedText = await translateKoreanToChinese({
        apiKey,
        model: parsed.data.model,
        text: parsed.data.text,
        context: parsed.data.context,
        safetyIdentifier: safetyIdentifierFromEmail(identity.email ?? identity.id)
      });
      return json({ translatedText });
    }

    if (request.method === "GET" && url.pathname === "/api/sessions") {
      const parsed = sessionListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) throw new HttpError(400, "Invalid lecture session query.");
      return json(await sessions.listSessions({
          courseId: parsed.data.courseId,
          status: parsed.data.status,
          limit: parsed.data.limit,
          startAt: parsed.data.start_at,
          endAt: parsed.data.end_at,
          cursor: parsed.data.cursor,
      }));
    }

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const parsed = createLectureSessionSchema.safeParse(await readJson(request));
      if (!parsed.success) throw new HttpError(400, "Invalid lecture session request.");
      let course = parsed.data.courseId === DAILY_COURSE.id ? DAILY_COURSE : await courses.getCourse(parsed.data.courseId);
      if (!course) {
        const study = createStudyClient(env);
        const remote = await study.listCourses({ includeArchived: true, refresh: true });
        await courses.upsertCourses(remote.courses, remote.syncedAt);
        course = await courses.getCourse(parsed.data.courseId);
      }
      if (!course) throw new HttpError(409, "The selected Hanyang course no longer exists.");
      if (course.isArchived) throw new HttpError(409, "Archived Hanyang courses cannot start a new recording.");
      const writerLeaseToken = randomToken();
      const session = await sessions.createSession({
        title: weekSessionTitle(course, parsed.data.startedAt, course.source === "canvas" ? await createStudyClient(env).getTimetable!().catch(() => null) : null),
        id: `lecture_${crypto.randomUUID()}`,
        course,
        startedAt: parsed.data.startedAt,
        models: parsed.data.models,
        writerLeaseToken,
        now: new Date().toISOString()
      });
      return json({ session, writerLease: { token: writerLeaseToken } }, 201);
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const sessionId = routeId(sessionMatch[1]);
      if (request.method === "GET") {
        const parsed = transcriptReadQuerySchema.safeParse(Object.fromEntries(url.searchParams));
        if (!parsed.success) throw new HttpError(400, "Invalid transcript range query.");
        const page = await sessions.getTranscriptPage(sessionId, {
          startMs: parsed.data.start_ms, endMs: parsed.data.end_ms, cursor: parsed.data.cursor, limit: parsed.data.limit,
        });
        if (!page) throw new HttpError(404, "Lecture session not found.");
        return json(page);
      }
      if (request.method === "DELETE") {
        if (await sessions.archiveSession(sessionId)) return new Response(null, { status: 204, headers: responseHeaders() });
        const existing = await sessions.getSession(sessionId);
        if (existing && (existing.status === "recording" || existing.status === "failed")) {
          throw new HttpError(409, "Unfinished lecture sessions cannot be archived.");
        }
        throw new HttpError(404, "Lecture session not found.");
      }
    }

    const actionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(checkpoint|fail|resume|complete)$/);
    if (request.method === "POST" && actionMatch) {
      const sessionId = routeId(actionMatch[1]);
      const action = actionMatch[2];
      const body = await readJson(request);
      if (action === "checkpoint") {
        const parsed = lectureCheckpointSchema.safeParse(body);
        if (!parsed.success) throw new HttpError(400, "Invalid lecture checkpoint.");
        const session = await sessions.checkpointSession(sessionId, parsed.data);
        if (!session) throw new HttpError(404, "Lecture session not found.");
        return json({ session });
      }
      if (action === "fail") {
        const parsed = failedLectureSessionSchema.safeParse(body);
        if (!parsed.success) throw new HttpError(400, "Invalid failed lecture checkpoint.");
        const session = await sessions.failSession(sessionId, parsed.data);
        if (!session) throw new HttpError(404, "Lecture session not found.");
        return json({ session });
      }
      if (action === "resume") {
        const parsed = resumeLectureSessionSchema.safeParse(body);
        if (!parsed.success) throw new HttpError(400, "Invalid lecture resume request.");
        const writerLeaseToken = parsed.data.takeover ? randomToken() : parsed.data.writerLeaseToken;
        const session = parsed.data.takeover
          ? await sessions.takeoverSession(sessionId, writerLeaseToken, parsed.data.expectedRevision)
          : await sessions.resumeSession(sessionId, writerLeaseToken, parsed.data.expectedRevision);
        if (!session) throw new HttpError(404, "Lecture session not found.");
        return json({ session, writerLease: { token: writerLeaseToken } });
      }
      const parsed = completeLectureSessionSchema.safeParse(body);
      if (!parsed.success) throw new HttpError(400, "Invalid completed lecture payload.");
      const session = await sessions.completeSession(sessionId, parsed.data);
      if (!session) throw new HttpError(404, "Lecture session not found.");
      return json({ session });
    }

    throw new HttpError(404, "API route not found.");
  } catch (error) {
    if (error instanceof InvalidLectureCursor) return json({ error: error.message, code: "invalid_cursor" }, 400);
    if (error instanceof InvalidLectureRecord) return json({ error: error.message, code: "invalid_record" }, 502);
    if (error instanceof HttpError) return json({ error: error.message, ...error.details }, error.status);
    if (error instanceof UnfinishedLectureConflict) {
      return json({
        error: "An unfinished lecture session already exists. Resume or finish it before starting another.",
        sessionId: error.sessionId
      }, 409);
    }
    if (error instanceof IncompleteFinalizationConflict) {
      return json({
        error: "This lecture may be missing its final segment. Explicit confirmation is required to finish it.",
        finalizationWarning: error.warning
      }, 409);
    }
    if (error instanceof WriterLeaseConflict) {
      return json({
        error: "Another device has taken over this lecture, or this browser has a stale revision.",
        code: "writer_lease_conflict",
        currentRevision: error.currentRevision
      }, 409);
    }
    if (error instanceof SessionNotWritableError) {
      return json({ error: "Lecture session is no longer writable", code: "session_not_writable" }, 409);
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
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

function createStudyClient(env: SitesEnv) {
  if (!env.STUDY_API_URL || !env.STUDY_SERVICE_TOKEN) {
    throw new HttpError(503, "Study course integration is not configured.");
  }
  return createStudyCourseClient({ baseUrl: env.STUDY_API_URL, serviceToken: env.STUDY_SERVICE_TOKEN });
}

function requireOpenAiKey(env: SitesEnv): string {
  if (!env.OPENAI_API_KEY?.trim()) throw new HttpError(503, "Realtime transcription is not configured.");
  return env.OPENAI_API_KEY;
}

function requireAuthenticatedUser(request: Request, env: SitesEnv): { id: string; email: string | null } {
  const id = request.headers.get("oai-authenticated-user-id")?.trim();
  if (!id) throw new HttpError(401, "Sign in to access Study Record.");
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase() || null;
  if (!env.STUDY_OWNER_EMAIL?.trim()) throw new HttpError(503, "Study Record owner is not configured.");
  if (email !== env.STUDY_OWNER_EMAIL.trim().toLowerCase()) throw new HttpError(403, "This account cannot access Study Record.");
  return { id, email };
}

async function requireServiceToken(request: Request, expected: string | undefined): Promise<void> {
  if (!expected?.trim()) throw new HttpError(503, "Lecture service authentication is not configured.");
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const [expectedHash, suppliedHash] = await Promise.all([sha256(expected), sha256(supplied)]);
  if (!supplied || expectedHash !== suppliedHash) {
    throw new HttpError(401, "Invalid lecture service token.");
  }
}

function requireSameOriginForMutation(request: Request, url: URL): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  if (request.headers.get("origin") !== url.origin) {
    throw new HttpError(403, "Cross-origin state changes are not allowed.");
  }
}

function enforceRateLimit(key: string, windowMs: number, maximum: number): void {
  const now = Date.now();
  const current = rateLimitBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(key, { resetAt: now + windowMs, count: 1 });
    return;
  }
  current.count += 1;
  if (current.count > maximum) throw new HttpError(429, "Too many requests. Try again later.");
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(415, "Content-Type must be application/json.");
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    throw new HttpError(413, "Request payload is too large.");
  }
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "Request payload is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "Invalid JSON payload.");
  }
}

function routeId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "Invalid route identifier.");
  }
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: responseHeaders() });
}

function responseHeaders(): HeadersInit {
  return {
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff"
  };
}

function logError(request: Request, error: unknown, event: string): void {
  console.error(JSON.stringify({
    event,
    method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(request.method) ? request.method : "OTHER",
    routeFamily: new URL(request.url).pathname.startsWith("/internal/") ? "internal" : "api",
    error: safeErrorDiagnostic(error)
  }));
}
