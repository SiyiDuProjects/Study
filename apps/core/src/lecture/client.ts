import { CanvasApiError } from "../canvas/index.js";
import {
  getLectureSessionResponseSchema,
  listLectureSessionsResponseSchema,
  searchLectureTranscriptsResponseSchema,
  type GetLectureSessionResponse,
  type LectureStatusFilter,
  type ListLectureSessionsResponse,
  type SearchLectureTranscriptsResponse,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface LectureClientOptions {
  baseUrl: string;
  serviceToken: string;
  siteAuthToken?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface ListLectureSessionsOptions {
  courseId?: string;
  status?: LectureStatusFilter;
  limit?: number;
}

export interface SearchLectureTranscriptsOptions {
  query: string;
  courseId?: string;
  status?: LectureStatusFilter;
  limit?: number;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new CanvasApiError(
      "invalid_argument",
      `limit must be an integer between 1 and ${maximum}.`,
    );
  }
  return resolved;
}

function boundedText(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new CanvasApiError(
      "invalid_argument",
      `${name} must contain between 1 and ${maximum} characters.`,
    );
  }
  return normalized;
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("response_too_large").catch(() => undefined);
        throw new CanvasApiError("invalid_response", "The Lecture response was too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

export class LectureClient {
  private readonly base: URL;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: LectureClientOptions) {
    this.base = new URL(options.baseUrl);
    if (
      (this.base.protocol !== "http:" && this.base.protocol !== "https:") ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      this.base.pathname !== "/"
    ) {
      throw new CanvasApiError(
        "configuration_error",
        "Lecture base URL must be a credential-free HTTP(S) origin.",
      );
    }
    if (options.serviceToken.trim().length < 32) {
      throw new CanvasApiError("configuration_error", "Lecture service token is invalid.");
    }
    if (options.siteAuthToken !== undefined && options.siteAuthToken.trim().length < 32) {
      throw new CanvasApiError("configuration_error", "Lecture Sites authorization token is invalid.");
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listSessions(options: ListLectureSessionsOptions = {}): Promise<ListLectureSessionsResponse> {
    const query = new URLSearchParams();
    if (options.courseId) query.set("course_id", boundedText(options.courseId, "course_id", 160));
    if (options.status) query.set("status", options.status);
    query.set("limit", String(boundedInteger(options.limit, 20, 100)));
    return listLectureSessionsResponseSchema.parse(
      await this.getJson(`/internal/mcp/lecture/sessions?${query.toString()}`),
    );
  }

  async getSession(sessionId: string): Promise<GetLectureSessionResponse> {
    const id = boundedText(sessionId, "session_id", 128);
    return getLectureSessionResponseSchema.parse(
      await this.getJson(`/internal/mcp/lecture/sessions/${encodeURIComponent(id)}`),
    );
  }

  async search(options: SearchLectureTranscriptsOptions): Promise<SearchLectureTranscriptsResponse> {
    const query = new URLSearchParams({ q: boundedText(options.query, "query", 500) });
    if (options.courseId) query.set("course_id", boundedText(options.courseId, "course_id", 160));
    if (options.status) query.set("status", options.status);
    query.set("limit", String(boundedInteger(options.limit, 20, 50)));
    return searchLectureTranscriptsResponseSchema.parse(
      await this.getJson(`/internal/mcp/lecture/search?${query.toString()}`),
    );
  }

  private async getJson(path: string): Promise<unknown> {
    const url = new URL(path, this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith("/internal/mcp/lecture/")) {
      throw new CanvasApiError("configuration_error", "Unsafe Lecture API path.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Bearer ${this.options.serviceToken}`,
        "User-Agent": "canvas-mcp-service/0.1 (lecture-readonly)",
      };
      if (this.options.siteAuthToken) {
        headers["OAI-Sites-Authorization"] = `Bearer ${this.options.siteAuthToken}`;
      }
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "error",
        signal: controller.signal,
      });
      const rawContentLength = response.headers.get("content-length");
      const contentLength = rawContentLength === null ? null : Number(rawContentLength);
      if (contentLength !== null && Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        throw new CanvasApiError("invalid_response", "The Lecture response was too large.");
      }
      const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
      if (!response.ok) {
        throw new CanvasApiError(
          response.status === 401 || response.status === 403
            ? "permission_denied"
            : response.status === 404
              ? "not_found"
              : response.status === 429
                ? "rate_limited"
                : "upstream_error",
          "The Lecture service rejected the request.",
          { status: response.status, retryable: response.status === 429 || response.status >= 500 },
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch (error) {
        throw new CanvasApiError(
          "invalid_response",
          "The Lecture service returned invalid JSON.",
          {},
          error instanceof Error ? { cause: error } : {},
        );
      }
    } catch (error) {
      if (error instanceof CanvasApiError) throw error;
      const timeout = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      throw new CanvasApiError(
        timeout ? "timeout" : "network_error",
        timeout
          ? "The Lecture service timed out."
          : "The Lecture service could not be reached.",
        { retryable: true },
        error instanceof Error ? { cause: error } : {},
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
