import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function randomOpaqueToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function hashPat(token: string, masterKey: Buffer): string {
  return createHmac("sha256", masterKey).update("canvas-pat\0", "utf8").update(token, "utf8").digest("hex");
}

export function safeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}
