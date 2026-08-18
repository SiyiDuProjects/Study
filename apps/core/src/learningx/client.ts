import { INSTITUTIONS, type CanvasConnection } from "../domain.js";
import { CanvasApiError } from "../canvas/errors.js";
import type { CanvasId } from "../canvas/types.js";
import type {
  LearningXAttendanceItem,
  LearningXFeature,
  LearningXModule,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

export interface LearningXClientOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_FORM_FIELDS = 100;
const MAX_FORM_BYTES = 256 * 1024;
const MAX_JWT_LENGTH = 16 * 1024;

const FEATURE_LABELS: Record<LearningXFeature, readonly RegExp[]> = {
  attendance: [
    /attendance/i,
    /출결/u,
    /출석/u,
    /학습\s*현황/u,
  ],
  modules: [
    /learning\s*x/i,
    /course\s*contents?/i,
    /modules?/i,
    /강의\s*콘텐츠/u,
    /온라인\s*강의/u,
    /주차\s*학습/u,
  ],
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function record(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function idValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function idArgument(value: CanvasId, name: string): string {
  const id = String(value);
  if (!/^[1-9]\d*$/.test(id)) {
    throw new CanvasApiError("invalid_argument", `${name} must be a positive Canvas id.`);
  }
  return id;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_match, raw: string) => String.fromCodePoint(Number(raw)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, raw: string) =>
      String.fromCodePoint(Number.parseInt(raw, 16)),
    );
}

function htmlAttribute(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return match ? decodeHtml(match[1] ?? match[2] ?? "") : null;
}

function statusError(status: number, operation: string): CanvasApiError {
  if (status === 401) {
    return new CanvasApiError("authentication_failed", `${operation} rejected the stored credential.`, {
      status,
    });
  }
  if (status === 403) {
    return new CanvasApiError("permission_denied", `${operation} is not available to this account.`, {
      status,
    });
  }
  if (status === 404) {
    return new CanvasApiError("not_found", `${operation} was not found for this course.`, { status });
  }
  if (status === 429) {
    return new CanvasApiError("rate_limited", `${operation} was rate limited.`, {
      status,
      retryable: true,
    });
  }
  return new CanvasApiError("upstream_error", `${operation} failed with HTTP ${status}.`, {
    status,
    retryable: status >= 500,
  });
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new CanvasApiError("invalid_response", "LearningX returned an oversized response.");
  }
  const body = await response.arrayBuffer();
  if (body.byteLength > maxBytes) {
    throw new CanvasApiError("invalid_response", "LearningX returned an oversized response.");
  }
  return new TextDecoder().decode(body);
}

function parseJson(text: string, operation: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CanvasApiError(
      "invalid_response",
      `${operation} returned non-JSON content.`,
      {},
      error instanceof Error ? { cause: error } : {},
    );
  }
}

export class LearningXReadClient {
  private readonly base: URL;
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(connection: CanvasConnection, options: LearningXClientOptions = {}) {
    if (connection.institution !== "hanyang") {
      throw new CanvasApiError(
        "configuration_error",
        "LearningX tools are enabled only for the Hanyang connection.",
      );
    }
    const expected = new URL(INSTITUTIONS.hanyang.baseUrl);
    const actual = new URL(connection.baseUrl);
    if (
      actual.protocol !== "https:" ||
      actual.origin !== expected.origin ||
      actual.pathname !== "/" ||
      actual.username ||
      actual.password ||
      actual.search ||
      actual.hash
    ) {
      throw new CanvasApiError(
        "configuration_error",
        "The Hanyang LearningX connection did not match the configured HTTPS origin.",
      );
    }
    if (connection.accessToken.length < 16 || connection.accessToken.length > 4096) {
      throw new CanvasApiError("configuration_error", "The Canvas access token is malformed.");
    }
    this.base = actual;
    this.baseUrl = actual.origin;
    this.accessToken = connection.accessToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async listAttendance(
    courseId: CanvasId,
    externalToolId?: CanvasId,
  ): Promise<LearningXAttendanceItem[]> {
    const course = idArgument(courseId, "course_id");
    const launch = await this.launch(course, "attendance", externalToolId);
    const profile = await this.canvasJson("/api/v1/users/self/profile", "Canvas profile");
    if (!isRecord(profile)) {
      throw new CanvasApiError("invalid_response", "Canvas profile had an unexpected shape.");
    }
    const query = new URLSearchParams({ user_id: idValue(profile.id), role: "1" });
    const loginId = stringValue(profile.login_id);
    if (loginId) query.set("user_login", loginId);
    const raw = await this.learningXJson(
      `/learningx/api/v1/courses/${course}/allcomponents_db?${query.toString()}`,
      launch.jwt,
      "LearningX attendance",
    );
    return records(raw)
      .map((item) => this.normalizeAttendance(item, course, launch.viewerUrl))
      .filter((item) => item.id !== "");
  }

  async getAttendanceItem(
    courseId: CanvasId,
    itemId: CanvasId,
    externalToolId?: CanvasId,
  ): Promise<LearningXAttendanceItem> {
    const course = idArgument(courseId, "course_id");
    const item = idArgument(itemId, "item_id");
    const launch = await this.launch(course, "attendance", externalToolId);
    const raw = await this.learningXJson(
      `/learningx/api/v1/courses/${course}/attendance_items/${item}`,
      launch.jwt,
      "LearningX attendance item",
    );
    if (!isRecord(raw)) {
      throw new CanvasApiError("invalid_response", "LearningX attendance item had an unexpected shape.");
    }
    return this.normalizeAttendance(raw, course, launch.viewerUrl);
  }

  async listModules(courseId: CanvasId, externalToolId?: CanvasId): Promise<LearningXModule[]> {
    const course = idArgument(courseId, "course_id");
    const launch = await this.launch(course, "modules", externalToolId);
    const raw = await this.learningXJson(
      `/learningx/api/v1/courses/${course}/modules`,
      launch.jwt,
      "LearningX modules",
    );
    return records(raw)
      .map((module) => {
        const moduleId = idValue(module.module_id ?? module.id);
        const rawItems = records(module.module_items ?? module.items);
        return {
          id: moduleId,
          courseId: idValue(module.course_id) || course,
          name: stringValue(module.title) ?? stringValue(module.name) ?? "",
          position: numberValue(module.position ?? module.week_position),
          requiredCount: numberValue(module.required_count),
          completedCount: numberValue(module.completed_count),
          viewerUrl: launch.viewerUrl,
          items: rawItems
            .map((item) => {
              const content = record(item.content_data) ?? item;
              return this.normalizeAttendance(content, course, launch.viewerUrl, item);
            })
            .filter((item) => item.id !== ""),
        } satisfies LearningXModule;
      })
      .filter((module) => module.id !== "");
  }

  private normalizeAttendance(
    raw: JsonRecord,
    courseId: string,
    viewerUrl: string,
    wrapper: JsonRecord = raw,
  ): LearningXAttendanceItem {
    const content = record(raw.item_content_data) ?? {};
    const attendance = record(raw.attendance_data) ?? {};
    return {
      id: idValue(raw.item_id ?? raw.id ?? wrapper.module_item_id ?? wrapper.id),
      courseId: idValue(raw.course_id) || courseId,
      title: stringValue(wrapper.title) ?? stringValue(raw.title) ?? "",
      type:
        stringValue(content.content_type) ??
        stringValue(wrapper.content_type) ??
        stringValue(raw.type),
      attendanceStatus:
        stringValue(attendance.attendance_status) ??
        stringValue(wrapper.attendance_status) ??
        stringValue(raw.attendance_status),
      useAttendance: booleanValue(raw.use_attendance ?? wrapper.use_attendance),
      completed: booleanValue(attendance.completed ?? wrapper.completed ?? raw.completed),
      dueAt: stringValue(raw.due_at ?? wrapper.due_at),
      unlockAt: stringValue(raw.unlock_at ?? wrapper.unlock_at),
      completedAt: stringValue(wrapper.completed_at ?? raw.completed_at),
      progressSeconds: numberValue(attendance.progress),
      lastAtSeconds: numberValue(attendance.last_at),
      required: booleanValue(wrapper.required ?? raw.required),
      durationSeconds: numberValue(content.duration ?? raw.duration),
      progressSupported:
        content.progress_support === undefined && raw.progress_support === undefined
          ? null
          : booleanValue(content.progress_support ?? raw.progress_support),
      viewerUrl,
    };
  }

  private async launch(
    courseId: string,
    feature: LearningXFeature,
    explicitToolId?: CanvasId,
  ): Promise<{ jwt: string; toolId: string; viewerUrl: string }> {
    const toolId = explicitToolId
      ? idArgument(explicitToolId, "external_tool_id")
      : await this.findToolId(courseId, feature);
    const sessionless = await this.canvasJson(
      `/api/v1/courses/${courseId}/external_tools/sessionless_launch?id=${toolId}`,
      "Canvas LearningX launch",
    );
    if (!isRecord(sessionless) || typeof sessionless.url !== "string") {
      throw new CanvasApiError("invalid_response", "Canvas returned an invalid LearningX launch URL.");
    }
    const verifier = this.allowedExternalUrl(sessionless.url, "LearningX verifier");
    const html = (await this.externalText(verifier, undefined, "LearningX verifier")).text;
    const formTag = html.match(/<form\b[^>]*>/i)?.[0];
    if (!formTag) {
      throw new CanvasApiError("invalid_response", "LearningX launch page did not contain a form.");
    }
    const actionValue = htmlAttribute(formTag, "action");
    if (!actionValue) {
      throw new CanvasApiError("invalid_response", "LearningX launch form did not contain an action.");
    }
    const action = this.allowedExternalUrl(new URL(actionValue, verifier).toString(), "LearningX form");
    if (action.origin !== verifier.origin) {
      throw new CanvasApiError(
        "permission_denied",
        "LearningX attempted to send the signed launch form to a different origin.",
      );
    }
    const form = new URLSearchParams();
    const inputTags = [...html.matchAll(/<input\b[^>]*>/gi)].map((match) => match[0]);
    if (inputTags.length < 1 || inputTags.length > MAX_FORM_FIELDS) {
      throw new CanvasApiError("invalid_response", "LearningX launch form had an unsafe field count.");
    }
    for (const input of inputTags) {
      const name = htmlAttribute(input, "name");
      if (!name || name.length > 200) continue;
      form.append(name, htmlAttribute(input, "value") ?? "");
    }
    const body = form.toString();
    if (form.size < 1 || Buffer.byteLength(body) > MAX_FORM_BYTES) {
      throw new CanvasApiError("invalid_response", "LearningX launch form was empty or oversized.");
    }
    const response = await this.externalText(
      action,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        redirect: "manual",
      },
      "LearningX form",
      true,
    );
    void response.text;
    const cookieHeader = response.headers;
    const tokenMatch = cookieHeader.match(/(?:^|[,;]\s*)xn_api_token=([^;,\s]+)/i);
    const tokenValue = tokenMatch?.[1];
    if (!tokenValue) {
      throw new CanvasApiError("authentication_failed", "LearningX did not issue a session token.");
    }
    let jwt = tokenValue;
    try {
      jwt = decodeURIComponent(jwt);
    } catch {
      // Keep the original cookie value when it was not URL encoded.
    }
    if (jwt.length > MAX_JWT_LENGTH || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) {
      throw new CanvasApiError("invalid_response", "LearningX issued a malformed session token.");
    }
    return {
      jwt,
      toolId,
      viewerUrl: `${this.baseUrl}/courses/${courseId}/external_tools/${toolId}`,
    };
  }

  private async findToolId(courseId: string, feature: LearningXFeature): Promise<string> {
    const raw = await this.canvasJson(
      `/api/v1/courses/${courseId}/tabs?include[]=external`,
      "Canvas course tabs",
    );
    const tab = records(raw).find((candidate) => {
      const label = stringValue(candidate.label) ?? "";
      return FEATURE_LABELS[feature].some((pattern) => pattern.test(label));
    });
    const id = tab ? stringValue(tab.id) : null;
    const toolId = id?.match(/^context_external_tool_(\d+)$/)?.[1];
    if (!toolId) {
      throw new CanvasApiError(
        "not_found",
        `No ${feature} LearningX tab was found. Use list_course_tabs to inspect this course.`,
      );
    }
    return toolId;
  }

  private async canvasJson(path: string, operation: string): Promise<unknown> {
    const url = new URL(path, `${this.baseUrl}/`);
    if (url.origin !== this.base.origin || !url.pathname.startsWith("/api/")) {
      throw new CanvasApiError("permission_denied", "Canvas credential routing was rejected.");
    }
    const response = await this.fetchResponse(
      url,
      {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${this.accessToken}` },
        redirect: "error",
      },
      operation,
    );
    return parseJson(response.text, operation);
  }

  private async learningXJson(path: string, jwt: string, operation: string): Promise<unknown> {
    const url = new URL(path, `${this.baseUrl}/`);
    if (url.origin !== this.base.origin || !url.pathname.startsWith("/learningx/api/")) {
      throw new CanvasApiError("permission_denied", "LearningX credential routing was rejected.");
    }
    const response = await this.fetchResponse(
      url,
      {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${jwt}` },
        redirect: "error",
      },
      operation,
    );
    return parseJson(response.text, operation);
  }

  private allowedExternalUrl(value: string, label: string): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch (error) {
      throw new CanvasApiError(
        "invalid_response",
        `${label} URL was invalid.`,
        {},
        error instanceof Error ? { cause: error } : {},
      );
    }
    const host = url.hostname.toLowerCase();
    const allowedHost =
      url.origin === this.base.origin ||
      host === "xinics.com" ||
      host.endsWith(".xinics.com") ||
      host === "hanyang.ac.kr" ||
      host.endsWith(".hanyang.ac.kr");
    if (
      url.protocol !== "https:" ||
      !allowedHost ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new CanvasApiError("permission_denied", `${label} URL was outside the allowlist.`);
    }
    return url;
  }

  private async externalText(
    url: URL,
    init: RequestInit | undefined,
    operation: string,
    includeHeaders = false,
  ): Promise<{ text: string; headers: string }> {
    const response = await this.fetchResponse(
      url,
      init ?? { method: "GET", redirect: "error" },
      operation,
    );
    if (!includeHeaders) return { text: response.text, headers: "" };
    const getSetCookie = (response.response.headers as Headers & {
      getSetCookie?: () => string[];
    }).getSetCookie;
    const headers = getSetCookie
      ? getSetCookie.call(response.response.headers).join(",")
      : response.response.headers.get("set-cookie") ?? "";
    return { text: response.text, headers };
  }

  private async fetchResponse(
    url: URL,
    init: RequestInit,
    operation: string,
  ): Promise<{ response: Response; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof Error && error.name === "AbortError") {
        throw new CanvasApiError("timeout", `${operation} timed out.`, { retryable: true }, { cause: error });
      }
      throw new CanvasApiError(
        "network_error",
        `${operation} failed before a response was received.`,
        { retryable: true },
        error instanceof Error ? { cause: error } : {},
      );
    }
    try {
      const text = await readBoundedText(response, this.maxResponseBytes);
      if (!response.ok && !(init.redirect === "manual" && response.status >= 300 && response.status < 400)) {
        throw statusError(response.status, operation);
      }
      return { response, text };
    } finally {
      clearTimeout(timer);
    }
  }
}
