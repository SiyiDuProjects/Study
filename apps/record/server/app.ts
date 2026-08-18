import express from "express";
import { existsSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { DAILY_COURSE } from "../shared/courses.js";
import {
  browserAuthMiddleware,
  developmentLoopbackHostMiddleware,
  internalHostMiddleware,
  serviceTokenMiddleware,
  trustedOriginMiddleware,
  type BrowserAuthenticator
} from "./auth.js";
import {
  createCourseRepository,
  createSessionRepository,
  IncompleteFinalizationConflict,
  UnfinishedLectureConflict,
  WriterLeaseConflict,
  type SqliteDatabase
} from "./db.js";
import { createRealtimeClientSecret, safetyIdentifierFromEmail, translateKoreanToChinese } from "./openai.js";
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
  translateRequestSchema
} from "./schemas.js";
import type { StudyCourseClient } from "./study.js";

export interface ServerAppOptions {
  db: SqliteDatabase;
  studyClient: StudyCourseClient;
  authenticateBrowser: BrowserAuthenticator;
  lectureServiceToken: string;
  internalAllowedHosts: readonly string[];
  publicOrigin?: string;
  openAiApiKey?: string;
  staticDir?: string | null;
  createClientSecret?: typeof createRealtimeClientSecret;
  translateText?: typeof translateKoreanToChinese;
}

export function createServerApp({
  db,
  studyClient,
  authenticateBrowser,
  lectureServiceToken,
  internalAllowedHosts,
  publicOrigin,
  openAiApiKey = process.env.OPENAI_API_KEY,
  staticDir,
  createClientSecret = createRealtimeClientSecret,
  translateText = translateKoreanToChinese
}: ServerAppOptions) {
  const app = express();
  const courses = createCourseRepository(db);
  const sessions = createSessionRepository(db);
  const authenticateService = serviceTokenMiddleware(lectureServiceToken);
  const authenticateInternalHost = internalHostMiddleware(internalAllowedHosts);
  const realtimeLimiter = createRateLimiter({ windowMs: 10 * 60_000, maximum: 40 });
  const translationLimiter = createRateLimiter({ windowMs: 60_000, maximum: 120 });

  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use(["/api", "/internal/mcp/lecture"], (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    next();
  });

  if (!publicOrigin) {
    app.use("/api", developmentLoopbackHostMiddleware());
  }

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, service: "study-lecture" });
  });

  // The MCP-facing surface is private service-to-service API. It does not use
  // the browser identity and never returns the legacy created_by_email field.
  app.get("/internal/mcp/lecture/sessions", authenticateInternalHost, authenticateService, (request, response) => {
    const parsed = internalSessionListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid lecture session query." });
      return;
    }
    response.json({
      sessions: sessions.listSessions({
        courseId: parsed.data.course_id,
        status: parsed.data.status,
        limit: parsed.data.limit
      })
    });
  });

  app.get("/internal/mcp/lecture/sessions/:id", authenticateInternalHost, authenticateService, (request, response) => {
    const session = sessions.getSession(routeId(request.params.id));
    if (!session) {
      response.status(404).json({ error: "Lecture session not found." });
      return;
    }
    response.json({ session });
  });

  app.get("/internal/mcp/lecture/search", authenticateInternalHost, authenticateService, (request, response) => {
    const parsed = internalSearchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid lecture search query." });
      return;
    }
    response.json({
      query: parsed.data.q,
      hits: sessions.searchSessions({
        query: parsed.data.q,
        courseId: parsed.data.course_id,
        status: parsed.data.status,
        limit: parsed.data.limit
      })
    });
  });

  if (publicOrigin) {
    app.use("/api", trustedOriginMiddleware(publicOrigin));
  }
  app.use("/api", browserAuthMiddleware(authenticateBrowser));

  app.get("/api/courses", async (request, response, next) => {
    const parsed = courseQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid course query." });
      return;
    }
    const includeArchived = parsed.data.includeArchived === "true";
    try {
      const remote = await studyClient.listCourses({ includeArchived: true, refresh: true });
      courses.upsertCourses(remote.courses, remote.syncedAt);
      response.json({
        courses: [DAILY_COURSE, ...courses.listCourses(includeArchived)],
        syncedAt: remote.syncedAt,
        stale: remote.stale,
        source: "study"
      });
    } catch {
      const cached = courses.listCourses(includeArchived);
      response.status(cached.length > 0 ? 200 : 503).json({
        courses: [DAILY_COURSE, ...cached],
        syncedAt: courses.syncedAt(),
        stale: true,
        source: "cache",
        warning: "Hanyang courses could not be refreshed. Showing the last saved course list."
      });
    }
  });

  app.post("/api/realtime/client-secret", realtimeLimiter, async (request, response, next) => {
    try {
      if (!openAiApiKey) {
        response.status(503).json({ error: "Realtime transcription is not configured." });
        return;
      }
      const parsed = realtimeClientSecretRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        response.status(400).json({ error: "Invalid realtime client secret request." });
        return;
      }
      const identity = response.locals.browserIdentity as { email: string };
      const clientSecret = await createClientSecret({
        apiKey: openAiApiKey,
        mode: parsed.data.mode,
        safetyIdentifier: safetyIdentifierFromEmail(identity.email)
      });
      response.json(clientSecret);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/translate", translationLimiter, async (request, response, next) => {
    try {
      if (!openAiApiKey) {
        response.status(503).json({ error: "Text translation is not configured." });
        return;
      }
      const parsed = translateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "Invalid translation request." });
        return;
      }
      const identity = response.locals.browserIdentity as { email: string };
      const translatedText = await translateText({
        apiKey: openAiApiKey,
        model: parsed.data.model,
        text: parsed.data.text,
        context: parsed.data.context,
        safetyIdentifier: safetyIdentifierFromEmail(identity.email)
      });
      response.json({ translatedText });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sessions", (request, response) => {
    const parsed = sessionListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid lecture session query." });
      return;
    }
    response.json({
      sessions: sessions.listSessions({
        courseId: parsed.data.courseId,
        status: parsed.data.status,
        limit: parsed.data.limit
      })
    });
  });

  app.get("/api/sessions/:id", (request, response) => {
    const session = sessions.getSession(routeId(request.params.id));
    if (!session) {
      response.status(404).json({ error: "Lecture session not found." });
      return;
    }
    response.json({ session });
  });

  app.post("/api/sessions", async (request, response, next) => {
    try {
      const parsed = createLectureSessionSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "Invalid lecture session request." });
        return;
      }
      let course = parsed.data.courseId === DAILY_COURSE.id ? DAILY_COURSE : courses.getCourse(parsed.data.courseId);
      if (!course) {
        const remote = await studyClient.listCourses({ includeArchived: true, refresh: true });
        courses.upsertCourses(remote.courses, remote.syncedAt);
        course = courses.getCourse(parsed.data.courseId);
      }
      if (!course) {
        response.status(409).json({ error: "The selected Hanyang course no longer exists." });
        return;
      }
      if (course.isArchived) {
        response.status(409).json({ error: "Archived Hanyang courses cannot start a new recording." });
        return;
      }
      const now = new Date().toISOString();
      const writerLeaseToken = randomBytes(32).toString("base64url");
      const session = sessions.createSession({
        id: `lecture_${randomUUID()}`,
        course,
        startedAt: parsed.data.startedAt,
        models: parsed.data.models,
        writerLeaseToken,
        now
      });
      response.status(201).json({ session, writerLease: { token: writerLeaseToken } });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sessions/:id/checkpoint", (request, response, next) => {
    try {
      const parsed = lectureCheckpointSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "Invalid lecture checkpoint." });
        return;
      }
      const session = sessions.checkpointSession(routeId(request.params.id), parsed.data);
      if (!session) {
        response.status(404).json({ error: "Lecture session not found." });
        return;
      }
      response.json({ session });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sessions/:id/fail", (request, response, next) => {
    try {
      const parsed = failedLectureSessionSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "Invalid failed lecture checkpoint." });
        return;
      }
      const session = sessions.failSession(routeId(request.params.id), parsed.data);
      if (!session) {
        response.status(404).json({ error: "Lecture session not found." });
        return;
      }
      response.json({ session });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sessions/:id/resume", (request, response, next) => {
    try {
      const parsed = resumeLectureSessionSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "Invalid lecture resume request." });
        return;
      }
      const id = routeId(request.params.id);
      const writerLeaseToken = parsed.data.takeover
        ? randomBytes(32).toString("base64url")
        : parsed.data.writerLeaseToken;
      const session = parsed.data.takeover
        ? sessions.takeoverSession(id, writerLeaseToken, parsed.data.expectedRevision)
        : sessions.resumeSession(id, writerLeaseToken, parsed.data.expectedRevision);
      if (!session) {
        response.status(404).json({ error: "Lecture session not found." });
        return;
      }
      response.json({ session, writerLease: { token: writerLeaseToken } });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sessions/:id/complete", (request, response, next) => {
    try {
      const parsed = completeLectureSessionSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "Invalid completed lecture payload." });
        return;
      }
      const session = sessions.completeSession(routeId(request.params.id), parsed.data);
      if (!session) {
        response.status(404).json({ error: "Lecture session not found." });
        return;
      }
      response.json({ session });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/sessions/:id", (request, response) => {
    const id = routeId(request.params.id);
    if (!sessions.archiveSession(id)) {
      const existing = sessions.getSession(id);
      if (existing && (existing.status === "recording" || existing.status === "failed")) {
        response.status(409).json({ error: "Unfinished lecture sessions cannot be archived." });
        return;
      }
      response.status(404).json({ error: "Lecture session not found." });
      return;
    }
    response.status(204).end();
  });

  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.use((request, response, next) => {
      if (request.method !== "GET" || request.path.startsWith("/api/") || request.path.startsWith("/internal/")) {
        next();
        return;
      }
      response.sendFile(path.join(staticDir, "index.html"));
    });
  }

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    console.error(error instanceof Error ? error.message : "Study Lecture request failed");
    if (error instanceof UnfinishedLectureConflict) {
      response.status(409).json({
        error: "An unfinished lecture session already exists. Resume or finish it before starting another.",
        sessionId: error.sessionId
      });
      return;
    }
    if (error instanceof IncompleteFinalizationConflict) {
      response.status(409).json({
        error: "This lecture may be missing its final segment. Explicit confirmation is required to finish it.",
        finalizationWarning: error.warning
      });
      return;
    }
    if (error instanceof WriterLeaseConflict) {
      response.status(409).json({
        error: "Another device has taken over this lecture, or this browser has a stale revision.",
        code: "writer_lease_conflict",
        currentRevision: error.currentRevision
      });
      return;
    }
    const message = error instanceof Error && /no longer writable|cannot be completed/.test(error.message)
      ? error.message
      : "Server request failed.";
    response.status(message === "Server request failed." ? 502 : 409).json({
      error: message,
      ...(message === "Server request failed." ? {} : { code: "session_not_writable" })
    });
  });

  return app;
}

function createRateLimiter({ windowMs, maximum }: { windowMs: number; maximum: number }): express.RequestHandler {
  const buckets = new Map<string, { resetAt: number; count: number }>();
  return (request, response, next) => {
    const now = Date.now();
    const identity = response.locals.browserIdentity as { email?: string } | undefined;
    const key = identity?.email ?? request.ip ?? "unknown";
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { resetAt: now + windowMs, count: 1 });
      next();
      return;
    }
    current.count += 1;
    if (current.count > maximum) {
      response.status(429).json({ error: "Too many requests. Try again later." });
      return;
    }
    next();
  };
}

function routeId(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}
