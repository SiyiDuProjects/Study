import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { CanvasApiError } from "./errors.js";
import type { Page } from "./types.js";

export function mapPage<T, U>(page: Page<T>, map: (item: T) => U): Page<U> {
  return { items: page.items.map(map), nextCursor: page.nextCursor };
}

interface Continuation {
  scope: string;
  url: string;
  offset: number;
}

/** Stateless continuation bound to one credential owner and exact query. */
export class CanvasCursor {
  private readonly key: Buffer;

  constructor(accessToken: string, userId: string) {
    this.key = createHash("sha256").update(JSON.stringify(["canvas-page-v1", accessToken, userId])).digest();
  }

  encode(state: Continuation): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const body = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url");
  }

  decode(cursor: string, scope: string): Continuation {
    try {
      if (cursor.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("Invalid cursor");
      const bytes = Buffer.from(cursor, "base64url");
      if (bytes.length <= 28) throw new Error("Invalid cursor");
      const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const state = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")) as Continuation;
      if (state.scope !== scope || typeof state.url !== "string" || !Number.isSafeInteger(state.offset) || state.offset < 0) {
        throw new Error("Invalid cursor");
      }
      return state;
    } catch {
      throw new CanvasApiError("invalid_argument", "The cursor is invalid for this account or query. Restart the list with the original filters.");
    }
  }
}
