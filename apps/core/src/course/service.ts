import { createHash } from "node:crypto";
import { LearningXReadClient, LearningXSessionCache } from "../learningx/index.js";
import type { SchoolViewer } from "../lecture/school-reader.js";

import type { AppDatabase } from "../db/index.js";
import type { CanvasConnection } from "../domain.js";
import { CanvasRestClient, CanvasApiError, asCanvasApiError, type CanvasCourse } from "../canvas/index.js";
import { getHanyangTimetable, getImportedTimetableOwnerId, type HanyangTimetable } from "../timetable.js";
import {
  CourseCatalogError,
  type CourseCatalogResponse,
  type CourseCatalogStatus,
  type CourseOption,
} from "./types.js";

interface CourseCatalogServiceOptions {
  db: AppDatabase;
  getConnection: (userId: string) => CanvasConnection;
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
  minIntervalSeconds: number;
}

interface SyncStateRow {
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_result_count: number | null;
  last_error_code: string | null;
}

interface CatalogRow {
  canvas_course_id: string;
  course_code: string | null;
  name: string;
  term_name: string | null;
  start_at: string | null;
  end_at: string | null;
  folder_name: string;
  status: CourseCatalogStatus;
  last_seen_at: number;
  archived_at: number | null;
}

interface NormalizedCourse {
  id: string;
  code: string | null;
  name: string;
  termId: string | null;
  termName: string | null;
  workflowState: string | null;
  enrollmentState: "active" | "completed";
  startAt: string | null;
  endAt: string | null;
  folderName: string;
  status: CourseCatalogStatus;
  metadataJson: string;
  snapshotHash: string;
}

function isoTime(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function safeFolderName(course: Pick<CanvasCourse, "id" | "name" | "courseCode">): string {
  const code = course.courseCode?.trim() || course.id;
  const raw = `${code} - ${course.name}`
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return (raw || `course-${course.id}`).slice(0, 120);
}

function normalizeCourse(
  course: CanvasCourse,
  enrollmentState: "active" | "completed",
): NormalizedCourse {
  const folderName = safeFolderName(course);
  const status: CourseCatalogStatus = enrollmentState === "completed" ? "archived" : "active";
  const metadata = {
    id: course.id,
    code: course.courseCode,
    name: course.name,
    termId: course.term?.id ?? null,
    termName: course.term?.name ?? null,
    workflowState: course.workflowState,
    enrollmentState,
    startAt: course.startAt,
    endAt: course.endAt,
    folderName,
    status,
  };
  const metadataJson = JSON.stringify(metadata);
  return {
    ...metadata,
    folderName,
    status,
    metadataJson,
    snapshotHash: createHash("sha256").update(metadataJson, "utf8").digest("hex"),
  };
}

function toCourseOption(row: CatalogRow): CourseOption {
  const code = row.course_code ?? row.canvas_course_id;
  return {
    id: row.canvas_course_id,
    code,
    name: row.name,
    term: row.term_name,
    folderName: row.folder_name,
    label: `${code} \u00b7 ${row.name}`,
    status: row.status,
    source: "canvas",
    startAt: row.start_at,
    endAt: row.end_at,
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    archivedAt: isoTime(row.archived_at),
  };
}

/** Publish a catalog only after both enrollment collections have been fully read. */
async function listAllCourses(client: CanvasRestClient, enrollmentState: "active" | "completed"): Promise<CanvasCourse[]> {
  const courses: CanvasCourse[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await client.listCourses({ enrollmentState, limit: 200, ...(cursor ? { cursor } : {}) });
    courses.push(...result.items);
    if (result.nextCursor === null) return courses;
    if (seen.has(result.nextCursor)) {
      throw new CanvasApiError("unsafe_pagination", "Course synchronization encountered a repeated cursor.");
    }
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new CanvasApiError("invalid_response", "Course synchronization exceeded its page budget; the previous catalog was retained.");
}

export class CourseCatalogService {
  private readonly clock: () => number;

  constructor(private readonly options: CourseCatalogServiceOptions) {
    this.clock = options.clock ?? Date.now;
  }

  async listForLecture(includeArchived = false): Promise<CourseCatalogResponse> {
    const userId = this.soleHanyangUserId();
    const now = this.clock();
    const state = this.syncState(userId);
    const minIntervalMs = this.options.minIntervalSeconds * 1_000;
    if (
      state?.last_attempt_at !== null &&
      state?.last_attempt_at !== undefined &&
      now - state.last_attempt_at < minIntervalMs
    ) {
      return this.cachedResponse(userId, includeArchived, state.last_error_code !== null);
    }

    try {
      const connection = this.options.getConnection(userId);
      if (connection.institution !== "hanyang") {
        throw new CourseCatalogError(
          "invalid_institution",
          "The connected Canvas account is not a Hanyang account.",
        );
      }
      const client = new CanvasRestClient(
        connection,
        this.options.fetch ? { fetch: this.options.fetch } : {},
      );
      const [active, completed] = await Promise.all([
        listAllCourses(client, "active"),
        listAllCourses(client, "completed"),
      ]);
      if (active.length === 0 && completed.length === 0 && this.hasCatalog(userId)) {
        this.saveSuspiciousEmptySync(userId, now);
        return this.cachedResponse(userId, includeArchived, true);
      }
      this.saveSuccessfulSync(userId, active, completed, now);
      return this.cachedResponse(userId, includeArchived, false);
    } catch (error) {
      const code = error instanceof CourseCatalogError
        ? error.code
        : asCanvasApiError(error).code;
      this.saveFailedSync(userId, code, now);
      const failedState = this.syncState(userId);
      if (failedState?.last_success_at === null || failedState?.last_success_at === undefined) {
        if (error instanceof CourseCatalogError) throw error;
        throw new CourseCatalogError(
          "canvas_unavailable",
          "The Hanyang course catalog is temporarily unavailable.",
          502,
        );
      }
      return this.cachedResponse(userId, includeArchived, true);
    }
  }

  async getTimetableForLecture(): Promise<HanyangTimetable> {
    const ownerCanvasUserId = getImportedTimetableOwnerId();
    const candidates = this.options.db.prepare(
      "SELECT user_id FROM canvas_connections WHERE institution = 'hanyang' AND canvas_user_id = ?",
    ).all(ownerCanvasUserId) as Array<{ user_id: string }>;
    if (candidates.length !== 1) {
      throw new CourseCatalogError("timetable_owner_unavailable", "The imported timetable owner has no unique Canvas connection.", 403);
    }
    this.assertLectureOwner(candidates[0]!.user_id);
    const connection = this.options.getConnection(candidates[0]!.user_id);
    const client = new CanvasRestClient(connection, this.options.fetch ? { fetch: this.options.fetch } : {});
    const status = await client.connectionStatus();
    return getHanyangTimetable(status.profile.id, new Date(this.clock()));
  }

  assertLectureOwner(userId: string): void {
    if (this.soleHanyangUserId() !== userId) {
      throw new CourseCatalogError(
        "lecture_owner_mismatch",
        "The authenticated user is not the configured Study Lecture owner.",
        403,
      );
    }
  }

  private readonly schoolLaunchCache = new LearningXSessionCache();

  async discoverSchoolViewers(courseId: string): Promise<SchoolViewer[]> {
    const catalog = await this.listForLecture(false);
    if (!catalog.courses.some(course => course.id === courseId && course.status === "active")) {
      throw new CourseCatalogError("course_unavailable", "An active Hanyang course is required.", 403);
    }
    const client = new LearningXReadClient(this.options.getConnection(this.soleHanyangUserId()), {
      sessionCache: this.schoolLaunchCache, ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    const modules = await client.listModules(courseId).catch(error => {
      if (error instanceof CanvasApiError && error.code === "not_found") return [];
      throw error;
    });
    const viewers = modules.flatMap(module => module.items.flatMap(item => item.translive
      ? [{ courseId, viewerId: item.translive.id, moduleItemId: item.moduleItemId ?? null,
          title: `${module.name} · ${item.title}`.slice(0, 500) }] : []));
    return [...new Map(viewers.map(viewer => [viewer.viewerId, viewer])).values()].slice(0, 200);
  }

  private soleHanyangUserId(): string {
    const rows = this.options.db
      .prepare(
        `SELECT user_id
         FROM canvas_connections
         WHERE institution = 'hanyang'
           AND user_id = (SELECT user_id FROM lecture_owner WHERE singleton = 1)`,
      )
      .all() as Array<{ user_id: string }>;
    if (rows.length === 0) {
      throw new CourseCatalogError(
        "canvas_connection_missing",
        "No Hanyang Canvas account is connected.",
      );
    }
    if (rows.length !== 1) {
      throw new CourseCatalogError(
        "ambiguous_canvas_owner",
        "The private Study service requires exactly one Hanyang Canvas account.",
      );
    }
    return rows[0]!.user_id;
  }

  private syncState(userId: string): SyncStateRow | null {
    return (this.options.db
      .prepare(
        `SELECT last_attempt_at, last_success_at, last_result_count, last_error_code
         FROM course_sync_state WHERE user_id = ?`,
      )
      .get(userId) as SyncStateRow | undefined) ?? null;
  }

  private cachedResponse(
    userId: string,
    includeArchived: boolean,
    stale: boolean,
  ): CourseCatalogResponse {
    const state = this.syncState(userId);
    const rows = this.options.db
      .prepare(
        `SELECT canvas_course_id, course_code, name, term_name, start_at, end_at,
                folder_name, status, last_seen_at, archived_at
         FROM course_catalog
         WHERE user_id = ?
           AND (? = 1 OR (present_in_latest_sync = 1 AND status = 'active'))
         ORDER BY status ASC, term_name DESC, course_code ASC, name ASC`,
      )
      .all(userId, includeArchived ? 1 : 0) as CatalogRow[];
    return {
      courses: rows.map(toCourseOption),
      syncedAt: isoTime(state?.last_success_at ?? null),
      stale,
    };
  }

  private saveSuccessfulSync(
    userId: string,
    active: CanvasCourse[],
    completed: CanvasCourse[],
    now: number,
  ): void {
    const normalized = new Map<string, NormalizedCourse>();
    for (const course of completed) {
      normalized.set(course.id, normalizeCourse(course, "completed"));
    }
    for (const course of active) {
      normalized.set(course.id, normalizeCourse(course, "active"));
    }

    const apply = this.options.db.transaction(() => {
      this.options.db
        .prepare("UPDATE course_catalog SET present_in_latest_sync = 0 WHERE user_id = ?")
        .run(userId);

      const existingStatement = this.options.db.prepare(
        `SELECT first_seen_at, archived_at, snapshot_hash
         FROM course_catalog WHERE user_id = ? AND canvas_course_id = ?`,
      );
      const upsert = this.options.db.prepare(
        `INSERT INTO course_catalog(
           user_id, canvas_course_id, course_code, name, term_id, term_name,
           workflow_state, enrollment_state, start_at, end_at, folder_name, status,
           first_seen_at, last_seen_at, archived_at, snapshot_hash, present_in_latest_sync
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(user_id, canvas_course_id) DO UPDATE SET
           course_code = excluded.course_code,
           name = excluded.name,
           term_id = excluded.term_id,
           term_name = excluded.term_name,
           workflow_state = excluded.workflow_state,
           enrollment_state = excluded.enrollment_state,
           start_at = excluded.start_at,
           end_at = excluded.end_at,
           folder_name = excluded.folder_name,
           status = excluded.status,
           last_seen_at = excluded.last_seen_at,
           archived_at = excluded.archived_at,
           snapshot_hash = excluded.snapshot_hash,
           present_in_latest_sync = 1`,
      );
      const snapshot = this.options.db.prepare(
        `INSERT INTO course_snapshots(
           user_id, canvas_course_id, captured_at, snapshot_hash, metadata_json
         ) VALUES (?, ?, ?, ?, ?)`,
      );

      for (const course of normalized.values()) {
        const existing = existingStatement.get(userId, course.id) as
          | { first_seen_at: number; archived_at: number | null; snapshot_hash: string }
          | undefined;
        const archivedAt = course.status === "archived"
          ? existing?.archived_at ?? now
          : null;
        upsert.run(
          userId,
          course.id,
          course.code,
          course.name,
          course.termId,
          course.termName,
          course.workflowState,
          course.enrollmentState,
          course.startAt,
          course.endAt,
          course.folderName,
          course.status,
          existing?.first_seen_at ?? now,
          now,
          archivedAt,
          course.snapshotHash,
        );
        if (!existing || existing.snapshot_hash !== course.snapshotHash) {
          snapshot.run(userId, course.id, now, course.snapshotHash, course.metadataJson);
        }
      }


      const missingActiveCourses = this.options.db.prepare(
        `SELECT canvas_course_id, course_code, name, term_id, term_name,
                workflow_state, enrollment_state, start_at, end_at, folder_name
         FROM course_catalog
         WHERE user_id = ? AND present_in_latest_sync = 0 AND status = 'active'`,
      ).all(userId) as Array<{
        canvas_course_id: string;
        course_code: string | null;
        name: string;
        term_id: string | null;
        term_name: string | null;
        workflow_state: string | null;
        enrollment_state: "active" | "completed";
        start_at: string | null;
        end_at: string | null;
        folder_name: string;
      }>;
      const archiveMissing = this.options.db.prepare(
        `UPDATE course_catalog
         SET status = 'archived', archived_at = COALESCE(archived_at, ?), snapshot_hash = ?
         WHERE user_id = ? AND canvas_course_id = ? AND present_in_latest_sync = 0 AND status = 'active'`,
      );
      for (const course of missingActiveCourses) {
        const metadataJson = JSON.stringify({
          id: course.canvas_course_id,
          code: course.course_code,
          name: course.name,
          termId: course.term_id,
          termName: course.term_name,
          workflowState: course.workflow_state,
          enrollmentState: course.enrollment_state,
          startAt: course.start_at,
          endAt: course.end_at,
          folderName: course.folder_name,
          status: "archived",
          archiveReason: "missing_from_latest_sync",
        });
        const snapshotHash = createHash("sha256").update(metadataJson, "utf8").digest("hex");
        archiveMissing.run(now, snapshotHash, userId, course.canvas_course_id);
        snapshot.run(userId, course.canvas_course_id, now, snapshotHash, metadataJson);
      }

      this.options.db.prepare(
        `INSERT INTO course_sync_state(
           user_id, last_attempt_at, last_success_at, last_nonempty_at,
           last_result_count, last_error_code
         ) VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(user_id) DO UPDATE SET
           last_attempt_at = excluded.last_attempt_at,
           last_success_at = excluded.last_success_at,
           last_nonempty_at = CASE
             WHEN excluded.last_result_count > 0 THEN excluded.last_success_at
             ELSE course_sync_state.last_nonempty_at
           END,
           last_result_count = excluded.last_result_count,
           last_error_code = NULL`,
      ).run(
        userId,
        now,
        now,
        normalized.size > 0 ? now : null,
        normalized.size,
      );
    });
    apply();
  }

  private saveFailedSync(userId: string, code: string, now: number): void {
    this.options.db.prepare(
      `INSERT INTO course_sync_state(user_id, last_attempt_at, last_error_code)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         last_attempt_at = excluded.last_attempt_at,
         last_error_code = excluded.last_error_code`,
    ).run(userId, now, code);
  }

  private hasCatalog(userId: string): boolean {
    return this.options.db
      .prepare("SELECT 1 FROM course_catalog WHERE user_id = ? LIMIT 1")
      .get(userId) !== undefined;
  }

  private saveSuspiciousEmptySync(userId: string, now: number): void {
    this.options.db.prepare(
      `INSERT INTO course_sync_state(
         user_id, last_attempt_at, last_result_count, last_error_code
       ) VALUES (?, ?, 0, 'empty_result')
       ON CONFLICT(user_id) DO UPDATE SET
         last_attempt_at = excluded.last_attempt_at,
         last_result_count = 0,
         last_error_code = 'empty_result'`,
    ).run(userId, now);
  }
}
