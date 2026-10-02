import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDatabase, type AppDatabase } from "../src/db/index.js";
import { createPatCipher, hashPat, pkceS256 } from "../src/crypto/index.js";
import { importBerkeleyAccount } from "../src/migration/berkeley.js";
import { INSTITUTIONS, type CanvasConnection, type InstitutionKey } from "../src/domain.js";
import { createCanvasMcpServer } from "../src/mcp/server.js";
import { createAuthService } from "../src/auth/service.js";
import { loadConfig } from "../src/config.js";
import { CourseCatalogService } from "../src/course/service.js";

const dbs: AppDatabase[] = [];
const key = Buffer.alloc(32, 5);
const sourceKey = Buffer.alloc(32, 8);
function database() { const db = openDatabase(":memory:"); dbs.push(db); return db; }
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function seed(db: AppDatabase, institution: InstitutionKey, id: string, encryptionKey = key) {
  const c = createPatCipher(encryptionKey).encrypt("fixture-pat", `canvas-pat:v1:${id}:${institution}`);
  db.prepare("INSERT INTO users VALUES (?, ?, ?, 1, 1)").run(id, "Student", institution);
  db.prepare("INSERT INTO canvas_connections VALUES (?, ?, ?, '42', 'Student', ?, ?, ?, ?, ?, 1, 1)")
    .run(id, institution, INSTITUTIONS[institution].baseUrl, c.version, c.iv, c.ciphertext, c.authTag, hashPat("fixture-pat", encryptionKey));
  db.prepare(`INSERT INTO webauthn_credentials(credential_id,user_id,public_key,counter,transports_json,device_type,backed_up,created_at,rp_id)
    VALUES (?, ?, ?, 0, '[]', 'singleDevice', 0, 1, ?)`)
    .run(`${id}-credential`, id, Buffer.from([1, 2, 3]), institution === "berkeley" ? "berkeley-canvas.gaid.studio" : "canvas.gaid.studio");
}
function config() {
  return loadConfig({ PUBLIC_ORIGIN: "https://study.siyidu.com", WEBAUTHN_RP_ID: "study.siyidu.com", MASTER_KEY_BASE64: key.toString("base64"),
    STUDY_SERVICE_TOKEN: "test-service-token-1234567890123456789", WEBAUTHN_LEGACY_LOGIN_ENABLED: "true", WEBAUTHN_BERKELEY_LOGIN_ENABLED: "true",
    LECTURE_API_URL: "https://lecture.siyidu.com", LECTURE_SERVICE_TOKEN: "test-lecture-token-1234567890123456789", CANVAS_MESSAGES_ENABLED: "true" });
}

describe("one Study plugin with independent school authorizations", () => {
  it("imports only Berkeley identity, re-encrypts its PAT and preserves the Hanyang archive owner", () => {
    const source = database(), target = database();
    seed(source, "berkeley", "berkeley-owner", sourceKey); seed(target, "hanyang", "hanyang-owner");
    expect(importBerkeleyAccount(source, target, sourceKey, key)).toEqual({ imported: true, credentials: 1 });
    const auth = createAuthService({ db: target, config: config(), validatePat: vi.fn() });
    expect(auth.getCanvasConnection("berkeley-owner")).toMatchObject({ institution: "berkeley", accessToken: "fixture-pat" });
    expect(auth.getCanvasConnection("hanyang-owner")).toMatchObject({ institution: "hanyang", accessToken: "fixture-pat" });
    expect(target.prepare("SELECT * FROM lecture_owner").get()).toEqual({ singleton: 1, user_id: "hanyang-owner" });
    expect(target.prepare("SELECT count(*) n FROM oauth_tokens").get()).toEqual({ n: 0 });
    expect(target.prepare("SELECT count(*) n FROM sessions").get()).toEqual({ n: 0 });
    expect(importBerkeleyAccount(source, target, sourceKey, key).imported).toBe(false);
    const catalog = new CourseCatalogService({ db: target, getConnection: id => auth.getCanvasConnection(id), minIntervalSeconds: 0 });
    expect(() => catalog.assertLectureOwner("berkeley-owner")).toThrow();
    expect(() => catalog.assertLectureOwner("hanyang-owner")).not.toThrow();
    target.prepare("DELETE FROM users WHERE id = 'hanyang-owner'").run();
    seed(target, "hanyang", "replacement");
    expect(() => catalog.assertLectureOwner("replacement")).toThrow();
  });

  it("rejects source tampering and account collisions without partially importing", () => {
    const source = database(), target = database();
    seed(source, "berkeley", "source-owner", sourceKey); seed(target, "hanyang", "hanyang-owner");
    expect(() => importBerkeleyAccount(source, target, key, key)).toThrow();
    expect(target.prepare("SELECT count(*) n FROM users").get()).toEqual({ n: 1 });
    seed(target, "berkeley", "different-owner");
    expect(() => importBerkeleyAccount(source, target, sourceKey, key)).toThrow(/collision/);
    expect(target.prepare("SELECT count(*) n FROM users").get()).toEqual({ n: 2 });
  });

  it("limits Berkeley grants to reads while Hanyang retains separately enabled scopes", async () => {
    const db = database(); seed(db, "berkeley", "berkeley-owner"); seed(db, "hanyang", "hanyang-owner");
    const auth = createAuthService({ db, config: config(), validatePat: vi.fn() });
    const redirect = "https://chatgpt.com/connector/oauth/study-test";
    const client = auth.registerOAuthClient({ redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
    const verifier = "a".repeat(43);
    for (const school of ["berkeley", "hanyang"]) {
      const input = { clientId: client.client_id, redirectUri: redirect, responseType: "code", codeChallenge: pkceS256(verifier), codeChallengeMethod: "S256", resource: config().oauthResource };
      const code = auth.issueAuthorizationCode(`${school}-owner`, input);
      const token = auth.exchangeAuthorizationCode({ clientId: client.client_id, code: code.code, redirectUri: redirect, codeVerifier: verifier, resource: input.resource });
      expect(token.scope.split(" ")).toEqual(school === "berkeley" ? ["canvas.read", "offline_access"] : config().oauthScopes);
    }
    expect((await auth.beginPasskeyLogin("berkeley")).options.rpId).toBe("berkeley-canvas.gaid.studio");
    expect((await auth.beginPasskeyLogin("legacy")).options.rpId).toBe("canvas.gaid.studio");
  });

  it("returns stable, distinct profile IDs and rejects Hanyang-only tools before fetching Berkeley data", async () => {
    for (const school of ["hanyang", "berkeley", "hanyang"] as const) {
      const connection: CanvasConnection = { userId: `${school}-owner`, institution: school, baseUrl: INSTITUTIONS[school].baseUrl,
        accessToken: `${school}-fixture`, canvasUserId: "42", canvasName: "Same name" };
      const fetcher = vi.fn();
      const server = createCanvasMcpServer({ userId: connection.userId, getConnection: () => connection, fetch: fetcher, learningXEnabled: true });
      const client = new Client({ name: "test", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a); await client.connect(b);
      try {
        const tools = await client.listTools();
        expect(tools.tools.find(t => t.name === "get_study_profile")?._meta?.["openai/profile"]).toBe(true);
        const profile = await client.callTool({ name: "get_study_profile", arguments: {} });
        expect(profile.structuredContent).toEqual({ id: connection.userId, name: "Same name", nickname: `${INSTITUTIONS[school].displayName} · Same name` });
        if (school === "berkeley") {
          expect((await client.callTool({ name: "get_timetable", arguments: {} })).isError).toBe(true);
          expect((await client.callTool({ name: "list_learningx_modules", arguments: { course_id: "7" } })).isError).toBe(true);
        }
        expect(fetcher).not.toHaveBeenCalled();
      } finally { await client.close(); await server.close(); }
    }
  });
});
