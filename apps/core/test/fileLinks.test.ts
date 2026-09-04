import { describe, expect, it } from "vitest";
import { createFileDownloadLink, verifyFileDownloadToken } from "../src/fileLinks.js";

const masterKey = Buffer.alloc(32, 7);
const now = 1_900_000_000_000;

describe("Canvas file links", () => {
  it("creates a scoped short-lived token and verifies it", () => {
    const link = createFileDownloadLink({
      publicOrigin: "https://study.siyidu.com",
      masterKey,
      userId: "owner",
      fileId: "123",
      now,
    });
    const token = new URL(link.uri).pathname.split("/").at(-1) ?? "";
    expect(link.uri).toMatch(/^https:\/\/study\.siyidu\.com\/files\//);
    expect(verifyFileDownloadToken({ token, masterKey, now })).toEqual({
      userId: "owner",
      fileId: "123",
      expiresAt: Math.floor(now / 1_000) + 15 * 60,
    });
  });

  it("rejects tampered and expired tokens", () => {
    const link = createFileDownloadLink({
      publicOrigin: "https://study.siyidu.com",
      masterKey,
      userId: "owner",
      fileId: "123",
      now,
    });
    const token = new URL(link.uri).pathname.split("/").at(-1) ?? "";
    expect(verifyFileDownloadToken({ token: `${token}x`, masterKey, now })).toBeNull();
    expect(verifyFileDownloadToken({ token, masterKey, now: now + 15 * 60 * 1_000 })).toBeNull();
  });
});
