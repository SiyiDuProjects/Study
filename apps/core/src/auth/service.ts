import { randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { INSTITUTIONS, type CanvasConnection, type InstitutionKey } from "../domain.js";
import { isAllowedChatGptRedirectUri, isAllowedOAuthRedirectUri } from "../config.js";
import { createPatCipher, hashOpaqueToken, hashPat, pkceS256, randomOpaqueToken, safeEqualText } from "../crypto/index.js";
import { AuthError, invalidClient, invalidGrant, invalidRequest } from "./errors.js";
import type {
  AccountSummary,
  AuthService,
  AuthServiceOptions,
  AuthenticatedUser,
  DynamicClientRegistrationInput,
  DynamicClientRegistrationResponse,
  OAuthAuthorizationInput,
  OAuthAuthorizationRequest,
  OAuthTokenResponse,
  StepUpAction,
} from "./types.js";

interface InviteRow {
  id: string;
  institution: string;
  expires_at: number;
  used_at: number | null;
}

interface SetupFlowRow {
  flow_hash: string;
  invite_id: string;
  pending_user_id: string;
  institution: string;
  base_url: string;
  canvas_user_id: string;
  canvas_name: string;
  pat_version: number;
  pat_iv: Buffer;
  pat_ciphertext: Buffer;
  pat_auth_tag: Buffer;
  pat_hash: string;
  device_name: string | null;
  challenge: string;
  expires_at: number;
  used_at: number | null;
}

interface LoginFlowRow {
  flow_hash: string;
  challenge: string;
  expires_at: number;
  used_at: number | null;
}

interface PasskeyRegistrationFlowRow {
  flow_hash: string;
  user_id: string;
  session_hash: string;
  device_name: string | null;
  challenge: string;
  expires_at: number;
  used_at: number | null;
}

interface StepUpFlowRow {
  flow_hash: string;
  user_id: string;
  session_hash: string;
  action: StepUpAction;
  challenge: string;
  expires_at: number;
}

interface CredentialRow {
  credential_id: string;
  user_id: string;
  public_key: Buffer;
  counter: number;
  transports_json: string;
  version: number;
}

interface SessionRow {
  user_id: string;
  expires_at: number;
  revoked_at: number | null;
  display_name: string;
  institution: string;
}

interface StepUpTokenRow {
  token_hash: string;
  user_id: string;
  session_hash: string;
  action: StepUpAction;
  expires_at: number;
}

interface CanvasConnectionRow {
  user_id: string;
  institution: string;
  base_url: string;
  canvas_user_id: string;
  canvas_name: string;
  pat_version: number;
  pat_iv: Buffer;
  pat_ciphertext: Buffer;
  pat_auth_tag: Buffer;
  updated_at: number;
}

interface OAuthClientRow {
  client_id: string;
  client_name: string;
  redirect_uris_json: string;
  grant_types_json: string;
  response_types_json: string;
  token_endpoint_auth_method: string;
  created_at: number;
}

interface OAuthCodeRow {
  code_hash: string;
  user_id: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  resource: string;
  code_challenge: string;
  expires_at: number;
  used_at: number | null;
}

interface OAuthTokenRow {
  token_hash: string;
  token_type: "access" | "refresh";
  family_id: string;
  user_id: string;
  client_id: string;
  resource: string;
  scope: string;
  expires_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
}

const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CHATGPT_CLIENT_NAME = "ChatGPT";
const CODEX_CLIENT_NAME = "Codex";
const STEP_UP_ACTIONS: readonly StepUpAction[] = ["add_passkey", "delete_account"];

function isInstitutionKey(value: string): value is InstitutionKey {
  return Object.hasOwn(INSTITUTIONS, value);
}

function requireInstitution(value: string): InstitutionKey {
  if (!isInstitutionKey(value)) {
    throw new AuthError("invalid_institution", "The invitation references an unsupported institution", 400);
  }
  return value;
}

function requireStepUpAction(value: string): StepUpAction {
  if (!STEP_UP_ACTIONS.includes(value as StepUpAction)) {
    throw new AuthError("invalid_step_up_action", "Unsupported step-up action", 400);
  }
  return value as StepUpAction;
}

function parseStringArray(raw: string): string[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Invalid JSON string array in database");
  }
  return value;
}

function patAad(userId: string, institution: InstitutionKey): string {
  return `canvas-pat:v1:${userId}:${institution}`;
}

function normalizeDeviceName(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length > 100) {
    throw new AuthError("invalid_device_name", "Passkey device name must be at most 100 characters", 400);
  }
  return normalized;
}

function patValidationError(error: unknown): AuthError {
  const record = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : {};
  const status = typeof record.status === "number"
    ? record.status
    : typeof record.statusCode === "number"
      ? record.statusCode
      : null;
  if (status === 401 || status === 403) {
    return new AuthError(
      "invalid_canvas_pat",
      "Canvas rejected the supplied personal access token",
      401,
    );
  }
  const code = typeof record.code === "string" ? record.code.toLowerCase() : "";
  const name = typeof record.name === "string" ? record.name : "";
  if (
    code === "timeout" ||
    code === "etimedout" ||
    code === "und_err_connect_timeout" ||
    name === "AbortError" ||
    status === 408 ||
    status === 504
  ) {
    return new AuthError(
      "canvas_timeout",
      "Canvas did not respond in time; the token was not changed",
      504,
    );
  }
  return new AuthError(
    "canvas_unavailable",
    "Canvas could not validate the token; try again later",
    502,
  );
}

function orderedUnique(values: readonly string[], order?: readonly string[]): string[] {
  const unique = [...new Set(values)];
  if (!order) {
    return unique.sort((left, right) => left.localeCompare(right));
  }
  return order.filter((value) => unique.includes(value));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function clientDisplayName(redirectUris: readonly string[]): string {
  return redirectUris.every((uri) => isAllowedChatGptRedirectUri(uri))
    ? CHATGPT_CLIENT_NAME
    : CODEX_CLIENT_NAME;
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  const { db, config, validatePat } = options;
  const clock = options.clock ?? Date.now;
  const patCipher = createPatCipher(config.masterKey);

  function now(): number {
    return clock();
  }

  const cleanup = db.transaction((at: number) => {
    db.prepare("DELETE FROM setup_flows WHERE expires_at <= ?").run(at);
    db.prepare("DELETE FROM login_flows WHERE expires_at <= ?").run(at);
    db.prepare("DELETE FROM passkey_registration_flows WHERE expires_at <= ?").run(at);
    db.prepare("DELETE FROM step_up_flows WHERE expires_at <= ?").run(at);
    db.prepare("DELETE FROM step_up_tokens WHERE expires_at <= ?").run(at);
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(at);
    db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").run(at);
    db.prepare(
      `DELETE FROM oauth_tokens
       WHERE expires_at <= ?
         AND (
           token_type = 'access'
           OR NOT EXISTS (
             SELECT 1 FROM oauth_tokens AS active
             WHERE active.family_id = oauth_tokens.family_id
               AND active.token_type = 'refresh'
               AND active.expires_at > ?
           )
         )`,
    ).run(at, at);
    db.prepare(
      `DELETE FROM invites
       WHERE expires_at <= ?
         AND NOT EXISTS (SELECT 1 FROM setup_flows WHERE setup_flows.invite_id = invites.id)`,
    ).run(at);
  });

  function operationTime(): number {
    const at = now();
    cleanup(at);
    return at;
  }

  function requireActiveSession(userId: string, sessionId: string, at: number): void {
    const active = db
      .prepare(
        `SELECT 1 FROM sessions
         WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(sessionId, userId, at);
    if (!active) {
      throw new AuthError("invalid_session", "The session is invalid or expired", 401);
    }
  }

  function consumeStepUpToken(
    userId: string,
    sessionId: string,
    action: StepUpAction,
    token: string,
    at: number,
  ): void {
    if (!token.trim()) {
      throw new AuthError("step_up_required", "A fresh passkey verification is required", 403);
    }
    const consumed = db
      .prepare(
        `DELETE FROM step_up_tokens WHERE token_hash = ?
         RETURNING token_hash, user_id, session_hash, action, expires_at`,
      )
      .get(hashOpaqueToken(token)) as StepUpTokenRow | undefined;
    if (
      !consumed ||
      consumed.user_id !== userId ||
      consumed.session_hash !== sessionId ||
      consumed.action !== action ||
      consumed.expires_at <= at
    ) {
      throw new AuthError("step_up_required", "A fresh passkey verification is required", 403);
    }
    requireActiveSession(userId, sessionId, at);
  }

  function updateCredentialCounter(
    credential: CredentialRow,
    newCounter: number,
    at: number,
  ): void {
    if (newCounter < credential.counter) {
      throw new AuthError("stale_passkey_counter", "The passkey counter moved backwards", 409);
    }
    const updated = db
      .prepare(
        `UPDATE webauthn_credentials
         SET counter = ?, version = version + 1, last_used_at = ?
         WHERE credential_id = ? AND user_id = ? AND counter = ? AND version = ?`,
      )
      .run(
        newCounter,
        at,
        credential.credential_id,
        credential.user_id,
        credential.counter,
        credential.version,
      );
    if (updated.changes !== 1) {
      throw new AuthError(
        "stale_passkey_counter",
        "A concurrent passkey assertion was already accepted; try again",
        409,
      );
    }
  }

  cleanup(now());

  function createSession(userId: string, at: number): { token: string; expiresAt: number } {
    const token = randomOpaqueToken("csess_");
    const expiresAt = at + config.sessionTtlSeconds * 1000;
    db.prepare(
      `INSERT INTO sessions(token_hash, user_id, expires_at, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(hashOpaqueToken(token), userId, expiresAt, at, at);
    return { token, expiresAt };
  }

  function parseScope(raw: string | undefined): { scope: string; scopes: string[] } {
    const requested = new Set(
      (raw?.trim() || config.oauthScopes.join(" ")).split(/\s+/).filter(Boolean),
    );
    if (!requested.has("canvas.read")) {
      throw new AuthError("invalid_scope", "The canvas.read scope is required", 400, "invalid_scope");
    }
    for (const scope of requested) {
      if (!config.oauthScopes.includes(scope as (typeof config.oauthScopes)[number])) {
        throw new AuthError("invalid_scope", `Unsupported OAuth scope: ${scope}`, 400, "invalid_scope");
      }
    }
    const scopes = config.oauthScopes.filter((scope) => requested.has(scope));
    return { scope: scopes.join(" "), scopes: [...scopes] };
  }

  function getOAuthClient(clientId: string): OAuthClientRow {
    const row = db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId) as
      | OAuthClientRow
      | undefined;
    if (!row) {
      throw invalidClient();
    }
    return row;
  }

  function loadAccountSummary(userId: string): AccountSummary {
    const row = db
      .prepare(
        `SELECT u.id, u.display_name, u.institution, c.base_url, c.canvas_user_id,
                c.canvas_name, c.updated_at
         FROM users u JOIN canvas_connections c ON c.user_id = u.id
         WHERE u.id = ?`,
      )
      .get(userId) as
      | {
          id: string;
          display_name: string;
          institution: string;
          base_url: string;
          canvas_user_id: string;
          canvas_name: string;
          updated_at: number;
        }
      | undefined;
    if (!row) {
      throw new AuthError("account_missing", "The account no longer exists", 404);
    }
    const institution = requireInstitution(row.institution);
    const passkeys = db
      .prepare(
        `SELECT credential_id, device_name, created_at, last_used_at
         FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at ASC`,
      )
      .all(userId) as Array<{
      credential_id: string;
      device_name: string | null;
      created_at: number;
      last_used_at: number | null;
    }>;
    return {
      user: {
        id: row.id,
        displayName: row.display_name,
        institution,
      },
      canvas: {
        institution,
        baseUrl: row.base_url,
        canvasUserId: row.canvas_user_id,
        canvasName: row.canvas_name,
        updatedAt: row.updated_at,
      },
      passkeys: passkeys.map((passkey) => ({
        id: passkey.credential_id,
        deviceName: passkey.device_name,
        createdAt: passkey.created_at,
        lastUsedAt: passkey.last_used_at,
      })),
    };
  }

  function issueTokenPair(
    input: {
      userId: string;
      clientId: string;
      resource: string;
      scope: string;
      familyId: string;
      issueRefresh: boolean;
    },
    at: number,
  ): OAuthTokenResponse {
    const accessToken = randomOpaqueToken("cat_");
    const accessExpiresAt = at + config.accessTokenTtlSeconds * 1000;
    db.prepare(
      `INSERT INTO oauth_tokens(
        token_hash, token_type, family_id, user_id, client_id, resource, scope, expires_at, created_at
       ) VALUES (?, 'access', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hashOpaqueToken(accessToken),
      input.familyId,
      input.userId,
      input.clientId,
      input.resource,
      input.scope,
      accessExpiresAt,
      at,
    );
    const response: OAuthTokenResponse = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: config.accessTokenTtlSeconds,
      scope: input.scope,
    };
    if (input.issueRefresh) {
      const refreshToken = randomOpaqueToken("crt_");
      db.prepare(
        `INSERT INTO oauth_tokens(
          token_hash, token_type, family_id, user_id, client_id, resource, scope, expires_at, created_at
         ) VALUES (?, 'refresh', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        hashOpaqueToken(refreshToken),
        input.familyId,
        input.userId,
        input.clientId,
        input.resource,
        input.scope,
        at + config.refreshTokenTtlSeconds * 1000,
        at,
      );
      response.refresh_token = refreshToken;
    }
    return response;
  }

  const service: AuthService = {
    config,

    createInvite(input) {
      if (!isInstitutionKey(input.institution)) {
        throw new AuthError("invalid_institution", "Unsupported institution", 400);
      }
      const at = operationTime();
      const ttlSeconds = input.ttlSeconds ?? config.inviteTtlSeconds;
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60) {
        throw new AuthError("invalid_invite_ttl", "Invitation TTL must be at least 60 seconds", 400);
      }
      const inviteToken = randomOpaqueToken("cinv_");
      const expiresAt = at + ttlSeconds * 1000;
      db.prepare(
        `INSERT INTO invites(id, token_hash, institution, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(randomUUID(), hashOpaqueToken(inviteToken), input.institution, expiresAt, at);
      return { inviteToken, expiresAt };
    },

    async beginSetup(input) {
      const inviteToken = input.inviteToken.trim();
      const pat = input.pat.trim();
      if (!inviteToken || !pat) {
        throw new AuthError("invalid_setup", "Invitation token and Canvas PAT are required", 400);
      }
      const at = operationTime();
      const invite = db.prepare("SELECT id, institution, expires_at, used_at FROM invites WHERE token_hash = ?").get(
        hashOpaqueToken(inviteToken),
      ) as InviteRow | undefined;
      if (!invite || invite.used_at !== null || invite.expires_at <= at) {
        throw new AuthError("invalid_invite", "The invitation is invalid, expired, or already used", 401);
      }
      const institution = requireInstitution(invite.institution);
      if (input.institution !== undefined && input.institution !== institution) {
        throw new AuthError(
          "institution_mismatch",
          "The selected institution does not match this invitation",
          400,
        );
      }
      const deviceName = normalizeDeviceName(input.deviceName);
      const institutionConfig = INSTITUTIONS[institution];
      let identity;
      try {
        identity = await validatePat({ institution, baseUrl: institutionConfig.baseUrl, pat });
      } catch (error) {
        throw patValidationError(error);
      }
      if (!identity.id || !identity.name) {
        throw new AuthError("invalid_canvas_identity", "Canvas returned an incomplete identity", 502);
      }

      const pendingUserId = randomUUID();
      const optionsJson = await generateRegistrationOptions({
        rpName: config.webauthnRpName,
        rpID: config.webauthnRpId,
        userName: identity.loginId ?? identity.id,
        userDisplayName: identity.name,
        userID: Buffer.from(pendingUserId, "utf8"),
        attestationType: "none",
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
      });
      const flowId = randomOpaqueToken("csetup_");
      const flowHash = hashOpaqueToken(flowId);
      const encrypted = patCipher.encrypt(pat, patAad(pendingUserId, institution));
      db.prepare(
        `INSERT INTO setup_flows(
          flow_hash, invite_id, pending_user_id, institution, base_url, canvas_user_id, canvas_name,
          pat_version, pat_iv, pat_ciphertext, pat_auth_tag, pat_hash, device_name, challenge,
          expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        flowHash,
        invite.id,
        pendingUserId,
        institution,
        institutionConfig.baseUrl,
        identity.id,
        identity.name,
        encrypted.version,
        encrypted.iv,
        encrypted.ciphertext,
        encrypted.authTag,
        hashPat(pat, config.masterKey),
        deviceName,
        optionsJson.challenge,
        at + config.setupFlowTtlSeconds * 1000,
        at,
      );
      return { flowId, options: optionsJson };
    },

    async finishSetup(input) {
      const flowHash = hashOpaqueToken(input.flowId);
      const at = operationTime();
      const flow = db
        .prepare(
          `DELETE FROM setup_flows
           WHERE flow_hash = ? AND used_at IS NULL AND expires_at > ?
           RETURNING *`,
        )
        .get(flowHash, at) as SetupFlowRow | undefined;
      if (!flow) {
        throw new AuthError("invalid_setup_flow", "The setup flow is invalid, expired, or already used", 401);
      }
      const institution = requireInstitution(flow.institution);
      const verification = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: flow.challenge,
        expectedOrigin: config.publicOrigin,
        expectedRPID: config.webauthnRpId,
        requireUserPresence: true,
        requireUserVerification: true,
      }).catch(() => {
        throw new AuthError("invalid_passkey", "Passkey registration could not be verified", 401);
      });
      if (!verification.verified || !verification.registrationInfo) {
        throw new AuthError("invalid_passkey", "Passkey registration could not be verified", 401);
      }
      const credential = verification.registrationInfo.credential;
      const sessionToken = randomOpaqueToken("csess_");
      const sessionExpiresAt = at + config.sessionTtlSeconds * 1000;
      const finalize = db.transaction(() => {
        db.prepare(
          "INSERT INTO users(id, display_name, institution, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).run(flow.pending_user_id, flow.canvas_name, institution, at, at);
        db.prepare(
          `INSERT INTO canvas_connections(
            user_id, institution, base_url, canvas_user_id, canvas_name, pat_version, pat_iv,
            pat_ciphertext, pat_auth_tag, pat_hash, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          flow.pending_user_id,
          institution,
          flow.base_url,
          flow.canvas_user_id,
          flow.canvas_name,
          flow.pat_version,
          flow.pat_iv,
          flow.pat_ciphertext,
          flow.pat_auth_tag,
          flow.pat_hash,
          at,
          at,
        );
        db.prepare(
          `INSERT INTO webauthn_credentials(
            credential_id, user_id, public_key, counter, transports_json, device_type, backed_up,
            device_name, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          credential.id,
          flow.pending_user_id,
          Buffer.from(credential.publicKey),
          credential.counter,
          JSON.stringify(credential.transports ?? []),
          verification.registrationInfo.credentialDeviceType,
          verification.registrationInfo.credentialBackedUp ? 1 : 0,
          flow.device_name,
          at,
        );
        const claimedInvite = db
          .prepare(
            `UPDATE invites SET used_at = ?, used_by_user_id = ?
             WHERE id = ? AND used_at IS NULL AND expires_at > ?`,
          )
          .run(at, flow.pending_user_id, flow.invite_id, at);
        if (claimedInvite.changes !== 1) {
          throw new AuthError("invalid_invite", "The invitation was already consumed", 409);
        }
        db.prepare(
          `INSERT INTO sessions(token_hash, user_id, expires_at, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(hashOpaqueToken(sessionToken), flow.pending_user_id, sessionExpiresAt, at, at);
      });
      try {
        finalize();
      } catch (error) {
        if (error instanceof AuthError) {
          throw error;
        }
        throw new AuthError("passkey_conflict", "This passkey is already registered", 409);
      }
      return {
        user: { id: flow.pending_user_id, displayName: flow.canvas_name, institution },
        sessionToken,
        sessionExpiresAt,
      };
    },

    async beginPasskeyLogin() {
      const at = operationTime();
      const optionsJson = await generateAuthenticationOptions({
        rpID: config.webauthnRpId,
        userVerification: "required",
      });
      const flowId = randomOpaqueToken("clogin_");
      db.prepare(
        `INSERT INTO login_flows(flow_hash, challenge, expires_at, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(
        hashOpaqueToken(flowId),
        optionsJson.challenge,
        at + config.webauthnFlowTtlSeconds * 1000,
        at,
      );
      return { flowId, options: optionsJson };
    },

    async finishPasskeyLogin(input) {
      const flowHash = hashOpaqueToken(input.flowId);
      const at = operationTime();
      const flow = db
        .prepare(
          `DELETE FROM login_flows
           WHERE flow_hash = ? AND used_at IS NULL AND expires_at > ?
           RETURNING *`,
        )
        .get(flowHash, at) as LoginFlowRow | undefined;
      if (!flow) {
        throw new AuthError("invalid_login_flow", "The login flow is invalid, expired, or already used", 401);
      }
      const credentialRow = db
        .prepare(
          `SELECT credential_id, user_id, public_key, counter, transports_json, version
           FROM webauthn_credentials WHERE credential_id = ?`,
        )
        .get(input.response.id) as CredentialRow | undefined;
      if (!credentialRow) {
        throw new AuthError("unknown_passkey", "The passkey is not registered", 401);
      }
      const transports = parseStringArray(credentialRow.transports_json) as AuthenticatorTransportFuture[];
      const verification = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: flow.challenge,
        expectedOrigin: config.publicOrigin,
        expectedRPID: config.webauthnRpId,
        credential: {
          id: credentialRow.credential_id,
          publicKey: new Uint8Array(credentialRow.public_key),
          counter: credentialRow.counter,
          transports,
        },
        requireUserVerification: true,
      }).catch(() => {
        throw new AuthError("invalid_passkey", "Passkey authentication could not be verified", 401);
      });
      if (!verification.verified) {
        throw new AuthError("invalid_passkey", "Passkey authentication could not be verified", 401);
      }
      const userRow = db.prepare("SELECT id, display_name, institution FROM users WHERE id = ?").get(
        credentialRow.user_id,
      ) as { id: string; display_name: string; institution: string } | undefined;
      if (!userRow) {
        throw new AuthError("unknown_user", "The passkey owner no longer exists", 401);
      }
      const institution = requireInstitution(userRow.institution);
      const sessionToken = randomOpaqueToken("csess_");
      const sessionExpiresAt = at + config.sessionTtlSeconds * 1000;
      const finish = db.transaction(() => {
        updateCredentialCounter(credentialRow, verification.authenticationInfo.newCounter, at);
        db.prepare(
          `INSERT INTO sessions(token_hash, user_id, expires_at, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(hashOpaqueToken(sessionToken), userRow.id, sessionExpiresAt, at, at);
      });
      finish();
      return {
        user: { id: userRow.id, displayName: userRow.display_name, institution },
        sessionToken,
        sessionExpiresAt,
      };
    },

    async beginStepUp(userId, sessionId, rawAction) {
      const action = requireStepUpAction(rawAction);
      const at = operationTime();
      requireActiveSession(userId, sessionId, at);
      const user = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
      if (!user) {
        throw new AuthError("account_missing", "The account no longer exists", 404);
      }
      const credentials = db
        .prepare(
          `SELECT credential_id, transports_json
           FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at ASC`,
        )
        .all(userId) as Array<{ credential_id: string; transports_json: string }>;
      if (credentials.length === 0) {
        throw new AuthError("passkey_missing", "No passkey is registered for this account", 409);
      }
      const optionsJson = await generateAuthenticationOptions({
        rpID: config.webauthnRpId,
        userVerification: "required",
        allowCredentials: credentials.map((credential) => ({
          id: credential.credential_id,
          transports: parseStringArray(credential.transports_json) as AuthenticatorTransportFuture[],
        })),
      });
      const createdAt = operationTime();
      requireActiveSession(userId, sessionId, createdAt);
      const flowId = randomOpaqueToken("cstepflow_");
      db.prepare(
        `INSERT INTO step_up_flows(
          flow_hash, user_id, session_hash, action, challenge, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        hashOpaqueToken(flowId),
        userId,
        sessionId,
        action,
        optionsJson.challenge,
        createdAt + config.stepUpFlowTtlSeconds * 1000,
        createdAt,
      );
      return { flowId, options: optionsJson };
    },

    async finishStepUp(input) {
      const at = operationTime();
      const flowHash = hashOpaqueToken(input.flowId);
      const flow = db
        .prepare(
          `DELETE FROM step_up_flows
           WHERE flow_hash = ? AND expires_at > ?
           RETURNING *`,
        )
        .get(flowHash, at) as StepUpFlowRow | undefined;
      if (
        !flow ||
        flow.user_id !== input.userId ||
        flow.session_hash !== input.sessionId
      ) {
        throw new AuthError(
          "invalid_step_up_flow",
          "The step-up flow is invalid, expired, or already used",
          401,
        );
      }
      requireActiveSession(input.userId, input.sessionId, at);
      const action = requireStepUpAction(flow.action);
      const credential = db
        .prepare(
          `SELECT credential_id, user_id, public_key, counter, transports_json, version
           FROM webauthn_credentials WHERE credential_id = ? AND user_id = ?`,
        )
        .get(input.response.id, input.userId) as CredentialRow | undefined;
      if (!credential) {
        throw new AuthError("unknown_passkey", "The passkey is not registered to this account", 401);
      }
      const verification = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: flow.challenge,
        expectedOrigin: config.publicOrigin,
        expectedRPID: config.webauthnRpId,
        credential: {
          id: credential.credential_id,
          publicKey: new Uint8Array(credential.public_key),
          counter: credential.counter,
          transports: parseStringArray(
            credential.transports_json,
          ) as AuthenticatorTransportFuture[],
        },
        requireUserVerification: true,
      }).catch(() => {
        throw new AuthError("invalid_passkey", "Passkey step-up could not be verified", 401);
      });
      if (!verification.verified) {
        throw new AuthError("invalid_passkey", "Passkey step-up could not be verified", 401);
      }
      const stepUpToken = randomOpaqueToken("cstep_");
      const issuedAt = operationTime();
      const expiresAt = issuedAt + config.stepUpTokenTtlSeconds * 1000;
      const issue = db.transaction(() => {
        requireActiveSession(input.userId, input.sessionId, issuedAt);
        updateCredentialCounter(credential, verification.authenticationInfo.newCounter, issuedAt);
        db.prepare(
          `INSERT INTO step_up_tokens(
            token_hash, user_id, session_hash, action, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          hashOpaqueToken(stepUpToken),
          input.userId,
          input.sessionId,
          action,
          expiresAt,
          issuedAt,
        );
      });
      issue();
      return { action, stepUpToken, expiresAt };
    },

    async beginPasskeyRegistration(input) {
      const { userId, sessionId, stepUpToken, deviceName } = input;
      const at = operationTime();
      consumeStepUpToken(userId, sessionId, "add_passkey", stepUpToken, at);
      const user = db.prepare("SELECT id, display_name FROM users WHERE id = ?").get(userId) as
        | { id: string; display_name: string }
        | undefined;
      if (!user) {
        throw new AuthError("account_missing", "The account no longer exists", 404);
      }
      const existingCredentials = db
        .prepare("SELECT credential_id, transports_json FROM webauthn_credentials WHERE user_id = ?")
        .all(userId) as Array<{ credential_id: string; transports_json: string }>;
      const optionsJson = await generateRegistrationOptions({
        rpName: config.webauthnRpName,
        rpID: config.webauthnRpId,
        userName: user.display_name,
        userDisplayName: user.display_name,
        userID: Buffer.from(user.id, "utf8"),
        attestationType: "none",
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
        excludeCredentials: existingCredentials.map((credential) => ({
          id: credential.credential_id,
          transports: parseStringArray(credential.transports_json) as AuthenticatorTransportFuture[],
        })),
      });
      const createdAt = operationTime();
      requireActiveSession(userId, sessionId, createdAt);
      const flowId = randomOpaqueToken("creg_");
      db.prepare(
        `INSERT INTO passkey_registration_flows(
          flow_hash, user_id, session_hash, device_name, challenge, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        hashOpaqueToken(flowId),
        userId,
        sessionId,
        normalizeDeviceName(deviceName),
        optionsJson.challenge,
        createdAt + config.webauthnFlowTtlSeconds * 1000,
        createdAt,
      );
      return { flowId, options: optionsJson };
    },

    async finishPasskeyRegistration(input) {
      const flowHash = hashOpaqueToken(input.flowId);
      const at = operationTime();
      const flow = db
        .prepare(
          `DELETE FROM passkey_registration_flows
           WHERE flow_hash = ? AND used_at IS NULL AND expires_at > ?
           RETURNING *`,
        )
        .get(flowHash, at) as PasskeyRegistrationFlowRow | undefined;
      if (
        !flow ||
        flow.user_id !== input.userId ||
        flow.session_hash !== input.sessionId
      ) {
        throw new AuthError(
          "invalid_registration_flow",
          "The passkey registration flow is invalid, expired, or already used",
          401,
        );
      }
      requireActiveSession(input.userId, input.sessionId, at);
      const verification = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: flow.challenge,
        expectedOrigin: config.publicOrigin,
        expectedRPID: config.webauthnRpId,
        requireUserPresence: true,
        requireUserVerification: true,
      }).catch(() => {
        throw new AuthError("invalid_passkey", "Passkey registration could not be verified", 401);
      });
      if (!verification.verified || !verification.registrationInfo) {
        throw new AuthError("invalid_passkey", "Passkey registration could not be verified", 401);
      }
      const credential = verification.registrationInfo.credential;
      const completedAt = operationTime();
      const finish = db.transaction(() => {
        requireActiveSession(input.userId, input.sessionId, completedAt);
        db.prepare(
          `INSERT INTO webauthn_credentials(
            credential_id, user_id, public_key, counter, transports_json, device_type, backed_up,
            device_name, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          credential.id,
          input.userId,
          Buffer.from(credential.publicKey),
          credential.counter,
          JSON.stringify(credential.transports ?? []),
          verification.registrationInfo.credentialDeviceType,
          verification.registrationInfo.credentialBackedUp ? 1 : 0,
          flow.device_name,
          completedAt,
        );
      });
      try {
        finish();
      } catch (error) {
        if (error instanceof AuthError) {
          throw error;
        }
        throw new AuthError("passkey_conflict", "This passkey is already registered", 409);
      }
      return { passkeyId: credential.id, deviceName: flow.device_name };
    },

    authenticateSession(sessionToken) {
      if (!sessionToken) {
        throw new AuthError("invalid_session", "A session cookie is required", 401);
      }
      const tokenHash = hashOpaqueToken(sessionToken);
      const row = db
        .prepare(
          `SELECT s.user_id, s.expires_at, s.revoked_at, u.display_name, u.institution
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ?`,
        )
        .get(tokenHash) as SessionRow | undefined;
      const at = operationTime();
      if (!row || row.revoked_at !== null || row.expires_at <= at) {
        throw new AuthError("invalid_session", "The session is invalid or expired", 401);
      }
      db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(
        at,
        tokenHash,
      );
      return {
        sessionId: tokenHash,
        user: {
          id: row.user_id,
          displayName: row.display_name,
          institution: requireInstitution(row.institution),
        },
        expiresAt: row.expires_at,
      };
    },

    revokeSession(sessionToken) {
      if (sessionToken) {
        const at = operationTime();
        const tokenHash = hashOpaqueToken(sessionToken);
        db.transaction(() => {
          db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(
            at,
            tokenHash,
          );
          db.prepare("DELETE FROM step_up_flows WHERE session_hash = ?").run(tokenHash);
          db.prepare("DELETE FROM step_up_tokens WHERE session_hash = ?").run(tokenHash);
          db.prepare("DELETE FROM passkey_registration_flows WHERE session_hash = ?").run(tokenHash);
        })();
      }
    },

    getAccountSummary(userId) {
      return loadAccountSummary(userId);
    },

    async rotateCanvasPat(userId, rawPat) {
      const pat = rawPat.trim();
      if (!pat) {
        throw new AuthError("invalid_canvas_pat", "A Canvas personal access token is required", 400);
      }
      const connection = db.prepare("SELECT * FROM canvas_connections WHERE user_id = ?").get(
        userId,
      ) as CanvasConnectionRow | undefined;
      if (!connection) {
        throw new AuthError("canvas_connection_missing", "No Canvas account is linked", 404);
      }
      const institution = requireInstitution(connection.institution);
      let identity;
      try {
        identity = await validatePat({ institution, baseUrl: connection.base_url, pat });
      } catch (error) {
        throw patValidationError(error);
      }
      if (!identity.id || !identity.name) {
        throw new AuthError("invalid_canvas_identity", "Canvas returned an incomplete identity", 502);
      }
      if (identity.id !== connection.canvas_user_id) {
        throw new AuthError(
          "canvas_identity_mismatch",
          "The token belongs to a different Canvas account",
          409,
        );
      }
      const encrypted = patCipher.encrypt(pat, patAad(userId, institution));
      const at = operationTime();
      const update = db.transaction(() => {
        db.prepare(
          `UPDATE canvas_connections
           SET canvas_name = ?, pat_version = ?, pat_iv = ?, pat_ciphertext = ?, pat_auth_tag = ?,
               pat_hash = ?, updated_at = ?
           WHERE user_id = ?`,
        ).run(
          identity.name,
          encrypted.version,
          encrypted.iv,
          encrypted.ciphertext,
          encrypted.authTag,
          hashPat(pat, config.masterKey),
          at,
          userId,
        );
        db.prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?").run(
          identity.name,
          at,
          userId,
        );
      });
      update();
      return loadAccountSummary(userId);
    },

    deleteAccount(userId, sessionId, stepUpToken) {
      const at = operationTime();
      const remove = db.transaction(() => {
        consumeStepUpToken(userId, sessionId, "delete_account", stepUpToken, at);
        db.prepare(
          `DELETE FROM setup_flows
           WHERE invite_id IN (SELECT id FROM invites WHERE used_by_user_id = ?)`,
        ).run(userId);
        db.prepare("UPDATE invites SET used_by_user_id = NULL WHERE used_by_user_id = ?").run(userId);
        const result = db.prepare("DELETE FROM users WHERE id = ?").run(userId);
        if (result.changes !== 1) {
          throw new AuthError("account_missing", "The account no longer exists", 404);
        }
      });
      try {
        remove();
      } catch (error) {
        // A failed binding check rolls its transaction back; burn any presented
        // capability afterward so a stolen/misrouted token still fails closed.
        if (stepUpToken) {
          db.prepare("DELETE FROM step_up_tokens WHERE token_hash = ?").run(
            hashOpaqueToken(stepUpToken),
          );
        }
        throw error;
      }
    },

    getCanvasConnection(userId): CanvasConnection {
      const row = db.prepare("SELECT * FROM canvas_connections WHERE user_id = ?").get(userId) as
        | CanvasConnectionRow
        | undefined;
      if (!row) {
        throw new AuthError("canvas_connection_missing", "No Canvas account is linked", 404);
      }
      const institution = requireInstitution(row.institution);
      const accessToken = patCipher.decrypt(
        {
          version: row.pat_version as 1,
          iv: row.pat_iv,
          ciphertext: row.pat_ciphertext,
          authTag: row.pat_auth_tag,
        },
        patAad(row.user_id, institution),
      );
      return {
        userId: row.user_id,
        institution,
        baseUrl: row.base_url,
        accessToken,
        canvasUserId: row.canvas_user_id,
        canvasName: row.canvas_name,
      };
    },

    registerOAuthClient(input: DynamicClientRegistrationInput): DynamicClientRegistrationResponse {
      if (!config.oauthDcrEnabled) {
        throw new AuthError(
          "dynamic_registration_disabled",
          "Dynamic OAuth client registration is currently disabled",
          403,
          "access_denied",
        );
      }
      if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length < 1 || input.redirect_uris.length > 10) {
        throw invalidRequest("redirect_uris must contain between one and ten URIs");
      }
      const redirectUris = orderedUnique(input.redirect_uris);
      if (redirectUris.some((uri) => !isAllowedOAuthRedirectUri(uri, config))) {
        throw new AuthError("invalid_redirect_uri", "OAuth redirect URI is not allowlisted", 400, "invalid_redirect_uri");
      }
      const grantTypes = orderedUnique(
        input.grant_types ?? ["authorization_code", "refresh_token"],
        ["authorization_code", "refresh_token"],
      );
      const responseTypes = orderedUnique(input.response_types ?? ["code"], ["code"]);
      if (
        !grantTypes.includes("authorization_code") ||
        (input.grant_types ?? []).some(
          (value) => value !== "authorization_code" && value !== "refresh_token",
        )
      ) {
        throw invalidRequest("Only authorization_code and refresh_token grants are supported");
      }
      if (
        responseTypes.length !== 1 ||
        responseTypes[0] !== "code" ||
        (input.response_types ?? []).some((value) => value !== "code")
      ) {
        throw invalidRequest("Only the code response type is supported");
      }
      if ((input.token_endpoint_auth_method ?? "none") !== "none") {
        throw invalidRequest("Only public clients using token_endpoint_auth_method=none are supported");
      }
      const clientName = clientDisplayName(redirectUris);
      const at = operationTime();
      const register = db.transaction((): DynamicClientRegistrationResponse => {
        const clients = db.prepare("SELECT * FROM oauth_clients ORDER BY created_at, client_id").all() as
          OAuthClientRow[];
        for (const client of clients) {
          const storedRedirectUris = orderedUnique(parseStringArray(client.redirect_uris_json));
          const storedGrantTypes = orderedUnique(
            parseStringArray(client.grant_types_json),
            ["authorization_code", "refresh_token"],
          );
          const storedResponseTypes = orderedUnique(parseStringArray(client.response_types_json), ["code"]);
          const identical =
            client.client_name === clientName &&
            client.token_endpoint_auth_method === "none" &&
            sameStrings(storedRedirectUris, redirectUris) &&
            sameStrings(storedGrantTypes, grantTypes) &&
            sameStrings(storedResponseTypes, responseTypes);
          if (identical) {
            return {
              client_id: client.client_id,
              client_id_issued_at: Math.floor(client.created_at / 1000),
              client_name: clientName,
              redirect_uris: redirectUris,
              grant_types: grantTypes,
              response_types: responseTypes,
              token_endpoint_auth_method: "none",
            };
          }
          if (sameStrings(storedRedirectUris, redirectUris)) {
            throw new AuthError(
              "oauth_client_metadata_conflict",
              "This redirect URI is already registered with different client metadata",
              409,
              "invalid_client_metadata",
            );
          }
        }
        if (clients.length >= config.oauthMaxClients) {
          throw new AuthError(
            "oauth_client_capacity_reached",
            "OAuth client registration capacity has been reached",
            409,
            "invalid_client_metadata",
          );
        }
        const clientId = randomOpaqueToken("client_", 24);
        db.prepare(
          `INSERT INTO oauth_clients(
            client_id, client_name, redirect_uris_json, grant_types_json, response_types_json,
            token_endpoint_auth_method, created_at
          ) VALUES (?, ?, ?, ?, ?, 'none', ?)`,
        ).run(
          clientId,
          clientName,
          JSON.stringify(redirectUris),
          JSON.stringify(grantTypes),
          JSON.stringify(responseTypes),
          at,
        );
        return {
          client_id: clientId,
          client_id_issued_at: Math.floor(at / 1000),
          client_name: clientName,
          redirect_uris: redirectUris,
          grant_types: grantTypes,
          response_types: responseTypes,
          token_endpoint_auth_method: "none",
        };
      });
      return register();
    },

    inspectAuthorizationRequest(input: OAuthAuthorizationInput): OAuthAuthorizationRequest {
      const client = getOAuthClient(input.clientId);
      if (input.responseType !== "code") {
        throw new AuthError("unsupported_response_type", "Only response_type=code is supported", 400, "unsupported_response_type");
      }
      if (input.resource !== config.oauthResource) {
        throw invalidRequest("The resource parameter must exactly match this MCP resource");
      }
      if (input.codeChallengeMethod !== "S256" || !PKCE_CHALLENGE_RE.test(input.codeChallenge)) {
        throw invalidRequest("PKCE with a valid S256 code challenge is required");
      }
      if (input.state !== undefined && (input.state.length < 1 || input.state.length > 2048)) {
        throw invalidRequest("OAuth state must be between 1 and 2048 characters");
      }
      const redirectUris = parseStringArray(client.redirect_uris_json);
      if (!redirectUris.includes(input.redirectUri) || !isAllowedOAuthRedirectUri(input.redirectUri, config)) {
        throw new AuthError("invalid_redirect_uri", "OAuth redirect URI is not registered", 400, "invalid_request");
      }
      const parsedScope = parseScope(input.scope);
      const grantTypes = parseStringArray(client.grant_types_json);
      if (parsedScope.scopes.includes("offline_access") && !grantTypes.includes("refresh_token")) {
        throw new AuthError(
          "invalid_scope",
          "offline_access requires a client registered for the refresh_token grant",
          400,
          "invalid_scope",
        );
      }
      return {
        clientId: input.clientId,
        clientName: clientDisplayName(redirectUris),
        redirectUri: input.redirectUri,
        responseType: input.responseType,
        codeChallenge: input.codeChallenge,
        codeChallengeMethod: input.codeChallengeMethod,
        resource: input.resource,
        scope: parsedScope.scope,
        scopes: parsedScope.scopes,
        ...(input.state === undefined ? {} : { state: input.state }),
      };
    },

    issueAuthorizationCode(userId, input) {
      const request = service.inspectAuthorizationRequest(input);
      const user = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
      if (!user) {
        throw new AuthError("invalid_session", "The authenticated user no longer exists", 401);
      }
      const code = randomOpaqueToken("cac_");
      const at = operationTime();
      db.prepare(
        `INSERT INTO oauth_codes(
          code_hash, user_id, client_id, redirect_uri, scope, resource, code_challenge, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        hashOpaqueToken(code),
        userId,
        request.clientId,
        request.redirectUri,
        request.scope,
        request.resource,
        request.codeChallenge,
        at + config.oauthCodeTtlSeconds * 1000,
        at,
      );
      const redirect = new URL(request.redirectUri);
      redirect.searchParams.set("code", code);
      if (request.state !== undefined) {
        redirect.searchParams.set("state", request.state);
      }
      return { code, redirectTo: redirect.toString() };
    },

    exchangeAuthorizationCode(input) {
      if (!PKCE_VERIFIER_RE.test(input.codeVerifier)) {
        throw invalidGrant("The PKCE code verifier is malformed");
      }
      const at = operationTime();
      const exchange = db.transaction(() => {
        const row = db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(
          hashOpaqueToken(input.code),
        ) as OAuthCodeRow | undefined;
        if (
          !row ||
          row.used_at !== null ||
          row.expires_at <= at ||
          row.client_id !== input.clientId ||
          row.redirect_uri !== input.redirectUri ||
          row.resource !== input.resource ||
          row.resource !== config.oauthResource ||
          !safeEqualText(pkceS256(input.codeVerifier), row.code_challenge)
        ) {
          throw invalidGrant();
        }
        const client = getOAuthClient(input.clientId);
        const claimed = db
          .prepare("UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL")
          .run(at, row.code_hash);
        if (claimed.changes !== 1) {
          throw invalidGrant();
        }
        return issueTokenPair(
          {
            userId: row.user_id,
            clientId: row.client_id,
            resource: row.resource,
            scope: row.scope,
            familyId: randomUUID(),
            issueRefresh: parseStringArray(client.grant_types_json).includes("refresh_token"),
          },
          at,
        );
      });
      return exchange();
    },

    exchangeRefreshToken(input) {
      const at = operationTime();
      const client = getOAuthClient(input.clientId);
      if (!parseStringArray(client.grant_types_json).includes("refresh_token")) {
        throw invalidGrant();
      }
      const rotate = db.transaction(():
        | { reused: true }
        | { reused: false; response: OAuthTokenResponse } => {
        const row = db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND token_type = 'refresh'").get(
          hashOpaqueToken(input.refreshToken),
        ) as OAuthTokenRow | undefined;
        if (!row || row.client_id !== input.clientId || row.resource !== input.resource || row.resource !== config.oauthResource) {
          throw invalidGrant();
        }
        if (row.rotated_at !== null) {
          db.prepare("UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ?").run(
            at,
            row.family_id,
          );
          return { reused: true };
        }
        if (row.revoked_at !== null || row.expires_at <= at) {
          throw invalidGrant();
        }
        const claimed = db
          .prepare("UPDATE oauth_tokens SET rotated_at = ? WHERE token_hash = ? AND rotated_at IS NULL AND revoked_at IS NULL")
          .run(at, row.token_hash);
        if (claimed.changes !== 1) {
          db.prepare("UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ?").run(
            at,
            row.family_id,
          );
          return { reused: true };
        }
        return {
          reused: false,
          response: issueTokenPair(
            {
              userId: row.user_id,
              clientId: row.client_id,
              resource: row.resource,
              scope: row.scope,
              familyId: row.family_id,
              issueRefresh: true,
            },
            at,
          ),
        };
      });
      const result = rotate();
      if (result.reused) {
        throw invalidGrant("Refresh token reuse was detected; the token family has been revoked");
      }
      return result.response;
    },

    revokeOAuthToken(token) {
      if (!token) {
        return;
      }
      const tokenHash = hashOpaqueToken(token);
      const row = db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ?").get(tokenHash) as
        | OAuthTokenRow
        | undefined;
      if (!row) {
        return;
      }
      const at = operationTime();
      if (row.token_type === "refresh") {
        db.prepare("UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ?").run(
          at,
          row.family_id,
        );
      } else {
        db.prepare("UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?").run(
          at,
          tokenHash,
        );
      }
    },

    validateAccessToken(token, requiredScopes = ["canvas.read"]) {
      if (!token) {
        throw new AuthError("invalid_token", "A bearer token is required", 401, "invalid_token");
      }
      const at = operationTime();
      const row = db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND token_type = 'access'").get(
        hashOpaqueToken(token),
      ) as OAuthTokenRow | undefined;
      if (!row || row.revoked_at !== null || row.expires_at <= at || row.resource !== config.oauthResource) {
        throw new AuthError("invalid_token", "The bearer token is invalid or expired", 401, "invalid_token");
      }
      const scopes = row.scope.split(" ").filter(Boolean);
      if (requiredScopes.some((scope) => !scopes.includes(scope))) {
        throw new AuthError("insufficient_scope", "The bearer token lacks a required scope", 403, "insufficient_scope");
      }
      return {
        userId: row.user_id,
        clientId: row.client_id,
        scope: scopes,
        resource: row.resource,
        expiresAt: row.expires_at,
      };
    },

    protectedResourceMetadata() {
      return {
        resource: config.oauthResource,
        authorization_servers: [config.oauthIssuer],
        scopes_supported: [...config.oauthScopes],
        bearer_methods_supported: ["header"],
        resource_documentation: `${config.publicOrigin}/account`,
      };
    },

    authorizationServerMetadata() {
      return {
        issuer: config.oauthIssuer,
        authorization_endpoint: `${config.publicOrigin}/oauth/authorize`,
        token_endpoint: `${config.publicOrigin}/oauth/token`,
        ...(config.oauthDcrEnabled
          ? { registration_endpoint: `${config.publicOrigin}/oauth/register` }
          : {}),
        revocation_endpoint: `${config.publicOrigin}/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: [...config.oauthScopes],
      };
    },
  };

  return service;
}
