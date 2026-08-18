import { z } from "zod";

const DEFAULT_CHATGPT_LEGACY_REDIRECT_URI =
  "https://chatgpt.com/connector_platform_oauth_redirect";
const CHATGPT_CALLBACK_PATH = /^\/connector\/oauth\/[A-Za-z0-9_-]{1,200}$/;

const optionalTrimmedString = (minimumLength: number) =>
  z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().min(minimumLength).optional(),
  );

const envSchema = z.object({
  PUBLIC_ORIGIN: z.string().url(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8794),
  DATABASE_PATH: z.string().min(1).default("./data/canvas.sqlite"),
  MASTER_KEY_BASE64: z.string().min(1),
  WEBAUTHN_RP_ID: z.string().min(1),
  WEBAUTHN_RP_NAME: z.string().min(1).default("Study"),
  TRUST_PROXY: z.coerce.number().int().min(0).max(2).default(1),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  STUDY_SERVICE_TOKEN: z.string().trim().min(32),
  LECTURE_API_URL: optionalTrimmedString(1),
  LECTURE_SERVICE_TOKEN: optionalTrimmedString(32),
  LECTURE_SITE_AUTH_TOKEN: optionalTrimmedString(32),
  COURSE_SYNC_MIN_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
  LEARNINGX_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  OAUTH_ADDITIONAL_REDIRECT_URIS: z.string().optional(),
  OAUTH_DCR_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  OAUTH_MAX_CLIENTS: z.coerce.number().int().min(1).max(32).default(8),
  INVITE_TTL_SECONDS: z.coerce.number().int().min(60).default(7 * 24 * 60 * 60),
  SETUP_FLOW_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(10 * 60),
  WEBAUTHN_FLOW_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(5 * 60),
  STEP_UP_FLOW_TTL_SECONDS: z.coerce.number().int().min(30).max(600).default(5 * 60),
  STEP_UP_TOKEN_TTL_SECONDS: z.coerce.number().int().min(30).max(600).default(2 * 60),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).default(12 * 60 * 60),
  OAUTH_CODE_TTL_SECONDS: z.coerce.number().int().min(30).max(600).default(5 * 60),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(60 * 60),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).default(30 * 24 * 60 * 60),
});

export interface AppConfig {
  publicOrigin: string;
  port: number;
  databasePath: string;
  masterKey: Buffer;
  webauthnRpId: string;
  webauthnRpName: string;
  trustProxy: number;
  cookieSecure: boolean;
  sessionCookieName: string;
  logLevel: "debug" | "info" | "warn" | "error";
  studyServiceToken: string;
  lectureApiUrl: string | null;
  lectureServiceToken: string | null;
  lectureSiteAuthToken: string | null;
  courseSyncMinIntervalSeconds: number;
  learningXEnabled: boolean;
  oauthIssuer: string;
  oauthResource: string;
  oauthScopes: readonly string[];
  additionalRedirectUris: ReadonlySet<string>;
  oauthDcrEnabled: boolean;
  oauthMaxClients: number;
  inviteTtlSeconds: number;
  setupFlowTtlSeconds: number;
  webauthnFlowTtlSeconds: number;
  stepUpFlowTtlSeconds: number;
  stepUpTokenTtlSeconds: number;
  sessionTtlSeconds: number;
  oauthCodeTtlSeconds: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
}

function normalizeOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("PUBLIC_ORIGIN must be a bare origin without credentials, query, or fragment");
  }
  if (url.pathname !== "/") {
    throw new Error("PUBLIC_ORIGIN must not include a path");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("PUBLIC_ORIGIN must use HTTPS (HTTP is allowed only for localhost)");
  }
  return url.origin;
}

function normalizeServiceOrigin(raw: string): string {
  const url = new URL(raw);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("LECTURE_API_URL must be a credential-free HTTP(S) origin");
  }
  return url.origin;
}

function decodeMasterKey(raw: string): Buffer {
  const canonical = raw.trim();
  const key = Buffer.from(canonical, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== canonical.replace(/=+$/, "")) {
    throw new Error("MASTER_KEY_BASE64 must be canonical base64 encoding of exactly 32 bytes");
  }
  return key;
}

function parseAdditionalRedirectUris(raw: string | undefined): ReadonlySet<string> {
  const values = (raw ?? "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const normalized = new Set<string>();
  for (const value of values) {
    const url = new URL(value);
    if (url.username || url.password || url.hash) {
      throw new Error("Additional OAuth redirect URIs cannot contain credentials or fragments");
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      throw new Error("Additional OAuth redirect URIs must use HTTPS or localhost HTTP");
    }
    normalized.add(url.toString());
  }
  return normalized;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const lectureConfigured = parsed.LECTURE_API_URL !== undefined;
  if (lectureConfigured !== (parsed.LECTURE_SERVICE_TOKEN !== undefined)) {
    throw new Error("LECTURE_API_URL and LECTURE_SERVICE_TOKEN must be configured together");
  }
  const publicOrigin = normalizeOrigin(parsed.PUBLIC_ORIGIN);
  const rpHost = new URL(publicOrigin).hostname;
  if (parsed.WEBAUTHN_RP_ID !== rpHost) {
    throw new Error("WEBAUTHN_RP_ID must exactly equal the PUBLIC_ORIGIN hostname for v1");
  }
  const secureOrigin = new URL(publicOrigin).protocol === "https:";
  if (secureOrigin && !parsed.COOKIE_SECURE) {
    throw new Error("COOKIE_SECURE must be true for HTTPS origins");
  }
  if (!secureOrigin && parsed.COOKIE_SECURE) {
    throw new Error("COOKIE_SECURE must be false for localhost HTTP origins");
  }

  return {
    publicOrigin,
    port: parsed.PORT,
    databasePath: parsed.DATABASE_PATH,
    masterKey: decodeMasterKey(parsed.MASTER_KEY_BASE64),
    webauthnRpId: parsed.WEBAUTHN_RP_ID,
    webauthnRpName: parsed.WEBAUTHN_RP_NAME,
    trustProxy: parsed.TRUST_PROXY,
    cookieSecure: parsed.COOKIE_SECURE,
    sessionCookieName: parsed.COOKIE_SECURE ? "__Host-canvas_session" : "canvas_session",
    logLevel: parsed.LOG_LEVEL,
    studyServiceToken: parsed.STUDY_SERVICE_TOKEN,
    lectureApiUrl: parsed.LECTURE_API_URL ? normalizeServiceOrigin(parsed.LECTURE_API_URL) : null,
    lectureServiceToken: parsed.LECTURE_SERVICE_TOKEN ?? null,
    lectureSiteAuthToken: parsed.LECTURE_SITE_AUTH_TOKEN ?? null,
    courseSyncMinIntervalSeconds: parsed.COURSE_SYNC_MIN_INTERVAL_SECONDS,
    learningXEnabled: parsed.LEARNINGX_ENABLED,
    oauthIssuer: publicOrigin,
    oauthResource: `${publicOrigin}/mcp`,
    oauthScopes: lectureConfigured
      ? ["canvas.read", "lecture.read", "offline_access"]
      : ["canvas.read", "offline_access"],
    additionalRedirectUris: parseAdditionalRedirectUris(parsed.OAUTH_ADDITIONAL_REDIRECT_URIS),
    oauthDcrEnabled: parsed.OAUTH_DCR_ENABLED,
    oauthMaxClients: parsed.OAUTH_MAX_CLIENTS,
    inviteTtlSeconds: parsed.INVITE_TTL_SECONDS,
    setupFlowTtlSeconds: parsed.SETUP_FLOW_TTL_SECONDS,
    webauthnFlowTtlSeconds: parsed.WEBAUTHN_FLOW_TTL_SECONDS,
    stepUpFlowTtlSeconds: parsed.STEP_UP_FLOW_TTL_SECONDS,
    stepUpTokenTtlSeconds: parsed.STEP_UP_TOKEN_TTL_SECONDS,
    sessionTtlSeconds: parsed.SESSION_TTL_SECONDS,
    oauthCodeTtlSeconds: parsed.OAUTH_CODE_TTL_SECONDS,
    accessTokenTtlSeconds: parsed.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: parsed.REFRESH_TOKEN_TTL_SECONDS,
  };
}

export function isAllowedChatGptRedirectUri(raw: string): boolean {
  if (raw === DEFAULT_CHATGPT_LEGACY_REDIRECT_URI) {
    return true;
  }
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      url.hostname === "chatgpt.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      CHATGPT_CALLBACK_PATH.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function isAllowedOAuthRedirectUri(raw: string, config: Pick<AppConfig, "additionalRedirectUris">): boolean {
  if (isAllowedChatGptRedirectUri(raw)) {
    return true;
  }
  try {
    return config.additionalRedirectUris.has(new URL(raw).toString());
  } catch {
    return false;
  }
}

export function normalizeReturnTo(raw: unknown, config: Pick<AppConfig, "publicOrigin">): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return "/account";
  }
  try {
    const url = new URL(raw, config.publicOrigin);
    if (url.origin !== config.publicOrigin) {
      return "/account";
    }
    let decodedPath = url.pathname;
    for (let index = 0; index < 3; index += 1) {
      if (
        decodedPath.startsWith("//") ||
        decodedPath.includes("\\") ||
        /(?:^|\/)\.\.(?:\/|$)/.test(decodedPath)
      ) {
        return "/account";
      }
      const next = decodeURIComponent(decodedPath);
      if (next === decodedPath) {
        break;
      }
      decodedPath = next;
    }
    if (
      decodedPath.startsWith("//") ||
      decodedPath.includes("\\") ||
      /(?:^|\/)\.\.(?:\/|$)/.test(decodedPath)
    ) {
      return "/account";
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/account";
  }
}

export { DEFAULT_CHATGPT_LEGACY_REDIRECT_URI };
