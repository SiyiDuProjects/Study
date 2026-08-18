import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { fileURLToPath } from "node:url";
import { type Server } from "node:http";
import { type AppConfig } from "./config.js";
import { type AppDatabase, openDatabase } from "./db/index.js";
import { CanvasRestClient } from "./canvas/index.js";
import { createAuthRouter, requireBearer } from "./auth/http.js";
import { createAuthService } from "./auth/service.js";
import { AuthError } from "./auth/errors.js";
import type { AuthService, BearerAuthentication, ValidatePat } from "./auth/types.js";
import { createCanvasMcpServer } from "./mcp/index.js";
import { isLectureToolName } from "./mcp/lectureTools.js";
import { CourseCatalogService } from "./course/index.js";
import { createInternalRouter } from "./internal/http.js";
import { LectureClient } from "./lecture/index.js";
import { log } from "./logger.js";

export interface CreateApplicationOptions {
  config: AppConfig;
  database?: AppDatabase;
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
}

export interface ApplicationRuntime {
  app: Express;
  config: AppConfig;
  database: AppDatabase;
  auth: AuthService;
  close(): void;
}

function validatePatWithCanvas(fetchImpl?: typeof globalThis.fetch): ValidatePat {
  return async ({ institution, baseUrl, pat }) => {
    const client = new CanvasRestClient(
      {
        userId: "pat-validation",
        institution,
        baseUrl,
        accessToken: pat,
        canvasUserId: "",
        canvasName: "",
      },
      fetchImpl ? { fetch: fetchImpl } : {},
    );
    const status = await client.connectionStatus();
    const profile = status.profile;
    return {
      id: profile.id,
      name: profile.name,
      ...(profile.sortableName === null ? {} : { sortableName: profile.sortableName }),
      ...(profile.loginId === null ? {} : { loginId: profile.loginId }),
    };
  };
}

function limiter(windowMs: number, limit: number): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_request, response) => {
      response.status(429).json({
        error: { code: "rate_limited", message: "Too many requests. Please try again later." },
      });
    },
  });
}

function page(webRoot: string, filename: string): RequestHandler {
  return (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    response.sendFile(filename, { root: webRoot }, (error) => {
      if (error) next(error);
    });
  };
}

function jsonRpcMethodNotAllowed(_request: express.Request, response: express.Response): void {
  response.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
}

function invokesLectureTool(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    const record = message as { method?: unknown; params?: unknown };
    if (record.method !== "tools/call" || !record.params || typeof record.params !== "object") {
      return false;
    }
    return isLectureToolName((record.params as { name?: unknown }).name);
  });
}

export function createApplication(options: CreateApplicationOptions): ApplicationRuntime {
  const { config } = options;
  const database = options.database ?? openDatabase(config.databasePath);
  const auth = createAuthService({
    db: database,
    config,
    validatePat: validatePatWithCanvas(options.fetch),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const courseCatalog = new CourseCatalogService({
    db: database,
    getConnection: (userId) => auth.getCanvasConnection(userId),
    minIntervalSeconds: config.courseSyncMinIntervalSeconds,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const lectureClient = config.lectureApiUrl && config.lectureServiceToken
    ? new LectureClient({
        baseUrl: config.lectureApiUrl,
        serviceToken: config.lectureServiceToken,
        ...(config.lectureSiteAuthToken === null ? {} : { siteAuthToken: config.lectureSiteAuthToken }),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      })
    : null;
  const publicHost = new URL(config.publicOrigin).hostname;
  const app = createMcpExpressApp({
    host: "0.0.0.0",
    allowedHosts: [...new Set([publicHost, "canvas", "localhost", "127.0.0.1", "[::1]"])],
  });
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'none'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          upgradeInsecureRequests: config.publicOrigin.startsWith("https:") ? [] : null,
        },
      },
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use((_request, response, next) => {
    response.set("X-Robots-Tag", "noindex, nofollow");
    response.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-create=(self), publickey-credentials-get=(self)",
    );
    next();
  });

  app.get("/healthz", (_request, response) => {
    response.set("Cache-Control", "no-store");
    response.json({ ok: true, service: "canvas", version: "0.1.0" });
  });
  app.get("/readyz", (_request, response, next) => {
    try {
      database.prepare("SELECT 1").get();
      response.set("Cache-Control", "no-store");
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  const webRoot = fileURLToPath(new URL("./web/", import.meta.url));
  app.use(
    "/assets",
    express.static(fileURLToPath(new URL("./web/assets/", import.meta.url)), {
      etag: true,
      fallthrough: false,
      maxAge: "1h",
    }),
  );
  app.get("/manifest.webmanifest", (_request, response) => {
    response.type("application/manifest+json").sendFile("manifest.webmanifest", { root: webRoot });
  });
  app.get("/", page(webRoot, "index.html"));
  app.get("/setup", page(webRoot, "setup.html"));
  app.get("/login", page(webRoot, "login.html"));
  app.get("/account", page(webRoot, "account.html"));
  app.get("/privacy", page(webRoot, "privacy.html"));
  app.get("/terms", page(webRoot, "terms.html"));

  app.use("/auth", limiter(10 * 60_000, 80));
  app.use("/api/account", limiter(10 * 60_000, 80));
  app.use("/oauth/register", limiter(60 * 60_000, 40));
  app.use("/oauth/authorize", limiter(10 * 60_000, 120));
  app.use("/oauth/consent", limiter(10 * 60_000, 120));
  app.use("/oauth/token", limiter(10 * 60_000, 120));
  app.use("/oauth/revoke", limiter(10 * 60_000, 120));
  app.use(createAuthRouter(auth, config));
  app.use(createInternalRouter(courseCatalog, config.studyServiceToken));

  const mcpLimit = limiter(60_000, 240);
  const bearer = requireBearer(auth, ["canvas.read"]);
  const lectureBearer = requireBearer(auth, ["canvas.read", "lecture.read"]);
  const requireToolScope: RequestHandler = (request, response, next) => {
    if (!lectureClient || !invokesLectureTool(request.body)) {
      next();
      return;
    }
    lectureBearer(request, response, next);
  };
  app.post("/mcp", mcpLimit, bearer, requireToolScope, async (request, response) => {
    const authentication = response.locals.auth as BearerAuthentication;
    const lectureCall = Boolean(lectureClient && invokesLectureTool(request.body));
    if (lectureCall) {
      try {
        courseCatalog.assertLectureOwner(authentication.userId);
      } catch (error) {
        log("warn", "lecture_owner_rejected", { error, userId: authentication.userId });
        response.status(403).json({
          jsonrpc: "2.0",
          error: { code: -32003, message: "The authenticated user cannot access Study Lecture." },
          id: request.body?.id ?? null,
        });
        return;
      }
    }
    const mcp = createCanvasMcpServer({
      userId: authentication.userId,
      getConnection: (userId) => auth.getCanvasConnection(userId),
      learningXEnabled: config.learningXEnabled,
      ...(lectureClient ? { lectureClient } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const transport = new StreamableHTTPServerTransport();
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      void transport.close().catch((error: unknown) => log("warn", "mcp_transport_close_failed", { error }));
      void mcp.close().catch((error: unknown) => log("warn", "mcp_server_close_failed", { error }));
    };
    response.once("close", close);
    try {
      // SDK 1.30's concrete transport and Transport declarations differ only in
      // exact-optional typing; at runtime this is the SDK's supported adapter.
      await mcp.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      log("error", "mcp_request_failed", { error, userId: authentication.userId });
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
      close();
    }
  });
  app.get("/mcp", mcpLimit, bearer, jsonRpcMethodNotAllowed);
  app.delete("/mcp", mcpLimit, bearer, jsonRpcMethodNotAllowed);

  app.use((_request, response) => {
    response.status(404).json({ error: { code: "not_found", message: "Route not found" } });
  });
  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof AuthError) {
      response.status(error.status).json({
        error: error.oauthError ?? error.code,
        error_description: error.message,
      });
      return;
    }
    const status =
      typeof error === "object" && error !== null && "status" in error &&
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500;
    log(status >= 500 ? "error" : "warn", "http_request_failed", { error, status });
    if (!response.headersSent) {
      response.status(status >= 400 && status < 500 ? status : 500).json({
        error: {
          code: status >= 400 && status < 500 ? "request_error" : "internal_error",
          message: status >= 400 && status < 500 ? "The request could not be handled" : "An internal error occurred",
        },
      });
    }
  };
  app.use(errorHandler);

  return {
    app,
    config,
    database,
    auth,
    close: () => database.close(),
  };
}

export async function closeHttpServer(server: Server, timeoutMs = 10_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
      reject(new Error("HTTP server shutdown timed out"));
    }, timeoutMs);
    timer.unref?.();
    server.close((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}
