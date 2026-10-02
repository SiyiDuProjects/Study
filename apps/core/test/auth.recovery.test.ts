import express from "express";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { verifyRegistrationResponse, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { createPasskeyRecovery, approvePasskeyRecovery } from "../src/auth/recovery.js";
import { createAuthService } from "../src/auth/service.js";
import { createAuthRouter } from "../src/auth/http.js";
import { loadConfig } from "../src/config.js";
import { openDatabase, type AppDatabase } from "../src/db/index.js";

vi.mock("@simplewebauthn/server", async importOriginal => ({
  ...await importOriginal<typeof import("@simplewebauthn/server")>(), verifyRegistrationResponse: vi.fn(),
}));
const databases: AppDatabase[] = [];
beforeEach(() => { vi.mocked(verifyRegistrationResponse).mockReset(); });
afterEach(() => { while (databases.length) databases.pop()!.close(); });
const credential = { id: "new-key" } as RegistrationResponseJSON;
function success() {
  return { verified: true, registrationInfo: { credential: { id: "new-key", publicKey: new Uint8Array([4,5,6]), counter: 0, transports: ["internal"] }, credentialDeviceType: "singleDevice", credentialBackedUp: false } } as never;
}
function harness() {
  const config = loadConfig({ PUBLIC_ORIGIN: "https://study.siyidu.com", WEBAUTHN_RP_ID: "study.siyidu.com",
    MASTER_KEY_BASE64: Buffer.alloc(32, 17).toString("base64"), DATABASE_PATH: ":memory:", COOKIE_SECURE: "true", TRUST_PROXY: "0",
    STUDY_SERVICE_TOKEN: "test-service-secret-for-recovery-only" } as NodeJS.ProcessEnv);
  const db = openDatabase(":memory:"); databases.push(db);
  const time = { now: 1_900_000_000_000 };
  for (const institution of ["hanyang", "berkeley"]) {
    db.prepare("INSERT INTO users VALUES (?,?,?,0,0)").run(institution, institution, institution);
    db.prepare(`INSERT INTO webauthn_credentials(credential_id,user_id,public_key,counter,transports_json,device_type,backed_up,created_at,rp_id)
      VALUES (?,?,?,0,'[]','singleDevice',0,0,'canvas.gaid.studio')`).run(`${institution}-old`, institution, Buffer.from([1]));
    db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at,last_seen_at) VALUES (?,?,?,0,0)").run(institution, institution, time.now + 9_999_999);
  }
  db.prepare("INSERT INTO lecture_owner VALUES (1,'hanyang')").run();
  const recovery = createPasskeyRecovery(db, config, () => time.now);
  const approve = (id: string) => approvePasskeyRecovery(db, id, "hanyang", "hanyang", time.now);
  const keys = () => db.prepare("SELECT credential_id,user_id FROM webauthn_credentials ORDER BY user_id").all();
  return { db, config, time, recovery, approve, keys };
}

it("requires server approval and the original browser cookie; public IDs grant no access", async () => {
  const h = harness(); const a = h.recovery.request(""); const b = h.recovery.request("");
  expect(a.state).toBe("pending"); expect(a).not.toHaveProperty("school");
  expect(h.recovery.request(a.browserToken).requestId).toBe(a.requestId);
  await expect(h.recovery.options(a.browserToken)).rejects.toMatchObject({ code: "recovery_pending" });
  h.approve(a.requestId);
  expect(() => h.recovery.status(a.requestId)).toThrow();
  await expect(h.recovery.options(b.browserToken)).rejects.toMatchObject({ code: "recovery_pending" });
  expect(h.recovery.status(a.browserToken).school).toMatch(/Hanyang/);
  expect(() => approvePasskeyRecovery(h.db, a.requestId, "berkeley", "berkeley", h.time.now)).toThrow();
  expect(() => approvePasskeyRecovery(h.db, b.requestId, "hanyang", "berkeley", h.time.now)).toThrow();
});

it("verifies canonical RP, origin and user verification, then replaces only the approved school's passkeys and sessions", async () => {
  const h = harness(); const a = h.recovery.request(""); h.approve(a.requestId);
  const beforeKeys = h.keys(); const options = await h.recovery.options(a.browserToken);
  expect(options.options.rp.id).toBe("study.siyidu.com");
  expect(options.options.user.id).toBe(Buffer.from("hanyang").toString("base64url"));
  expect(h.keys()).toEqual(beforeKeys);
  vi.mocked(verifyRegistrationResponse).mockResolvedValue(success());
  expect(await h.recovery.finish(a.browserToken, credential)).toMatchObject({ recovered: true });
  expect(verifyRegistrationResponse).toHaveBeenCalledWith(expect.objectContaining({ expectedChallenge: options.options.challenge,
    expectedOrigin: "https://study.siyidu.com", expectedRPID: "study.siyidu.com", requireUserVerification: true }));
  expect(h.keys()).toEqual([{ credential_id: "berkeley-old", user_id: "berkeley" }, { credential_id: "new-key", user_id: "hanyang" }]);
  expect(h.db.prepare("SELECT user_id,revoked_at FROM sessions ORDER BY user_id").all()).toEqual([{ user_id: "berkeley", revoked_at: null }, { user_id: "hanyang", revoked_at: h.time.now }]);
  expect(h.db.prepare("SELECT user_id FROM lecture_owner").get()).toEqual({ user_id: "hanyang" });
  expect(h.db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 2 });
  await expect(h.recovery.finish(a.browserToken, credential)).rejects.toMatchObject({ code: "recovery_unavailable" });
});

it("leaves credentials intact after failed verification and refuses approval or completion after expiry", async () => {
  const h = harness(); const a = h.recovery.request(""); h.approve(a.requestId); await h.recovery.options(a.browserToken);
  const before = h.keys(); vi.mocked(verifyRegistrationResponse).mockRejectedValue(new Error("invalid signature"));
  await expect(h.recovery.finish(a.browserToken, credential)).rejects.toMatchObject({ code: "invalid_passkey" });
  expect(h.keys()).toEqual(before);
  h.time.now += 31 * 60_000;
  await expect(h.recovery.finish(a.browserToken, credential)).rejects.toThrow();
  expect(() => h.approve(a.requestId)).toThrow();
  expect(h.keys()).toEqual(before);
});

it("atomically rejects parallel replay and invalidates other approved recovery requests for that account", async () => {
  const h = harness(); const a = h.recovery.request(""); const b = h.recovery.request(""); h.approve(a.requestId); h.approve(b.requestId);
  await h.recovery.options(a.browserToken); await h.recovery.options(b.browserToken);
  vi.mocked(verifyRegistrationResponse).mockResolvedValue(success());
  const results = await Promise.allSettled([h.recovery.finish(a.browserToken, credential), h.recovery.finish(a.browserToken, credential)]);
  expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  await expect(h.recovery.finish(b.browserToken, credential)).rejects.toMatchObject({ code: "recovery_unavailable" });
});

it("rechecks expiry after asynchronous verification and rolls back credential conflicts", async () => {
  const h = harness(); const a = h.recovery.request(""); h.approve(a.requestId); await h.recovery.options(a.browserToken);
  const before = h.keys();
  vi.mocked(verifyRegistrationResponse).mockImplementation(async () => { h.time.now += 31 * 60_000; return success(); });
  await expect(h.recovery.finish(a.browserToken, credential)).rejects.toThrow(); expect(h.keys()).toEqual(before);
  const b = h.recovery.request(""); h.approve(b.requestId); await h.recovery.options(b.browserToken);
  const conflict = success() as any; conflict.registrationInfo.credential.id = "berkeley-old";
  vi.mocked(verifyRegistrationResponse).mockResolvedValue(conflict);
  await expect(h.recovery.finish(b.browserToken, credential)).rejects.toMatchObject({ code: "passkey_conflict" });
  expect(h.keys()).toEqual(before);
});

it("HTTP requires same-origin POSTs and HttpOnly host cookies, exposes no bearer link or approval endpoint", async () => {
  const h = harness();
  const auth = createAuthService({ db: h.db, config: h.config, validatePat: async () => { throw Error("unused"); } });
  const app = express().use(createAuthRouter(auth, h.config, h.recovery));
  await request(app).post("/auth/recovery/request").set("Origin", "https://evil.example").send({}).expect(403);
  const response = await request(app).post("/auth/recovery/request").set("Origin", h.config.publicOrigin).send({}).expect(200);
  expect(response.body).not.toHaveProperty("browserToken");
  const cookie = response.headers["set-cookie"][0];
  expect(cookie).toContain("__Host-study-recovery="); expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("Secure"); expect(cookie).toContain("SameSite=Strict");
  expect(response.headers["cache-control"]).toBe("no-store");
  h.approve(response.body.requestId);
  await request(app).post("/auth/recovery/options").set("Origin", h.config.publicOrigin).send({ requestId: response.body.requestId }).expect(401);
  await request(app).post("/auth/recovery/options").set("Origin", h.config.publicOrigin).set("Cookie", cookie.split(";")[0]).send({}).expect(200);
  await request(app).post("/auth/recovery/approve").set("Origin", h.config.publicOrigin).send({}).expect(404);
});
