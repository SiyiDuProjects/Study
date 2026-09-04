import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_VERSION = 1;
const TOKEN_CONTEXT = "canvas-file-download\0";
export const FILE_LINK_TTL_SECONDS = 15 * 60;

export interface FileDownloadGrant {
  userId: string;
  fileId: string;
  expiresAt: number;
}

interface FileDownloadTokenPayload {
  v: 1;
  u: string;
  f: string;
  e: number;
}

function signature(payload: string, masterKey: Buffer): Buffer {
  return createHmac("sha256", masterKey).update(TOKEN_CONTEXT, "utf8").update(payload, "utf8").digest();
}

export function createFileDownloadLink(input: {
  publicOrigin: string;
  masterKey: Buffer;
  userId: string;
  fileId: string;
  now?: number;
  ttlSeconds?: number;
}): { uri: string; expiresAt: string } {
  if (!input.userId.trim() || !/^[1-9]\d*$/.test(input.fileId)) {
    throw new Error("A valid user and Canvas file id are required.");
  }
  const now = input.now ?? Date.now();
  const ttlSeconds = input.ttlSeconds ?? FILE_LINK_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 60 * 60) {
    throw new Error("File link TTL must be between 60 and 3600 seconds.");
  }
  const expiresAt = Math.floor(now / 1_000) + ttlSeconds;
  const payloadObject: FileDownloadTokenPayload = {
    v: TOKEN_VERSION,
    u: input.userId,
    f: input.fileId,
    e: expiresAt,
  };
  const payload = Buffer.from(JSON.stringify(payloadObject), "utf8").toString("base64url");
  const token = `${payload}.${signature(payload, input.masterKey).toString("base64url")}`;
  return {
    uri: new URL(`/files/${encodeURIComponent(token)}`, input.publicOrigin).toString(),
    expiresAt: new Date(expiresAt * 1_000).toISOString(),
  };
}

export function verifyFileDownloadToken(input: {
  token: string;
  masterKey: Buffer;
  now?: number;
}): FileDownloadGrant | null {
  const parts = input.token.split(".");
  if (parts.length !== 2) return null;
  const [payload, encodedSignature] = parts;
  if (!payload || !encodedSignature) return null;

  let suppliedSignature: Buffer;
  let parsed: unknown;
  try {
    suppliedSignature = Buffer.from(encodedSignature, "base64url");
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
  } catch {
    return null;
  }
  const expectedSignature = signature(payload, input.masterKey);
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Partial<FileDownloadTokenPayload>;
  if (
    value.v !== TOKEN_VERSION ||
    typeof value.u !== "string" ||
    !value.u.trim() ||
    typeof value.f !== "string" ||
    !/^[1-9]\d*$/.test(value.f) ||
    typeof value.e !== "number" ||
    !Number.isInteger(value.e)
  ) {
    return null;
  }
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1_000);
  if (value.e <= nowSeconds || value.e > nowSeconds + 60 * 60) return null;
  return { userId: value.u, fileId: value.f, expiresAt: value.e };
}
