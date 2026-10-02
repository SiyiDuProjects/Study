import { createHash } from "node:crypto";
import type { AppDatabase } from "../db/index.js";
import { CanvasApiError } from "./errors.js";

/** In-flight claims younger than this may still be running (each LMS request has its own 60s timeout). */
export const RESOLVE_MIN_PENDING_AGE_MS = 15 * 60_000;

export interface UnresolvedWriteReceipt {
  userId: string;
  requestId: string;
  kind: string;
  target: string;
  status: "pending" | "unknown";
  createdAt: string;
}

export class WriteLedger {
  constructor(private readonly db: AppDatabase) {}
  fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
  previous(userId: string, requestId: string, kind: string, fingerprint: string): unknown | undefined {
    const row = this.db.prepare("SELECT kind,fingerprint,status,result_json FROM canvas_write_receipts WHERE user_id=? AND request_id=?")
      .get(userId, requestId) as {kind: string; fingerprint: string; status: string; result_json: string | null} | undefined;
    if (!row) return undefined;
    if (row.kind !== kind || row.fingerprint !== fingerprint) throw new CanvasApiError("invalid_argument", "Request ID already belongs to different content or a different operation.");
    if (row.status === "complete" && row.result_json) return JSON.parse(row.result_json);
    if (row.status === "complete") throw new CanvasApiError("canvas_error", "An administrator confirmed this operation in LMS records. Do not repeat it.");
    throw new CanvasApiError("canvas_error", `Operation is ${row.status}. Inspect LMS records before any new request; do not retry automatically.`);
  }
  claim(userId: string, requestId: string, kind: string, fingerprint: string, target: string): void {
    try {
      this.db.prepare("INSERT INTO canvas_write_receipts(user_id,request_id,kind,fingerprint,target,status,created_at) VALUES(?,?,?,?,?,'pending',?)")
        .run(userId, requestId, kind, fingerprint, target, Date.now());
    } catch {
      throw new CanvasApiError("canvas_error", "An operation for this request or target is pending or unknown. Inspect LMS records before retrying.");
    }
  }
  finish(userId: string, requestId: string, result?: unknown): void {
    this.db.prepare("UPDATE canvas_write_receipts SET status=?,result_json=? WHERE user_id=? AND request_id=?")
      .run(result ? "complete" : "unknown", result ? JSON.stringify(result) : null, userId, requestId);
  }
  /** Drop a claim whose operation provably never reached LMS, so the same request can run again. */
  release(userId: string, requestId: string): void {
    this.db.prepare("DELETE FROM canvas_write_receipts WHERE user_id=? AND request_id=? AND status='pending'").run(userId, requestId);
  }
}

export function listUnresolvedWriteReceipts(db: AppDatabase): UnresolvedWriteReceipt[] {
  const rows = db.prepare(`SELECT user_id,request_id,kind,target,status,created_at FROM canvas_write_receipts
    WHERE status IN ('pending','unknown') ORDER BY created_at`).all() as
    {user_id: string; request_id: string; kind: string; target: string; status: "pending" | "unknown"; created_at: number}[];
  return rows.map(row => ({ userId: row.user_id, requestId: row.request_id, kind: row.kind, target: row.target,
    status: row.status, createdAt: new Date(row.created_at).toISOString() }));
}

/**
 * Administrative reconciliation after a person has inspected the LMS records.
 * "applied" keeps the request ID permanently answered without inventing a receipt;
 * "not_applied" removes the claim so the target and request ID are usable again.
 */
export function resolveWriteReceipt(db: AppDatabase, userId: string, requestId: string,
  outcome: "applied" | "not_applied", now = Date.now()): { requestId: string; kind: string; outcome: "applied" | "not_applied" } {
  return db.transaction(() => {
    const row = db.prepare("SELECT kind,status,created_at FROM canvas_write_receipts WHERE user_id=? AND request_id=?")
      .get(userId, requestId) as {kind: string; status: string; created_at: number} | undefined;
    if (!row) throw new Error("No write receipt exists for this account and request ID.");
    if (row.status !== "pending" && row.status !== "unknown") throw new Error(`Write receipt is already ${row.status}.`);
    if (row.status === "pending" && now - row.created_at < RESOLVE_MIN_PENDING_AGE_MS) {
      throw new Error("This operation may still be running. Wait at least 15 minutes after it started.");
    }
    if (outcome === "applied") {
      db.prepare("UPDATE canvas_write_receipts SET status='complete',result_json=NULL WHERE user_id=? AND request_id=?").run(userId, requestId);
    } else {
      db.prepare("DELETE FROM canvas_write_receipts WHERE user_id=? AND request_id=?").run(userId, requestId);
    }
    return { requestId, kind: row.kind, outcome };
  })();
}
