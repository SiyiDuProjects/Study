import type { AppDatabase } from "../db/index.js";
import { createPatCipher, hashPat } from "../crypto/index.js";
import { INSTITUTIONS } from "../domain.js";

/** Import identity and credentials only. OAuth grants, browser sessions and invitations are never copied. */
export function importBerkeleyAccount(source: AppDatabase, target: AppDatabase, sourceKey: Buffer, targetKey: Buffer): { imported: boolean; credentials: number } {
  for (const db of [source, target]) {
    if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Database integrity check failed");
  }
  const users = source.prepare("SELECT * FROM users").all() as Array<Record<string, unknown>>;
  const connections = source.prepare("SELECT * FROM canvas_connections").all() as Array<Record<string, unknown>>;
  if (users.length !== 1 || connections.length !== 1) throw new Error("Expected exactly one source school account");
  const user = users[0]!;
  const connection = connections[0]!;
  if (user.institution !== "berkeley" || connection.institution !== "berkeley" || user.id !== connection.user_id || connection.base_url !== INSTITUTIONS.berkeley.baseUrl) {
    throw new Error("Source identity or school origin mismatch");
  }
  const credentials = source.prepare("SELECT * FROM webauthn_credentials WHERE user_id = ?").all(user.id) as Array<Record<string, unknown>>;
  if (!credentials.length || credentials.some(c => !["berkeley.siyidu.com", "berkeley-canvas.gaid.studio"].includes(String(c.rp_id)))) {
    throw new Error("Source passkey RP is not an approved Berkeley migration origin");
  }
  const aad = `canvas-pat:v1:${String(user.id)}:berkeley`;
  const pat = createPatCipher(sourceKey).decrypt({ version: connection.pat_version as 1,
    iv: connection.pat_iv as Buffer, ciphertext: connection.pat_ciphertext as Buffer, authTag: connection.pat_auth_tag as Buffer }, aad);
  if (hashPat(pat, sourceKey) !== connection.pat_hash) throw new Error("Source credential integrity mismatch");
  const targetHash = hashPat(pat, targetKey);
  const encrypted = createPatCipher(targetKey).encrypt(pat, aad);
  // Explicit column lists avoid importing source-only provenance or unrelated data.
  const insert = (table: string, columns: string[], row: Record<string, unknown>) => {
    target.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map(c => row[c]));
  };
  return target.transaction(() => {
    const existing = target.prepare("SELECT * FROM canvas_connections WHERE user_id = ? OR institution = 'berkeley'").all(user.id) as Array<Record<string, unknown>>;
    if (existing.length) {
      const row = existing[0]!;
      if (existing.length === 1 && row.user_id === user.id && row.institution === "berkeley" && row.canvas_user_id === connection.canvas_user_id && row.pat_hash === targetHash) {
        const targetPat = createPatCipher(targetKey).decrypt({ version: row.pat_version as 1, iv: row.pat_iv as Buffer,
          ciphertext: row.pat_ciphertext as Buffer, authTag: row.pat_auth_tag as Buffer }, aad);
        if (targetPat === pat) return { imported: false, credentials: credentials.length };
      }
      throw new Error("Target school account collision; no data changed");
    }
    insert("users", ["id", "display_name", "institution", "created_at", "updated_at"], user);
    insert("canvas_connections", ["user_id", "institution", "base_url", "canvas_user_id", "canvas_name", "pat_version", "pat_iv", "pat_ciphertext", "pat_auth_tag", "pat_hash", "created_at", "updated_at"],
      { ...connection, pat_hash: targetHash, pat_version: encrypted.version, pat_iv: encrypted.iv, pat_ciphertext: encrypted.ciphertext, pat_auth_tag: encrypted.authTag });
    for (const credential of credentials) insert("webauthn_credentials",
      ["credential_id", "user_id", "public_key", "counter", "transports_json", "device_type", "backed_up", "created_at", "last_used_at", "device_name", "version", "rp_id"], credential);
    if ((target.pragma("foreign_key_check") as unknown[]).length) throw new Error("Target ownership validation failed");
    return { imported: true, credentials: credentials.length };
  })();
}
