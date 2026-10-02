import { createHash } from "node:crypto";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

import { INSTITUTIONS, type CanvasConnection } from "../domain.js";
import { sanitizeHtml as sanitizeLearningXHtml, plainText as learningXPlainText } from "../content.js";
import { CanvasApiError } from "../canvas/errors.js";
import type { CanvasId } from "../canvas/types.js";
import type {
  LearningXAttendanceItem,
  LearningXBoard,
  LearningXBoardAttachment,
  LearningXBoardPost,
  LearningXBoardPostPage,
  LearningXBoardPostSummary,
  LearningXFeature,
  LearningXModule,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

export interface LearningXClientOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  sessionCache?: LearningXSessionCache;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_FORM_FIELDS = 100;
const MAX_FORM_BYTES = 256 * 1024;
const MAX_JWT_LENGTH = 16 * 1024;
const SESSION_TTL_MS = 60_000;
const MAX_CACHED_SESSIONS = 64;

interface LearningXSession {
  jwt: string;
  toolId: string;
  viewerUrl: string;
  createdAt: number;
}

/** Short-lived launch reuse only; never caches course data or persists credentials. */
export class LearningXSessionCache {
  private readonly entries = new Map<string, { session: LearningXSession; expiresAt: number }>();

  get(key: string, now: number): LearningXSession | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.session;
  }

  set(key: string, session: LearningXSession, now: number): void {
    for (const [existingKey, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(existingKey);
    }
    let expiresAt = session.createdAt + SESSION_TTL_MS;
    try {
      const claims = JSON.parse(Buffer.from(session.jwt.split(".")[1]!, "base64url").toString("utf8")) as unknown;
      if (isRecord(claims) && typeof claims.exp === "number" && Number.isFinite(claims.exp)) {
        expiresAt = Math.min(expiresAt, claims.exp * 1_000 - 5_000);
      }
    } catch {
      // Opaque/legacy session tokens still have the short local lifetime.
    }
    if (expiresAt <= now) return;
    this.entries.delete(key);
    while (this.entries.size >= MAX_CACHED_SESSIONS) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, { session, expiresAt });
  }

  invalidate(identity: string, jwt: string): void {
    for (const [key, entry] of this.entries) {
      if (key.startsWith(`${identity}:`) && entry.session.jwt === jwt) this.entries.delete(key);
    }
  }
}

const FEATURE_LABELS: Record<LearningXFeature, readonly RegExp[]> = {
  attendance: [
    /attendance/i,
    /출결/u,
    /출석/u,
    /학습\s*현황/u,
  ],
  modules: [
    /learning\s*x/i,
    /weekly\s*learning/i,
    /course\s*contents?/i,
    /modules?/i,
    /강의\s*콘텐츠/u,
    /온라인\s*강의/u,
    /주차\s*학습/u,
  ],
  board: [
    /board/i,
    /게시판/u,
    /公告板|讨论区|留言板/u,
  ],
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecords(value: unknown, operation: string): JsonRecord[] {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new CanvasApiError("invalid_response", `${operation} returned an unexpected list shape.`);
  }
  return value as JsonRecord[];
}

function optionalRecords(value: unknown, operation: string): JsonRecord[] {
  return value === undefined || value === null ? [] : requireRecords(value, operation);
}

function requiredResponseId(value: unknown, operation: string): string {
  const id = idValue(value);
  if (!/^[1-9]\d*$/.test(id)) {
    throw new CanvasApiError("invalid_response", `${operation} returned an invalid item identifier.`);
  }
  return id;
}

function scopedResponseId(value: unknown, expected: string, operation: string): string {
  if (value === undefined || value === null) return expected;
  const id = requiredResponseId(value, operation);
  if (id !== expected) {
    throw new CanvasApiError("invalid_response", `${operation} returned an item outside the requested scope.`);
  }
  return id;
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

function nullableBooleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
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

function pageArgument(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new CanvasApiError("invalid_argument", "page must be an integer between 1 and 1000.");
  }
  return value;
}

function keywordArgument(value: string): string {
  const keyword = value.trim();
  if (keyword.length > 200) {
    throw new CanvasApiError("invalid_argument", "keyword must be at most 200 characters.");
  }
  return keyword;
}

function normalizeBoardAttachment(raw: JsonRecord): LearningXBoardAttachment {
  return {
    id: requiredResponseId(raw.id, "LearningX attachment"),
    filename: stringValue(raw.filename) ?? stringValue(raw.display_name) ?? "",
    size: numberValue(raw.filesize ?? raw.size),
    canvasFileId:
      raw.canvas_file_id === undefined || raw.canvas_file_id === null
        ? null
        : idValue(raw.canvas_file_id),
  };
}

type HtmlNode = DefaultTreeAdapterMap["node"];

function findHtmlNodes(node: HtmlNode, name: string): HtmlNode[] {
  const found: HtmlNode[] = [];
  const pending = [node];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.nodeName === name) found.push(current);
    if ("childNodes" in current) pending.push(...current.childNodes.slice().reverse());
  }
  return found;
}

function htmlAttribute(node: HtmlNode, name: string): string | null {
  return "attrs" in node ? node.attrs.find((attribute) => attribute.name === name)?.value ?? null : null;
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
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new CanvasApiError("invalid_response", "LearningX returned an oversized response.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
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
  private readonly sessionCache: LearningXSessionCache;
  private readonly cacheIdentity: string;
  private readonly now: () => number;

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
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000 ||
        !Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1 || this.maxResponseBytes > 32 * 1024 * 1024) {
      throw new CanvasApiError("configuration_error", "LearningX request limits are invalid.");
    }
    this.sessionCache = options.sessionCache ?? new LearningXSessionCache();
    this.cacheIdentity = createHash("sha256").update(JSON.stringify([
      connection.userId, connection.canvasUserId, actual.origin, connection.accessToken,
    ])).digest("hex");
    this.now = options.now ?? Date.now;
  }

  async listAttendance(
    courseId: CanvasId,
    externalToolId?: CanvasId,
  ): Promise<LearningXAttendanceItem[]> {
    const course = idArgument(courseId, "course_id");
    const launch = await this.launch(course, "attendance", externalToolId);
    const [rawItems, rawSummary] = await Promise.all([
      this.learningXJson(
        `/learningx/api/v1/courses/${course}/attendance_items?include_detail=true`,
        launch.jwt,
        "LearningX attendance items",
      ),
      this.learningXJson(
        `/learningx/api/v1/courses/${course}/attendance_items/summary?only_use_attendance=true`,
        launch.jwt,
        "LearningX attendance summary",
      ),
    ]);
    if (!isRecord(rawItems) || !isRecord(rawSummary) || !isRecord(rawSummary.attendance_summaries)) {
      throw new CanvasApiError("invalid_response", "LearningX attendance returned an unexpected response shape.");
    }
    const summaries = rawSummary.attendance_summaries;
    for (const [key, summary] of Object.entries(summaries)) {
      const itemId = requiredResponseId(key, "LearningX attendance summary");
      if (!isRecord(summary)) {
        throw new CanvasApiError("invalid_response", "LearningX attendance summary returned an unexpected item shape.");
      }
      scopedResponseId(summary.item_id, itemId, "LearningX attendance summary");
      scopedResponseId(summary.course_id, course, "LearningX attendance summary");
    }
    return requireRecords(rawItems.attendance_items, "LearningX attendance items")
      .map((item) => {
        const normalized = this.normalizeAttendance(item, course, launch.viewerUrl);
        if (normalized.useAttendance === null) {
          throw new CanvasApiError("invalid_response", "LearningX attendance item did not provide a valid attendance inclusion flag.");
        }
        const summary = record(summaries[normalized.id]);
        return { ...normalized, attendanceStatus: stringValue(summary?.attendance_status) };
      })
      .filter((item) => item.useAttendance === true);
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
    const result = this.normalizeAttendance(raw, course, launch.viewerUrl);
    if (result.id !== item || result.courseId !== course) {
      throw new CanvasApiError("invalid_response", "LearningX returned a different attendance item.");
    }
    return result;
  }

  async listModules(courseId: CanvasId, externalToolId?: CanvasId): Promise<LearningXModule[]> {
    const course = idArgument(courseId, "course_id");
    const launch = await this.launch(course, "modules", externalToolId);
    const raw = await this.learningXJson(
      `/learningx/api/v1/courses/${course}/modules`,
      launch.jwt,
      "LearningX modules",
    );
    return requireRecords(raw, "LearningX modules")
      .map((module) => {
        const moduleId = requiredResponseId(module.module_id ?? module.id, "LearningX module");
        const rawItems = requireRecords(module.module_items ?? module.items, "LearningX module items");
        return {
          id: moduleId,
          courseId: scopedResponseId(module.course_id, course, "LearningX module"),
          name: stringValue(module.title) ?? stringValue(module.name) ?? "",
          position: numberValue(module.position ?? module.week_position),
          requiredCount: numberValue(module.required_count),
          completedCount: numberValue(module.completed_count),
          viewerUrl: launch.viewerUrl,
          items: rawItems
            .map((item) => {
              const content = record(item.content_data) ?? item;
              return this.normalizeAttendance(content, course, launch.viewerUrl, item);
            }),
        } satisfies LearningXModule;
      });
  }

  async listBoards(courseId: CanvasId, externalToolId?: CanvasId): Promise<LearningXBoard[]> {
    const course = idArgument(courseId, "course_id");
    const launch = await this.launch(course, "board", externalToolId);
    const raw = await this.learningXJson(
      `/learningx/api/v1/learningx_board/courses/${course}/boards`,
      launch.jwt,
      "LearningX boards",
    );
    return requireRecords(raw, "LearningX boards")
      .map((board) => this.normalizeBoard(board, course));
  }

  async listBoardPosts(
    courseId: CanvasId,
    boardId: CanvasId,
    options: { page?: number; keyword?: string } = {},
    externalToolId?: CanvasId,
  ): Promise<LearningXBoardPostPage> {
    const course = idArgument(courseId, "course_id");
    const board = idArgument(boardId, "board_id");
    const page = pageArgument(options.page ?? 1);
    const keyword = keywordArgument(options.keyword ?? "");
    const launch = await this.launch(course, "board", externalToolId);
    const query = new URLSearchParams({
      page: String(page),
      filter: "title",
      keyword,
    });
    const raw = await this.learningXJson(
      `/learningx/api/v1/learningx_board/courses/${course}/boards/${board}/posts?${query.toString()}`,
      launch.jwt,
      "LearningX board posts",
    );
    if (!isRecord(raw)) {
      throw new CanvasApiError("invalid_response", "LearningX board posts had an unexpected shape.");
    }
    if (raw.pagination !== undefined && !isRecord(raw.pagination)) {
      throw new CanvasApiError("invalid_response", "LearningX board pagination had an unexpected shape.");
    }
    const pagination = record(raw.pagination) ?? {};
    const items = requireRecords(raw.items, "LearningX board posts");
    return {
      page: numberValue(pagination.current_page ?? pagination.page) ?? page,
      perPage: numberValue(pagination.per_page ?? pagination.page_size),
      totalCount: numberValue(pagination.total_count ?? pagination.total),
      totalPages: numberValue(pagination.total_pages ?? pagination.last_page),
      posts: items.map((post) => this.normalizeBoardPostSummary(post, course, board)),
    };
  }

  async getBoardPost(
    courseId: CanvasId,
    boardId: CanvasId,
    postId: CanvasId,
    externalToolId?: CanvasId,
  ): Promise<LearningXBoardPost> {
    const course = idArgument(courseId, "course_id");
    const board = idArgument(boardId, "board_id");
    const post = idArgument(postId, "post_id");
    const launch = await this.launch(course, "board", externalToolId);
    const rawResponse = await this.learningXJson(
      `/learningx/api/v1/learningx_board/courses/${course}/boards/${board}/posts/${post}`,
      launch.jwt,
      "LearningX board post",
    );
    if (!isRecord(rawResponse)) {
      throw new CanvasApiError("invalid_response", "LearningX board post had an unexpected shape.");
    }
    const raw = record(rawResponse.post) ?? rawResponse;
    const summary = this.normalizeBoardPostSummary(raw, course, board);
    if (summary.id !== post || summary.courseId !== course || summary.boardId !== board) {
      throw new CanvasApiError("invalid_response", "LearningX returned a different board post.");
    }
    const contentHtml = sanitizeLearningXHtml(raw.content);
    return {
      ...summary,
      contentHtml,
      contentText: learningXPlainText(contentHtml),
      updatedAt: stringValue(raw.updated_at),
      attachments: optionalRecords(raw.attachments, "LearningX attachments").map(normalizeBoardAttachment),
      comments: optionalRecords(raw.comments, "LearningX comments")
        .filter((comment) => !booleanValue(comment.is_deleted))
        .map((comment) => {
          const commentHtml = sanitizeLearningXHtml(comment.content);
          return {
            id: requiredResponseId(comment.id, "LearningX comment"),
            userName: stringValue(comment.user_name),
            contentHtml: commentHtml,
            contentText: learningXPlainText(commentHtml),
            createdAt: stringValue(comment.created_at),
            secret: booleanValue(comment.is_secret),
            attachments: optionalRecords(comment.attachments, "LearningX comment attachments").map(normalizeBoardAttachment),
          };
        }),
    };
  }

  private normalizeBoard(raw: JsonRecord, courseId: string): LearningXBoard {
    const descriptionHtml = sanitizeLearningXHtml(raw.description);
    return {
      id: requiredResponseId(raw.id, "LearningX board"),
      courseId: scopedResponseId(raw.course_id, courseId, "LearningX board"),
      title: stringValue(raw.title) ?? "",
      descriptionHtml,
      descriptionText: learningXPlainText(descriptionHtml),
      type: stringValue(raw.type ?? raw.board_type),
      slug: stringValue(raw.slug),
      position: numberValue(raw.position),
      totalPostCount: numberValue(raw.total_post_count ?? raw.post_count) ?? 0,
      totalCommentCount: numberValue(raw.total_comment_count) ?? 0,
      unreadPostCount: numberValue(raw.unread_post_count) ?? 0,
      latestPostCreatedAt: stringValue(raw.latest_post_created_at ?? raw.last_post_at),
      useAttachment: booleanValue(raw.use_attachment),
      useComment: booleanValue(raw.use_comment),
      useNotice: booleanValue(raw.use_notice),
      useReply: booleanValue(raw.use_reply),
    };
  }

  private normalizeBoardPostSummary(
    raw: JsonRecord,
    courseId: string,
    boardId: string,
  ): LearningXBoardPostSummary {
    return {
      id: requiredResponseId(raw.id, "LearningX board post"),
      courseId: scopedResponseId(raw.course_id, courseId, "LearningX board post"),
      boardId: scopedResponseId(raw.board_id, boardId, "LearningX board post"),
      index: numberValue(raw.idx ?? raw.index),
      title: stringValue(raw.title) ?? "",
      userName: stringValue(raw.user_name),
      attachmentCount: numberValue(raw.attachment_count) ?? optionalRecords(raw.attachments, "LearningX attachments").length,
      commentCount: numberValue(raw.comment_count) ?? optionalRecords(raw.comments, "LearningX comments").length,
      viewCount: numberValue(raw.view_count) ?? 0,
      notice: booleanValue(raw.is_notice),
      createdAt: stringValue(raw.created_at),
    };
  }

  private normalizeAttendance(
    raw: JsonRecord,
    courseId: string,
    viewerUrl: string,
    wrapper: JsonRecord = raw,
  ): LearningXAttendanceItem {
    const content = record(raw.item_content_data) ?? {};
    const attendance = record(raw.attendance_data) ?? {};
    const type = stringValue(content.content_type) ?? stringValue(raw.item_content_type) ?? stringValue(wrapper.content_type) ?? stringValue(raw.type);
    const transliveId = String(content.translive_id ?? "");
    return {
      id: requiredResponseId(raw.item_id ?? raw.id ?? wrapper.module_item_id ?? wrapper.id, "LearningX attendance item"),
      courseId: scopedResponseId(raw.course_id, courseId, "LearningX attendance item"),
      title: stringValue(wrapper.title) ?? stringValue(raw.title) ?? "",
      type,
      moduleItemId: wrapper.module_item_id == null ? null : requiredResponseId(wrapper.module_item_id, "Canvas module item"),
      translive: type === "translive" && /^\d{1,20}$/.test(transliveId)
        ? { id: transliveId, viewerUrl: `https://learning.hanyang.ac.kr/translive/v/${transliveId}` } : null,
      attendanceStatus:
        stringValue(attendance.attendance_status) ??
        stringValue(wrapper.attendance_status) ??
        stringValue(raw.attendance_status),
      useAttendance: nullableBooleanValue(raw.use_attendance ?? wrapper.use_attendance),
      completed: nullableBooleanValue(attendance.completed ?? wrapper.completed ?? raw.completed),
      dueAt: stringValue(raw.due_at ?? wrapper.due_at),
      unlockAt: stringValue(raw.unlock_at ?? wrapper.unlock_at),
      completedAt: stringValue(wrapper.completed_at ?? raw.completed_at),
      progressSeconds: numberValue(attendance.progress),
      lastAtSeconds: numberValue(attendance.last_at),
      required: nullableBooleanValue(wrapper.required ?? raw.required),
      durationSeconds: type === "translive" ? null : numberValue(content.duration ?? raw.duration),
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
  ): Promise<LearningXSession> {
    const prefix = `${this.cacheIdentity}:${courseId}:`;
    const selector = explicitToolId
      ? `tool:${idArgument(explicitToolId, "external_tool_id")}`
      : `feature:${feature}`;
    const cached = this.sessionCache.get(prefix + selector, this.now());
    if (cached) return cached;
    const toolId = explicitToolId
      ? idArgument(explicitToolId, "external_tool_id")
      : await this.findToolId(courseId, feature);
    const toolKey = `${prefix}tool:${toolId}`;
    const cachedTool = this.sessionCache.get(toolKey, this.now());
    if (cachedTool) {
      this.sessionCache.set(prefix + selector, cachedTool, this.now());
      return cachedTool;
    }
    const sessionless = await this.canvasJson(
      `/api/v1/courses/${courseId}/external_tools/sessionless_launch?id=${toolId}`,
      "Canvas LearningX launch",
    );
    if (!isRecord(sessionless) || typeof sessionless.url !== "string") {
      throw new CanvasApiError("invalid_response", "Canvas returned an invalid LearningX launch URL.");
    }
    const verifier = this.allowedExternalUrl(sessionless.url, "LearningX verifier");
    const html = (await this.externalText(verifier, undefined, "LearningX verifier")).text;
    const forms = findHtmlNodes(parseFragment(html), "form");
    if (forms.length !== 1) {
      throw new CanvasApiError("invalid_response", "LearningX launch page must contain one form.");
    }
    const launchForm = forms[0]!;
    const actionValue = htmlAttribute(launchForm, "action");
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
    const inputTags = findHtmlNodes(launchForm, "input");
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
    const session = {
      jwt,
      toolId,
      viewerUrl: `${this.baseUrl}/courses/${courseId}/external_tools/${toolId}`,
      createdAt: this.now(),
    };
    this.sessionCache.set(toolKey, session, this.now());
    if (prefix + selector !== toolKey) this.sessionCache.set(prefix + selector, session, this.now());
    return session;
  }

  private async findToolId(courseId: string, feature: LearningXFeature): Promise<string> {
    const raw = await this.canvasJson(
      `/api/v1/courses/${courseId}/tabs?include[]=external`,
      "Canvas course tabs",
    );
    const candidates = requireRecords(raw, "Canvas course tabs").filter((candidate) => {
      if (candidate.hidden === true || !/^context_external_tool_[1-9]\d*$/.test(stringValue(candidate.id) ?? "")) {
        return false;
      }
      const label = stringValue(candidate.label) ?? "";
      return FEATURE_LABELS[feature].some((pattern) => pattern.test(label));
    });
    if (candidates.length > 1) {
      const ids = candidates.map((candidate) => String(candidate.id).replace("context_external_tool_", ""));
      throw new CanvasApiError(
        "invalid_argument",
        `Multiple ${feature} LearningX tabs match (tool IDs: ${ids.join(", ")}). Use list_course_tabs and pass the exact external_tool_id.`,
      );
    }
    const tab = candidates[0];
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
    try {
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
    } catch (error) {
      if (error instanceof CanvasApiError && error.status === 401) this.sessionCache.invalidate(this.cacheIdentity, jwt);
      throw error;
    }
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
    } catch (error) {
      if (!(error instanceof CanvasApiError) && controller.signal.aborted) {
        throw new CanvasApiError("timeout", `${operation} timed out.`, { retryable: true });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
