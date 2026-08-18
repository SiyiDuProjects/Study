import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isAllowedChatGptRedirectUri,
  isAllowedOAuthRedirectUri,
  loadConfig,
  normalizeReturnTo,
  type AppConfig,
} from "../src/config.js";
import { createPatCipher, hashOpaqueToken, pkceS256 } from "../src/crypto/index.js";
import { openDatabase, type AppDatabase } from "../src/db/index.js";
import {
  createAuthRouter,
  createAuthService,
  requireBearer,
  type AuthService,
  type OAuthAuthorizationInput,
  type ValidatePat,
} from "../src/auth/index.js";

const CHATGPT_CALLBACK = "https://chatgpt.com/connector/oauth/canvas-test";
const SECOND_CHATGPT_CALLBACK = "https://chatgpt.com/connector/oauth/canvas-test-two";
const LEGACY_CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect";
const VERIFIER = "A".repeat(43);

interface Harness {
  config: AppConfig;
  db: AppDatabase;
  service: AuthService;
  time: { value: number };
}

const databases: AppDatabase[] = [];

afterEach(() => {
  while (databases.length) {
    databases.pop()?.close();
  }
});

function testConfig(): AppConfig {
  return loadConfig({
    PUBLIC_ORIGIN: "http://localhost:8794",
    PORT: "8794",
    DATABASE_PATH: ":memory:",
    MASTER_KEY_BASE64: Buffer.alloc(32, 3).toString("base64"),
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_RP_NAME: "Canvas Test",
    COOKIE_SECURE: "false",
    TRUST_PROXY: "0",
    STUDY_SERVICE_TOKEN: "study-service-token-for-tests-123456",
  } as NodeJS.ProcessEnv);
}

function makeHarness(validatePat?: ValidatePat): Harness {
  const config = testConfig();
  const db = openDatabase(":memory:");
  databases.push(db);
  const time = { value: 1_800_000_000_000 };
  const service = createAuthService({
    db,
    config,
    clock: () => time.value,
    validatePat:
      validatePat ??
      (async () => ({ id: "canvas-user-1", name: "Canvas User", loginId: "canvas-user" })),
  });
  return { config, db, service, time };
}

function seedUser(db: AppDatabase, at: number, id = "user-1"): void {
  db.prepare(
    "INSERT INTO users(id, display_name, institution, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "Canvas User", "hanyang", at, at);
}

function seedCanvasConnection(harness: Harness, pat = "old-pat"): void {
  seedUser(harness.db, harness.time.value);
  const encrypted = createPatCipher(harness.config.masterKey).encrypt(
    pat,
    "canvas-pat:v1:user-1:hanyang",
  );
  harness.db
    .prepare(
      `INSERT INTO canvas_connections(
        user_id, institution, base_url, canvas_user_id, canvas_name, pat_version, pat_iv,
        pat_ciphertext, pat_auth_tag, pat_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "user-1",
      "hanyang",
      "https://learning.hanyang.ac.kr",
      "canvas-user-1",
      "Canvas User",
      encrypted.version,
      encrypted.iv,
      encrypted.ciphertext,
      encrypted.authTag,
      "fingerprint",
      harness.time.value,
      harness.time.value,
    );
}

function seedStepUpToken(
  harness: Harness,
  sessionId: string,
  action: "add_passkey" | "delete_account",
  token = `cstep_${action}`,
): string {
  harness.db
    .prepare(
      `INSERT INTO step_up_tokens(
        token_hash, user_id, session_hash, action, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      hashOpaqueToken(token),
      "user-1",
      sessionId,
      action,
      harness.time.value + harness.config.stepUpTokenTtlSeconds * 1000,
      harness.time.value,
    );
  return token;
}

function registerClient(service: AuthService): string {
  return service.registerOAuthClient({ redirect_uris: [CHATGPT_CALLBACK] }).client_id;
}

function authorizationInput(
  config: AppConfig,
  clientId: string,
  scope?: string,
): OAuthAuthorizationInput {
  return {
    clientId,
    redirectUri: CHATGPT_CALLBACK,
    responseType: "code",
    codeChallenge: pkceS256(VERIFIER),
    codeChallengeMethod: "S256",
    resource: config.oauthResource,
    ...(scope === undefined ? {} : { scope }),
    state: "state-1",
  };
}

function issueTokens(harness: Harness, scope?: string) {
  seedUser(harness.db, harness.time.value);
  const clientId = registerClient(harness.service);
  const input = authorizationInput(harness.config, clientId, scope);
  const { code } = harness.service.issueAuthorizationCode("user-1", input);
  const response = harness.service.exchangeAuthorizationCode({
    code,
    clientId,
    redirectUri: CHATGPT_CALLBACK,
    codeVerifier: VERIFIER,
    resource: harness.config.oauthResource,
  });
  return { clientId, code, input, response };
}

describe("configuration security", () => {
  it("allows exact ChatGPT callbacks and rejects lookalikes", () => {
    const config = testConfig();
    expect(isAllowedChatGptRedirectUri(CHATGPT_CALLBACK)).toBe(true);
    expect(isAllowedChatGptRedirectUri(LEGACY_CALLBACK)).toBe(true);
    expect(isAllowedOAuthRedirectUri(CHATGPT_CALLBACK, config)).toBe(true);
    expect(isAllowedChatGptRedirectUri("https://chatgpt.com.evil.test/connector/oauth/x")).toBe(false);
    expect(isAllowedChatGptRedirectUri("https://chatgpt.com/connector/oauth/x?next=evil")).toBe(false);
    expect(isAllowedChatGptRedirectUri("http://chatgpt.com/connector/oauth/x")).toBe(false);
  });

  it("normalizes return paths without permitting open redirects", () => {
    const config = testConfig();
    expect(normalizeReturnTo("/oauth/authorize?x=1", config)).toBe("/oauth/authorize?x=1");
    expect(normalizeReturnTo("https://evil.test", config)).toBe("/account");
    expect(normalizeReturnTo("//evil.test/path", config)).toBe("/account");
    expect(normalizeReturnTo("/\\evil.test", config)).toBe("/account");
    expect(normalizeReturnTo("/%2f%2fevil.test/path", config)).toBe("/account");
    expect(normalizeReturnTo("/%255c%255cevil.test/path", config)).toBe("/account");
    expect(normalizeReturnTo("/safe/%2e%2e/account", config)).toBe("/account");
  });

  it("rejects non-canonical or wrongly sized master keys", () => {
    expect(() =>
      loadConfig({
        PUBLIC_ORIGIN: "http://localhost:8794",
        MASTER_KEY_BASE64: Buffer.alloc(31).toString("base64"),
        WEBAUTHN_RP_ID: "localhost",
        COOKIE_SECURE: "false",
        STUDY_SERVICE_TOKEN: "study-service-token-for-tests-123456",
      } as NodeJS.ProcessEnv),
    ).toThrow(/32 bytes/);
  });

  it("requires exact RP host matching and scheme-appropriate secure cookies", () => {
    const base = {
      MASTER_KEY_BASE64: Buffer.alloc(32, 4).toString("base64"),
      DATABASE_PATH: ":memory:",
      STUDY_SERVICE_TOKEN: "study-service-token-for-tests-123456",
    };
    expect(() =>
      loadConfig({
        ...base,
        PUBLIC_ORIGIN: "https://canvas.example.com",
        WEBAUTHN_RP_ID: "example.com",
        COOKIE_SECURE: "true",
      } as NodeJS.ProcessEnv),
    ).toThrow(/exactly equal/);
    expect(() =>
      loadConfig({
        ...base,
        PUBLIC_ORIGIN: "https://canvas.example.com",
        WEBAUTHN_RP_ID: "canvas.example.com",
        COOKIE_SECURE: "false",
      } as NodeJS.ProcessEnv),
    ).toThrow(/must be true/);
    expect(() =>
      loadConfig({
        ...base,
        PUBLIC_ORIGIN: "http://localhost:8794",
        WEBAUTHN_RP_ID: "localhost",
        COOKIE_SECURE: "true",
      } as NodeJS.ProcessEnv),
    ).toThrow(/must be false/);
  });
});

describe("database and invitation security", () => {
  it("applies all schema migrations", () => {
    const { db } = makeHarness();
    expect(
      db.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
    ).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
    ]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(
        "passkey_registration_flows",
      ),
    ).toBeTruthy();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(
        "step_up_tokens",
      ),
    ).toBeTruthy();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(
        "oauth_clients_singleton_insert",
      ),
    ).toBeUndefined();
    for (const table of ["course_catalog", "course_snapshots", "course_sync_state"]) {
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
      ).toBeTruthy();
    }
  });

  it("opportunistically removes expired auth state at the exact expiry boundary", () => {
    const harness = makeHarness();
    seedUser(harness.db, harness.time.value);
    const clientId = registerClient(harness.service);
    const activeSession = "active-session-hash";
    harness.db
      .prepare(
        `INSERT INTO sessions(token_hash, user_id, expires_at, created_at, last_seen_at)
         VALUES (?, 'user-1', ?, ?, ?), (?, 'user-1', ?, ?, ?)`,
      )
      .run(
        "expired-session-hash",
        harness.time.value,
        harness.time.value,
        harness.time.value,
        activeSession,
        harness.time.value + 1,
        harness.time.value,
        harness.time.value,
      );
    harness.db
      .prepare(
        `INSERT INTO login_flows(flow_hash, challenge, expires_at, created_at)
         VALUES ('expired-login', 'challenge', ?, ?), ('active-login', 'challenge', ?, ?)`,
      )
      .run(
        harness.time.value,
        harness.time.value,
        harness.time.value + 1,
        harness.time.value,
      );
    harness.db
      .prepare(
        `INSERT INTO passkey_registration_flows(
          flow_hash, user_id, session_hash, challenge, expires_at, created_at
        ) VALUES ('expired-registration', 'user-1', ?, 'challenge', ?, ?),
                 ('active-registration', 'user-1', ?, 'challenge', ?, ?)`,
      )
      .run(
        activeSession,
        harness.time.value,
        harness.time.value,
        activeSession,
        harness.time.value + 1,
        harness.time.value,
      );
    harness.db
      .prepare(
        `INSERT INTO step_up_flows(
          flow_hash, user_id, session_hash, action, challenge, expires_at, created_at
        ) VALUES ('expired-step-flow', 'user-1', ?, 'add_passkey', 'challenge', ?, ?),
                 ('active-step-flow', 'user-1', ?, 'add_passkey', 'challenge', ?, ?)`,
      )
      .run(
        activeSession,
        harness.time.value,
        harness.time.value,
        activeSession,
        harness.time.value + 1,
        harness.time.value,
      );
    harness.db
      .prepare(
        `INSERT INTO step_up_tokens(
          token_hash, user_id, session_hash, action, expires_at, created_at
        ) VALUES ('expired-step-token', 'user-1', ?, 'delete_account', ?, ?),
                 ('active-step-token', 'user-1', ?, 'delete_account', ?, ?)`,
      )
      .run(
        activeSession,
        harness.time.value,
        harness.time.value,
        activeSession,
        harness.time.value + 1,
        harness.time.value,
      );
    harness.db
      .prepare(
        `INSERT INTO oauth_codes(
          code_hash, user_id, client_id, redirect_uri, scope, resource, code_challenge,
          expires_at, created_at
        ) VALUES ('expired-code', 'user-1', ?, ?, 'canvas.read', ?, ?, ?, ?),
                 ('active-code', 'user-1', ?, ?, 'canvas.read', ?, ?, ?, ?)`,
      )
      .run(
        clientId,
        CHATGPT_CALLBACK,
        harness.config.oauthResource,
        pkceS256(VERIFIER),
        harness.time.value,
        harness.time.value,
        clientId,
        CHATGPT_CALLBACK,
        harness.config.oauthResource,
        pkceS256(VERIFIER),
        harness.time.value + 1,
        harness.time.value,
      );
    harness.db
      .prepare(
        `INSERT INTO oauth_tokens(
          token_hash, token_type, family_id, user_id, client_id, resource, scope,
          expires_at, created_at
        ) VALUES ('expired-access', 'access', 'expired-family', 'user-1', ?, ?, 'canvas.read', ?, ?),
                 ('active-access', 'access', 'active-family', 'user-1', ?, ?, 'canvas.read', ?, ?)`,
      )
      .run(
        clientId,
        harness.config.oauthResource,
        harness.time.value,
        harness.time.value,
        clientId,
        harness.config.oauthResource,
        harness.time.value + 1,
        harness.time.value,
      );

    harness.service.createInvite({ institution: "hanyang" });

    for (const [table, expiredId, activeId, column] of [
      ["sessions", "expired-session-hash", activeSession, "token_hash"],
      ["login_flows", "expired-login", "active-login", "flow_hash"],
      ["passkey_registration_flows", "expired-registration", "active-registration", "flow_hash"],
      ["step_up_flows", "expired-step-flow", "active-step-flow", "flow_hash"],
      ["step_up_tokens", "expired-step-token", "active-step-token", "token_hash"],
      ["oauth_codes", "expired-code", "active-code", "code_hash"],
      ["oauth_tokens", "expired-access", "active-access", "token_hash"],
    ] as const) {
      expect(harness.db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(expiredId)).toBeUndefined();
      expect(harness.db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(activeId)).toBeTruthy();
    }
  });

  it("stores only an invitation hash and enforces expiry before PAT validation", async () => {
    const validatePat = vi.fn(async () => ({ id: "1", name: "User" }));
    const harness = makeHarness(validatePat);
    const invite = harness.service.createInvite({ institution: "hanyang", ttlSeconds: 60 });
    const row = harness.db.prepare("SELECT token_hash FROM invites").get() as { token_hash: string };
    expect(row.token_hash).toBe(hashOpaqueToken(invite.inviteToken));
    expect(row.token_hash).not.toContain(invite.inviteToken);

    harness.time.value = invite.expiresAt + 1;
    await expect(
      harness.service.beginSetup({ inviteToken: invite.inviteToken, pat: "candidate-pat" }),
    ).rejects.toThrow(/invalid, expired, or already used/);
    expect(validatePat).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 401 }, 401, "invalid_canvas_pat"],
    [{ status: 403 }, 401, "invalid_canvas_pat"],
    [{ code: "timeout" }, 504, "canvas_timeout"],
    [{ status: 500 }, 502, "canvas_unavailable"],
    [{ code: "network_error" }, 502, "canvas_unavailable"],
  ] as const)(
    "maps PAT validation failure %# without leaking the upstream error",
    async (failure, status, code) => {
      const harness = makeHarness(async () => {
        throw Object.assign(new Error("sensitive upstream details"), failure);
      });
      const invite = harness.service.createInvite({ institution: "hanyang" });
      await expect(
        harness.service.beginSetup({ inviteToken: invite.inviteToken, pat: "candidate-pat" }),
      ).rejects.toMatchObject({ status, code });
    },
  );
});

describe("OAuth 2.1 service", () => {
  it("keeps canvas-only grants compatible when Lecture is configured", () => {
    const config = loadConfig({
      PUBLIC_ORIGIN: "http://localhost:8794",
      DATABASE_PATH: ":memory:",
      MASTER_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
      WEBAUTHN_RP_ID: "localhost",
      COOKIE_SECURE: "false",
      STUDY_SERVICE_TOKEN: "study-service-token-for-tests-123456",
      LECTURE_API_URL: "http://lecture:8091",
      LECTURE_SERVICE_TOKEN: "lecture-service-token-for-tests-1234",
    } as NodeJS.ProcessEnv);
    const db = openDatabase(":memory:");
    databases.push(db);
    const service = createAuthService({
      db,
      config,
      validatePat: async () => ({ id: "1", name: "Student" }),
    });
    const client = service.registerOAuthClient({
      client_name: "Lecture-aware client",
      redirect_uris: [CHATGPT_CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });

    expect(config.oauthScopes).toEqual(["canvas.read", "lecture.read", "offline_access"]);
    expect(
      service.inspectAuthorizationRequest(
        authorizationInput(config, client.client_id, "canvas.read"),
      ).scope,
    ).toBe("canvas.read");
    expect(
      service.inspectAuthorizationRequest(
        authorizationInput(config, client.client_id, "canvas.read lecture.read"),
      ).scope,
    ).toBe("canvas.read lecture.read");

    seedUser(db, Date.now());
    const { code } = service.issueAuthorizationCode(
      "user-1",
      authorizationInput(config, client.client_id, "canvas.read lecture.read"),
    );
    const tokens = service.exchangeAuthorizationCode({
      code,
      clientId: client.client_id,
      redirectUri: CHATGPT_CALLBACK,
      codeVerifier: VERIFIER,
      resource: config.oauthResource,
    });
    expect(tokens.refresh_token).toMatch(/^crt_/);
    expect(tokens.scope).toBe("canvas.read lecture.read");
    expect(service.validateAccessToken(tokens.access_token).scope).toEqual([
      "canvas.read",
      "lecture.read",
    ]);
  });

  it("makes exact DCR metadata idempotent while allowing bounded independent connections", () => {
    const { service } = makeHarness();
    const client = service.registerOAuthClient({
      client_name: "<script>spoofed</script>",
      redirect_uris: [CHATGPT_CALLBACK],
      grant_types: ["refresh_token", "authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(client.client_id).toMatch(/^client_/);
    expect(client.client_name).toBe("ChatGPT");
    expect(client.token_endpoint_auth_method).toBe("none");
    const replay = service.registerOAuthClient({
      redirect_uris: [CHATGPT_CALLBACK, CHATGPT_CALLBACK],
      grant_types: ["authorization_code", "refresh_token", "authorization_code"],
      response_types: ["code", "code"],
    });
    expect(replay.client_id).toBe(client.client_id);
    expect(replay.client_id_issued_at).toBe(client.client_id_issued_at);
    const second = service.registerOAuthClient({ redirect_uris: [SECOND_CHATGPT_CALLBACK] });
    expect(second.client_id).not.toBe(client.client_id);
    expect(second.client_name).toBe("ChatGPT");
    expect(() =>
      service.registerOAuthClient({ redirect_uris: ["https://evil.test/callback"] }),
    ).toThrow(/not allowlisted/);
    expect(() =>
      service.registerOAuthClient({
        redirect_uris: [CHATGPT_CALLBACK],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    ).toThrow(/public clients/);
    expect(() =>
      service.registerOAuthClient({
        redirect_uris: [CHATGPT_CALLBACK],
        grant_types: ["authorization_code"],
      }),
    ).toThrow(/different client metadata/);
  });

  it("fails closed when the private DCR capacity is reached", () => {
    const harness = makeHarness();
    harness.config.oauthMaxClients = 1;
    harness.service.registerOAuthClient({ redirect_uris: [CHATGPT_CALLBACK] });
    expect(() =>
      harness.service.registerOAuthClient({ redirect_uris: [SECOND_CHATGPT_CALLBACK] }),
    ).toThrow(/capacity/);
    expect(harness.db.prepare("SELECT COUNT(*) AS count FROM oauth_clients").get()).toEqual({
      count: 1,
    });
  });

  it("can close the public DCR window without invalidating existing metadata", () => {
    const harness = makeHarness();
    harness.config.oauthDcrEnabled = false;

    expect(() =>
      harness.service.registerOAuthClient({ redirect_uris: [CHATGPT_CALLBACK] }),
    ).toThrow(/currently disabled/);
    expect(harness.service.authorizationServerMetadata()).not.toHaveProperty(
      "registration_endpoint",
    );
  });

  it("defaults omitted scope to durable read access, hashes grants, and consumes a code once", () => {
    const harness = makeHarness();
    seedUser(harness.db, harness.time.value);
    const clientId = registerClient(harness.service);
    const input = authorizationInput(harness.config, clientId);
    expect(harness.service.inspectAuthorizationRequest(input).scope).toBe(
      "canvas.read offline_access",
    );
    const { code, redirectTo } = harness.service.issueAuthorizationCode("user-1", input);
    expect(redirectTo).toContain(`state=${input.state}`);
    const storedCode = harness.db.prepare("SELECT code_hash FROM oauth_codes").get() as {
      code_hash: string;
    };
    expect(storedCode.code_hash).toBe(hashOpaqueToken(code));
    expect(storedCode.code_hash).not.toBe(code);

    const tokens = harness.service.exchangeAuthorizationCode({
      code,
      clientId,
      redirectUri: CHATGPT_CALLBACK,
      codeVerifier: VERIFIER,
      resource: harness.config.oauthResource,
    });
    expect(tokens.refresh_token).toMatch(/^crt_/);
    expect(tokens.scope).toBe("canvas.read offline_access");
    const storedTokens = harness.db.prepare("SELECT token_hash FROM oauth_tokens").all() as Array<{
      token_hash: string;
    }>;
    expect(storedTokens.map((row) => row.token_hash)).toContain(hashOpaqueToken(tokens.access_token));
    expect(storedTokens).toHaveLength(2);
    expect(storedTokens.some((row) => row.token_hash === tokens.access_token)).toBe(false);

    expect(() =>
      harness.service.exchangeAuthorizationCode({
        code,
        clientId,
        redirectUri: CHATGPT_CALLBACK,
        codeVerifier: VERIFIER,
        resource: harness.config.oauthResource,
      }),
    ).toThrow(/invalid or expired/);
  });

  it("issues durable access without expanding an explicit minimal scope", () => {
    const harness = makeHarness();
    const { clientId, response } = issueTokens(harness, "canvas.read");
    expect(response.refresh_token).toMatch(/^crt_/);
    expect(response.scope).toBe("canvas.read");
    expect(harness.service.validateAccessToken(response.access_token).scope).toEqual(["canvas.read"]);
    expect(() =>
      harness.service.validateAccessToken(response.access_token, ["offline_access"]),
    ).toThrow(/required scope/);

    const rotated = harness.service.exchangeRefreshToken({
      refreshToken: response.refresh_token!,
      clientId,
      resource: harness.config.oauthResource,
    });
    expect(rotated.refresh_token).toMatch(/^crt_/);
    expect(rotated.scope).toBe("canvas.read");
    expect(harness.service.validateAccessToken(rotated.access_token).scope).toEqual(["canvas.read"]);

    harness.db.prepare("UPDATE oauth_tokens SET resource = ? WHERE token_hash = ?").run(
      "https://evil.test/mcp",
      hashOpaqueToken(response.access_token),
    );
    expect(() => harness.service.validateAccessToken(response.access_token)).toThrow(
      /invalid or expired/,
    );
  });

  it("does not issue a refresh token to a client without the refresh_token grant", () => {
    const harness = makeHarness();
    seedUser(harness.db, harness.time.value);
    const client = harness.service.registerOAuthClient({
      redirect_uris: [CHATGPT_CALLBACK],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    const { code } = harness.service.issueAuthorizationCode(
      "user-1",
      authorizationInput(harness.config, client.client_id, "canvas.read"),
    );
    const tokens = harness.service.exchangeAuthorizationCode({
      code,
      clientId: client.client_id,
      redirectUri: CHATGPT_CALLBACK,
      codeVerifier: VERIFIER,
      resource: harness.config.oauthResource,
    });
    expect(tokens.refresh_token).toBeUndefined();
    expect(tokens.scope).toBe("canvas.read");
  });

  it("expires access tokens using the injected clock", () => {
    const harness = makeHarness();
    const { response } = issueTokens(harness, "canvas.read");
    harness.time.value += harness.config.accessTokenTtlSeconds * 1000 + 1;
    expect(() => harness.service.validateAccessToken(response.access_token)).toThrow(
      /invalid or expired/,
    );
  });

  it("rotates refresh tokens and revokes the whole family on reuse", () => {
    const harness = makeHarness();
    const { clientId, response } = issueTokens(harness, "canvas.read offline_access");
    const oldRefresh = response.refresh_token!;
    const rotated = harness.service.exchangeRefreshToken({
      refreshToken: oldRefresh,
      clientId,
      resource: harness.config.oauthResource,
    });
    expect(rotated.refresh_token).toMatch(/^crt_/);
    expect(rotated.refresh_token).not.toBe(oldRefresh);

    expect(() =>
      harness.service.exchangeRefreshToken({
        refreshToken: oldRefresh,
        clientId,
        resource: harness.config.oauthResource,
      }),
    ).toThrow(/reuse was detected/);
    expect(() => harness.service.validateAccessToken(rotated.access_token)).toThrow(
      /invalid or expired/,
    );
  });

  it("retains rotated refresh reuse sentinels until the refresh family expires", () => {
    const harness = makeHarness();
    const { clientId, response } = issueTokens(harness, "canvas.read offline_access");
    const originalRefresh = response.refresh_token!;
    harness.time.value += 1_000;
    const rotated = harness.service.exchangeRefreshToken({
      refreshToken: originalRefresh,
      clientId,
      resource: harness.config.oauthResource,
    });
    const rotatedRefresh = rotated.refresh_token!;

    harness.db.prepare("UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?").run(
      harness.time.value,
      hashOpaqueToken(originalRefresh),
    );
    harness.service.createInvite({ institution: "hanyang" });
    expect(
      harness.db.prepare("SELECT token_hash FROM oauth_tokens WHERE token_hash = ?").get(
        hashOpaqueToken(originalRefresh),
      ),
    ).toBeTruthy();

    harness.db.prepare("UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?").run(
      harness.time.value,
      hashOpaqueToken(rotatedRefresh),
    );
    harness.service.createInvite({ institution: "hanyang" });
    expect(
      harness.db.prepare("SELECT token_hash FROM oauth_tokens WHERE token_type = 'refresh'").get(),
    ).toBeUndefined();
    expect(
      harness.db.prepare("SELECT token_hash FROM oauth_tokens WHERE token_type = 'access'").get(),
    ).toBeTruthy();
  });

  it("revokes access tokens and exposes resource/auth-server metadata", () => {
    const harness = makeHarness();
    const { response } = issueTokens(harness, "canvas.read");
    harness.service.revokeOAuthToken(response.access_token);
    expect(() => harness.service.validateAccessToken(response.access_token)).toThrow(
      /invalid or expired/,
    );
    expect(harness.service.protectedResourceMetadata()).toMatchObject({
      resource: harness.config.oauthResource,
      authorization_servers: [harness.config.oauthIssuer],
    });
    expect(harness.service.authorizationServerMetadata()).toMatchObject({
      code_challenge_methods_supported: ["S256"],
      registration_endpoint: `${harness.config.publicOrigin}/oauth/register`,
    });
  });
});

describe("account management", () => {
  it("rotates an encrypted PAT only for the same Canvas identity", async () => {
    const harness = makeHarness(async ({ pat }) => {
      if (pat === "new-pat") {
        return { id: "canvas-user-1", name: "Renamed User" };
      }
      return { id: "different-user", name: "Wrong User" };
    });
    seedCanvasConnection(harness);

    const account = await harness.service.rotateCanvasPat("user-1", "new-pat");
    expect(account.user.displayName).toBe("Renamed User");
    expect(harness.service.getCanvasConnection("user-1").accessToken).toBe("new-pat");
    const stored = harness.db.prepare("SELECT pat_ciphertext FROM canvas_connections").get() as {
      pat_ciphertext: Buffer;
    };
    expect(stored.pat_ciphertext.toString("utf8")).not.toContain("new-pat");

    await expect(harness.service.rotateCanvasPat("user-1", "wrong-pat")).rejects.toThrow(
      /different Canvas account/,
    );
  });

  it("deletes the account and cascades its sessions", () => {
    const harness = makeHarness();
    seedUser(harness.db, harness.time.value);
    const sessionId = hashOpaqueToken("csess_account-delete");
    harness.db
      .prepare(
        `INSERT INTO sessions(token_hash, user_id, expires_at, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        "user-1",
        harness.time.value + 1000,
        harness.time.value,
        harness.time.value,
      );
    const stepUpToken = seedStepUpToken(harness, sessionId, "delete_account");
    harness.db
      .prepare(
        `INSERT INTO invites(id, token_hash, institution, expires_at, used_at, used_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "invite-1",
        "invite-hash",
        "hanyang",
        harness.time.value + 1000,
        harness.time.value,
        "user-1",
        harness.time.value,
      );
    harness.service.deleteAccount("user-1", sessionId, stepUpToken);
    expect(harness.db.prepare("SELECT id FROM users").get()).toBeUndefined();
    expect(harness.db.prepare("SELECT token_hash FROM sessions").get()).toBeUndefined();
    expect(harness.db.prepare("SELECT used_by_user_id FROM invites").get()).toEqual({
      used_by_user_id: null,
    });
  });
});

describe("HTTP contracts", () => {
  it("serves metadata and enforces same-origin browser POSTs", async () => {
    const harness = makeHarness();
    const app = express().use(createAuthRouter(harness.service, harness.config));

    await request(app)
      .get("/.well-known/oauth-protected-resource")
      .expect(200)
      .expect(({ body }) => expect(body.resource).toBe(harness.config.oauthResource));
    await request(app).post("/auth/login/options").expect(403);
    await request(app)
      .post("/auth/login/options")
      .set("Origin", harness.config.publicOrigin)
      .set("Sec-Fetch-Site", "same-origin")
      .send({})
      .expect(200)
      .expect(({ body }) => {
        expect(body.flowId).toMatch(/^clogin_/);
        expect(body.options.challenge).toBeTruthy();
      });
  });

  it("round-trips a safe login returnTo and rejects an open redirect", async () => {
    const harness = makeHarness();
    const app = express().use(createAuthRouter(harness.service, harness.config));

    await request(app)
      .get("/auth/session?returnTo=%2Foauth%2Fauthorize%3Fx%3D1")
      .expect(200)
      .expect(({ body }) => {
        expect(body.authenticated).toBe(false);
        expect(body.returnTo).toBe("/oauth/authorize?x=1");
        expect(body.redirectTo).toBe("/login");
      });
    await request(app)
      .get("/auth/session?returnTo=https%3A%2F%2Fevil.test")
      .expect(200)
      .expect(({ body }) => {
        expect(body.returnTo).toBe("/account");
        expect(body.redirectTo).toBe("/login");
      });
  });

  it("accepts the account deletion confirmation contract", async () => {
    const harness = makeHarness();
    seedUser(harness.db, harness.time.value);
    const rawSession = "csess_test-session";
    const sessionId = hashOpaqueToken(rawSession);
    harness.db
      .prepare(
        `INSERT INTO sessions(token_hash, user_id, expires_at, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        "user-1",
        harness.time.value + 60_000,
        harness.time.value,
        harness.time.value,
      );
    const stepUpToken = seedStepUpToken(harness, sessionId, "delete_account");
    const app = express().use(createAuthRouter(harness.service, harness.config));

    await request(app)
      .post("/api/account/delete")
      .set("Origin", harness.config.publicOrigin)
      .set("Cookie", `${harness.config.sessionCookieName}=${rawSession}`)
      .send({ confirmation: "DELETE", stepUpToken })
      .expect(200)
      .expect({ ok: true, redirectTo: "/" });
    expect(harness.db.prepare("SELECT id FROM users WHERE id = 'user-1'").get()).toBeUndefined();
  });

  it("puts validated bearer identity and scopes in res.locals.auth", async () => {
    const harness = makeHarness();
    const { response } = issueTokens(harness, "canvas.read");
    const app = express();
    app.get("/protected", requireBearer(harness.service), (_request, result) => {
      result.json(result.locals.auth);
    });

    await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${response.access_token}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.userId).toBe("user-1");
        expect(body.scope).toEqual(["canvas.read"]);
      });
    await request(app)
      .get("/protected")
      .expect(401)
      .expect("WWW-Authenticate", /resource_metadata=/);
  });

  it("completes the browser authorization POST and form-encoded PKCE exchange", async () => {
    const harness = makeHarness();
    seedUser(harness.db, harness.time.value);
    const clientId = registerClient(harness.service);
    const rawSession = "csess_oauth-session";
    harness.db
      .prepare(
        `INSERT INTO sessions(token_hash, user_id, expires_at, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        hashOpaqueToken(rawSession),
        "user-1",
        harness.time.value + 60_000,
        harness.time.value,
        harness.time.value,
      );
    const app = express().use(createAuthRouter(harness.service, harness.config));
    const oauthRequest = {
      client_id: clientId,
      redirect_uri: CHATGPT_CALLBACK,
      response_type: "code",
      code_challenge: pkceS256(VERIFIER),
      code_challenge_method: "S256",
      resource: harness.config.oauthResource,
      scope: "canvas.read offline_access",
      state: "state-1",
    };

    await request(app)
      .get("/oauth/authorize")
      .set("Cookie", `${harness.config.sessionCookieName}=${rawSession}`)
      .query(oauthRequest)
      .expect(200)
      .expect("Content-Type", /html/)
      .expect(/<script src="\/assets\/oauth-consent\.js" defer><\/script>/)
      .expect(/<form id="oauth-consent-form" method="post" action="\/oauth\/consent">/)
      .expect(/Signed in as <strong>Canvas User<\/strong> at Hanyang HY-ON/);

    await request(app)
      .post("/oauth/authorize")
      .set("Origin", harness.config.publicOrigin)
      .set("Cookie", `${harness.config.sessionCookieName}=${rawSession}`)
      .send({ ...oauthRequest, authorization_user_id: "another-user" })
      .expect(409)
      .expect(({ body }) => {
        expect(body.error).toBe("access_denied");
      });

    const authorization = await request(app)
      .post("/oauth/consent")
      .set("Origin", harness.config.publicOrigin)
      .set("Cookie", `${harness.config.sessionCookieName}=${rawSession}`)
      .send({ ...oauthRequest, authorization_user_id: "user-1" })
      .expect(200);
    const redirect = new URL(authorization.body.redirectTo as string);
    expect(redirect.origin + redirect.pathname).toBe(CHATGPT_CALLBACK);
    expect(redirect.searchParams.get("state")).toBe("state-1");

    await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code: redirect.searchParams.get("code"),
        client_id: clientId,
        redirect_uri: CHATGPT_CALLBACK,
        code_verifier: VERIFIER,
        resource: harness.config.oauthResource,
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.access_token).toMatch(/^cat_/);
        expect(body.refresh_token).toMatch(/^crt_/);
      });
  });
});
