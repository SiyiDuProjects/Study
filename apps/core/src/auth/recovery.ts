import { randomUUID } from "node:crypto";
import { generateRegistrationOptions, verifyRegistrationResponse, type RegistrationResponseJSON } from "@simplewebauthn/server";
import type { AppConfig } from "../config.js";
import { hashOpaqueToken, randomOpaqueToken } from "../crypto/index.js";
import type { AppDatabase } from "../db/index.js";
import { INSTITUTIONS, type InstitutionKey } from "../domain.js";
import { AuthError } from "./errors.js";

export const RECOVERY_TTL_MS = 30 * 60_000;
const APPROVAL_TTL_MS = 10 * 60_000;
type RecoveryRow = { id: string; browser_hash: string; user_id: string | null; created_at: number;
  expires_at: number; approved_at: number | null; used_at: number | null; challenge: string | null;
  challenge_expires_at: number | null; rp_id: string; expected_origin: string };
const unavailable = () => new AuthError("recovery_unavailable", "Recovery is unavailable or expired. Start a new request.", 401);

/** Server-operator CLI only. The public request ID cannot authorize a browser. */
export function approvePasskeyRecovery(db: AppDatabase, requestId: string, userId: string, institution: InstitutionKey, at = Date.now()) {
  return db.transaction(() => {
    const user = db.prepare("SELECT id FROM users WHERE id = ? AND institution = ?").get(userId, institution);
    if (!user) throw new AuthError("recovery_account_mismatch", "Exact account and school are required", 400);
    const result = db.prepare(`UPDATE passkey_recovery_requests SET user_id = ?, approved_at = ?, expires_at = MIN(expires_at, ?)
      WHERE id = ? AND user_id IS NULL AND approved_at IS NULL AND used_at IS NULL AND expires_at > ?`)
      .run(userId, at, at + APPROVAL_TTL_MS, requestId, at);
    if (result.changes !== 1) throw unavailable();
    return { approved: true, requestId, userId, institution };
  })();
}

export function createPasskeyRecovery(db: AppDatabase, config: AppConfig, clock = Date.now) {
  function active(browserToken: string): RecoveryRow {
    if (!browserToken || browserToken.length > 256) throw unavailable();
    const row = db.prepare("SELECT * FROM passkey_recovery_requests WHERE browser_hash = ?").get(hashOpaqueToken(browserToken)) as RecoveryRow | undefined;
    if (!row || row.used_at !== null || row.expires_at <= clock() || row.rp_id !== config.webauthnRpId || row.expected_origin !== config.publicOrigin) throw unavailable();
    return row;
  }
  function approved(browserToken: string) {
    const row = active(browserToken);
    if (!row.user_id || row.approved_at === null) throw new AuthError("recovery_pending", "Waiting for administrator approval", 403);
    const user = db.prepare("SELECT id, display_name, institution FROM users WHERE id = ?").get(row.user_id) as { id: string; display_name: string; institution: InstitutionKey } | undefined;
    if (!user || !Object.hasOwn(INSTITUTIONS, user.institution)) throw unavailable();
    return { row, user };
  }
  function status(browserToken: string) {
    const row = active(browserToken);
    return { requestId: row.id, expiresAt: row.expires_at, state: row.approved_at === null ? "pending" : "approved",
      ...(row.approved_at === null ? {} : { school: INSTITUTIONS[approved(browserToken).user.institution].displayName }) };
  }
  return {
    request(previousToken: string) {
      try { return { browserToken: previousToken, ...status(previousToken) }; } catch { /* expired requests can be replaced */ }
      const at = clock();
      db.prepare("DELETE FROM passkey_recovery_requests WHERE expires_at <= ?").run(at);
      const count = db.prepare("SELECT COUNT(*) AS n FROM passkey_recovery_requests").get() as { n: number };
      if (count.n >= 500) throw new AuthError("recovery_busy", "Please try recovery again later", 429);
      const browserToken = randomOpaqueToken("crecovery_");
      db.prepare(`INSERT INTO passkey_recovery_requests(id, browser_hash, created_at, expires_at, rp_id, expected_origin)
        VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), hashOpaqueToken(browserToken), at, at + RECOVERY_TTL_MS, config.webauthnRpId, config.publicOrigin);
      return { browserToken, ...status(browserToken) };
    },
    status,
    async options(browserToken: string) {
      const { row, user } = approved(browserToken);
      const options = await generateRegistrationOptions({ rpID: row.rp_id, rpName: config.webauthnRpName,
        userID: new Uint8Array(Buffer.from(user.id)), userName: `${user.display_name} (${INSTITUTIONS[user.institution].displayName})`,
        userDisplayName: `${user.display_name} (${INSTITUTIONS[user.institution].displayName})`, attestationType: "none",
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        // Recovery replaces lost credentials; never exclude the other school's key.
        excludeCredentials: (db.prepare("SELECT credential_id FROM webauthn_credentials WHERE user_id = ? AND rp_id = ?").all(user.id, row.rp_id) as { credential_id: string }[])
          .map(credential => ({ id: credential.credential_id })),
      });
      const at = clock();
      const result = db.prepare(`UPDATE passkey_recovery_requests SET challenge = ?, challenge_expires_at = ?
        WHERE id = ? AND used_at IS NULL AND expires_at > ?`).run(options.challenge, Math.min(row.expires_at, at + config.webauthnFlowTtlSeconds * 1000), row.id, at);
      if (result.changes !== 1) throw unavailable();
      return { options };
    },
    async finish(browserToken: string, response: RegistrationResponseJSON) {
      const { row, user } = approved(browserToken);
      if (!row.challenge || !row.challenge_expires_at || row.challenge_expires_at <= clock()) throw unavailable();
      let verification;
      try {
        verification = await verifyRegistrationResponse({ response, expectedChallenge: row.challenge,
          expectedOrigin: row.expected_origin, expectedRPID: row.rp_id, requireUserVerification: true });
      } catch { throw new AuthError("invalid_passkey", "Passkey registration could not be verified", 401); }
      if (!verification.verified || !verification.registrationInfo) throw new AuthError("invalid_passkey", "Passkey registration could not be verified", 401);
      const info = verification.registrationInfo;
      const at = clock();
      db.transaction(() => {
        const consumed = db.prepare(`UPDATE passkey_recovery_requests SET used_at = ? WHERE id = ?
          AND challenge = ? AND used_at IS NULL AND expires_at > ? AND challenge_expires_at > ?`)
          .run(at, row.id, row.challenge, at, at);
        if (consumed.changes !== 1) throw unavailable();
        if (db.prepare("SELECT 1 FROM webauthn_credentials WHERE credential_id = ?").get(info.credential.id)) {
          throw new AuthError("passkey_conflict", "This passkey is already registered", 409);
        }
        db.prepare("DELETE FROM webauthn_credentials WHERE user_id = ?").run(user.id);
        db.prepare(`INSERT INTO webauthn_credentials(credential_id, user_id, rp_id, public_key, counter,
          transports_json, device_type, backed_up, device_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(info.credential.id, user.id, row.rp_id, Buffer.from(info.credential.publicKey), info.credential.counter,
            JSON.stringify(info.credential.transports ?? []), info.credentialDeviceType, info.credentialBackedUp ? 1 : 0, "Recovered Study passkey", at);
        db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(at, user.id);
        for (const table of ["step_up_flows", "step_up_tokens", "passkey_registration_flows"]) {
          db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(user.id);
        }
        db.prepare("UPDATE passkey_recovery_requests SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(at, user.id);
        // Existing scoped OAuth connections continue during migration; no PAT or archive changes.
      })();
      return { recovered: true, school: INSTITUTIONS[user.institution].displayName };
    },
  };
}
export type PasskeyRecovery = ReturnType<typeof createPasskeyRecovery>;
