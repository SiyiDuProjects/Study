import { describe, expect, it, vi } from "vitest";
import { CanvasRestClient } from "../src/canvas/client.js";
import type { CanvasConnection } from "../src/domain.js";
import { sanitizeHtml, plainText, safePublicUrl } from "../src/content.js";

const connection: CanvasConnection = { userId: "audit", institution: "hanyang", baseUrl: "https://learning.hanyang.ac.kr",
  accessToken: "synthetic-test-token", canvasUserId: "42", canvasName: "Synthetic" };
const now = () => new Date("2026-09-21T00:00:00Z");
const client = (data: unknown) => new CanvasRestClient(connection, { fetch: async () => Response.json(data), now });
const assignment = (id: number, submission: Record<string, unknown>) => ({ id, course_id: 7, name: `Task ${id}`,
  due_at: "2026-09-20T14:59:59Z", submission: { assignment_id: id, user_id: 42, ...submission } });

describe("coursework safety regressions", () => {
  it("finds graded missing work from all assignments instead of the upstream overdue bucket", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.has("bucket")).toBe(false);
      expect(url.searchParams.getAll("include[]")).toContain("submission");
      return Response.json([
        assignment(8, { workflow_state: "graded", missing: true, score: 0, submitted_at: null }),
        assignment(9, { workflow_state: "graded", missing: false, submitted_at: "2026-09-19T00:00:00Z" }),
        assignment(10, { workflow_state: "unsubmitted", excused: true }),
        assignment(11, { workflow_state: "graded", redo_request: true, submitted_at: "2026-09-19T00:00:00Z" }),
      ]);
    });
    const result = await new CanvasRestClient(connection, { fetch, now }).listAssignments(7, { bucket: "overdue", includeSubmission: false });
    expect(result.items.map(x => x.id)).toEqual(["8", "11"]);
    expect(result.items[0]?.submission).toMatchObject({ status: "missing", score: 0 });
    expect(result.coverage).toMatchObject({ courseId: "7", selection: "overdue", source: "all_assignments", submissionIncluded: true, queryExhausted: true });
  });

  it("continues a full-source overdue scan across pages of completed work", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get("page") === "2") return Response.json([assignment(8, { workflow_state: "graded", missing: true })]);
      return Response.json([assignment(9, { workflow_state: "submitted" })], {
        headers: { Link: '<https://learning.hanyang.ac.kr/api/v1/courses/7/assignments?page=2>; rel="next"' },
      });
    });
    const api = new CanvasRestClient(connection, { fetch, now, maxPages: 1 });
    const first = await api.listAssignments(7, { bucket: "overdue", limit: 1 });
    expect(first.items).toEqual([]);
    expect(first.coverage.queryExhausted).toBe(false);
    expect(first.nextCursor).toEqual(expect.any(String));
    const next = await api.listAssignments(7, { bucket: "overdue", limit: 1, cursor: first.nextCursor! });
    expect(next.items[0]?.id).toBe("8");
    expect(next.coverage.queryExhausted).toBe(true);
    await expect(api.listAssignments(7, { limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("does not label a future resubmission as overdue", async () => {
    const result = await client([{ ...assignment(8, { workflow_state: "graded", redo_request: true }), due_at: "2026-10-01T00:00:00Z" }]).listAssignments(7, { bucket: "overdue" });
    expect(result.items).toEqual([]);
  });

  it.each([
    [{ graded: true, missing: true, submitted: false }, "missing"],
    [{ graded: true, redo_request: true, submitted: true }, "resubmission_required"],
    [{ graded: true, submitted: false }, "unsubmitted"],
  ])("retains conflicting Planner flags even with a manual completion override: %j", async (flags, status) => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).searchParams.has("filter")).toBe(false);
      return Response.json([{ plannable_id: 8, plannable_type: "assignment", course_id: 7, submissions: flags,
        planner_override: { marked_complete: true, dismissed: true }, plannable: { title: "Task" } }]);
    });
    const result = await new CanvasRestClient(connection, { fetch, now }).getUpcomingWork();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ completed: false, submissionStatus: status, submissionFlags: { graded: true }, plannerOverride: { markedComplete: true, dismissed: true } });
  });

  it("keeps a grade or manual check alone from establishing assignment completion", async () => {
    const result = await client([{ plannable_id: 8, plannable_type: "assignment", submissions: { graded: true }, planner_override: { marked_complete: true } }]).getUpcomingWork();
    expect(result.items[0]?.completed).toBeNull();
  });

  it("keeps an announcement display/publication date separate from its deadline", async () => {
    const result = await client([{ plannable_id: 8, plannable_type: "announcement", plannable_date: "2026-09-06T06:52:12Z", plannable: { title: "Class September 21" } }]).getUpcomingWork();
    expect(result.items[0]).toMatchObject({ date: "2026-09-06T06:52:12Z", dueAt: null });
  });

  it("preserves locks, attempts and resubmission facts in detail and history", async () => {
    const result = await client({ ...assignment(8, { workflow_state: "graded", redo_request: true, extra_attempts: 2 }),
      locked_for_user: true, lock_at: null, lock_explanation: "<p>Module locked</p>", allowed_attempts: 1 }).getAssignment(7, 8);
    expect(result).toMatchObject({ lockedForUser: true, lockAt: null, lockExplanation: "Module locked", allowedAttempts: 1,
      submission: { status: "resubmission_required", redoRequest: true, extraAttempts: 2 } });
    const history = await client({ workflow_state: "submitted", submission_history: [{ workflow_state: "graded", redo_request: true }] }).getSubmissionStatus(7, 8, true);
    expect(history.history[0]?.redoRequest).toBe(true);
  });

  it.each([
    {}, { assignment_id: 999, workflow_state: "submitted" }, { user_id: 99, workflow_state: "graded" },
    { course_id: 99, workflow_state: "submitted" }, { id: "bad", workflow_state: "submitted" },
    { workflow_state: "graded", missing: "true" },
  ])("rejects malformed or mismatched submissions: %j", async data => {
    await expect(client(data).getSubmissionStatus(7, 8)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([{}, { id: "bad" }, { id: 999 }, { id: 8, course_id: 999 }, { id: 8, submission: [] }])("rejects invalid assignment detail: %j", async data => {
    await expect(client(data).getAssignment(7, 8)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects missing IDs in assignment lists and mismatched embedded submissions", async () => {
    await expect(client([{}]).listAssignments(7)).rejects.toMatchObject({ code: "invalid_response" });
    await expect(client([assignment(8, { assignment_id: 9, workflow_state: "submitted" })]).listAssignments(7)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("retains unknown state instead of manufacturing an unsubmitted fact", async () => {
    const result = await client({ id: 123, workflow_state: "future_state" }).getSubmissionStatus(7, 8);
    expect(result).toMatchObject({ status: "unknown", missing: null, late: null, redoRequest: null, score: null });
  });

  it("does not silently drop malformed attempt history or accept ambiguous Planner flags", async () => {
    await expect(client({ workflow_state: "graded", submission_history: [null] }).getSubmissionStatus(7, 8, true))
      .rejects.toMatchObject({ code: "invalid_response" });
    await expect(client([{ plannable_id: 8, plannable_type: "assignment", submissions: { submitted: true, missing: "true" } }]).getUpcomingWork())
      .rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("safe coursework content without silent evidence loss", () => {
  it("keeps numeric resource locators and strips credential parameters and fragments", () => {
    expect(safePublicUrl("https://school.example/view?id=27&token=synthetic-secret#secret")).toBe("https://school.example/view?id=27");
    expect(safePublicUrl("/view?id=27&verifier=synthetic-secret")).toBe("/view?id=27");
    expect(safePublicUrl("https://school.example/view?id=synthetic-secret")).toBe("https://school.example/view");
  });

  it("removes capability queries from visible text, link labels and image alt text", () => {
    const html = sanitizeHtml('<p>https://school.example/join?token=synthetic-secret</p><a href="https://school.example/join?token=synthetic-secret">https://school.example/join?token=synthetic-secret</a><img alt="https://school.example/join?token=synthetic-secret">');
    expect(html).not.toContain("synthetic-secret");
    expect(plainText(html)).not.toContain("synthetic-secret");
    expect(html).toContain("Link parameters omitted");
  });

  it("preserves a safe school file reference without rendering an active embed", () => {
    const html = sanitizeHtml('<iframe src="https://learning.hanyang.ac.kr/courses/7/files/123/preview?verifier=synthetic-secret"></iframe>');
    expect(html).toContain("/files/123/preview");
    expect(html).toContain("Embedded content not read");
    expect(html).not.toMatch(/iframe|synthetic-secret/);
  });

  it("marks unsupported embeds as missing evidence without surfacing arbitrary targets", () => {
    const html = sanitizeHtml('<iframe src="https://attacker.example/collect"></iframe><script>synthetic-secret</script>');
    expect(html).toBe("[Embedded content not read]");
  });
});
