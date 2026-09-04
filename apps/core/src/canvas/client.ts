import { INSTITUTIONS, type CanvasConnection, type InstitutionKey } from "../domain.js";
import { CanvasApiError } from "./errors.js";
import type {
  CanvasAnnouncement,
  CanvasAssignment,
  CanvasCalendarEvent,
  CanvasConnectionStatus,
  CanvasConversation,
  CanvasConversationMessage,
  CanvasConversationSummary,
  CanvasCourse,
  CanvasCourseSubmission,
  CanvasCourseTab,
  CanvasDiscussionEntry,
  CanvasDiscussionTopic,
  CanvasFile,
  CanvasGrade,
  CanvasId,
  CanvasModule,
  CanvasModuleItem,
  CanvasPage,
  CanvasPageSummary,
  CanvasQuiz,
  CanvasSubmission,
  CanvasUpcomingWorkItem,
  CanvasWeeklySummary,
  GradeOptions,
  ListAnnouncementsOptions,
  ListAssignmentsOptions,
  ListCalendarEventsOptions,
  ListConversationsOptions,
  ListCourseSubmissionsOptions,
  ListCoursesOptions,
  ListDiscussionTopicsOptions,
  ListFilesOptions,
  ListModulesOptions,
  NormalizedSubmissionStatus,
  UpcomingWorkOptions,
  WeeklySummaryOptions,
} from "./types.js";

type JsonRecord = Record<string, unknown>;
type QueryValue = string | number | boolean | null | undefined;
type Query = Record<string, QueryValue | QueryValue[]>;

export interface CanvasRestClientOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxPages?: number;
  maxResponseBytes?: number;
  now?: () => Date;
}

interface JsonPage {
  data: unknown;
  linkHeader: string | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_LIST_LIMIT = 500;
const MAX_LIST_LIMIT = 2_000;
const MAX_HTML_LENGTH = 50_000;
const MAX_TEXT_LENGTH = 30_000;

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new CanvasApiError(
      "invalid_response",
      "Canvas returned a response larger than the configured safety limit.",
      { status: response.status },
    );
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new CanvasApiError(
          "invalid_response",
          "Canvas returned a response larger than the configured safety limit.",
          { status: response.status },
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

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

/**
 * Canvas rich text is untrusted course-authored data. Keep useful formatting,
 * but remove active content and cap its size before it reaches an MCP model.
 */
function sanitizeCanvasHtml(value: unknown): string | null {
  const input = stringValue(value);
  if (input === null) return null;
  return input
    .slice(0, MAX_HTML_LENGTH)
    .replace(/<(script|style|iframe|object|embed|form|meta|base)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|iframe|object|embed|form|meta|base)\b[^>]*\/?\s*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(style|srcdoc)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(
      /\s+(href|src|xlink:href|action|formaction)\s*=\s*(["'])\s*(?:javascript|data):[\s\S]*?\2/gi,
      "",
    )
    .replace(
      /\s+(href|src|xlink:href|action|formaction)\s*=\s*(?:javascript|data):[^\s>]*/gi,
      "",
    )
    .slice(0, MAX_HTML_LENGTH);
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const codePoint = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    }
    if (body.startsWith("#")) {
      const codePoint = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    }
    return named[body.toLowerCase()] ?? entity;
  });
}

function canvasPlainText(html: string | null): string | null {
  if (html === null) return null;
  const text = decodeHtmlEntities(
    html
      .replace(/<(br|\/p|\/div|\/li|\/tr|h[1-6])\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.slice(0, MAX_TEXT_LENGTH);
}

function idValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return "";
}

function idArgument(value: CanvasId, name: string): string {
  const id = String(value);
  if (!/^[1-9]\d*$/.test(id)) {
    throw new CanvasApiError("invalid_argument", `${name} must be a positive Canvas id.`);
  }
  return id;
}

function pageUrlArgument(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 512 || /[\\/?#]/.test(normalized)) {
    throw new CanvasApiError(
      "invalid_argument",
      "page_url must be a non-empty Canvas page identifier without path separators.",
    );
  }
  return encodeURIComponent(normalized);
}

function boundedLimit(limit: number | undefined): number {
  const resolved = limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_LIST_LIMIT) {
    throw new CanvasApiError(
      "invalid_argument",
      `limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`,
    );
  }
  return resolved;
}

function parseDate(value: string | undefined, name: string, fallback: Date): Date {
  if (value === undefined) {
    return fallback;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new CanvasApiError("invalid_argument", `${name} must be a valid ISO-8601 date-time.`);
  }
  return parsed;
}

function resolveWindow(
  startAt: string | undefined,
  endAt: string | undefined,
  now: Date,
): { startAt: string; endAt: string } {
  const start = parseDate(startAt, "start_at", now);
  const defaultEnd = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1_000);
  const end = parseDate(endAt, "end_at", defaultEnd);
  if (end.getTime() <= start.getTime()) {
    throw new CanvasApiError("invalid_argument", "end_at must be later than start_at.");
  }
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

function normalizeBaseUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new CanvasApiError(
      "configuration_error",
      `${label} is not a valid URL.`,
      {},
      error instanceof Error ? { cause: error } : {},
    );
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new CanvasApiError(
      "configuration_error",
      `${label} must be a credential-free HTTPS origin.`,
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (url.pathname !== "/") {
    throw new CanvasApiError("configuration_error", `${label} must not contain a path.`);
  }
  return url;
}

function canvasErrorMessage(body: unknown, fallback: string): string {
  const clean = (value: string): string =>
    value
      .replace(/<[^>]*>/g, " ")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 500);
  if (isRecord(body)) {
    const direct = stringValue(body.message) ?? stringValue(body.error) ?? stringValue(body.status);
    if (direct) {
      return clean(direct) || fallback;
    }
    if (Array.isArray(body.errors)) {
      const messages = body.errors
        .map((item) => (isRecord(item) ? stringValue(item.message) : stringValue(item)))
        .filter((item): item is string => item !== null);
      if (messages.length > 0) {
        return clean(messages.join("; ")) || fallback;
      }
    }
  }
  return fallback;
}

function errorCodeForStatus(status: number): {
  code:
    | "authentication_failed"
    | "permission_denied"
    | "not_found"
    | "rate_limited"
    | "canvas_error"
    | "upstream_error";
  retryable: boolean;
} {
  if (status === 401) return { code: "authentication_failed", retryable: false };
  if (status === 403) return { code: "permission_denied", retryable: false };
  if (status === 404) return { code: "not_found", retryable: false };
  if (status === 408 || status === 429) return { code: "rate_limited", retryable: true };
  if (status >= 500) return { code: "upstream_error", retryable: true };
  return { code: "canvas_error", retryable: false };
}

function retryAfterSeconds(value: string | null, now: Date): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 1_000));
}

function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const pattern = /<([^>]+)>\s*;\s*rel="([^"]+)"/g;
  for (const match of linkHeader.matchAll(pattern)) {
    const relations = (match[2] ?? "").split(/\s+/);
    if (relations.includes("next")) {
      return match[1] ?? null;
    }
  }
  return null;
}

function courseIdFromContext(value: unknown): string | null {
  const context = stringValue(value);
  return context?.match(/^course_(\d+)$/)?.[1] ?? null;
}

function submissionStatus(raw: JsonRecord): NormalizedSubmissionStatus {
  if (booleanValue(raw.excused)) return "excused";
  if (booleanValue(raw.missing)) return "missing";
  const state = stringValue(raw.workflow_state);
  if (state === "graded") return "graded";
  if (stringValue(raw.submitted_at) || state === "submitted" || state === "pending_review") {
    return "submitted";
  }
  return "unsubmitted";
}

function normalizeAttachment(raw: JsonRecord) {
  return {
    id: idValue(raw.id),
    filename: stringValue(raw.filename) ?? stringValue(raw.display_name) ?? "",
    displayName: stringValue(raw.display_name),
    contentType: stringValue(raw["content-type"]) ?? stringValue(raw.content_type),
    size: numberValue(raw.size) ?? numberValue(raw.filesize),
  };
}

function normalizeSubmission(
  raw: JsonRecord,
  courseId: string,
  assignmentId: string,
  includeHistory = true,
): CanvasSubmission {
  const attachments = records(raw.attachments).map(normalizeAttachment);
  const history = includeHistory
    ? records(raw.submission_history).map((item) =>
        normalizeSubmission(item, courseId, assignmentId, false),
      )
    : [];

  return {
    id: raw.id === null || raw.id === undefined ? null : idValue(raw.id),
    assignmentId,
    courseId,
    status: submissionStatus(raw),
    workflowState: stringValue(raw.workflow_state),
    submittedAt: stringValue(raw.submitted_at),
    gradedAt: stringValue(raw.graded_at),
    score: numberValue(raw.score),
    grade: stringValue(raw.grade),
    attempt: numberValue(raw.attempt),
    late: booleanValue(raw.late),
    missing: booleanValue(raw.missing),
    excused: booleanValue(raw.excused),
    secondsLate: numberValue(raw.seconds_late) ?? 0,
    submissionType: stringValue(raw.submission_type),
    attachments,
    history,
  };
}

function normalizeConversationSummary(raw: JsonRecord): CanvasConversationSummary {
  const lastMessageHtml = sanitizeCanvasHtml(raw.last_message);
  return {
    id: idValue(raw.id),
    subject: stringValue(raw.subject) ?? "",
    workflowState: stringValue(raw.workflow_state),
    lastMessage: canvasPlainText(lastMessageHtml),
    lastMessageAt: stringValue(raw.last_message_at) ?? stringValue(raw.start_at),
    messageCount: numberValue(raw.message_count) ?? 0,
    subscribed: booleanValue(raw.subscribed),
    private: booleanValue(raw.private),
    starred: booleanValue(raw.starred),
    contextCode: stringValue(raw.context_code),
    contextName: stringValue(raw.context_name),
    participants: records(raw.participants).map((participant) => ({
      id: idValue(participant.id),
      name: stringValue(participant.name) ?? stringValue(participant.full_name) ?? "",
      fullName: stringValue(participant.full_name),
    })),
  };
}

function normalizeConversationMessage(raw: JsonRecord, depth = 0): CanvasConversationMessage {
  const bodyHtml = sanitizeCanvasHtml(raw.body);
  const forwarded = depth >= 3 ? [] : records(raw.forwarded_messages);
  return {
    id: idValue(raw.id),
    createdAt: stringValue(raw.created_at),
    authorId:
      raw.author_id === undefined || raw.author_id === null ? null : idValue(raw.author_id),
    generated: booleanValue(raw.generated),
    bodyHtml,
    bodyText: canvasPlainText(bodyHtml),
    attachments: records(raw.attachments).map(normalizeAttachment),
    forwardedMessages: forwarded.map((message) => normalizeConversationMessage(message, depth + 1)),
  };
}

function normalizeEnrollment(raw: JsonRecord): CanvasCourse["enrollment"] {
  const grades = record(raw.grades) ?? {};
  return {
    id: idValue(raw.id),
    type: stringValue(raw.type),
    role: stringValue(raw.role),
    state: stringValue(raw.enrollment_state),
    currentScore: numberValue(grades.current_score),
    currentGrade: stringValue(grades.current_grade),
    finalScore: numberValue(grades.final_score),
    finalGrade: stringValue(grades.final_grade),
  };
}

/** A GET-only Canvas REST client with a fixed institutional origin. */
export class CanvasRestClient {
  readonly institution: InstitutionKey;
  readonly baseUrl: string;

  private readonly accessToken: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxPages: number;
  private readonly maxResponseBytes: number;
  private readonly now: () => Date;
  private readonly base: URL;

  constructor(connection: CanvasConnection, options: CanvasRestClientOptions = {}) {
    if (!Object.prototype.hasOwnProperty.call(INSTITUTIONS, connection.institution)) {
      throw new CanvasApiError("configuration_error", "Unknown Canvas institution.");
    }
    const institution = INSTITUTIONS[connection.institution];
    const canonical = normalizeBaseUrl(institution.baseUrl, "Institution base URL");
    const supplied = normalizeBaseUrl(connection.baseUrl, "Connection base URL");
    if (supplied.href !== canonical.href) {
      throw new CanvasApiError(
        "configuration_error",
        "Connection base URL does not match the configured institution allowlist.",
      );
    }
    if (
      !connection.accessToken ||
      connection.accessToken.trim() !== connection.accessToken ||
      /[\u0000-\u001f\u007f]/.test(connection.accessToken) ||
      connection.accessToken.length > 4_096
    ) {
      throw new CanvasApiError("configuration_error", "Canvas access token is missing or malformed.");
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
      throw new CanvasApiError(
        "configuration_error",
        "Canvas timeout must be an integer between 100 and 60000 milliseconds.",
      );
    }
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200) {
      throw new CanvasApiError(
        "configuration_error",
        "Canvas maxPages must be an integer between 1 and 200.",
      );
    }
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (
      !Number.isInteger(maxResponseBytes) ||
      maxResponseBytes < 64 ||
      maxResponseBytes > MAX_RESPONSE_BYTES
    ) {
      throw new CanvasApiError(
        "configuration_error",
        `Canvas maxResponseBytes must be an integer between 64 and ${MAX_RESPONSE_BYTES}.`,
      );
    }

    this.institution = connection.institution;
    this.base = canonical;
    this.baseUrl = canonical.origin + (canonical.pathname === "/" ? "" : canonical.pathname);
    this.accessToken = connection.accessToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = timeoutMs;
    this.maxPages = maxPages;
    this.maxResponseBytes = maxResponseBytes;
    this.now = options.now ?? (() => new Date());
  }

  async connectionStatus(): Promise<CanvasConnectionStatus> {
    const raw = await this.getRecord("/api/v1/users/self/profile");
    const institution = INSTITUTIONS[this.institution];
    return {
      connected: true,
      institution: this.institution,
      institutionName: institution.displayName,
      baseUrl: this.baseUrl,
      profile: {
        id: idValue(raw.id),
        name: stringValue(raw.name) ?? "",
        sortableName: stringValue(raw.sortable_name),
        loginId: stringValue(raw.login_id),
        primaryEmail: stringValue(raw.primary_email),
        avatarUrl: stringValue(raw.avatar_url),
      },
    };
  }

  async listCourses(options: ListCoursesOptions = {}): Promise<CanvasCourse[]> {
    const query: Query = {
      "include[]": [
        "term",
        "teachers",
        "course_image",
        "total_scores",
        "current_grading_period_scores",
      ],
      enrollment_state: options.enrollmentState ?? "active",
      "state[]": ["available", "completed"],
    };
    const rows = await this.getAllRecords("/api/v1/courses", query, options.limit);
    return rows.map((row) => this.normalizeCourse(row));
  }

  async getCourse(courseId: CanvasId): Promise<CanvasCourse> {
    const id = idArgument(courseId, "course_id");
    const raw = await this.getRecord(`/api/v1/courses/${id}`, {
      "include[]": [
        "term",
        "teachers",
        "course_image",
        "syllabus_body",
        "total_scores",
        "current_grading_period_scores",
      ],
    });
    return this.normalizeCourse(raw);
  }

  async listAssignments(
    courseId: CanvasId,
    options: ListAssignmentsOptions = {},
  ): Promise<CanvasAssignment[]> {
    const id = idArgument(courseId, "course_id");
    const query: Query = { order_by: "due_at" };
    if (options.bucket) query.bucket = options.bucket;
    if (options.includeSubmission !== false) query["include[]"] = ["submission"];
    const rows = await this.getAllRecords(
      `/api/v1/courses/${id}/assignments`,
      query,
      options.limit,
    );
    return rows.map((row) => this.normalizeAssignment(row, id));
  }

  async getAssignment(courseId: CanvasId, assignmentId: CanvasId): Promise<CanvasAssignment> {
    const course = idArgument(courseId, "course_id");
    const assignment = idArgument(assignmentId, "assignment_id");
    const raw = await this.getRecord(
      `/api/v1/courses/${course}/assignments/${assignment}`,
      { "include[]": ["submission"] },
    );
    return this.normalizeAssignment(raw, course);
  }

  async listAnnouncements(
    courseId: CanvasId,
    options: ListAnnouncementsOptions = {},
  ): Promise<CanvasAnnouncement[]> {
    const id = idArgument(courseId, "course_id");
    return this.listAnnouncementsForCourses([id], options);
  }

  async listModules(courseId: CanvasId, options: ListModulesOptions = {}): Promise<CanvasModule[]> {
    const id = idArgument(courseId, "course_id");
    const query: Query = {};
    if (options.includeItems !== false) query["include[]"] = ["items", "content_details"];
    const rows = await this.getAllRecords(`/api/v1/courses/${id}/modules`, query, options.limit);
    return rows.map((row) => this.normalizeModule(row));
  }

  async listCourseTabs(courseId: CanvasId, limit?: number): Promise<CanvasCourseTab[]> {
    const id = idArgument(courseId, "course_id");
    const rows = await this.getAllRecords(
      `/api/v1/courses/${id}/tabs`,
      { "include[]": ["external"] },
      limit,
    );
    return rows.map((row) => this.normalizeCourseTab(row));
  }

  async listQuizzes(courseId: CanvasId, limit?: number): Promise<CanvasQuiz[]> {
    const id = idArgument(courseId, "course_id");
    const rows = await this.getAllRecords(`/api/v1/courses/${id}/quizzes`, {}, limit);
    return rows.map((row) => this.normalizeQuiz(row, id));
  }

  async listDiscussionTopics(
    courseId: CanvasId,
    options: ListDiscussionTopicsOptions = {},
  ): Promise<CanvasDiscussionTopic[]> {
    const id = idArgument(courseId, "course_id");
    const rows = await this.getAllRecords(
      `/api/v1/courses/${id}/discussion_topics`,
      {
        order_by: options.orderBy ?? "recent_activity",
        only_announcements: options.onlyAnnouncements ?? false,
      },
      options.limit,
    );
    return rows.map((row) => this.normalizeDiscussionTopic(row, id));
  }

  async listDiscussionEntries(
    courseId: CanvasId,
    topicId: CanvasId,
    limit?: number,
  ): Promise<CanvasDiscussionEntry[]> {
    const course = idArgument(courseId, "course_id");
    const topic = idArgument(topicId, "topic_id");
    const rows = await this.getAllRecords(
      `/api/v1/courses/${course}/discussion_topics/${topic}/entries`,
      {},
      limit,
    );
    return rows.map((row) => this.normalizeDiscussionEntry(row, topic));
  }

  async listPages(courseId: CanvasId, limit?: number): Promise<CanvasPageSummary[]> {
    const id = idArgument(courseId, "course_id");
    const rows = await this.getAllRecords(`/api/v1/courses/${id}/pages`, {}, limit);
    return rows.map((row) => this.normalizePageSummary(row));
  }

  async getPage(courseId: CanvasId, pageUrl: string): Promise<CanvasPage> {
    const course = idArgument(courseId, "course_id");
    const page = pageUrlArgument(pageUrl);
    const raw = await this.getRecord(`/api/v1/courses/${course}/pages/${page}`);
    const summary = this.normalizePageSummary(raw);
    const bodyHtml = sanitizeCanvasHtml(raw.body);
    return {
      ...summary,
      bodyHtml,
      bodyText: canvasPlainText(bodyHtml),
    };
  }

  async listFiles(courseId: CanvasId, options: ListFilesOptions = {}): Promise<CanvasFile[]> {
    const id = idArgument(courseId, "course_id");
    const query: Query = {
      sort: options.sort ?? "name",
      order: options.order ?? "asc",
    };
    if (options.searchTerm) query.search_term = options.searchTerm.slice(0, 200);
    if (options.contentTypes?.length) query["content_types[]"] = options.contentTypes.slice(0, 20);
    const rows = await this.getAllRecords(`/api/v1/courses/${id}/files`, query, options.limit);
    return rows.map((row) => this.normalizeFile(row));
  }

  async listConversations(
    options: ListConversationsOptions = {},
  ): Promise<CanvasConversationSummary[]> {
    const rows = await this.getAllRecords(
      "/api/v1/conversations",
      { scope: options.scope ?? "inbox" },
      options.limit,
    );
    return rows.map(normalizeConversationSummary);
  }

  async getConversation(conversationId: CanvasId): Promise<CanvasConversation> {
    const id = idArgument(conversationId, "conversation_id");
    const raw = await this.getRecord(`/api/v1/conversations/${id}`, {
      // Canvas defaults this GET to a write-like read-state transition. Keep it
      // explicitly false so MCP reads never mark Inbox messages as read.
      auto_mark_as_read: false,
    });
    return {
      ...normalizeConversationSummary(raw),
      messages: records(raw.messages).map((message) => normalizeConversationMessage(message)),
    };
  }

  async listCourseSubmissions(
    courseId: CanvasId,
    options: ListCourseSubmissionsOptions = {},
  ): Promise<CanvasCourseSubmission[]> {
    const course = idArgument(courseId, "course_id");
    const includes = ["assignment", "submission_comments"];
    if (options.includeHistory) includes.push("submission_history");
    const rows = await this.getAllRecords(
      `/api/v1/courses/${course}/students/submissions`,
      {
        "student_ids[]": ["self"],
        "include[]": includes,
      },
      options.limit,
    );
    return rows.map((raw) => {
      const assignment = record(raw.assignment) ?? {};
      const assignmentId = idValue(raw.assignment_id) || idValue(assignment.id);
      const submission = normalizeSubmission(raw, course, assignmentId, options.includeHistory === true);
      return {
        ...submission,
        assignment: {
          id: assignmentId,
          name: stringValue(assignment.name) ?? "",
          dueAt: stringValue(assignment.due_at),
          pointsPossible: numberValue(assignment.points_possible),
          htmlUrl: stringValue(assignment.html_url),
        },
        comments: records(raw.submission_comments).map((comment) => {
          const commentHtml = sanitizeCanvasHtml(comment.comment);
          return {
            id: idValue(comment.id),
            authorId:
              comment.author_id === undefined || comment.author_id === null
                ? null
                : idValue(comment.author_id),
            authorName: stringValue(comment.author_name),
            commentHtml,
            commentText: canvasPlainText(commentHtml),
            createdAt: stringValue(comment.created_at),
            attachments: records(comment.attachments).map(normalizeAttachment),
          };
        }),
      };
    });
  }

  async listCalendarEvents(
    options: ListCalendarEventsOptions = {},
  ): Promise<CanvasCalendarEvent[]> {
    const window = resolveWindow(options.startAt, options.endAt, this.now());
    const query: Query = {
      type: options.type ?? "event",
      start_date: window.startAt,
      end_date: window.endAt,
    };
    if (options.courseIds && options.courseIds.length > 0) {
      query["context_codes[]"] = options.courseIds.map(
        (id) => `course_${idArgument(id, "course_ids")}`,
      );
    }
    const rows = await this.getAllRecords("/api/v1/calendar_events", query, options.limit);
    return rows.map((row) => this.normalizeCalendarEvent(row));
  }

  async getUpcomingWork(options: UpcomingWorkOptions = {}): Promise<CanvasUpcomingWorkItem[]> {
    const window = resolveWindow(options.startAt, options.endAt, this.now());
    const query: Query = { start_date: window.startAt, end_date: window.endAt };
    if (options.courseIds && options.courseIds.length > 0) {
      query["context_codes[]"] = options.courseIds.map(
        (id) => `course_${idArgument(id, "course_ids")}`,
      );
    }
    const rows = await this.getAllRecords("/api/v1/planner/items", query, options.limit);
    const items = rows.map((row) => this.normalizeUpcomingWork(row));
    return options.includeCompleted ? items : items.filter((item) => !item.completed);
  }

  async getSubmissionStatus(
    courseId: CanvasId,
    assignmentId: CanvasId,
    includeHistory = false,
  ): Promise<CanvasSubmission> {
    const course = idArgument(courseId, "course_id");
    const assignment = idArgument(assignmentId, "assignment_id");
    const query: Query = {};
    if (includeHistory) query["include[]"] = ["submission_history"];
    const raw = await this.getRecord(
      `/api/v1/courses/${course}/assignments/${assignment}/submissions/self`,
      query,
    );
    return normalizeSubmission(raw, course, assignment, includeHistory);
  }

  async getGrades(options: GradeOptions = {}): Promise<CanvasGrade[]> {
    const query: Query = {
      "type[]": ["StudentEnrollment"],
      "include[]": ["current_points", "current_grading_period_scores"],
      "state[]": options.includeCompleted ? ["active", "completed"] : ["active"],
    };
    if (options.courseId !== undefined) {
      query.course_id = idArgument(options.courseId, "course_id");
    }
    const rows = await this.getAllRecords(
      "/api/v1/users/self/enrollments",
      query,
      options.limit,
    );
    return rows.map((row) => this.normalizeGrade(row));
  }

  async weeklySummary(options: WeeklySummaryOptions = {}): Promise<CanvasWeeklySummary> {
    const window = resolveWindow(options.startAt, options.endAt, this.now());
    const limit = Math.min(boundedLimit(options.limitPerCollection ?? 200), 500);
    const selectedIds = options.courseIds?.map((id) => idArgument(id, "course_ids"));

    const courseFilter = selectedIds ? { courseIds: selectedIds } : {};
    const [allCourses, upcomingWork, calendarEvents] = await Promise.all([
      this.listCourses({ enrollmentState: "active", limit }),
      this.getUpcomingWork({
        startAt: window.startAt,
        endAt: window.endAt,
        ...courseFilter,
        includeCompleted: true,
        limit,
      }),
      this.listCalendarEvents({
        startAt: window.startAt,
        endAt: window.endAt,
        ...courseFilter,
        type: "event",
        limit,
      }),
    ]);

    const selected = selectedIds ? new Set(selectedIds) : null;
    const courses = selected ? allCourses.filter((course) => selected.has(course.id)) : allCourses;
    const announcementCourseIds = selectedIds ?? courses.map((course) => course.id);
    const announcements = await this.listAnnouncementsForCourses(announcementCourseIds, {
      startAt: window.startAt,
      endAt: window.endAt,
      activeOnly: true,
      limit,
    });

    return {
      window,
      courses,
      upcomingWork,
      calendarEvents,
      announcements,
      counts: {
        courses: courses.length,
        upcomingWork: upcomingWork.length,
        incompleteWork: upcomingWork.filter((item) => !item.completed).length,
        calendarEvents: calendarEvents.length,
        announcements: announcements.length,
      },
    };
  }

  private normalizeCourse(raw: JsonRecord): CanvasCourse {
    const id = idValue(raw.id);
    const term = record(raw.term);
    const enrollments = records(raw.enrollments);
    const enrollmentRaw =
      enrollments.find((item) => stringValue(item.type) === "StudentEnrollment") ??
      enrollments[0] ??
      null;
    const syllabusBody = sanitizeCanvasHtml(raw.syllabus_body);
    return {
      id,
      name: stringValue(raw.name) ?? "",
      courseCode: stringValue(raw.course_code),
      workflowState: stringValue(raw.workflow_state),
      startAt: stringValue(raw.start_at),
      endAt: stringValue(raw.end_at),
      timeZone: stringValue(raw.time_zone),
      isPublic: booleanValue(raw.is_public),
      syllabusBody,
      syllabusText: canvasPlainText(syllabusBody),
      htmlUrl: `${this.baseUrl}/courses/${id}`,
      term: term
        ? {
            id: idValue(term.id),
            name: stringValue(term.name) ?? "",
            startAt: stringValue(term.start_at),
            endAt: stringValue(term.end_at),
          }
        : null,
      teachers: records(raw.teachers).map((teacher) => ({
        id: idValue(teacher.id),
        name: stringValue(teacher.name) ?? "",
        displayName: stringValue(teacher.display_name),
        avatarImageUrl: stringValue(teacher.avatar_image_url),
      })),
      enrollment: enrollmentRaw ? normalizeEnrollment(enrollmentRaw) : null,
    };
  }

  private normalizeAssignment(raw: JsonRecord, courseId: string): CanvasAssignment {
    const id = idValue(raw.id);
    const submission = record(raw.submission);
    const descriptionHtml = sanitizeCanvasHtml(raw.description);
    return {
      id,
      courseId,
      name: stringValue(raw.name) ?? "",
      descriptionHtml,
      descriptionText: canvasPlainText(descriptionHtml),
      dueAt: stringValue(raw.due_at),
      unlockAt: stringValue(raw.unlock_at),
      lockAt: stringValue(raw.lock_at),
      pointsPossible: numberValue(raw.points_possible),
      position: numberValue(raw.position),
      published: booleanValue(raw.published),
      workflowState: stringValue(raw.workflow_state),
      submissionTypes: Array.isArray(raw.submission_types)
        ? raw.submission_types.filter((item): item is string => typeof item === "string")
        : [],
      allowedExtensions: Array.isArray(raw.allowed_extensions)
        ? raw.allowed_extensions.filter((item): item is string => typeof item === "string")
        : [],
      hasSubmittedSubmissions: booleanValue(raw.has_submitted_submissions),
      htmlUrl: stringValue(raw.html_url),
      submission: submission ? normalizeSubmission(submission, courseId, id, false) : null,
    };
  }

  private normalizeAnnouncement(raw: JsonRecord): CanvasAnnouncement {
    const author = record(raw.author);
    const courseId = idValue(raw.context_code).match(/^course_(\d+)$/)?.[1] ?? null;
    const messageHtml = sanitizeCanvasHtml(raw.message);
    return {
      id: idValue(raw.id),
      courseId,
      title: stringValue(raw.title) ?? "",
      messageHtml,
      messageText: canvasPlainText(messageHtml),
      postedAt: stringValue(raw.posted_at),
      delayedPostAt: stringValue(raw.delayed_post_at),
      lastReplyAt: stringValue(raw.last_reply_at),
      authorName: author ? stringValue(author.display_name) ?? stringValue(author.name) : null,
      htmlUrl: stringValue(raw.html_url),
      readState: stringValue(raw.read_state),
      locked: booleanValue(raw.locked),
      published: raw.published === undefined ? true : booleanValue(raw.published),
    };
  }

  private normalizeModule(raw: JsonRecord): CanvasModule {
    return {
      id: idValue(raw.id),
      name: stringValue(raw.name) ?? "",
      position: numberValue(raw.position),
      unlockAt: stringValue(raw.unlock_at),
      requireSequentialProgress: booleanValue(raw.require_sequential_progress),
      prerequisiteModuleIds: Array.isArray(raw.prerequisite_module_ids)
        ? raw.prerequisite_module_ids.map(idValue).filter(Boolean)
        : [],
      state: stringValue(raw.state),
      completedAt: stringValue(raw.completed_at),
      published: raw.published === undefined ? true : booleanValue(raw.published),
      items: records(raw.items).map((item) => this.normalizeModuleItem(item)),
    };
  }

  private normalizeModuleItem(raw: JsonRecord): CanvasModuleItem {
    const requirement = record(raw.completion_requirement);
    const details = record(raw.content_details);
    return {
      id: idValue(raw.id),
      moduleId: idValue(raw.module_id),
      title: stringValue(raw.title) ?? "",
      type: stringValue(raw.type),
      position: numberValue(raw.position),
      indent: numberValue(raw.indent) ?? 0,
      contentId: raw.content_id === undefined || raw.content_id === null ? null : idValue(raw.content_id),
      htmlUrl: stringValue(raw.html_url),
      externalUrl: stringValue(raw.external_url),
      published: raw.published === undefined ? true : booleanValue(raw.published),
      completionRequirement: requirement
        ? {
            type: stringValue(requirement.type),
            completed: booleanValue(requirement.completed),
            minScore: numberValue(requirement.min_score),
          }
        : null,
      contentDetails: details
        ? {
            dueAt: stringValue(details.due_at),
            unlockAt: stringValue(details.unlock_at),
            lockAt: stringValue(details.lock_at),
            pointsPossible: numberValue(details.points_possible),
          }
        : null,
    };
  }

  private normalizeCourseTab(raw: JsonRecord): CanvasCourseTab {
    const id = stringValue(raw.id) ?? idValue(raw.id);
    return {
      id,
      label: stringValue(raw.label) ?? "",
      type: stringValue(raw.type),
      position: numberValue(raw.position),
      hidden: booleanValue(raw.hidden),
      visibility: stringValue(raw.visibility),
      htmlUrl: stringValue(raw.html_url),
      externalToolId: id.match(/^context_external_tool_(\d+)$/)?.[1] ?? null,
    };
  }

  private normalizeQuiz(raw: JsonRecord, courseId: string): CanvasQuiz {
    const descriptionHtml = sanitizeCanvasHtml(raw.description);
    return {
      id: idValue(raw.id),
      courseId,
      title: stringValue(raw.title) ?? "",
      descriptionHtml,
      descriptionText: canvasPlainText(descriptionHtml),
      quizType: stringValue(raw.quiz_type),
      dueAt: stringValue(raw.due_at),
      unlockAt: stringValue(raw.unlock_at),
      lockAt: stringValue(raw.lock_at),
      timeLimitMinutes: numberValue(raw.time_limit),
      allowedAttempts: numberValue(raw.allowed_attempts),
      scoringPolicy: stringValue(raw.scoring_policy),
      pointsPossible: numberValue(raw.points_possible),
      questionCount: numberValue(raw.question_count),
      published: booleanValue(raw.published),
      htmlUrl: stringValue(raw.html_url),
    };
  }

  private normalizeDiscussionTopic(raw: JsonRecord, courseId: string): CanvasDiscussionTopic {
    const author = record(raw.author);
    const messageHtml = sanitizeCanvasHtml(raw.message);
    return {
      id: idValue(raw.id),
      courseId,
      title: stringValue(raw.title) ?? "",
      messageHtml,
      messageText: canvasPlainText(messageHtml),
      postedAt: stringValue(raw.posted_at),
      lastReplyAt: stringValue(raw.last_reply_at),
      discussionType: stringValue(raw.discussion_type),
      published: raw.published === undefined ? true : booleanValue(raw.published),
      locked: booleanValue(raw.locked),
      subscribed: booleanValue(raw.subscribed),
      unreadCount: numberValue(raw.unread_count),
      htmlUrl: stringValue(raw.html_url),
      authorName: author ? stringValue(author.display_name) ?? stringValue(author.name) : null,
    };
  }

  private normalizeDiscussionEntry(
    raw: JsonRecord,
    topicId: string,
    depth = 0,
  ): CanvasDiscussionEntry {
    const messageHtml = sanitizeCanvasHtml(raw.message);
    const user = record(raw.user);
    const replies = depth >= 3 ? [] : records(raw.replies);
    return {
      id: idValue(raw.id),
      topicId,
      userId:
        raw.user_id === undefined || raw.user_id === null ? null : idValue(raw.user_id),
      userName:
        stringValue(raw.user_name) ??
        (user ? stringValue(user.display_name) ?? stringValue(user.name) : null),
      messageHtml,
      messageText: canvasPlainText(messageHtml),
      createdAt: stringValue(raw.created_at),
      updatedAt: stringValue(raw.updated_at),
      readState: stringValue(raw.read_state),
      deleted: booleanValue(raw.deleted),
      replies: replies.map((reply) => this.normalizeDiscussionEntry(reply, topicId, depth + 1)),
    };
  }

  private normalizePageSummary(raw: JsonRecord): CanvasPageSummary {
    return {
      url: stringValue(raw.url) ?? "",
      title: stringValue(raw.title) ?? "",
      createdAt: stringValue(raw.created_at),
      updatedAt: stringValue(raw.updated_at),
      published: raw.published === undefined ? true : booleanValue(raw.published),
      frontPage: booleanValue(raw.front_page),
      htmlUrl: stringValue(raw.html_url),
    };
  }

  private normalizeFile(raw: JsonRecord): CanvasFile {
    return {
      id: idValue(raw.id),
      folderId:
        raw.folder_id === undefined || raw.folder_id === null ? null : idValue(raw.folder_id),
      displayName: stringValue(raw.display_name) ?? stringValue(raw.filename) ?? "",
      filename: stringValue(raw.filename) ?? "",
      contentType: stringValue(raw["content-type"]) ?? stringValue(raw.content_type),
      size: numberValue(raw.size),
      createdAt: stringValue(raw.created_at),
      updatedAt: stringValue(raw.updated_at),
      modifiedAt: stringValue(raw.modified_at),
      unlockAt: stringValue(raw.unlock_at),
      lockAt: stringValue(raw.lock_at),
      locked: booleanValue(raw.locked),
      hidden: booleanValue(raw.hidden),
    };
  }

  private normalizeCalendarEvent(raw: JsonRecord): CanvasCalendarEvent {
    const assignment = record(raw.assignment);
    const contextCode = stringValue(raw.context_code);
    const descriptionHtml = sanitizeCanvasHtml(raw.description ?? assignment?.description);
    return {
      id: idValue(raw.id),
      type: stringValue(raw.type) ?? (assignment ? "assignment" : "event"),
      title: stringValue(raw.title) ?? stringValue(assignment?.name) ?? "",
      createdAt: stringValue(raw.created_at) ?? stringValue(assignment?.created_at),
      updatedAt: stringValue(raw.updated_at) ?? stringValue(assignment?.updated_at),
      descriptionHtml,
      descriptionText: canvasPlainText(descriptionHtml),
      startAt: stringValue(raw.start_at) ?? stringValue(assignment?.due_at),
      endAt: stringValue(raw.end_at) ?? stringValue(assignment?.due_at),
      allDay: booleanValue(raw.all_day),
      contextCode,
      courseId: courseIdFromContext(contextCode),
      workflowState: stringValue(raw.workflow_state),
      locationName: stringValue(raw.location_name),
      htmlUrl: stringValue(raw.html_url) ?? stringValue(assignment?.html_url),
    };
  }

  private normalizeUpcomingWork(raw: JsonRecord): CanvasUpcomingWorkItem {
    const plannable = record(raw.plannable) ?? {};
    const plannerOverride = record(raw.planner_override);
    const rawSubmissions = Array.isArray(raw.submissions)
      ? records(raw.submissions)[0] ?? null
      : record(raw.submissions);
    const status = rawSubmissions ? submissionStatus(rawSubmissions) : null;
    const completeFromSubmission =
      status === "submitted" || status === "graded" || status === "excused";
    return {
      id: idValue(raw.plannable_id) || idValue(plannable.id),
      courseId:
        raw.course_id === undefined || raw.course_id === null ? null : idValue(raw.course_id),
      type: stringValue(raw.plannable_type) ?? "unknown",
      title:
        stringValue(plannable.title) ??
        stringValue(plannable.name) ??
        stringValue(raw.context_name) ??
        "",
      date: stringValue(raw.plannable_date),
      dueAt: stringValue(plannable.due_at) ?? stringValue(raw.plannable_date),
      htmlUrl: stringValue(plannable.html_url) ?? stringValue(raw.html_url),
      pointsPossible: numberValue(plannable.points_possible),
      completed: booleanValue(plannerOverride?.marked_complete) || completeFromSubmission,
      submissionStatus: status,
    };
  }

  private normalizeGrade(raw: JsonRecord): CanvasGrade {
    const grades = record(raw.grades) ?? {};
    return {
      enrollmentId: idValue(raw.id),
      courseId: idValue(raw.course_id),
      enrollmentState: stringValue(raw.enrollment_state),
      currentScore: numberValue(grades.current_score),
      currentGrade: stringValue(grades.current_grade),
      finalScore: numberValue(grades.final_score),
      finalGrade: stringValue(grades.final_grade),
      currentPoints: numberValue(grades.current_points),
    };
  }

  private async listAnnouncementsForCourses(
    courseIds: string[],
    options: ListAnnouncementsOptions,
  ): Promise<CanvasAnnouncement[]> {
    if (courseIds.length === 0) return [];
    const limit = boundedLimit(options.limit);
    const all: CanvasAnnouncement[] = [];
    const uniqueIds = [...new Set(courseIds.map((id) => idArgument(id, "course_ids")))];

    for (let offset = 0; offset < uniqueIds.length && all.length < limit; offset += 50) {
      const batch = uniqueIds.slice(offset, offset + 50);
      const query: Query = {
        "context_codes[]": batch.map((id) => `course_${id}`),
        active_only: options.activeOnly ?? true,
        latest_only: false,
      };
      if (options.startAt || options.endAt) {
        const start = options.startAt
          ? parseDate(options.startAt, "start_at", this.now())
          : null;
        const end = options.endAt ? parseDate(options.endAt, "end_at", this.now()) : null;
        if (start && end && end.getTime() <= start.getTime()) {
          throw new CanvasApiError("invalid_argument", "end_at must be later than start_at.");
        }
        if (start) query.start_date = start.toISOString();
        if (end) query.end_date = end.toISOString();
      }
      const rows = await this.getAllRecords(
        "/api/v1/announcements",
        query,
        limit - all.length,
      );
      all.push(...rows.map((row) => this.normalizeAnnouncement(row)));
    }

    return all
      .sort((a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? ""))
      .slice(0, limit);
  }

  private apiUrl(path: string, query: Query = {}): URL {
    if (!path.startsWith("/api/")) {
      throw new CanvasApiError("configuration_error", "Canvas client only permits API paths.");
    }
    const url = new URL(path, `${this.baseUrl}/`);
    this.assertSafeApiUrl(url);
    for (const [key, raw] of Object.entries(query)) {
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, String(value));
        }
      }
    }
    return url;
  }

  private assertSafeApiUrl(url: URL): void {
    if (
      url.protocol !== "https:" ||
      url.origin !== this.base.origin ||
      !url.pathname.startsWith("/api/") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new CanvasApiError(
        "unsafe_pagination",
        "Canvas returned a pagination URL outside the configured HTTPS API origin.",
      );
    }
  }

  private async getRecord(path: string, query: Query = {}): Promise<JsonRecord> {
    const page = await this.fetchJson(this.apiUrl(path, query));
    if (!isRecord(page.data)) {
      throw new CanvasApiError("invalid_response", "Canvas returned an unexpected response shape.");
    }
    return page.data;
  }

  private async getAllRecords(
    path: string,
    query: Query = {},
    requestedLimit?: number,
  ): Promise<JsonRecord[]> {
    const limit = boundedLimit(requestedLimit);
    const first = this.apiUrl(path, { ...query, per_page: Math.min(100, limit) });
    const output: JsonRecord[] = [];
    const seen = new Set<string>();
    let current: URL | null = first;
    let pageCount = 0;

    while (current && output.length < limit) {
      this.assertSafeApiUrl(current);
      if (seen.has(current.href)) {
        throw new CanvasApiError("unsafe_pagination", "Canvas pagination contained a cycle.");
      }
      seen.add(current.href);
      pageCount += 1;
      if (pageCount > this.maxPages) {
        throw new CanvasApiError(
          "invalid_response",
          `Canvas pagination exceeded the ${this.maxPages}-page safety limit.`,
        );
      }

      const page = await this.fetchJson(current);
      if (!Array.isArray(page.data) || page.data.some((item) => !isRecord(item))) {
        throw new CanvasApiError("invalid_response", "Canvas returned an unexpected paginated shape.");
      }
      output.push(...(page.data as JsonRecord[]));

      const link = nextLink(page.linkHeader);
      if (!link || output.length >= limit) {
        current = null;
      } else {
        let candidate: URL;
        try {
          candidate = new URL(link, current);
        } catch (error) {
          throw new CanvasApiError(
            "unsafe_pagination",
            "Canvas returned an invalid pagination URL.",
            {},
            error instanceof Error ? { cause: error } : {},
          );
        }
        this.assertSafeApiUrl(candidate);
        current = candidate;
      }
    }

    return output.slice(0, limit);
  }

  private async fetchJson(url: URL): Promise<JsonPage> {
    this.assertSafeApiUrl(url);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    timer.unref?.();

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.accessToken}`,
          "User-Agent": "canvas-mcp-service/0.1 (read-only)",
        },
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const name = error instanceof Error ? error.name : "";
      if (timedOut || name === "AbortError") {
        throw new CanvasApiError(
          "timeout",
          `Canvas did not respond within ${this.timeoutMs}ms.`,
          { retryable: true },
          error instanceof Error ? { cause: error } : {},
        );
      }
      throw new CanvasApiError(
        "network_error",
        "Canvas request failed before a response was received.",
        { retryable: true },
        error instanceof Error ? { cause: error } : {},
      );
    }

    let text: string;
    try {
      text = await readResponseText(response, this.maxResponseBytes);
    } catch (error) {
      if (error instanceof CanvasApiError) {
        throw error;
      }
      const name = error instanceof Error ? error.name : "";
      if (timedOut || name === "AbortError") {
        throw new CanvasApiError(
          "timeout",
          `Canvas did not finish responding within ${this.timeoutMs}ms.`,
          { retryable: true },
          error instanceof Error ? { cause: error } : {},
        );
      }
      throw new CanvasApiError(
        "network_error",
        "Canvas response ended before its body was received.",
        { retryable: true },
        error instanceof Error ? { cause: error } : {},
      );
    } finally {
      clearTimeout(timer);
    }
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text) as unknown;
      } catch (error) {
        if (response.ok) {
          throw new CanvasApiError(
            "invalid_response",
            "Canvas returned non-JSON content for an API request.",
            { status: response.status },
            error instanceof Error ? { cause: error } : {},
          );
        }
      }
    }

    if (!response.ok) {
      const mapped = errorCodeForStatus(response.status);
      const fallback = `Canvas API request failed with HTTP ${response.status}.`;
      throw new CanvasApiError(mapped.code, canvasErrorMessage(body, fallback), {
        status: response.status,
        retryable: mapped.retryable,
        requestId: response.headers.get("x-request-context-id"),
        retryAfterSeconds: retryAfterSeconds(response.headers.get("retry-after"), this.now()),
      });
    }

    return { data: body, linkHeader: response.headers.get("link") };
  }
}

export function createCanvasRestClient(
  connection: CanvasConnection,
  options: CanvasRestClientOptions = {},
): CanvasRestClient {
  return new CanvasRestClient(connection, options);
}
