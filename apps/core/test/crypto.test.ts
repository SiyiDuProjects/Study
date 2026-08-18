import { describe, expect, it } from "vitest";
import {
  createPatCipher,
  hashOpaqueToken,
  hashPat,
  pkceS256,
  randomOpaqueToken,
  safeEqualText,
} from "../src/crypto/index.js";

describe("PAT encryption", () => {
  const key = Buffer.alloc(32, 7);
  const aad = "canvas-pat:v1:user-1:hanyang";

  it("round-trips with AES-256-GCM and uses a fresh nonce", () => {
    const cipher = createPatCipher(key);
    const first = cipher.encrypt("secret-pat", aad);
    const second = cipher.encrypt("secret-pat", aad);

    expect(cipher.decrypt(first, aad)).toBe("secret-pat");
    expect(first.iv).toHaveLength(12);
    expect(first.authTag).toHaveLength(16);
    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertext.toString("utf8")).not.toContain("secret-pat");
  });

  it("rejects the wrong key, AAD, and modified ciphertext", () => {
    const cipher = createPatCipher(key);
    const encrypted = cipher.encrypt("secret-pat", aad);

    expect(() => cipher.decrypt(encrypted, `${aad}:other`)).toThrow();
    expect(() => createPatCipher(Buffer.alloc(32, 8)).decrypt(encrypted, aad)).toThrow();

    const tampered = {
      ...encrypted,
      ciphertext: Buffer.from(encrypted.ciphertext),
    };
    tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 1;
    expect(() => cipher.decrypt(tampered, aad)).toThrow();
  });

  it("requires an exact 256-bit master key", () => {
    expect(() => createPatCipher(Buffer.alloc(31))).toThrow(/32 bytes/);
  });
});

describe("opaque token helpers", () => {
  it("generates opaque values and stores deterministic hashes", () => {
    const token = randomOpaqueToken("test_");
    expect(token).toMatch(/^test_[A-Za-z0-9_-]+$/);
    expect(hashOpaqueToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashOpaqueToken(token)).not.toContain(token);
    expect(hashPat("pat", Buffer.alloc(32, 1))).not.toBe(hashOpaqueToken("pat"));
  });

  it("derives PKCE S256 challenges and compares text safely", () => {
    expect(pkceS256("A".repeat(43))).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(safeEqualText("same", "same")).toBe(true);
    expect(safeEqualText("same", "different")).toBe(false);
  });
});
