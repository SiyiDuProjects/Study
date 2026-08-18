import { createPublicKey, timingSafeEqual, verify } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

interface AccessClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  email?: unknown;
}

interface AccessJwk {
  [key: string]: unknown;
  kid?: string;
  alg?: string;
}

export interface BrowserIdentity {
  email: string;
}

export type BrowserAuthenticator = (request: Request) => Promise<BrowserIdentity>;

export const PUBLIC_BROWSER_OWNER_EMAIL = "public-hanyang-owner@lecture.invalid";

export function createConfiguredBrowserAuthenticator({
  production,
  authMode,
  teamDomain,
  audience,
  ownerEmail
}: {
  production: boolean;
  authMode?: string;
  teamDomain?: string;
  audience?: string;
  ownerEmail?: string;
}): BrowserAuthenticator {
  const mode = authMode?.trim();
  if (mode === "public") {
    return createPublicOwnerAuthenticator();
  }
  if (mode === "cloudflare-access") {
    if (!teamDomain || !audience || !ownerEmail) {
      throw new Error(
        "CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, and LECTURE_OWNER_EMAIL are required for LECTURE_AUTH_MODE=cloudflare-access"
      );
    }
    return createCloudflareAccessAuthenticator({ teamDomain, audience, ownerEmail });
  }
  if (mode) {
    throw new Error("LECTURE_AUTH_MODE must be exactly public or cloudflare-access");
  }
  if (production) {
    throw new Error(
      "LECTURE_AUTH_MODE must be explicitly configured in production; set it to public only when unauthenticated browser access is intended"
    );
  }
  return createDevelopmentLoopbackAuthenticator(ownerEmail);
}

export function createPublicOwnerAuthenticator(): BrowserAuthenticator {
  const identity = Object.freeze({ email: PUBLIC_BROWSER_OWNER_EMAIL });
  return async () => identity;
}

export function createDevelopmentLoopbackAuthenticator(ownerEmail?: string): BrowserAuthenticator {
  const developmentEmail = ownerEmail?.trim().toLowerCase() || "local-hanyang-owner@example.invalid";
  return async (request) => {
    const address = request.socket.remoteAddress ?? "";
    if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") {
      throw new AuthFailure("Development API access is limited to the local machine");
    }
    return { email: developmentEmail };
  };
}

export function createCloudflareAccessAuthenticator({
  teamDomain,
  audience,
  ownerEmail,
  fetchImpl = fetch
}: {
  teamDomain: string;
  audience: string;
  ownerEmail: string;
  fetchImpl?: typeof fetch;
}): BrowserAuthenticator {
  const issuer = normalizeTeamDomain(teamDomain);
  const normalizedOwner = ownerEmail.trim().toLowerCase();
  if (!audience.trim() || !normalizedOwner) {
    throw new Error("CF_ACCESS_AUD and LECTURE_OWNER_EMAIL are required");
  }

  let cachedKeys: { expiresAt: number; keys: AccessJwk[] } | null = null;

  async function getKeys(): Promise<AccessJwk[]> {
    if (cachedKeys && cachedKeys.expiresAt > Date.now()) {
      return cachedKeys.keys;
    }
    const response = await fetchImpl(new URL("/cdn-cgi/access/certs", issuer), {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) {
      throw new Error("Cloudflare Access keys could not be loaded");
    }
    const body = (await response.json()) as { keys?: AccessJwk[] };
    if (!Array.isArray(body.keys) || body.keys.length === 0) {
      throw new Error("Cloudflare Access keys response was invalid");
    }
    cachedKeys = { expiresAt: Date.now() + 60 * 60_000, keys: body.keys };
    return body.keys;
  }

  return async (request) => {
    const token = request.header("Cf-Access-Jwt-Assertion")?.trim();
    if (!token) {
      throw new AuthFailure("Cloudflare Access assertion is required");
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new AuthFailure("Cloudflare Access assertion is malformed");
    }
    const header = decodeJson<{ alg?: unknown; kid?: unknown }>(parts[0]);
    const claims = decodeJson<AccessClaims>(parts[1]);
    if (header.alg !== "RS256" || typeof header.kid !== "string") {
      throw new AuthFailure("Cloudflare Access assertion algorithm is not allowed");
    }
    const key = (await getKeys()).find((candidate) => candidate.kid === header.kid);
    if (!key) {
      cachedKeys = null;
      throw new AuthFailure("Cloudflare Access signing key was not found");
    }
    const signatureValid = verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key, format: "jwk" } as unknown as Parameters<typeof createPublicKey>[0]),
      Buffer.from(parts[2], "base64url")
    );
    if (!signatureValid) {
      throw new AuthFailure("Cloudflare Access assertion signature is invalid");
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const tokenAudience = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
    if (
      claims.iss !== issuer.origin ||
      !tokenAudience.includes(audience) ||
      typeof claims.exp !== "number" ||
      claims.exp <= nowSeconds ||
      (typeof claims.nbf === "number" && claims.nbf > nowSeconds + 30)
    ) {
      throw new AuthFailure("Cloudflare Access assertion claims are invalid");
    }
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    if (!email || email !== normalizedOwner) {
      throw new AuthFailure("Cloudflare Access user is not the configured Hanyang owner");
    }
    return { email };
  };
}

export function browserAuthMiddleware(authenticate: BrowserAuthenticator): RequestHandler {
  return async (request, response, next) => {
    try {
      response.locals.browserIdentity = await authenticate(request);
      next();
    } catch (error) {
      if (error instanceof AuthFailure) {
        response.status(401).json({ error: error.message });
        return;
      }
      next(error);
    }
  };
}

export function serviceTokenMiddleware(expectedToken: string): RequestHandler {
  if (!expectedToken.trim()) {
    throw new Error("LECTURE_SERVICE_TOKEN is required");
  }
  return (request: Request, response: Response, next: NextFunction) => {
    const authorization = request.header("Authorization") ?? "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!safeTokenEqual(supplied, expectedToken)) {
      response.status(401).json({ error: "A valid lecture service token is required." });
      return;
    }
    next();
  };
}

export function internalHostMiddleware(allowedHosts: readonly string[]): RequestHandler {
  const exactHosts = new Set(allowedHosts.filter((value) => value.includes(":")).map((value) => value.toLowerCase()));
  const exactHostnames = new Set(allowedHosts.filter((value) => !value.includes(":")).map((value) => value.toLowerCase()));
  if (exactHosts.size === 0 && exactHostnames.size === 0) {
    throw new Error("At least one exact internal host must be configured");
  }
  return (request, response, next) => {
    const suppliedHost = request.header("host")?.trim().toLowerCase() ?? "";
    let hostname = "";
    try {
      hostname = new URL(`http://${suppliedHost}`).hostname.toLowerCase();
    } catch {
      response.status(421).json({ error: "Internal request host is invalid." });
      return;
    }
    if (!exactHosts.has(suppliedHost) && !exactHostnames.has(hostname)) {
      response.status(421).json({ error: "Internal request host is not allowed." });
      return;
    }
    next();
  };
}

export function developmentLoopbackHostMiddleware(): RequestHandler {
  return (request, response, next) => {
    const localPort = request.socket.localPort;
    const suppliedHost = request.header("host")?.trim().toLowerCase() ?? "";
    if (!localPort || (suppliedHost !== `127.0.0.1:${localPort}` && suppliedHost !== `localhost:${localPort}`)) {
      response.status(421).json({ error: "Development API host is not allowed." });
      return;
    }
    next();
  };
}

export function trustedOriginMiddleware(publicOrigin: string): RequestHandler {
  const expected = new URL(publicOrigin);
  return (request, response, next) => {
    const host = request.header("host")?.toLowerCase();
    if (host !== expected.host.toLowerCase()) {
      response.status(421).json({ error: "Request host is not allowed." });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.header("origin");
      if (origin !== expected.origin) {
        response.status(403).json({ error: "Request origin is not allowed." });
        return;
      }
    }
    next();
  };
}

export class AuthFailure extends Error {}

function normalizeTeamDomain(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "gaid.cloudflareaccess.com") {
    throw new Error("CF_ACCESS_TEAM_DOMAIN must be exactly https://gaid.cloudflareaccess.com");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  return url;
}

function decodeJson<T>(value: string): T {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    throw new AuthFailure("Cloudflare Access assertion could not be decoded");
  }
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
