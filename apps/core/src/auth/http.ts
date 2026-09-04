import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import cookieParser from "cookie-parser";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from "express";
import { normalizeReturnTo, type AppConfig } from "../config.js";
import { INSTITUTIONS, type InstitutionKey } from "../domain.js";
import { AuthError, invalidClient, invalidRequest } from "./errors.js";
import { assertSameOriginBrowserPost } from "./origin.js";
import type {
  AuthService,
  DynamicClientRegistrationInput,
  OAuthAuthorizationInput,
  SessionAuthentication,
  StepUpAction,
  WebAuthnLoginMode,
} from "./types.js";

type AsyncHandler = (request: Request, response: Response, next: NextFunction) => Promise<void>;

function asyncHandler(handler: AsyncHandler): RequestHandler {
  return (request, response, next) => {
    void handler(request, response, next).catch(next);
  };
}

function browserPost(config: AppConfig, handler: AsyncHandler): RequestHandler {
  return asyncHandler(async (request, response, next) => {
    assertSameOriginBrowserPost(request, config);
    await handler(request, response, next);
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest("A JSON object is required");
  }
  return value as Record<string, unknown>;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  aliases: readonly string[] = [],
): string {
  const raw = [key, ...aliases]
    .map((candidate) => record[candidate])
    .find((value) => value !== undefined);
  if (typeof raw !== "string" || !raw.trim()) {
    throw invalidRequest(`${key} is required`);
  }
  return raw;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const raw = record[key];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw invalidRequest(`${key} must be a string`);
  }
  return raw;
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const raw = record[key];
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
    throw invalidRequest(`${key} must be an array of strings`);
  }
  return raw;
}

function requiredObject<T>(
  record: Record<string, unknown>,
  key: string,
  aliases: readonly string[] = [],
): T {
  const raw = [key, ...aliases]
    .map((candidate) => record[candidate])
    .find((value) => value !== undefined);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidRequest(`${key} is required`);
  }
  return raw as T;
}

function optionalInstitution(record: Record<string, unknown>): InstitutionKey | undefined {
  const raw = record.institution;
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string" || !Object.hasOwn(INSTITUTIONS, raw)) {
    throw new AuthError("invalid_institution", "Unsupported institution", 400);
  }
  return raw as InstitutionKey;
}

function requiredStepUpAction(record: Record<string, unknown>): StepUpAction {
  const action = requiredString(record, "action");
  if (action !== "add_passkey" && action !== "delete_account") {
    throw new AuthError("invalid_step_up_action", "Unsupported step-up action", 400);
  }
  return action;
}

function optionalLoginMode(record: Record<string, unknown>): WebAuthnLoginMode | undefined {
  const mode = record.mode;
  if (mode === undefined) {
    return undefined;
  }
  if (mode !== "auto" && mode !== "canonical" && mode !== "legacy") {
    throw new AuthError("invalid_login_mode", "Unsupported passkey login mode", 400);
  }
  return mode;
}

function queryString(request: Request, key: string, required = true): string | undefined {
  const raw = request.query[key];
  if (raw === undefined && !required) {
    return undefined;
  }
  if (typeof raw !== "string" || (required && !raw)) {
    throw invalidRequest(`${key} must appear exactly once`);
  }
  return raw;
}

function authorizationInputFromQuery(request: Request): OAuthAuthorizationInput {
  const scope = queryString(request, "scope", false);
  const state = queryString(request, "state", false);
  return {
    clientId: queryString(request, "client_id")!,
    redirectUri: queryString(request, "redirect_uri")!,
    responseType: queryString(request, "response_type")!,
    codeChallenge: queryString(request, "code_challenge")!,
    codeChallengeMethod: queryString(request, "code_challenge_method")!,
    resource: queryString(request, "resource")!,
    ...(scope === undefined ? {} : { scope }),
    ...(state === undefined ? {} : { state }),
  };
}

function authorizationInputFromBody(request: Request): OAuthAuthorizationInput {
  const body = asRecord(request.body);
  const scope = optionalString(body, "scope");
  const state = optionalString(body, "state");
  return {
    clientId: requiredString(body, "client_id"),
    redirectUri: requiredString(body, "redirect_uri"),
    responseType: requiredString(body, "response_type"),
    codeChallenge: requiredString(body, "code_challenge"),
    codeChallengeMethod: requiredString(body, "code_challenge_method"),
    resource: requiredString(body, "resource"),
    ...(scope === undefined ? {} : { scope }),
    ...(state === undefined ? {} : { state }),
  };
}

function parseCookies(request: Request): Record<string, string> {
  const parsed: unknown = request.cookies;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }
  const result: Record<string, string> = {};
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    try {
      result[name] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      // Malformed cookies are ignored and treated as an absent session.
    }
  }
  return result;
}

function sessionToken(request: Request, config: AppConfig): string {
  return parseCookies(request)[config.sessionCookieName] ?? "";
}

function setSessionCookie(
  response: Response,
  config: AppConfig,
  token: string,
  expiresAt: number,
): void {
  response.cookie(config.sessionCookieName, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt),
  });
}

function clearSessionCookie(response: Response, config: AppConfig): void {
  response.clearCookie(config.sessionCookieName, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function hiddenInput(name: string, value: string | undefined): string {
  if (value === undefined) {
    return "";
  }
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function renderAuthorizationForm(
  input: OAuthAuthorizationInput,
  clientName: "ChatGPT" | "Codex",
  scope: string,
  user: SessionAuthentication["user"],
): string {
  const institutionName = INSTITUTIONS[user.institution].displayName;
  const grantsLecture = scope.split(/\s+/).includes("lecture.read");
  const dataDescription = grantsLecture
    ? "Hanyang Canvas data and saved Study Lecture transcripts"
    : "Hanyang Canvas data";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Study access</title><script src="/assets/oauth-consent.js" defer></script></head><body>
<main><h1>Authorize ${clientName}</h1>
<p>Signed in as <strong>${escapeHtml(user.displayName)}</strong> at ${escapeHtml(institutionName)}.</p>
<p>This grants read-only access to ${dataDescription} with scopes: ${escapeHtml(scope)}.</p>
<p>After approval, return to <code>${escapeHtml(input.redirectUri)}</code>.</p>
<form id="oauth-consent-form" method="post" action="/oauth/consent">
${hiddenInput("client_id", input.clientId)}
${hiddenInput("redirect_uri", input.redirectUri)}
${hiddenInput("response_type", input.responseType)}
${hiddenInput("code_challenge", input.codeChallenge)}
${hiddenInput("code_challenge_method", input.codeChallengeMethod)}
${hiddenInput("resource", input.resource)}
${hiddenInput("scope", input.scope)}
${hiddenInput("state", input.state)}
${hiddenInput("authorization_user_id", user.id)}
<button type="submit">Allow read-only access</button>
</form><p id="oauth-consent-status" role="status" hidden></p></main></body></html>`;
}

function oauthNoStore(response: Response): void {
  response.set("Cache-Control", "no-store");
  response.set("Pragma", "no-cache");
}

function bearerChallenge(config: AppConfig, error?: AuthError, requiredScopes?: readonly string[]): string {
  const parameters = [
    `resource_metadata="${config.publicOrigin}/.well-known/oauth-protected-resource"`,
  ];
  if (error?.oauthError) {
    parameters.push(`error="${error.oauthError}"`);
  }
  if (requiredScopes?.length) {
    parameters.push(`scope="${requiredScopes.join(" ")}"`);
  }
  return `Bearer ${parameters.join(", ")}`;
}

export function requireSession(service: AuthService): RequestHandler {
  return (request, response, next) => {
    try {
      const session = service.authenticateSession(sessionToken(request, service.config));
      response.locals.session = session;
      response.locals.user = session.user;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireBearer(
  service: AuthService,
  requiredScopes: readonly string[] = ["canvas.read"],
): RequestHandler {
  return (request, response, next) => {
    const match = /^Bearer ([^\s,]+)$/i.exec(request.headers.authorization ?? "");
    try {
      if (!match?.[1]) {
        throw new AuthError("invalid_token", "A bearer token is required", 401, "invalid_token");
      }
      const authentication = service.validateAccessToken(match[1], requiredScopes);
      response.locals.auth = authentication;
      next();
    } catch (error) {
      const authError = error instanceof AuthError ? error : undefined;
      response.set("WWW-Authenticate", bearerChallenge(service.config, authError, requiredScopes));
      next(error);
    }
  };
}

export function createAuthRouter(service: AuthService, config: AppConfig = service.config): Router {
  const router = express.Router();
  router.use(cookieParser());
  router.use(express.json({ limit: "64kb" }));
  router.use(express.urlencoded({ extended: false, limit: "32kb" }));

  router.get("/.well-known/oauth-protected-resource", (_request, response) => {
    response.json(service.protectedResourceMetadata());
  });
  router.get("/.well-known/oauth-protected-resource/mcp", (_request, response) => {
    response.json(service.protectedResourceMetadata());
  });
  router.get("/mcp/.well-known/oauth-protected-resource", (_request, response) => {
    response.json(service.protectedResourceMetadata());
  });
  router.get("/.well-known/oauth-authorization-server", (_request, response) => {
    response.json(service.authorizationServerMetadata());
  });

  const setupOptions = browserPost(config, async (request, response) => {
    const body = asRecord(request.body);
    const institution = optionalInstitution(body);
    const deviceName = optionalString(body, "deviceName");
    const result = await service.beginSetup({
      inviteToken: requiredString(body, "inviteToken"),
      pat: requiredString(body, "pat", ["canvasAccessToken"]),
      ...(institution === undefined ? {} : { institution }),
      ...(deviceName === undefined ? {} : { deviceName }),
    });
    oauthNoStore(response);
    response.json(result);
  });
  router.post("/auth/setup/options", setupOptions);
  router.post("/auth/register/options", setupOptions);

  const setupVerify = browserPost(config, async (request, response) => {
    const body = asRecord(request.body);
    const result = await service.finishSetup({
      flowId: requiredString(body, "flowId"),
      response: requiredObject<RegistrationResponseJSON>(body, "response", ["credential"]),
    });
    setSessionCookie(response, config, result.sessionToken, result.sessionExpiresAt);
    oauthNoStore(response);
    response.json({
      user: result.user,
      expiresAt: result.sessionExpiresAt,
      returnTo: "/account",
      redirectTo: "/account",
    });
  });
  router.post("/auth/setup/verify", setupVerify);
  router.post("/auth/register/verify", setupVerify);

  const loginOptions = browserPost(config, async (request, response) => {
    const body = request.body === undefined ? {} : asRecord(request.body);
    oauthNoStore(response);
    response.json(await service.beginPasskeyLogin(optionalLoginMode(body)));
  });
  router.post("/auth/passkey/options", loginOptions);
  router.post("/auth/login/options", loginOptions);

  const loginVerify = browserPost(config, async (request, response) => {
    const body = asRecord(request.body);
    const result = await service.finishPasskeyLogin({
      flowId: requiredString(body, "flowId"),
      response: requiredObject<AuthenticationResponseJSON>(body, "response", ["credential"]),
    });
    setSessionCookie(response, config, result.sessionToken, result.sessionExpiresAt);
    oauthNoStore(response);
    const redirectTo = normalizeReturnTo(body.returnTo, config);
    response.json({
      user: result.user,
      expiresAt: result.sessionExpiresAt,
      returnTo: redirectTo,
      redirectTo,
      ...(result.migrationStepUpToken === undefined
        ? {}
        : {
            migrationStepUpToken: result.migrationStepUpToken,
            migrationStepUpExpiresAt: result.migrationStepUpExpiresAt,
          }),
    });
  });
  router.post("/auth/passkey/verify", loginVerify);
  router.post("/auth/login/verify", loginVerify);

  router.get("/auth/session", (request, response) => {
    const returnTo = normalizeReturnTo(request.query.returnTo, config);
    try {
      const session = service.authenticateSession(sessionToken(request, config));
      oauthNoStore(response);
      response.json({
        authenticated: true,
        user: session.user,
        expiresAt: session.expiresAt,
        legacyLoginEnabled: config.webauthnLegacyLoginEnabled,
        returnTo,
        redirectTo: returnTo,
      });
    } catch (error) {
      if (!(error instanceof AuthError) || error.code !== "invalid_session") {
        throw error;
      }
      clearSessionCookie(response, config);
      oauthNoStore(response);
      response.json({
        authenticated: false,
        legacyLoginEnabled: config.webauthnLegacyLoginEnabled,
        returnTo,
        redirectTo: "/login",
      });
    }
  });

  router.post(
    "/auth/logout",
    browserPost(config, async (request, response) => {
      service.revokeSession(sessionToken(request, config));
      clearSessionCookie(response, config);
      oauthNoStore(response);
      response.json({ ok: true, redirectTo: "/login" });
    }),
  );

  router.get("/api/account", requireSession(service), (request, response) => {
    const session = response.locals.session as SessionAuthentication;
    oauthNoStore(response);
    response.json(service.getAccountSummary(session.user.id));
  });

  router.post(
    "/api/account/canvas-token",
    requireSession(service),
    browserPost(config, async (request, response) => {
      const session = response.locals.session as SessionAuthentication;
      const body = asRecord(request.body);
      const account = await service.rotateCanvasPat(
        session.user.id,
        requiredString(body, "canvasAccessToken", ["pat"]),
      );
      oauthNoStore(response);
      response.json(account);
    }),
  );

  router.post(
    "/api/account/step-up/options",
    requireSession(service),
    browserPost(config, async (request, response) => {
      const session = response.locals.session as SessionAuthentication;
      const body = asRecord(request.body);
      oauthNoStore(response);
      response.json(
        await service.beginStepUp(
          session.user.id,
          session.sessionId,
          requiredStepUpAction(body),
        ),
      );
    }),
  );

  router.post(
    "/api/account/step-up/verify",
    requireSession(service),
    browserPost(config, async (request, response) => {
      const session = response.locals.session as SessionAuthentication;
      const body = asRecord(request.body);
      const result = await service.finishStepUp({
        userId: session.user.id,
        sessionId: session.sessionId,
        flowId: requiredString(body, "flowId"),
        response: requiredObject<AuthenticationResponseJSON>(body, "response", ["credential"]),
      });
      oauthNoStore(response);
      response.json(result);
    }),
  );

  router.post(
    "/api/account/passkeys/options",
    requireSession(service),
    browserPost(config, async (request, response) => {
      const session = response.locals.session as SessionAuthentication;
      const body = asRecord(request.body);
      const deviceName = optionalString(body, "deviceName");
      oauthNoStore(response);
      response.json(
        await service.beginPasskeyRegistration({
          userId: session.user.id,
          sessionId: session.sessionId,
          stepUpToken: requiredString(body, "stepUpToken"),
          ...(deviceName === undefined ? {} : { deviceName }),
        }),
      );
    }),
  );

  router.post(
    "/api/account/passkeys/verify",
    requireSession(service),
    browserPost(config, async (request, response) => {
      const session = response.locals.session as SessionAuthentication;
      const body = asRecord(request.body);
      const result = await service.finishPasskeyRegistration({
        userId: session.user.id,
        sessionId: session.sessionId,
        flowId: requiredString(body, "flowId"),
        response: requiredObject<RegistrationResponseJSON>(body, "response", ["credential"]),
      });
      oauthNoStore(response);
      response.status(201).json(result);
    }),
  );

  router.post(
    "/api/account/delete",
    requireSession(service),
    browserPost(config, async (request, response) => {
      const body = asRecord(request.body);
      if (body.confirm !== true && body.confirmation !== "DELETE") {
        throw invalidRequest("confirm must be true or confirmation must equal DELETE");
      }
      const session = response.locals.session as SessionAuthentication;
      service.deleteAccount(
        session.user.id,
        session.sessionId,
        requiredString(body, "stepUpToken"),
      );
      clearSessionCookie(response, config);
      oauthNoStore(response);
      response.json({ ok: true, redirectTo: "/" });
    }),
  );

  router.post(
    "/oauth/register",
    asyncHandler(async (request, response) => {
      const body = asRecord(request.body);
      const redirectUris = optionalStringArray(body, "redirect_uris");
      if (!redirectUris) {
        throw invalidRequest("redirect_uris is required");
      }
      const clientName = optionalString(body, "client_name");
      const grantTypes = optionalStringArray(body, "grant_types");
      const responseTypes = optionalStringArray(body, "response_types");
      const tokenEndpointAuthMethod = optionalString(body, "token_endpoint_auth_method");
      const input: DynamicClientRegistrationInput = {
        redirect_uris: redirectUris,
        ...(clientName === undefined ? {} : { client_name: clientName }),
        ...(grantTypes === undefined ? {} : { grant_types: grantTypes }),
        ...(responseTypes === undefined ? {} : { response_types: responseTypes }),
        ...(tokenEndpointAuthMethod === undefined
          ? {}
          : { token_endpoint_auth_method: tokenEndpointAuthMethod }),
      };
      oauthNoStore(response);
      response.status(201).json(service.registerOAuthClient(input));
    }),
  );

  router.get(
    "/oauth/authorize",
    asyncHandler(async (request, response) => {
      const input = authorizationInputFromQuery(request);
      const inspected = service.inspectAuthorizationRequest(input);
      let session: SessionAuthentication;
      try {
        session = service.authenticateSession(sessionToken(request, config));
      } catch (error) {
        if (!(error instanceof AuthError) || error.code !== "invalid_session") {
          throw error;
        }
        const returnTo = normalizeReturnTo(request.originalUrl, config);
        response.redirect(302, `/login?returnTo=${encodeURIComponent(returnTo)}`);
        return;
      }
      oauthNoStore(response);
      const clientName = inspected.clientName === "Codex" ? "Codex" : "ChatGPT";
      response
        .type("html")
        .send(renderAuthorizationForm(inspected, clientName, inspected.scope, session.user));
    }),
  );

  const completeAuthorization = browserPost(config, async (request, response) => {
      const session = response.locals.session as SessionAuthentication;
      const body = asRecord(request.body);
      if (requiredString(body, "authorization_user_id") !== session.user.id) {
        throw new AuthError(
          "authorization_session_changed",
          "The signed-in account changed after this authorization page was opened",
          409,
          "access_denied",
        );
      }
      const result = service.issueAuthorizationCode(
        session.user.id,
        authorizationInputFromBody(request),
      );
      oauthNoStore(response);
      if (!request.is("application/json")) {
        response.redirect(303, result.redirectTo);
        return;
      }
      response.json({ redirectTo: result.redirectTo });
    });

  // Keep the protocol endpoint for JSON clients, but send browser consent forms
  // to a dedicated path. Some browser privacy extensions block form POSTs to
  // paths ending in `/oauth/authorize` even though the GET consent page loads.
  router.post("/oauth/authorize", requireSession(service), completeAuthorization);
  router.post("/oauth/consent", requireSession(service), completeAuthorization);

  router.post(
    "/oauth/token",
    asyncHandler(async (request, response) => {
      oauthNoStore(response);
      if (request.headers.authorization) {
        throw invalidClient("Public OAuth clients must not use client authentication");
      }
      const body = asRecord(request.body);
      const grantType = requiredString(body, "grant_type");
      if (grantType === "authorization_code") {
        response.json(
          service.exchangeAuthorizationCode({
            code: requiredString(body, "code"),
            clientId: requiredString(body, "client_id"),
            redirectUri: requiredString(body, "redirect_uri"),
            codeVerifier: requiredString(body, "code_verifier"),
            resource: requiredString(body, "resource"),
          }),
        );
        return;
      }
      if (grantType === "refresh_token") {
        response.json(
          service.exchangeRefreshToken({
            refreshToken: requiredString(body, "refresh_token"),
            clientId: requiredString(body, "client_id"),
            resource: requiredString(body, "resource"),
          }),
        );
        return;
      }
      throw new AuthError(
        "unsupported_grant_type",
        "Only authorization_code and refresh_token grants are supported",
        400,
        "unsupported_grant_type",
      );
    }),
  );

  router.post(
    "/oauth/revoke",
    asyncHandler(async (request, response) => {
      oauthNoStore(response);
      if (request.headers.authorization) {
        throw invalidClient("Public OAuth clients must not use client authentication");
      }
      service.revokeOAuthToken(requiredString(asRecord(request.body), "token"));
      response.status(200).send();
    }),
  );

  const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
    if (response.headersSent) {
      return;
    }
    const oauth = request.path.startsWith("/oauth/");
    if (error instanceof AuthError) {
      oauthNoStore(response);
      if (oauth) {
        response.status(error.status).json({
          error: error.oauthError ?? error.code,
          error_description: error.message,
        });
      } else {
        response.status(error.status).json({ error: { code: error.code, message: error.message } });
      }
      return;
    }
    oauthNoStore(response);
    const malformedJson = error instanceof SyntaxError && "status" in error && error.status === 400;
    response.status(malformedJson ? 400 : 500).json({
      error: oauth
        ? malformedJson
          ? "invalid_request"
          : "server_error"
        : {
            code: malformedJson ? "invalid_request" : "internal_error",
            message: malformedJson ? "Malformed request body" : "An internal error occurred",
          },
    });
  };
  router.use(errorHandler);

  return router;
}
