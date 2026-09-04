import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthRouter, createAuthService, type AuthService } from "../src/auth/index.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { hashOpaqueToken } from "../src/crypto/index.js";
import { openDatabase, type AppDatabase } from "../src/db/index.js";

vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyAuthenticationResponse: vi.fn(),
    verifyRegistrationResponse: vi.fn(),
  };
});

interface Harness {
  config: AppConfig;
  db: AppDatabase;
  service: AuthService;
  time: { value: number };
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

function makeHarness(): Harness {
  const config = loadConfig({
    PUBLIC_ORIGIN: "http://localhost:8794",
    DATABASE_PATH: ":memory:",
    MASTER_KEY_BASE64: Buffer.alloc(32, 9).toString("base64"),
    WEBAUTHN_RP_ID: "localhost",
    COOKIE_SECURE: "false",
    STUDY_SERVICE_TOKEN: "study-service-token-for-tests-123456",
  } as NodeJS.ProcessEnv);
  const db = openDatabase(":memory:");
  databases.push(db);
  const time = { value: 1_900_000_000_000 };
  const service = createAuthService({
    db,
    config,
    clock: () => time.value,
    validatePat: async () => ({ id: "canvas-user-1", name: "Canvas User" }),
  });
  return { config, db, service, time };
}

function seedUserAndCredential(harness: Harness): void {
  harness.db
    .prepare(
      "INSERT INTO users(id, display_name, institution, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("user-1", "Canvas User", "hanyang", harness.time.value, harness.time.value);
  harness.db
    .prepare(
      `INSERT INTO webauthn_credentials(
        credential_id, user_id, rp_id, public_key, counter, transports_json, device_type, backed_up,
        device_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "credential-1",
      "user-1",
      harness.config.webauthnRpId,
      Buffer.from([1, 2, 3]),
      0,
      "[]",
      "singleDevice",
      0,
      "Primary",
      harness.time.value,
    );
}

function seedSession(harness: Harness, rawSession = "csess_primary"): {
  rawSession: string;
  sessionId: string;
} {
  const sessionId = hashOpaqueToken(rawSession);
  harness.db
    .prepare(
      `INSERT INTO sessions(token_hash, user_id, expires_at, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      "user-1",
      harness.time.value + harness.config.sessionTtlSeconds * 1000,
      harness.time.value,
      harness.time.value,
    );
  return { rawSession, sessionId };
}

function authenticationResponse(id = "credential-1"): AuthenticationResponseJSON {
  return { id } as AuthenticationResponseJSON;
}

function registrationResponse(id = "new-credential"): RegistrationResponseJSON {
  return { id } as RegistrationResponseJSON;
}

function mockAuthenticationSuccess(newCounter = 0): void {
  vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter },
  } as never);
}

function mockRegistrationSuccess(id = "new-credential"): void {
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

function seedStepUpToken(
  harness: Harness,
  sessionId: string,
  action: "add_passkey" | "delete_account",
  token: string,
): void {
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
}

describe("operation-bound WebAuthn step-up", () => {
  it("issues only hashed, short-lived tokens and consumes the matching action once", async () => {
    const harness = makeHarness();
    seedUserAndCredential(harness);
    const { sessionId } = seedSession(harness);
    mockAuthenticationSuccess(0);

    const stepUp = await harness.service.beginStepUp("user-1", sessionId, "add_passkey");
    expect(stepUp.options.allowCredentials?.[0]?.id).toBe("credential-1");
    expect(
      harness.db.prepare("SELECT flow_hash FROM step_up_flows").get(),
    ).toEqual({ flow_hash: hashOpaqueToken(stepUp.flowId) });

    const verified = await harness.service.finishStepUp({
      userId: "user-1",
      sessionId,
      flowId: stepUp.flowId,
      response: authenticationResponse(),
    });
    expect(verified.action).toBe("add_passkey");
    expect(verified.stepUpToken).toMatch(/^cstep_/);
    expect(verified.expiresAt - harness.time.value).toBe(
      harness.config.stepUpTokenTtlSeconds * 1000,
    );
    expect(harness.db.prepare("SELECT flow_hash FROM step_up_flows").get()).toBeUndefined();
    expect(harness.db.prepare("SELECT token_hash, session_hash FROM step_up_tokens").get()).toEqual({
      token_hash: hashOpaqueToken(verified.stepUpToken),
      session_hash: sessionId,
    });

    expect(() =>
      harness.service.deleteAccount("user-1", sessionId, verified.stepUpToken),
    ).toThrow(
      /fresh passkey verification/,
    );
    await expect(
      harness.service.beginPasskeyRegistration({
        userId: "user-1",
        sessionId,
        stepUpToken: verified.stepUpToken,
      }),
    ).rejects.toThrow(/fresh passkey verification/);

    const replacementFlow = await harness.service.beginStepUp(
      "user-1",
      sessionId,
      "add_passkey",
    );
    const replacement = await harness.service.finishStepUp({
      userId: "user-1",
      sessionId,
      flowId: replacementFlow.flowId,
      response: authenticationResponse(),
    });
    const registration = await harness.service.beginPasskeyRegistration({
      userId: "user-1",
      sessionId,
      stepUpToken: replacement.stepUpToken,
      deviceName: "Phone",
    });
    expect(registration.flowId).toMatch(/^creg_/);
    await expect(
      harness.service.beginPasskeyRegistration({
        userId: "user-1",
        sessionId,
        stepUpToken: replacement.stepUpToken,
      }),
    ).rejects.toThrow(/fresh passkey verification/);
  });

  it("requires a fresh delete_account assertion and rejects expiration and replay", async () => {
    const harness = makeHarness();
    seedUserAndCredential(harness);
    const { sessionId } = seedSession(harness);
    mockAuthenticationSuccess(0);
    const flow = await harness.service.beginStepUp("user-1", sessionId, "delete_account");
    const verified = await harness.service.finishStepUp({
      userId: "user-1",
      sessionId,
      flowId: flow.flowId,
      response: authenticationResponse(),
    });
    harness.time.value = verified.expiresAt + 1;
    expect(() =>
      harness.service.deleteAccount("user-1", sessionId, verified.stepUpToken),
    ).toThrow(
      /fresh passkey verification/,
    );

    const replacement = "cstep_delete-replacement";
    seedStepUpToken(harness, sessionId, "delete_account", replacement);
    harness.service.deleteAccount("user-1", sessionId, replacement);
    expect(harness.db.prepare("SELECT id FROM users WHERE id = 'user-1'").get()).toBeUndefined();
    expect(() => harness.service.deleteAccount("user-1", sessionId, replacement)).toThrow(
      /fresh passkey verification/,
    );
  });

  it("binds flows and tokens to one active session and invalidates them on logout", async () => {
    const harness = makeHarness();
    seedUserAndCredential(harness);
    const primary = seedSession(harness, "csess_primary-device");
    const other = seedSession(harness, "csess_other-device");
    mockAuthenticationSuccess(0);

    const wrongSessionFlow = await harness.service.beginStepUp(
      "user-1",
      primary.sessionId,
      "add_passkey",
    );
    await expect(
      harness.service.finishStepUp({
        userId: "user-1",
        sessionId: other.sessionId,
        flowId: wrongSessionFlow.flowId,
        response: authenticationResponse(),
      }),
    ).rejects.toMatchObject({ code: "invalid_step_up_flow" });
    expect(harness.db.prepare("SELECT flow_hash FROM step_up_flows").get()).toBeUndefined();

    const flow = await harness.service.beginStepUp(
      "user-1",
      primary.sessionId,
      "add_passkey",
    );
    const token = await harness.service.finishStepUp({
      userId: "user-1",
      sessionId: primary.sessionId,
      flowId: flow.flowId,
      response: authenticationResponse(),
    });
    await expect(
      harness.service.beginPasskeyRegistration({
        userId: "user-1",
        sessionId: other.sessionId,
        stepUpToken: token.stepUpToken,
      }),
    ).rejects.toMatchObject({ code: "step_up_required" });
    expect(harness.db.prepare("SELECT token_hash FROM step_up_tokens").get()).toBeUndefined();

    const logoutFlow = await harness.service.beginStepUp(
      "user-1",
      primary.sessionId,
      "delete_account",
    );
    const logoutToken = await harness.service.finishStepUp({
      userId: "user-1",
      sessionId: primary.sessionId,
      flowId: logoutFlow.flowId,
      response: authenticationResponse(),
    });
    harness.service.revokeSession(primary.rawSession);
    expect(harness.db.prepare("SELECT token_hash FROM step_up_tokens").get()).toBeUndefined();
    expect(() =>
      harness.service.deleteAccount("user-1", primary.sessionId, logoutToken.stepUpToken),
    ).toThrow(/fresh passkey verification/);
  });
});

describe("atomic WebAuthn flow claims", () => {
  it("destroys setup PAT ciphertext before verification, including on failure", async () => {
    const harness = makeHarness();
    const invite = harness.service.createInvite({ institution: "hanyang" });
    const setup = await harness.service.beginSetup({
      inviteToken: invite.inviteToken,
      pat: "setup-secret-pat",
    });
    expect(harness.db.prepare("SELECT pat_ciphertext FROM setup_flows").get()).toBeTruthy();
    vi.mocked(verifyRegistrationResponse).mockRejectedValue(new Error("bad assertion"));

    await expect(
      harness.service.finishSetup({ flowId: setup.flowId, response: registrationResponse() }),
    ).rejects.toMatchObject({ code: "invalid_passkey" });
    expect(harness.db.prepare("SELECT flow_hash FROM setup_flows").get()).toBeUndefined();
    expect(harness.db.prepare("SELECT used_at FROM invites").get()).toEqual({ used_at: null });

    await expect(
      harness.service.finishSetup({ flowId: setup.flowId, response: registrationResponse() }),
    ).rejects.toMatchObject({ code: "invalid_setup_flow" });
    expect(verifyRegistrationResponse).toHaveBeenCalledTimes(1);
  });

  it("destroys login, passkey-registration, and step-up flows on failed verification", async () => {
    const harness = makeHarness();
    seedUserAndCredential(harness);
    const { sessionId } = seedSession(harness);

    const login = await harness.service.beginPasskeyLogin();
    vi.mocked(verifyAuthenticationResponse).mockRejectedValueOnce(new Error("bad login"));
    await expect(
      harness.service.finishPasskeyLogin({
        flowId: login.flowId,
        response: authenticationResponse(),
      }),
    ).rejects.toMatchObject({ code: "invalid_passkey" });
    expect(harness.db.prepare("SELECT flow_hash FROM login_flows").get()).toBeUndefined();

    seedStepUpToken(harness, sessionId, "add_passkey", "cstep_add");
    const registration = await harness.service.beginPasskeyRegistration({
      userId: "user-1",
      sessionId,
      stepUpToken: "cstep_add",
    });
    vi.mocked(verifyRegistrationResponse).mockRejectedValueOnce(new Error("bad registration"));
    await expect(
      harness.service.finishPasskeyRegistration({
        userId: "user-1",
        sessionId,
        flowId: registration.flowId,
        response: registrationResponse(),
      }),
    ).rejects.toMatchObject({ code: "invalid_passkey" });
    expect(
      harness.db.prepare("SELECT flow_hash FROM passkey_registration_flows").get(),
    ).toBeUndefined();

    const stepUp = await harness.service.beginStepUp(
      "user-1",
      sessionId,
      "delete_account",
    );
    vi.mocked(verifyAuthenticationResponse).mockRejectedValueOnce(new Error("bad step-up"));
    await expect(
      harness.service.finishStepUp({
        userId: "user-1",
        sessionId,
        flowId: stepUp.flowId,
        response: authenticationResponse(),
      }),
    ).rejects.toMatchObject({ code: "invalid_passkey" });
    expect(harness.db.prepare("SELECT flow_hash FROM step_up_flows").get()).toBeUndefined();
  });
});

describe("passkey counter CAS", () => {
  it("prevents a concurrent zero-counter assertion from creating a session", async () => {
    const harness = makeHarness();
    seedUserAndCredential(harness);
    const login = await harness.service.beginPasskeyLogin();
    vi.mocked(verifyAuthenticationResponse).mockImplementationOnce(async () => {
      harness.db
        .prepare("UPDATE webauthn_credentials SET version = version + 1 WHERE credential_id = ?")
        .run("credential-1");
      return {
        verified: true,
        authenticationInfo: { newCounter: 0 },
      } as never;
    });

    await expect(
      harness.service.finishPasskeyLogin({
        flowId: login.flowId,
        response: authenticationResponse(),
      }),
    ).rejects.toMatchObject({ code: "stale_passkey_counter", status: 409 });
    expect(harness.db.prepare("SELECT token_hash FROM sessions").get()).toBeUndefined();
    expect(harness.db.prepare("SELECT version FROM webauthn_credentials").get()).toEqual({
      version: 1,
    });

    mockAuthenticationSuccess(0);
    const next = await harness.service.beginPasskeyLogin();
    await expect(
      harness.service.finishPasskeyLogin({
        flowId: next.flowId,
        response: authenticationResponse(),
      }),
    ).resolves.toMatchObject({ user: { id: "user-1" } });
    expect(harness.db.prepare("SELECT version FROM webauthn_credentials").get()).toEqual({
      version: 2,
    });
  });
});

describe("step-up HTTP contract", () => {
  it("keeps tokens on no-store POST responses and requires them for add-passkey", async () => {
    const harness = makeHarness();
    seedUserAndCredential(harness);
    mockAuthenticationSuccess(0);
    const rawSession = "csess_step-up";
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
    const common = (path: string) =>
      request(app)
        .post(path)
        .set("Origin", harness.config.publicOrigin)
        .set("Cookie", `${harness.config.sessionCookieName}=${rawSession}`);

    const options = await common("/api/account/step-up/options")
      .send({ action: "add_passkey" })
      .expect(200)
      .expect("Cache-Control", "no-store");
    const verified = await common("/api/account/step-up/verify")
      .send({ flowId: options.body.flowId, credential: authenticationResponse() })
      .expect(200)
      .expect("Cache-Control", "no-store");
    expect(verified.body.stepUpToken).toMatch(/^cstep_/);

    await common("/api/account/passkeys/options").send({}).expect(400);
    await common("/api/account/passkeys/options")
      .send({ stepUpToken: verified.body.stepUpToken, deviceName: "Laptop" })
      .expect(200);
  });
});
