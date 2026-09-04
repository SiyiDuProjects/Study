import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import Database from "better-sqlite3";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAuthRouter,
  createAuthService,
  type AuthService,
} from "../src/auth/index.js";
import {
  loadConfig,
  STUDY_LEGACY_WEBAUTHN_RP_ID,
  type AppConfig,
} from "../src/config.js";
import { hashOpaqueToken, pkceS256 } from "../src/crypto/index.js";
import { openDatabase, runMigrations, type AppDatabase } from "../src/db/index.js";

vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyAuthenticationResponse: vi.fn(),
    verifyRegistrationResponse: vi.fn(),
  };
});

const CANONICAL_ORIGIN = "https://study.siyidu.com";
const CANONICAL_RP = "study.siyidu.com";
const LEGACY_ORIGIN = "https://canvas.gaid.studio";
const LEGACY_RP = "canvas.gaid.studio";
const LEGACY_RESOURCE = `${LEGACY_ORIGIN}/mcp`;
const CHATGPT_CALLBACK = "https://chatgpt.com/connector/oauth/hanyang-legacy";
const VERIFIER = "A".repeat(43);

interface Harness {
  config: AppConfig;
  db: AppDatabase;
  service: AuthService;
  time: number;
}

const databases: AppDatabase[] = [];

beforeEach(() => {
  vi.mocked(verifyAuthenticationResponse).mockReset();
  vi.mocked(verifyRegistrationResponse).mockReset();
});

afterEach(() => {
  while (databases.length) {
    databases.pop()?.close();
  }
});

function candidateConfig(legacyLoginEnabled = true): AppConfig {
  return loadConfig({
    PUBLIC_ORIGIN: CANONICAL_ORIGIN,
    DATABASE_PATH: ":memory:",
    MASTER_KEY_BASE64: Buffer.alloc(32, 17).toString("base64"),
    WEBAUTHN_RP_ID: CANONICAL_RP,
    WEBAUTHN_RP_NAME: "Study ROR Test",
    WEBAUTHN_LEGACY_LOGIN_ENABLED: String(legacyLoginEnabled),
    COOKIE_SECURE: "true",
    TRUST_PROXY: "0",
    STUDY_SERVICE_TOKEN: "study-service-token-for-ror-tests-123456",
  } as NodeJS.ProcessEnv);
}

function makeHarness(legacyLoginEnabled = true): Harness {
  const config = candidateConfig(legacyLoginEnabled);
  const db = openDatabase(":memory:");
  databases.push(db);
  const time = 1_900_000_000_000;
  const service = createAuthService({
    db,
    config,
    clock: () => time,
    validatePat: async () => ({ id: "canvas-user-1", name: "Canvas User" }),
  });
  db.prepare(
    "INSERT INTO users(id, display_name, institution, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("user-1", "Canvas User", "hanyang", time, time);
  return { config, db, service, time };
}

function seedCredential(
  harness: Harness,
  id: string,
  rpId: string,
  createdAt = harness.time,
): void {
  harness.db.prepare(
    `INSERT INTO webauthn_credentials(
      credential_id, user_id, rp_id, public_key, counter, transports_json, device_type,
      backed_up, device_name, created_at
    ) VALUES (?, 'user-1', ?, ?, 0, '[]', 'singleDevice', 0, ?, ?)`,
  ).run(id, rpId, Buffer.from([1, 2, 3]), id, createdAt);
}

function seedSession(harness: Harness, rawSession = "csess_ror"): {
  rawSession: string;
  sessionId: string;
} {
  const sessionId = hashOpaqueToken(rawSession);
  harness.db.prepare(
    `INSERT INTO sessions(token_hash, user_id, expires_at, created_at, last_seen_at)
     VALUES (?, 'user-1', ?, ?, ?)`,
  ).run(
    sessionId,
    harness.time + harness.config.sessionTtlSeconds * 1000,
    harness.time,
    harness.time,
  );
  return { rawSession, sessionId };
}

function authenticationResponse(id: string): AuthenticationResponseJSON {
  return { id } as AuthenticationResponseJSON;
}

function registrationResponse(id: string): RegistrationResponseJSON {
  return { id } as RegistrationResponseJSON;
}

function mockAuthenticationSuccess(): void {
  vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter: 0 },
  } as never);
}

function mockRegistrationSuccess(id: string): void {
  vi.mocked(verifyRegistrationResponse).mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: {
        id,
        publicKey: new Uint8Array([4, 5, 6]),
        counter: 0,
        transports: [],
      },
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
    },
  } as never);
}

describe("Study candidate WebAuthn configuration", () => {
  it("hard-binds legacy ROR to the exact Study candidate hostname", () => {
    expect(candidateConfig()).toMatchObject({
      publicOrigin: CANONICAL_ORIGIN,
      webauthnRpId: CANONICAL_RP,
      webauthnLegacyLoginEnabled: true,
      webauthnLegacyRpId: LEGACY_RP,
    });
    expect(STUDY_LEGACY_WEBAUTHN_RP_ID).toBe(LEGACY_RP);
    expect(candidateConfig(false).webauthnLegacyRpId).toBeNull();

    const base = {
      MASTER_KEY_BASE64: Buffer.alloc(32, 17).toString("base64"),
      COOKIE_SECURE: "true",
      WEBAUTHN_LEGACY_LOGIN_ENABLED: "true",
      STUDY_SERVICE_TOKEN: "study-service-token-for-ror-tests-123456",
    };
    expect(() =>
      loadConfig({
        ...base,
        PUBLIC_ORIGIN: "https://other.siyidu.com",
        WEBAUTHN_RP_ID: "other.siyidu.com",
      } as NodeJS.ProcessEnv),
    ).toThrow(/allowlisted only for https:\/\/study\.siyidu\.com/);
    expect(() =>
      loadConfig({
        ...base,
        PUBLIC_ORIGIN: LEGACY_ORIGIN,
        WEBAUTHN_RP_ID: LEGACY_RP,
      } as NodeJS.ProcessEnv),
    ).toThrow(/allowlisted only/);

    const ignoredOverride = loadConfig({
      ...base,
      PUBLIC_ORIGIN: CANONICAL_ORIGIN,
      WEBAUTHN_RP_ID: CANONICAL_RP,
      WEBAUTHN_LEGACY_RP_ID: "attacker.example",
    } as NodeJS.ProcessEnv);
    expect(ignoredOverride.webauthnLegacyRpId).toBe(LEGACY_RP);
  });

  it("allows only the exact legacy MCP resource alias on the Study canonical origin", () => {
    const config = candidateConfig(false);
    expect(config.oauthResource).toBe(`${CANONICAL_ORIGIN}/mcp`);
    expect([...config.oauthResourceAliases]).toEqual([LEGACY_RESOURCE]);

    const local = loadConfig({
      PUBLIC_ORIGIN: "http://localhost:8794",
      DATABASE_PATH: ":memory:",
      MASTER_KEY_BASE64: Buffer.alloc(32, 17).toString("base64"),
      WEBAUTHN_RP_ID: "localhost",
      COOKIE_SECURE: "false",
      TRUST_PROXY: "0",
      STUDY_SERVICE_TOKEN: "study-service-token-for-ror-tests-123456",
    } as NodeJS.ProcessEnv);
    expect([...local.oauthResourceAliases]).toEqual([]);
  });
});

describe("legacy cloud App OAuth resource", () => {
  it("keeps legacy grants usable without accepting arbitrary resources", () => {
    const harness = makeHarness(false);
    const clientId = harness.service.registerOAuthClient({
      redirect_uris: [CHATGPT_CALLBACK],
    }).client_id;
    const input = {
      clientId,
      redirectUri: CHATGPT_CALLBACK,
      responseType: "code",
      codeChallenge: pkceS256(VERIFIER),
      codeChallengeMethod: "S256",
      resource: LEGACY_RESOURCE,
      scope: "canvas.read offline_access",
      state: "legacy-app-state",
    };

    expect(harness.service.inspectAuthorizationRequest(input).resource).toBe(LEGACY_RESOURCE);
    const { code } = harness.service.issueAuthorizationCode("user-1", input);
    const tokens = harness.service.exchangeAuthorizationCode({
      code,
      clientId,
      redirectUri: CHATGPT_CALLBACK,
      codeVerifier: VERIFIER,
      resource: LEGACY_RESOURCE,
    });
    expect(harness.service.validateAccessToken(tokens.access_token).resource).toBe(LEGACY_RESOURCE);

    const rotated = harness.service.exchangeRefreshToken({
      refreshToken: tokens.refresh_token!,
      clientId,
      resource: LEGACY_RESOURCE,
    });
    expect(harness.service.validateAccessToken(rotated.access_token).resource).toBe(LEGACY_RESOURCE);

    expect(() => harness.service.inspectAuthorizationRequest({
      ...input,
      resource: "https://attacker.example/mcp",
    })).toThrow(/exactly match this MCP resource/);
  });
});

describe("RP-aware migration", () => {
  it("backfills every pre-v6 credential and in-flight flow to the legacy RP", () => {
    const db = new Database(":memory:");
    databases.push(db);
    db.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations(version, applied_at)
      VALUES (1, 0), (2, 0), (3, 0), (4, 0), (5, 0);

      CREATE TABLE webauthn_credentials(
        credential_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO webauthn_credentials(credential_id, user_id, created_at)
      VALUES ('legacy-credential', 'user-1', 1);

      CREATE TABLE setup_flows(flow_hash TEXT PRIMARY KEY);
      INSERT INTO setup_flows(flow_hash) VALUES ('setup');
      CREATE TABLE login_flows(flow_hash TEXT PRIMARY KEY);
      INSERT INTO login_flows(flow_hash) VALUES ('login');
      CREATE TABLE passkey_registration_flows(flow_hash TEXT PRIMARY KEY);
      INSERT INTO passkey_registration_flows(flow_hash) VALUES ('registration');
      CREATE TABLE step_up_flows(flow_hash TEXT PRIMARY KEY);
      INSERT INTO step_up_flows(flow_hash) VALUES ('step-up');
    `);

    runMigrations(db);

    expect(db.prepare("SELECT rp_id FROM webauthn_credentials").get()).toEqual({
      rp_id: LEGACY_RP,
    });
    for (const table of [
      "setup_flows",
      "login_flows",
      "passkey_registration_flows",
      "step_up_flows",
    ]) {
      expect(db.prepare(`SELECT rp_id, expected_origin FROM ${table}`).get()).toEqual({
        rp_id: LEGACY_RP,
        expected_origin: LEGACY_ORIGIN,
      });
    }
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
      version: 6,
    });

    db.prepare(
      "INSERT INTO webauthn_credentials(credential_id, user_id, created_at) VALUES (?, ?, ?)",
    ).run("rollback-image-write", "user-1", 2);
    expect(
      db.prepare("SELECT rp_id FROM webauthn_credentials WHERE credential_id = ?").get(
        "rollback-image-write",
      ),
    ).toEqual({ rp_id: LEGACY_RP });
  });
});

describe("candidate ROR ceremonies", () => {
  it("freezes the legacy RP and exact canonical expected origin on login", async () => {
    const harness = makeHarness();
    seedCredential(harness, "legacy-credential", LEGACY_RP);
    mockAuthenticationSuccess();

    const login = await harness.service.beginPasskeyLogin();
    expect(login.options.rpId).toBe(LEGACY_RP);
    expect(harness.db.prepare("SELECT rp_id, expected_origin FROM login_flows").get()).toEqual({
      rp_id: LEGACY_RP,
      expected_origin: CANONICAL_ORIGIN,
    });

    harness.config.publicOrigin = "https://unrelated.example";
    harness.config.webauthnRpId = "unrelated.example";
    const result = await harness.service.finishPasskeyLogin({
      flowId: login.flowId,
      response: authenticationResponse("legacy-credential"),
    });
    expect(verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrigin: CANONICAL_ORIGIN,
        expectedRPID: LEGACY_RP,
      }),
    );
    expect(result.migrationStepUpToken).toMatch(/^cstep_/);
    expect(harness.db.prepare("SELECT token_hash, user_id FROM sessions").get()).toEqual({
      token_hash: hashOpaqueToken(result.sessionToken),
      user_id: "user-1",
    });
    expect(
      harness.db.prepare(
        "SELECT token_hash, session_hash, action FROM step_up_tokens",
      ).get(),
    ).toEqual({
      token_hash: hashOpaqueToken(result.migrationStepUpToken!),
      session_hash: hashOpaqueToken(result.sessionToken),
      action: "add_passkey",
    });
  });

  it("logically isolates credentials by the RP captured in the flow", async () => {
    const harness = makeHarness();
    seedCredential(harness, "legacy-credential", LEGACY_RP);
    const login = await harness.service.beginPasskeyLogin();
    seedCredential(harness, "canonical-credential", CANONICAL_RP, harness.time + 1);

    await expect(
      harness.service.finishPasskeyLogin({
        flowId: login.flowId,
        response: authenticationResponse("canonical-credential"),
      }),
    ).rejects.toMatchObject({ code: "unknown_passkey" });
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("prefers canonical credentials and can close legacy fallback immediately", async () => {
    const harness = makeHarness();
    seedCredential(harness, "legacy-credential", LEGACY_RP);
    expect((await harness.service.beginPasskeyLogin()).options.rpId).toBe(LEGACY_RP);
    expect((await harness.service.beginPasskeyLogin("legacy")).options.rpId).toBe(LEGACY_RP);

    const { sessionId } = seedSession(harness);
    const legacyStepUp = await harness.service.beginStepUp(
      "user-1",
      sessionId,
      "delete_account",
    );
    expect(legacyStepUp.options.rpId).toBe(LEGACY_RP);
    expect(legacyStepUp.options.allowCredentials?.map((item) => item.id)).toEqual([
      "legacy-credential",
    ]);

    seedCredential(harness, "canonical-credential", CANONICAL_RP, harness.time + 1);
    expect((await harness.service.beginPasskeyLogin()).options.rpId).toBe(CANONICAL_RP);
    expect((await harness.service.beginPasskeyLogin("legacy")).options.rpId).toBe(LEGACY_RP);
    const canonicalStepUp = await harness.service.beginStepUp(
      "user-1",
      sessionId,
      "add_passkey",
    );
    expect(canonicalStepUp.options.rpId).toBe(CANONICAL_RP);
    expect(canonicalStepUp.options.allowCredentials?.map((item) => item.id)).toEqual([
      "canonical-credential",
    ]);

    const disabled = makeHarness(false);
    seedCredential(disabled, "legacy-only", LEGACY_RP);
    expect((await disabled.service.beginPasskeyLogin()).options.rpId).toBe(CANONICAL_RP);
    await expect(disabled.service.beginPasskeyLogin("legacy")).rejects.toMatchObject({
      code: "passkey_missing",
    });

    const inFlight = await harness.service.beginPasskeyLogin("legacy");
    harness.config.webauthnLegacyLoginEnabled = false;
    harness.config.webauthnLegacyRpId = null;
    await expect(
      harness.service.finishPasskeyLogin({
        flowId: inFlight.flowId,
        response: authenticationResponse("legacy-credential"),
      }),
    ).rejects.toMatchObject({ code: "passkey_rp_disabled" });
  });

  it("uses the legacy login assertion once to register a canonical passkey", async () => {
    const harness = makeHarness();
    seedCredential(harness, "legacy-credential", LEGACY_RP);
    mockAuthenticationSuccess();
    const login = await harness.service.beginPasskeyLogin();
    const signedIn = await harness.service.finishPasskeyLogin({
      flowId: login.flowId,
      response: authenticationResponse("legacy-credential"),
    });
    expect(signedIn.migrationStepUpToken).toMatch(/^cstep_/);

    const sessionId = hashOpaqueToken(signedIn.sessionToken);
    const registration = await harness.service.beginPasskeyRegistration({
      userId: "user-1",
      sessionId,
      stepUpToken: signedIn.migrationStepUpToken!,
      deviceName: "siyidu.com migration",
    });
    expect(registration.options.rp.id).toBe(CANONICAL_RP);
    expect(registration.options.excludeCredentials).toEqual([]);
    expect(
      harness.db.prepare(
        "SELECT rp_id, expected_origin FROM passkey_registration_flows",
      ).get(),
    ).toEqual({ rp_id: CANONICAL_RP, expected_origin: CANONICAL_ORIGIN });
    await expect(
      harness.service.beginPasskeyRegistration({
        userId: "user-1",
        sessionId,
        stepUpToken: signedIn.migrationStepUpToken!,
      }),
    ).rejects.toMatchObject({ code: "step_up_required" });

    mockRegistrationSuccess("canonical-new");
    await harness.service.finishPasskeyRegistration({
      userId: "user-1",
      sessionId,
      flowId: registration.flowId,
      response: registrationResponse("canonical-new"),
    });
    expect(verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrigin: CANONICAL_ORIGIN,
        expectedRPID: CANONICAL_RP,
      }),
    );
    expect(
      harness.db.prepare("SELECT rp_id FROM webauthn_credentials WHERE credential_id = ?").get(
        "canonical-new",
      ),
    ).toEqual({ rp_id: CANONICAL_RP });
    expect((await harness.service.beginPasskeyLogin()).options.rpId).toBe(CANONICAL_RP);

    const fallback = await harness.service.beginPasskeyLogin("legacy");
    const fallbackResult = await harness.service.finishPasskeyLogin({
      flowId: fallback.flowId,
      response: authenticationResponse("legacy-credential"),
    });
    expect(fallbackResult.migrationStepUpToken).toBeUndefined();
  });

  it("stores canonical context on setup and canonical-preferred step-up flows", async () => {
    const harness = makeHarness();
    const invite = harness.service.createInvite({ institution: "hanyang" });
    await harness.service.beginSetup({ inviteToken: invite.inviteToken, pat: "candidate-pat" });
    expect(harness.db.prepare("SELECT rp_id, expected_origin FROM setup_flows").get()).toEqual({
      rp_id: CANONICAL_RP,
      expected_origin: CANONICAL_ORIGIN,
    });

    seedCredential(harness, "canonical", CANONICAL_RP);
    const { sessionId } = seedSession(harness, "csess_flow-context");
    await harness.service.beginStepUp("user-1", sessionId, "add_passkey");
    expect(harness.db.prepare("SELECT rp_id, expected_origin FROM step_up_flows").get()).toEqual({
      rp_id: CANONICAL_RP,
      expected_origin: CANONICAL_ORIGIN,
    });
  });
});

describe("candidate HTTP contract", () => {
  it("advertises legacy fallback only when enabled and rejects arbitrary modes", async () => {
    const harness = makeHarness();
    const app = express().use(createAuthRouter(harness.service, harness.config));
    await request(app)
      .get("/auth/session")
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ authenticated: false, legacyLoginEnabled: true });
      });
    await request(app)
      .post("/auth/login/options")
      .set("Origin", CANONICAL_ORIGIN)
      .send({ mode: "third-party" })
      .expect(400)
      .expect(({ body }) => {
        expect(body.error.code).toBe("invalid_login_mode");
      });
  });
});
