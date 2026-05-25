import express, { type Request } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { COURSES } from "../shared/courses.js";
import { createSessionRepository, type SqliteDatabase } from "./db.js";
import { createRealtimeClientSecret, safetyIdentifierFromEmail, translateKoreanToChinese } from "./openai.js";
import {
  classSessionSchema,
  courseQuerySchema,
  realtimeClientSecretRequestSchema,
  translateRequestSchema
} from "./schemas.js";

export interface ServerAppOptions {
  db: SqliteDatabase;
  openAiApiKey?: string;
  staticDir?: string | null;
  createClientSecret?: typeof createRealtimeClientSecret;
  translateText?: typeof translateKoreanToChinese;
}

export function createServerApp({
  db,
  openAiApiKey = process.env.OPENAI_API_KEY,
  staticDir,
  createClientSecret = createRealtimeClientSecret,
  translateText = translateKoreanToChinese
}: ServerAppOptions) {
  const app = express();
  const sessions = createSessionRepository(db);

  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/courses", (_req, res) => {
    res.json({ courses: COURSES });
  });

  app.post("/api/realtime/client-secret", async (req, res, next) => {
    try {
      if (!openAiApiKey) {
        res.status(500).json({ error: "OPENAI_API_KEY is not configured on the server." });
        return;
      }

      const parsed = realtimeClientSecretRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid realtime client secret request." });
        return;
      }

      const clientSecret = await createClientSecret({
        apiKey: openAiApiKey,
        mode: parsed.data.mode,
        safetyIdentifier: safetyIdentifierFromEmail(getRequesterEmail(req))
      });
      res.json(clientSecret);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/translate", async (req, res, next) => {
    try {
      if (!openAiApiKey) {
        res.status(500).json({ error: "OPENAI_API_KEY is not configured on the server." });
        return;
      }

      const parsed = translateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid translation request." });
        return;
      }

      const translatedText = await translateText({
        apiKey: openAiApiKey,
        model: parsed.data.model,
        text: parsed.data.text,
        context: parsed.data.context,
        safetyIdentifier: safetyIdentifierFromEmail(getRequesterEmail(req))
      });

      res.json({ translatedText });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sessions", (req, res) => {
    const parsed = courseQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid course filter." });
      return;
    }

    res.json({ sessions: sessions.listSessions(parsed.data.courseId) });
  });

  app.get("/api/sessions/:id", (req, res) => {
    const session = sessions.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found." });
      return;
    }

    res.json({ session });
  });

  app.post("/api/sessions", (req, res) => {
    const parsed = classSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid session payload." });
      return;
    }

    const saved = sessions.saveSession(parsed.data, getRequesterEmail(req));
    res.status(201).json({ session: saved });
  });

  app.delete("/api/sessions/:id", (req, res) => {
    const deleted = sessions.deleteSession(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "Session not found." });
      return;
    }

    res.status(204).end();
  });

  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api/")) {
        next();
        return;
      }

      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(error);
    res.status(502).json({ error: "Server request failed." });
  });

  return app;
}

function getRequesterEmail(req: Request): string | null {
  const email =
    req.header("cf-access-authenticated-user-email") ??
    req.header("x-authenticated-user-email") ??
    req.header("x-forwarded-email");
  return email?.trim() || null;
}
