import { INSTITUTIONS, type CanvasConnection, type InstitutionKey } from "../domain.js";
import { isIP } from "node:net";
import { CanvasApiError, asCanvasApiError } from "./errors.js";
import { sanitizeHtml as sanitizeCanvasHtml, plainText as canvasPlainText, safePublicUrl } from "../content.js";
import { CanvasCursor, mapPage } from "./pagination.js";
import type {
  CanvasAnnouncement,
  CanvasAssignment,
  CanvasAssignmentPage,
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
  CanvasFileDownload,
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
  ListOptions,
  NormalizedSubmissionStatus,
  Page,
  SourceResult,
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
  maxFileBytes?: number;
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
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 2_000;

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new CanvasApiError(
      "invalid_response",
      "Canvas returned a response larger than the configured safety limit.",
      { status: response.status },
    );
  }
  if (!response.body) return new Uint8Array();

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
  return bytes;
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readResponseBytes(response, maxBytes));
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

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function responseId(value: unknown): string {
  const id = idValue(value);
  if (!/^[1-9]\d*$/.test(id) || (typeof value === "number" && !Number.isSafeInteger(value))) {
    throw new CanvasApiError("invalid_response", "Canvas returned a missing or invalid record identity.");
  }
  return id;
}

function matchResponseId(value: unknown, expected: string): void {
  if (value !== undefined && value !== null && responseId(value) !== expected) {
    throw new CanvasApiError("invalid_response", "Canvas returned a record for a different requested identity.");
  }
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

function errorCodeForStatus(status: number, profileRequest = false): {
  code:
    | "authentication_failed"
    | "access_denied"
    | "permission_denied"
    | "not_found"
    | "rate_limited"
    | "canvas_error"
    | "upstream_error";
  retryable: boolean;
} {
  if (status === 401) {
    // HY-ON uses 401 for both operation permissions and credentials. Only the
    // explicit own-profile check can distinguish a rejected connection.
    return { code: profileRequest ? "authentication_failed" : "access_denied", retryable: false };
  }
  if (status === 403) return { code: "permission_denied", retryable: false };
  if (status === 404) return { code: "not_found", retryable: false };
  if (status === 408 || status === 429) return { code: "rate_limited", retryable: true };
  if (status >= 500) return { code: "upstream_error", retryable: true };
  return { code: "canvas_error", retryable: false };
}

function isSafeFileRedirect(url: URL): boolean {
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return false;
  }
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    const parts = hostname.split(".").map(Number);
    const first = parts[0] ?? -1;
    const second = parts[1] ?? -1;
    if (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    ) {
      return false;
    }
  }
  if (ipVersion === 6 && (hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:"))) {
    return false;
  }
  return true;
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
  if (booleanValue(raw.redo_request)) return "resubmission_required";
  if (booleanValue(raw.missing)) return "missing";
  const state = stringValue(raw.workflow_state);
  if (state === "graded") return "graded";
  if (stringValue(raw.submitted_at) || state === "submitted" || state === "pending_review") {
    return "submitted";
  }
  return state === "unsubmitted" ? "unsubmitted" : "unknown";
}

/** Planner supplies booleans, not a Submission resource. Absence is unknown. */
function plannerSubmissionStatus(raw: JsonRecord | null): NormalizedSubmissionStatus | null {
  if (!raw) return null;
  if (raw.excused === true) return "excused";
  if (raw.redo_request === true) return "resubmission_required";
  if (raw.missing === true) return "missing";
  if (raw.submitted === false && raw.needs_grading !== true) return "unsubmitted";
  if (raw.graded === true) return "graded";
  if (raw.submitted === true || raw.needs_grading === true) return "submitted";
  if (raw.submitted === false) return "unsubmitted";
  return null;
}

async function sourceResult<T>(operation: Promise<Page<T>>): Promise<SourceResult<T>> {
  try {
    return { ok: true, result: await operation, error: null };
  } catch (error) {
    return { ok: false, result: null, error: asCanvasApiError(error).toJSON() };
  }
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
  expectedUserId?: string,
): CanvasSubmission {
  matchResponseId(raw.assignment_id, assignmentId);
  matchResponseId(raw.course_id, courseId);
  if (expectedUserId) matchResponseId(raw.user_id, expectedUserId);
  if (raw.id != null) responseId(raw.id);
  for (const field of ["missing", "excused", "late", "redo_request"]) {
    if (raw[field] != null && typeof raw[field] !== "boolean") {
      throw new CanvasApiError("invalid_response", "Canvas returned an invalid submission status flag.");
    }
  }
  if (!stringValue(raw.workflow_state) && raw.id == null &&
      ![raw.missing, raw.excused, raw.redo_request].some(value => typeof value === "boolean") && !stringValue(raw.submitted_at)) {
    throw new CanvasApiError("invalid_response", "Canvas did not provide a recognizable submission record.");
  }
  const attachments = records(raw.attachments).map(normalizeAttachment);
  if (includeHistory && raw.submission_history != null &&
      (!Array.isArray(raw.submission_history) || raw.submission_history.some(item => !isRecord(item)))) {
    throw new CanvasApiError("invalid_response", "Canvas returned an invalid submission history.");
  }
  const history = includeHistory
    ? records(raw.submission_history).map((item) =>
        normalizeSubmission(item, courseId, assignmentId, false, expectedUserId),
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
    late: nullableBoolean(raw.late),
    missing: nullableBoolean(raw.missing),
    excused: nullableBoolean(raw.excused),
    redoRequest: nullableBoolean(raw.redo_request),
    extraAttempts: numberValue(raw.extra_attempts),
    secondsLate: numberValue(raw.seconds_late),
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
  private readonly maxFileBytes: number;
  private readonly now: () => Date;
  private readonly base: URL;
  private readonly cursor: CanvasCursor;
  private readonly canvasUserId: string;

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
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (!Number.isInteger(maxFileBytes) || maxFileBytes < 64 || maxFileBytes > MAX_FILE_BYTES) {
      throw new CanvasApiError(
        "configuration_error",
        `Canvas maxFileBytes must be an integer between 64 and ${MAX_FILE_BYTES}.`,
      );
    }

    this.institution = connection.institution;
    this.base = canonical;
    this.baseUrl = canonical.origin + (canonical.pathname === "/" ? "" : canonical.pathname);
    this.accessToken = connection.accessToken;
    this.canvasUserId = connection.canvasUserId;
    this.cursor = new CanvasCursor(connection.accessToken, connection.userId);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = timeoutMs;
    this.maxPages = maxPages;
    this.maxResponseBytes = maxResponseBytes;
    this.maxFileBytes = maxFileBytes;
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
        avatarUrl: safePublicUrl(raw.avatar_url, this.baseUrl),
      },
    };
  }

  async listCourses(options: ListCoursesOptions = {}): Promise<Page<CanvasCourse>> {
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
    const selected = options.courseIds ? new Set(options.courseIds.map((id) => idArgument(id, "course_ids"))) : null;
    const termId = options.termId === undefined ? null : idArgument(options.termId, "term_id");
    const rows = await this.getPageRecords("/api/v1/courses", query, options,
      (row) => (!selected || selected.has(idValue(row.id))) &&
        (termId === null || idValue((isRecord(row.term) ? row.term.id : null) ?? row.enrollment_term_id) === termId),
      JSON.stringify([query, selected ? [...selected].sort() : null, ...(termId === null ? [] : [termId])]));
    return mapPage(rows, (row) => this.normalizeCourse(row));
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
  ): Promise<CanvasAssignmentPage> {
    const id = idArgument(courseId, "course_id");
    const checkedAt = this.now();
    const overdue = options.bucket === "overdue";
    const includeSubmission = overdue || options.includeSubmission !== false;
    const query: Query = { order_by: "due_at" };
    if (options.bucket && !overdue) query.bucket = options.bucket;
    if (includeSubmission) query["include[]"] = ["submission"];
    const rows = await this.getPageRecords(
      `/api/v1/courses/${id}/assignments`,
      query,
      options,
      overdue ? (raw) => {
        const assignment = this.normalizeAssignment(raw, id);
        const submission = assignment.submission;
        if (submission?.excused === true) return false;
        if (submission?.missing === true) return true;
        if (!assignment.dueAt || Date.parse(assignment.dueAt) >= checkedAt.getTime()) return false;
        if (submission?.redoRequest === true) return true;
        // A grade alone does not establish that this student submitted work.
        return !submission || (!submission.submittedAt && submission.status !== "submitted");
      } : undefined,
      JSON.stringify([query, options.bucket ?? null, "assignment-safety-v2"]),
    );
    return { ...mapPage(rows, (row) => this.normalizeAssignment(row, id)), coverage: {
      courseId: id, selection: options.bucket ?? "all", source: !options.bucket || overdue ? "all_assignments" : "upstream_bucket",
      submissionIncluded: includeSubmission, queryExhausted: rows.nextCursor === null, checkedAt: checkedAt.toISOString(),
    } };
  }

  async getAssignment(courseId: CanvasId, assignmentId: CanvasId): Promise<CanvasAssignment> {
    const course = idArgument(courseId, "course_id");
    const assignment = idArgument(assignmentId, "assignment_id");
    const raw = await this.getRecord(
      `/api/v1/courses/${course}/assignments/${assignment}`,
      { "include[]": ["submission"] },
    );
    matchResponseId(raw.id, assignment);
    return this.normalizeAssignment(raw, course);
  }

  async listAnnouncements(
    courseId: CanvasId | CanvasId[],
    options: ListAnnouncementsOptions = {},
  ): Promise<Page<CanvasAnnouncement>> {
    const ids = (Array.isArray(courseId) ? courseId : [courseId]).map((id) => idArgument(id, "course_id"));
    return this.listAnnouncementsForCourses(ids, options);
  }

  async listModules(courseId: CanvasId, options: ListModulesOptions = {}): Promise<Page<CanvasModule>> {
    const id = idArgument(courseId, "course_id");
    const rows = await this.getPageRecords(`/api/v1/courses/${id}/modules`, {}, options);
    return mapPage(rows, (row) => this.normalizeModule(row));
  }

  async listModuleItems(courseId: CanvasId, moduleId: CanvasId, options: ListOptions = {}): Promise<Page<CanvasModuleItem>> {
    const course = idArgument(courseId, "course_id");
    const module = idArgument(moduleId, "module_id");
    const rows = await this.getPageRecords(`/api/v1/courses/${course}/modules/${module}/items`, { "include[]": ["content_details"] }, options);
    return mapPage(rows, (row) => this.normalizeModuleItem(row, module));
  }

  async listCourseTabs(courseId: CanvasId, options: ListOptions = {}): Promise<Page<CanvasCourseTab>> {
    const id = idArgument(courseId, "course_id");
    const rows = await this.getPageRecords(
      `/api/v1/courses/${id}/tabs`,
      { "include[]": ["external"] },
      options,
    );
    return mapPage(rows, (row) => this.normalizeCourseTab(row));
  }

  async listQuizzes(courseId: CanvasId, options: ListOptions = {}): Promise<Page<CanvasQuiz>> {
    const id = idArgument(courseId, "course_id");
    const rows = await this.getPageRecords(`/api/v1/courses/${id}/quizzes`, {}, options);
    return mapPage(rows, (row) => this.normalizeQuiz(row, id));
  }

  async listDiscussionTopics(
    courseId: CanvasId,
    options: ListDiscussionTopicsOptions = {},
  ): Promise<Page<CanvasDiscussionTopic>> {
    const id = idArgument(courseId, "course_id");
    const rows = await this.getPageRecords(
      `/api/v1/courses/${id}/discussion_topics`,
      {
        order_by: options.orderBy ?? "recent_activity",
        only_announcements: options.onlyAnnouncements ?? false,
      },
      options,
    );
    return mapPage(rows, (row) => this.normalizeDiscussionTopic(row, id));
  }

  async listDiscussionEntries(
    courseId: CanvasId,
    topicId: CanvasId,
    options: ListOptions = {},
  ): Promise<Page<CanvasDiscussionEntry>> {
    const course = idArgument(courseId, "course_id");
    const topic = idArgument(topicId, "topic_id");
    const rows = await this.getPageRecords(
      `/api/v1/courses/${course}/discussion_topics/${topic}/entries`,
      {},
      options,
    );
    return mapPage(rows, (row) => this.normalizeDiscussionEntry(row, topic));
  }

  async listDiscussionReplies(courseId: CanvasId, topicId: CanvasId, entryId: CanvasId, options: ListOptions = {}): Promise<Page<CanvasDiscussionEntry>> {
    const course = idArgument(courseId, "course_id");
    const topic = idArgument(topicId, "topic_id");
    const entry = idArgument(entryId, "entry_id");
    const rows = await this.getPageRecords(`/api/v1/courses/${course}/discussion_topics/${topic}/entries/${entry}/replies`, {}, options);
    return mapPage(rows, (row) => this.normalizeDiscussionEntry(row, topic));
  }

  async listPages(courseId: CanvasId, options: ListOptions = {}): Promise<Page<CanvasPageSummary>> {
    const id = idArgument(courseId, "course_id");
    const rows = await this.getPageRecords(`/api/v1/courses/${id}/pages`, {}, options);
    return mapPage(rows, (row) => this.normalizePageSummary(row));
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

  async listFiles(courseId: CanvasId, options: ListFilesOptions = {}): Promise<Page<CanvasFile>> {
    const id = idArgument(courseId, "course_id");
    const query: Query = {
      sort: options.sort ?? "name",
      order: options.order ?? "asc",
    };
    if (options.searchTerm) query.search_term = options.searchTerm.slice(0, 200);
    if (options.contentTypes?.length) query["content_types[]"] = options.contentTypes.slice(0, 20);
    const rows = await this.getPageRecords(`/api/v1/courses/${id}/files`, query, options);
    return mapPage(rows, (row) => this.normalizeFile(row));
  }

  async getFile(fileId: CanvasId): Promise<CanvasFile> {
    const id = idArgument(fileId, "file_id");
    const raw = await this.getRecord(`/api/v1/files/${id}`);
    return this.normalizeFile(raw);
  }

  async downloadFile(fileId: CanvasId): Promise<CanvasFileDownload> {
    const id = idArgument(fileId, "file_id");
    const raw = await this.getRecord(`/api/v1/files/${id}`);
    const file = this.normalizeFile(raw);
    if (file.size !== null && file.size > this.maxFileBytes) {
      throw new CanvasApiError(
        "invalid_response",
        `Canvas file exceeds the ${Math.floor(this.maxFileBytes / (1024 * 1024))} MiB download limit.`,
      );
    }
    const rawUrl = stringValue(raw.url);
    if (!rawUrl) {
      throw new CanvasApiError("invalid_response", "Canvas did not return a download URL for this file.");
    }
    let downloadUrl: URL;
    try {
      downloadUrl = new URL(rawUrl);
    } catch (error) {
      throw new CanvasApiError(
        "invalid_response",
        "Canvas returned an invalid file download URL.",
        {},
        error instanceof Error ? { cause: error } : {},
      );
    }
    if (
      downloadUrl.protocol !== "https:" ||
      downloadUrl.origin !== this.base.origin ||
      !downloadUrl.pathname.startsWith("/files/") ||
      downloadUrl.username !== "" ||
      downloadUrl.password !== ""
    ) {
      throw new CanvasApiError(
        "invalid_response",
        "Canvas returned a file download URL outside the configured HTTPS origin.",
      );
    }
    const downloaded = await this.fetchDownload(downloadUrl);
    return {
      file,
      bytes: downloaded.bytes,
      contentType: file.contentType || downloaded.contentType || "application/octet-stream",
    };
  }

  async listConversations(
    options: ListConversationsOptions = {},
  ): Promise<Page<CanvasConversationSummary>> {
    const rows = await this.getPageRecords(
      "/api/v1/conversations",
      { scope: options.scope ?? "inbox" },
      options,
    );
    return mapPage(rows, normalizeConversationSummary);
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
  ): Promise<Page<CanvasCourseSubmission>> {
    const course = idArgument(courseId, "course_id");
    const includes = ["assignment", "submission_comments"];
    if (options.includeHistory) includes.push("submission_history");
    const rows = await this.getPageRecords(
      `/api/v1/courses/${course}/students/submissions`,
      {
        "student_ids[]": ["self"],
        "include[]": includes,
      },
      options,
    );
    return mapPage(rows, (raw) => {
      const assignment = record(raw.assignment) ?? {};
      const assignmentId = responseId(raw.assignment_id ?? assignment.id);
      matchResponseId(assignment.id, assignmentId);
      matchResponseId(assignment.course_id, course);
      const submission = normalizeSubmission(raw, course, assignmentId, options.includeHistory === true, this.canvasUserId);
      return {
        ...submission,
        assignment: {
          id: assignmentId,
          name: stringValue(assignment.name) ?? "",
          dueAt: stringValue(assignment.due_at),
          pointsPossible: numberValue(assignment.points_possible),
          htmlUrl: safePublicUrl(assignment.html_url, this.baseUrl),
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
  ): Promise<Page<CanvasCalendarEvent>> {
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
    const rows = await this.getPageRecords("/api/v1/calendar_events", query, options, undefined,
      JSON.stringify([options.startAt ?? null, options.endAt ?? null, options.courseIds?.map(String) ?? null, options.type ?? "event"]));
    return mapPage(rows, (row) => this.normalizeCalendarEvent(row));
  }

  async getUpcomingWork(options: UpcomingWorkOptions = {}): Promise<Page<CanvasUpcomingWorkItem>> {
    const window = resolveWindow(options.startAt, options.endAt, this.now());
    const query: Query = { start_date: window.startAt, end_date: window.endAt };
    // Fetch all Planner rows: upstream incomplete_items can discard graded missing
    // work or manual overrides before we can inspect the contradictory flags.
    if (options.courseIds && options.courseIds.length > 0) {
      query["context_codes[]"] = options.courseIds.map(
        (id) => `course_${idArgument(id, "course_ids")}`,
      );
    }
    const rows = await this.getPageRecords("/api/v1/planner/items", query, options,
      options.includeCompleted ? undefined : (row) => this.normalizeUpcomingWork(row).completed !== true,
      JSON.stringify([options.startAt ?? null, options.endAt ?? null, options.courseIds?.map(String) ?? null, options.includeCompleted ?? false]));
    return mapPage(rows, (row) => this.normalizeUpcomingWork(row));
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
    return normalizeSubmission(raw, course, assignment, includeHistory, this.canvasUserId);
  }

  async getGrades(options: GradeOptions = {}): Promise<Page<CanvasGrade>> {
    const query: Query = {
      "type[]": ["StudentEnrollment"],
      "include[]": ["current_points", "current_grading_period_scores"],
      "state[]": options.includeCompleted ? ["active", "completed"] : ["active"],
    };
    if (options.courseId !== undefined) {
      query.course_id = idArgument(options.courseId, "course_id");
    }
    const rows = await this.getPageRecords(
      "/api/v1/users/self/enrollments",
      query,
      options,
    );
    return mapPage(rows, (row) => this.normalizeGrade(row));
  }

  async weeklySummary(options: WeeklySummaryOptions = {}): Promise<CanvasWeeklySummary> {
    const window = resolveWindow(options.startAt, options.endAt, this.now());
    const limit = Math.min(boundedLimit(options.limitPerCollection ?? 200), 500);
    const selectedIds = options.courseIds?.map((id) => idArgument(id, "course_ids"));
    const courseFilter = selectedIds ? { courseIds: selectedIds } : {};
    const announcementsWindow = resolveWindow(
      options.announcementsStartAt ?? new Date(new Date(window.startAt).getTime() - 14 * 86_400_000).toISOString(),
      window.endAt,
      this.now(),
    );
    const coursesPromise = sourceResult(this.listCourses({ enrollmentState: "active", ...courseFilter, limit }));
    const announcementsPromise = (async (): Promise<SourceResult<CanvasAnnouncement>> => {
      const courses = await coursesPromise;
      if (!selectedIds && !courses.ok) return { ok: false, result: null, error: courses.error };
      const ids = selectedIds ?? (courses.ok ? courses.result.items.map((course) => course.id) : []);
      return sourceResult(this.listAnnouncements(ids, { ...announcementsWindow, activeOnly: true, limit }));
    })();
    const [courses, upcomingWork, calendarEvents, announcements] = await Promise.all([
      coursesPromise,
      sourceResult(this.getUpcomingWork({
        startAt: window.startAt,
        endAt: window.endAt,
        ...courseFilter,
        includeCompleted: true,
        limit,
      })),
      sourceResult(this.listCalendarEvents({
        startAt: window.startAt,
        endAt: window.endAt,
        ...courseFilter,
        type: "event",
        limit,
      })),
      announcementsPromise,
    ]);
    return {
      window,
      announcementsWindow,
      sources: { courses, upcomingWork, calendarEvents, announcements },
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
        avatarImageUrl: safePublicUrl(teacher.avatar_image_url, this.baseUrl),
      })),
      enrollment: enrollmentRaw ? normalizeEnrollment(enrollmentRaw) : null,
    };
  }

  private normalizeAssignment(raw: JsonRecord, courseId: string): CanvasAssignment {
    const id = responseId(raw.id);
    matchResponseId(raw.course_id, courseId);
    if (raw.submission != null && !isRecord(raw.submission)) {
      throw new CanvasApiError("invalid_response", "Canvas returned an invalid submission shape.");
    }
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
      lockedForUser: nullableBoolean(raw.locked_for_user),
      lockExplanation: canvasPlainText(sanitizeCanvasHtml(raw.lock_explanation)),
      allowedAttempts: numberValue(raw.allowed_attempts),
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
      htmlUrl: safePublicUrl(raw.html_url, this.baseUrl),
      submission: submission ? normalizeSubmission(submission, courseId, id, false, this.canvasUserId) : null,
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
      htmlUrl: safePublicUrl(raw.html_url, this.baseUrl),
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
      itemCount: numberValue(raw.items_count),
    };
  }

  private normalizeModuleItem(raw: JsonRecord, moduleId: string): CanvasModuleItem {
    const requirement = record(raw.completion_requirement);
    const details = record(raw.content_details);
    return {
      id: idValue(raw.id),
      moduleId,
      title: stringValue(raw.title) ?? "",
      type: stringValue(raw.type),
      position: numberValue(raw.position),
      indent: numberValue(raw.indent) ?? 0,
      contentId: raw.content_id === undefined || raw.content_id === null ? null : idValue(raw.content_id),
      htmlUrl: safePublicUrl(raw.html_url, this.baseUrl),
      externalUrl: safePublicUrl(raw.external_url, this.baseUrl),
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
      htmlUrl: safePublicUrl(raw.html_url, this.baseUrl),
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
      htmlUrl: safePublicUrl(raw.html_url, this.baseUrl),
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
      htmlUrl: safePublicUrl(raw.html_url, this.baseUrl),
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
    const recent = records(raw.recent_replies);
    const replies = depth >= 3 ? [] : recent;
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
      hasMoreReplies: raw.has_more_replies === true || (depth >= 3 && recent.length > 0),
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
      htmlUrl: safePublicUrl(raw.html_url, this.baseUrl),
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
      htmlUrl: safePublicUrl(raw.html_url, this.baseUrl) ?? safePublicUrl(assignment?.html_url, this.baseUrl),
    };
  }

  private normalizeUpcomingWork(raw: JsonRecord): CanvasUpcomingWorkItem {
    const plannable = record(raw.plannable) ?? {};
    const plannerOverride = record(raw.planner_override);
    const status = plannerSubmissionStatus(record(raw.submissions));
    const flags = record(raw.submissions) ?? {};
    for (const field of ["submitted", "graded", "needs_grading", "missing", "excused", "redo_request"]) {
      if (flags[field] != null && typeof flags[field] !== "boolean") {
        throw new CanvasApiError("invalid_response", "Canvas returned an invalid Planner status flag.");
      }
    }
    const type = stringValue(raw.plannable_type) ?? "unknown";
    const completeFromSubmission =
      status === "submitted" || status === "excused" || (status === "graded" && flags.submitted === true);
    return {
      id: idValue(raw.plannable_id) || idValue(plannable.id),
      courseId:
        raw.course_id === undefined || raw.course_id === null ? null : idValue(raw.course_id),
      type,
      title:
        stringValue(plannable.title) ??
        stringValue(plannable.name) ??
        stringValue(raw.context_name) ??
        "",
      date: stringValue(raw.plannable_date),
      dueAt: stringValue(plannable.due_at) ??
        (["assignment", "quiz", "discussion_topic"].includes(type) ? stringValue(raw.plannable_date) : null),
      htmlUrl: safePublicUrl(plannable.html_url, this.baseUrl) ?? safePublicUrl(raw.html_url, this.baseUrl),
      pointsPossible: numberValue(plannable.points_possible),
      completed: status === "missing" || status === "resubmission_required" || status === "unsubmitted" ? false
        : completeFromSubmission || (plannerOverride?.marked_complete === true && !["assignment", "quiz", "discussion_topic"].includes(type)) ? true : null,
      submissionStatus: status,
      submissionFlags: {
        submitted: nullableBoolean(flags.submitted), graded: nullableBoolean(flags.graded),
        needsGrading: nullableBoolean(flags.needs_grading), missing: nullableBoolean(flags.missing),
        excused: nullableBoolean(flags.excused), redoRequest: nullableBoolean(flags.redo_request),
      },
      plannerOverride: plannerOverride ? {
        markedComplete: nullableBoolean(plannerOverride.marked_complete), dismissed: nullableBoolean(plannerOverride.dismissed),
      } : null,
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
  ): Promise<Page<CanvasAnnouncement>> {
    if (courseIds.length === 0) return { items: [], nextCursor: null };
    const uniqueIds = [...new Set(courseIds.map((id) => idArgument(id, "course_ids")))].sort();
    const query: Query = {
      "context_codes[]": uniqueIds.map((id) => `course_${id}`),
      active_only: options.activeOnly ?? true,
      latest_only: false,
    };
    const start = options.startAt ? parseDate(options.startAt, "start_at", this.now()) : null;
    const end = options.endAt ? parseDate(options.endAt, "end_at", this.now()) : null;
    if (start && end && end.getTime() <= start.getTime()) {
      throw new CanvasApiError("invalid_argument", "end_at must be later than start_at.");
    }
    if (start) query.start_date = start.toISOString();
    if (end) query.end_date = end.toISOString();
    const rows = await this.getPageRecords("/api/v1/announcements", query, options);
    return mapPage(rows, (row) => this.normalizeAnnouncement(row));
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

  private async getPageRecords(
    path: string,
    query: Query = {},
    options: ListOptions = {},
    accept: (row: JsonRecord) => boolean = () => true,
    queryScope = JSON.stringify(query),
  ): Promise<Page<JsonRecord>> {
    const limit = boundedLimit(options.limit);
    const scope = JSON.stringify([path, queryScope]);
    const first = this.apiUrl(path, { ...query, per_page: Math.min(100, limit) });
    const output: JsonRecord[] = [];
    const seen = new Set<string>();
    const continuation = options.cursor ? this.cursor.decode(options.cursor, scope) : null;
    let current: URL | null = continuation ? new URL(continuation.url) : first;
    let offset = continuation?.offset ?? 0;
    let pageCount = 0;
    while (current) {
      this.assertSafeApiUrl(current);
      if (current.pathname !== first.pathname) {
        throw new CanvasApiError("unsafe_pagination", "Canvas pagination changed the requested API endpoint.");
      }
      if (seen.has(current.href)) {
        throw new CanvasApiError("unsafe_pagination", "Canvas pagination contained a cycle.");
      }
      if (pageCount >= this.maxPages) {
        return { items: output, nextCursor: this.cursor.encode({ scope, url: current.href, offset }) };
      }
      seen.add(current.href);
      pageCount += 1;
      const page = await this.fetchJson(current);
      if (!Array.isArray(page.data) || page.data.some((item) => !isRecord(item))) {
        throw new CanvasApiError("invalid_response", "Canvas returned an unexpected paginated shape.");
      }
      const link = nextLink(page.linkHeader);
      let next: URL | null = null;
      if (link) {
        try {
          next = new URL(link, current);
        } catch {
          throw new CanvasApiError("unsafe_pagination", "Canvas returned an invalid pagination URL.");
        }
        this.assertSafeApiUrl(next);
        if (next.pathname !== first.pathname || seen.has(next.href)) {
          throw new CanvasApiError("unsafe_pagination", "Canvas pagination changed endpoint or contained a cycle.");
        }
      }
      for (let index = offset; index < page.data.length; index += 1) {
        const row = page.data[index] as JsonRecord;
        if (accept(row)) output.push(row);
        if (output.length === limit) {
          const moreInPage = index + 1 < page.data.length;
          const url = moreInPage ? current : next;
          return {
            items: output,
            nextCursor: url ? this.cursor.encode({ scope, url: url.href, offset: moreInPage ? index + 1 : 0 }) : null,
          };
        }
      }
      current = next;
      offset = 0;
    }
    return { items: output, nextCursor: null };
  }

  private async fetchDownload(initialUrl: URL): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(this.timeoutMs, 30_000));
    timer.unref?.();

    let current = initialUrl;
    try {
      for (let redirects = 0; redirects <= 5; redirects += 1) {
        let response: Response;
        try {
          response = await this.fetchImpl(current, {
            method: "GET",
            headers: {
              Accept: "*/*",
              "User-Agent": "canvas-mcp-service/0.1 (read-only file relay)",
            },
            redirect: "manual",
            signal: controller.signal,
          });
        } catch (error) {
          const name = error instanceof Error ? error.name : "";
          if (timedOut || name === "AbortError") {
            throw new CanvasApiError(
              "timeout",
              "Canvas file download did not finish within the safety timeout.",
              { retryable: true },
              error instanceof Error ? { cause: error } : {},
            );
          }
          throw new CanvasApiError(
            "network_error",
            "Canvas file download failed before a response was received.",
            { retryable: true },
            error instanceof Error ? { cause: error } : {},
          );
        }

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location || redirects === 5) {
            throw new CanvasApiError("invalid_response", "Canvas file download used an invalid redirect chain.");
          }
          let candidate: URL;
          try {
            candidate = new URL(location, current);
          } catch (error) {
            throw new CanvasApiError(
              "invalid_response",
              "Canvas file download returned an invalid redirect URL.",
              {},
              error instanceof Error ? { cause: error } : {},
            );
          }
          if (!isSafeFileRedirect(candidate)) {
            throw new CanvasApiError("invalid_response", "Canvas file download redirected to an unsafe URL.");
          }
          current = candidate;
          continue;
        }

        if (!response.ok) {
          const mapped = errorCodeForStatus(response.status);
          throw new CanvasApiError(
            mapped.code,
            `Canvas file download failed with HTTP ${response.status}.`,
            {
              status: response.status,
              retryable: mapped.retryable,
              requestId: response.headers.get("x-request-context-id"),
              retryAfterSeconds: retryAfterSeconds(response.headers.get("retry-after"), this.now()),
            },
          );
        }

        const bytes = await readResponseBytes(response, this.maxFileBytes);
        return {
          bytes,
          contentType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || null,
        };
      }
      throw new CanvasApiError("invalid_response", "Canvas file download exceeded the redirect limit.");
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (!(error instanceof CanvasApiError) && (timedOut || name === "AbortError")) {
        throw new CanvasApiError(
          "timeout",
          "Canvas file download did not finish within the safety timeout.",
          { retryable: true },
          error instanceof Error ? { cause: error } : {},
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
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
      const mapped = errorCodeForStatus(response.status, url.pathname === "/api/v1/users/self/profile");
      const message = mapped.code === "access_denied"
        ? "Canvas denied access. This response does not distinguish an expired connection from permission to this resource; use connection_status to check the connection."
        : mapped.code === "authentication_failed"
          ? "Canvas rejected the configured connection during its own-profile check."
          : `Canvas API request failed with HTTP ${response.status}.`;
      throw new CanvasApiError(mapped.code, message, {
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
