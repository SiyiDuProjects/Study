import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EncryptedPat {
  version: 1;
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

export interface PatCipher {
  encrypt(plaintext: string, aad: string): EncryptedPat;
  decrypt(value: EncryptedPat, aad: string): string;
}

export function createPatCipher(masterKey: Buffer): PatCipher {
  if (masterKey.length !== 32) {
    throw new Error("AES-256-GCM master key must be exactly 32 bytes");
  }
  const key = Buffer.from(masterKey);
  return {
    encrypt(plaintext, aad) {
      if (!plaintext) {
        throw new Error("Canvas PAT cannot be empty");
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return { version: 1, iv, ciphertext, authTag: cipher.getAuthTag() };
    },
    decrypt(value, aad) {
      if (value.version !== 1 || value.iv.length !== 12 || value.authTag.length !== 16) {
        throw new Error("Unsupported or malformed encrypted PAT");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, value.iv, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(value.authTag);
      return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString("utf8");
    },
  };
}
