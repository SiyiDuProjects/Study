import { describe, expect, it, vi } from "vitest";

import type { CanvasConnection } from "../src/domain.js";
import { CanvasApiError, CanvasRestClient } from "../src/canvas/index.js";

const connection: CanvasConnection = {
  userId: "app-user-1",
  institution: "hanyang",
  baseUrl: "https://learning.hanyang.ac.kr",
  accessToken: "secret-pat",
  canvasUserId: "42",
  canvasName: "Student",
};

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function mockFetch(
  implementation: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>,
): typeof globalThis.fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    implementation(new URL(String(input)), init),
  ) as unknown as typeof globalThis.fetch;
}

describe("CanvasRestClient", () => {
  it("filters persistent active old courses by exact term across pages without losing continuations", async () => {
    const current = { id: 5751, name: "Fall 2026", start_at: "2026-08-01T07:00:00Z", end_at: null };
    const past = { id: 5648, name: "Fall 2025", start_at: "2025-08-01T07:00:00Z", end_at: null };
    const fetch = mockFetch((url, init) => {
      expect(init?.method).toBe("GET");
      expect(url.searchParams.has("enrollment_term_id")).toBe(false);
      if (url.searchParams.get("page") === "2") return json([
        { id: 3, term: current },
        { id: 4, term: { id: 1818, name: "Default Term" } },
        { id: 5, enrollment_term_id: 5751 },
      ]);
      return json([{ id: 1, term: past, workflow_state: "available" }, { id: 2, term: current }], {
        headers: { Link: '<https://learning.hanyang.ac.kr/api/v1/courses?page=2>; rel="next"' },
      });
    });
    const client = new CanvasRestClient(connection, { fetch });
    const first = await client.listCourses({ termId: "5751", limit: 1 });
    expect(first.items.map(c => c.id)).toEqual(["2"]);
    const second = await client.listCourses({ termId: "5751", limit: 1, cursor: first.nextCursor! });
    expect(second.items.map(c => c.id)).toEqual(["3"]);
    const third = await client.listCourses({ termId: "5751", limit: 1, cursor: second.nextCursor! });
    expect(third.items.map(c => c.id)).toEqual(["5"]);
    expect(third.nextCursor).toBeNull();
    const callsBefore = vi.mocked(fetch).mock.calls.length;
    await expect(client.listCourses({ termId: "5648", limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(client.listCourses({ limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "invalid_argument" });
    expect(fetch).toHaveBeenCalledTimes(callsBefore);
    expect((await client.listCourses({ termId: "5751", courseIds: [2, 4] })).items.map(c => c.id)).toEqual(["2"]);
    expect((await client.listCourses({ termId: "5648" })).items.map(c => c.id)).toEqual(["1"]);
    expect((await client.listCourses()).items.map(c => c.id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("does not mistake an empty term-filtered scan budget for the end of the collection", async () => {
    const fetch = mockFetch(url => url.searchParams.get("page") === "2"
      ? json([{ id: 2, term: { id: 5751, name: "Fall 2026" } }])
      : json([{ id: 1, term: { id: 5648, name: "Fall 2025" } }], {
        headers: { Link: '<https://learning.hanyang.ac.kr/api/v1/courses?page=2>; rel="next"' },
      }));
    const client = new CanvasRestClient(connection, { fetch, maxPages: 1 });
    const first = await client.listCourses({ termId: "5751" });
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const last = await client.listCourses({ termId: "5751", cursor: first.nextCursor! });
    expect(last.items.map(c => c.id)).toEqual(["2"]);
    expect(last.nextCursor).toBeNull();
  });

  it("preserves ambiguous HY-ON 401 denials without interpreting translated wording", async () => {
    const fetch = mockFetch(() => json({
      status: "未授权",
      errors: [{ message: "用户无权执行该操作" }],
    }, { status: 401 }));
    const client = new CanvasRestClient(connection, { fetch });
    await expect(client.listFiles(7)).rejects.toMatchObject({
      code: "access_denied", status: 401, retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not diagnose an expired credential from a resource denial alone", async () => {
    const fetch = mockFetch(() => json({
      status: "unauthorized", errors: [{ message: "Invalid access token." }],
    }, { status: 401 }));
    const client = new CanvasRestClient(connection, { fetch });
    await expect(client.listFiles(7)).rejects.toMatchObject({
      code: "access_denied", status: 401, retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("requires the connection base URL to match the institution allowlist", () => {
    expect(
      () =>
        new CanvasRestClient({
          ...connection,
          baseUrl: "https://attacker.example",
        }),
    ).toThrowError(CanvasApiError);
  });

  it("rejects a path-like Canvas ID before making any request", async () => {
    const fetch = mockFetch(() => json({}));
    const client = new CanvasRestClient(connection, { fetch });

    await expect(client.getCourse("../users/self")).rejects.toMatchObject({ code: "invalid_argument" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a reversed Planner date window before making any request", async () => {
    const fetch = mockFetch(() => json([]));
    const client = new CanvasRestClient(connection, { fetch });

    await expect(client.getUpcomingWork({
      startAt: "2026-09-14T00:00:00Z",
      endAt: "2026-09-07T00:00:00Z",
    })).rejects.toMatchObject({ code: "invalid_argument" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses a Bearer token, GET only, and sanitizes untrusted Canvas HTML", async () => {
    const fetch = mockFetch((url, init) => {
      expect(url.origin).toBe("https://learning.hanyang.ac.kr");
      expect(url.pathname).toBe("/api/v1/courses/7");
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-pat");
      expect(init?.body).toBeUndefined();
      return json({
        id: 7,
        name: "Safety 101",
        syllabus_body:
          '<style>body{display:none}</style><p onclick="steal()">Read this</p><script>steal()</script><a href="javascript:steal()">link</a>',
      });
    });
    const client = new CanvasRestClient(connection, { fetch });

    const course = await client.getCourse(7);

    expect(course.syllabusBody).toContain("Read this");
    expect(course.syllabusBody).not.toMatch(/script|style|onclick|javascript:/i);
    expect(course.syllabusText).toContain("Read this");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("follows only same-origin HTTPS Canvas pagination links", async () => {
    const fetch = mockFetch((url) => {
      if (url.searchParams.get("page") === "2") {
        return json([{ id: 2, name: "Second" }]);
      }
      return json([{ id: 1, name: "First" }], {
        headers: {
          Link: '<https://learning.hanyang.ac.kr/api/v1/courses?page=2>; rel="next"',
        },
      });
    });
    const client = new CanvasRestClient(connection, { fetch });

    const courses = await client.listCourses({ limit: 10 });

    expect(courses.items.map((course) => course.id)).toEqual(["1", "2"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    "https://attacker.example/api/v1/courses?page=2",
    "http://learning.hanyang.ac.kr/api/v1/courses?page=2",
    "https://learning.hanyang.ac.kr/login?page=2",
  ])("rejects an unsafe next link before sending the token: %s", async (link) => {
    const fetch = mockFetch(() =>
      json([{ id: 1, name: "First" }], {
        headers: { Link: `<${link}>; rel="next"` },
      }),
    );
    const client = new CanvasRestClient(connection, { fetch });

    await expect(client.listCourses({ limit: 10 })).rejects.toMatchObject({
      code: "unsafe_pagination",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a self-referencing next link even when the requested page is already full", async () => {
    const fetch = mockFetch((url) => json([{ id: 7, name: "First" }], {
      headers: { Link: `<${url.href}>; rel="next"` },
    }));
    const client = new CanvasRestClient(connection, { fetch });

    await expect(client.listCourses({ limit: 1 })).rejects.toMatchObject({ code: "unsafe_pagination" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("normalizes Canvas HTTP errors without exposing the token", async () => {
    const fetch = mockFetch(() =>
      json(
        { errors: [{ message: "Invalid access token" }] },
        { status: 401, headers: { "x-request-context-id": "request-123" } },
      ),
    );
    const client = new CanvasRestClient(connection, { fetch });

    await expect(client.connectionStatus()).rejects.toMatchObject({
      code: "authentication_failed",
      status: 401,
      requestId: "request-123",
      retryable: false,
      message: "Canvas rejected the configured connection during its own-profile check.",
    });
    await client.connectionStatus().catch((error: unknown) => {
      expect(String(error)).not.toContain("secret-pat");
    });
  });

  it("normalizes aborts as retryable timeouts", async () => {
    const fetch = mockFetch(() => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    const client = new CanvasRestClient(connection, { fetch, timeoutMs: 100 });

    await expect(client.connectionStatus()).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });
  });

  it("stops reading Canvas responses that exceed the byte safety limit", async () => {
    const fetch = mockFetch(() =>
      json({ id: 42, name: "Student", padding: "x".repeat(256) }),
    );
    const client = new CanvasRestClient(connection, { fetch, maxResponseBytes: 64 });

    await expect(client.connectionStatus()).rejects.toMatchObject({
      code: "invalid_response",
      retryable: false,
    });
  });

  it("downloads a Canvas file while sending the PAT only to the metadata API", async () => {
    const fetch = mockFetch((url, init) => {
      if (url.pathname === "/api/v1/files/52") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-pat");
        return json({
          id: 52,
          display_name: "Course notes.pdf",
          filename: "course-notes.pdf",
          "content-type": "application/pdf",
          size: 4,
          url: "https://learning.hanyang.ac.kr/files/52/download?verifier=secret",
        });
      }
      expect(url.pathname).toBe("/files/52/download");
      expect(url.searchParams.get("verifier")).toBe("secret");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(init?.method).toBe("GET");
      return new Response(Uint8Array.from([37, 80, 68, 70]), {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "4" },
      });
    });
    const client = new CanvasRestClient(connection, { fetch, maxFileBytes: 64 });

    const download = await client.downloadFile(52);

    expect(download.file).toMatchObject({ id: "52", filename: "course-notes.pdf" });
    expect(download.contentType).toBe("application/pdf");
    expect([...download.bytes]).toEqual([37, 80, 68, 70]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects foreign Canvas file URLs before making a download request", async () => {
    const fetch = mockFetch(() =>
      json({
        id: 52,
        filename: "course-notes.pdf",
        size: 4,
        url: "https://attacker.example/files/52/download",
      }),
    );
    const client = new CanvasRestClient(connection, { fetch, maxFileBytes: 64 });

    await expect(client.downloadFile(52)).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized Canvas files before downloading their bytes", async () => {
    const fetch = mockFetch(() =>
      json({
        id: 52,
        filename: "large.zip",
        size: 65,
        url: "https://learning.hanyang.ac.kr/files/52/download",
      }),
    );
    const client = new CanvasRestClient(connection, { fetch, maxFileBytes: 64 });

    await expect(client.downloadFile(52)).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("normalizes self-submission semantics and never follows attachment URLs", async () => {
    const fetch = mockFetch((url) => {
      expect(url.pathname).toBe("/api/v1/courses/7/assignments/9/submissions/self");
      return json({
        id: 50,
        assignment_id: 9,
        workflow_state: "graded",
        submitted_at: "2026-08-16T20:00:00Z",
        score: 9,
        grade: "9",
        late: true,
        missing: false,
        preview_url: "https://learning.hanyang.ac.kr/submissions/50?verifier=secret",
        attachments: [
          {
            id: 99,
            filename: "answer.pdf",
            url: "https://attacker.example/download",
          },
        ],
      });
    });
    const client = new CanvasRestClient(connection, { fetch });

    const submission = await client.getSubmissionStatus(7, 9);

    expect(submission).toMatchObject({ status: "graded", late: true, missing: false });
    expect(submission.attachments[0]).toEqual({
      id: "99",
      filename: "answer.pdf",
      displayName: null,
      contentType: null,
      size: null,
    });
    expect(JSON.stringify(submission)).not.toContain("attacker.example");
    expect(JSON.stringify(submission)).not.toContain("verifier");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads Inbox without marking messages read and sanitizes conversation bodies", async () => {
    const fetch = mockFetch((url, init) => {
      expect(init?.method).toBe("GET");
      if (url.pathname === "/api/v1/conversations") {
        expect(url.searchParams.get("scope")).toBe("unread");
        return json([
          {
            id: 12,
            subject: "Office hours",
            workflow_state: "unread",
            last_message: "<b>See you</b><script>steal()</script>",
            last_message_at: "2026-08-30T01:00:00Z",
            message_count: 1,
            participants: [{ id: 3, name: "Teacher", full_name: "Teacher Name" }],
          },
        ]);
      }
      expect(url.pathname).toBe("/api/v1/conversations/12");
      expect(url.searchParams.get("auto_mark_as_read")).toBe("false");
      return json({
        id: 12,
        subject: "Office hours",
        workflow_state: "unread",
        messages: [
          {
            id: 13,
            author_id: 3,
            body: '<p onclick="steal()">Message</p><iframe src="https://attacker.example"></iframe>',
            attachments: [{ id: 14, filename: "notes.pdf", url: "https://attacker.example/file" }],
          },
        ],
      });
    });
    const client = new CanvasRestClient(connection, { fetch });

    const summaries = await client.listConversations({ scope: "unread", limit: 10 });
    const conversation = await client.getConversation(12);

    expect(summaries.items[0]).toMatchObject({ id: "12", lastMessage: "See you" });
    expect(conversation.messages[0]).toMatchObject({ bodyText: expect.stringContaining("Message") });
    expect(conversation.messages[0]?.bodyText).toContain("[Embedded content not read]");
    expect(conversation.messages[0]?.bodyHtml).not.toMatch(/onclick|iframe/i);
    expect(JSON.stringify(conversation)).not.toMatch(/attacker\.example/i);
  });

  it("lists only the authenticated student's course submissions with sanitized feedback", async () => {
    const fetch = mockFetch((url) => {
      expect(url.pathname).toBe("/api/v1/courses/7/students/submissions");
      expect(url.searchParams.getAll("student_ids[]")).toEqual(["self"]);
      expect(url.searchParams.getAll("include[]")).toEqual([
        "assignment",
        "submission_comments",
        "submission_history",
      ]);
      return json([
        {
          id: 50,
          assignment_id: 9,
          workflow_state: "graded",
          assignment: { id: 9, name: "Essay", due_at: "2026-09-01T00:00:00Z" },
          submission_comments: [
            {
              id: 51,
              author_name: "Teacher",
              comment: '<p onmouseover="steal()">Good work</p>',
              attachments: [{ id: 52, filename: "rubric.pdf", url: "https://attacker.example" }],
            },
          ],
          submission_history: [{ id: 49, assignment_id: 9, workflow_state: "submitted" }],
        },
      ]);
    });
    const client = new CanvasRestClient(connection, { fetch });

    const submissions = await client.listCourseSubmissions(7, { includeHistory: true });

    expect(submissions.items[0]).toMatchObject({
      assignment: { id: "9", name: "Essay" },
      comments: [{ authorName: "Teacher", commentText: "Good work" }],
    });
    expect(submissions.items[0]).toMatchObject({ status: "graded", score: null, grade: null });
    expect(submissions.items[0]?.comments[0]?.commentHtml).not.toMatch(/onmouseover/i);
    expect(JSON.stringify(submissions)).not.toMatch(/attacker\.example/i);
  });

  it("returns posted grades only and omits unposted grade fields", async () => {
    const fetch = mockFetch(() =>
      json([
        {
          id: 12,
          course_id: 7,
          enrollment_state: "active",
          grades: {
            current_score: 91,
            current_grade: "A-",
            final_score: 89,
            final_grade: "B+",
            current_points: 182,
            unposted_current_score: 99,
            unposted_current_grade: "A+",
          },
        },
      ]),
    );
    const client = new CanvasRestClient(connection, { fetch });

    const grades = await client.getGrades({ courseId: 7 });

    expect(grades.items[0]).toMatchObject({ currentScore: 91, currentGrade: "A-" });
    expect(grades.items[0]).not.toHaveProperty("unpostedCurrentScore");
    expect(grades.items[0]).not.toHaveProperty("unpostedCurrentGrade");
  });

  it("normalizes expanded course content without exposing file download URLs or active HTML", async () => {
    const fetch = mockFetch((url) => {
      if (url.pathname.endsWith("/tabs")) {
        return json([
          {
            id: "context_external_tool_123",
            label: "LearningX",
            html_url: "https://learning.example/course-tool",
          },
        ]);
      }
      if (url.pathname.endsWith("/quizzes")) {
        return json([{ id: 8, title: "Quiz", description: "<script>x()</script><p>Read</p>" }]);
      }
      if (url.pathname.endsWith("/discussion_topics")) {
        return json([{ id: 9, title: "Topic", message: "<p onclick=bad()>Discuss</p>" }]);
      }
      if (url.pathname.endsWith("/discussion_topics/9/entries")) {
        return json([{ id: 10, message: "<p>Answer</p>", recent_replies: [] }]);
      }
      if (url.pathname.endsWith("/pages/week-1")) {
        return json({ url: "week-1", title: "Week 1", body: "<iframe src=x></iframe><p>Page</p>" });
      }
      if (url.pathname.endsWith("/pages")) {
        return json([{ url: "week-1", title: "Week 1" }]);
      }
      if (url.pathname.endsWith("/files")) {
        return json([
          {
            id: 11,
            filename: "notes.pdf",
            display_name: "Notes",
            url: "https://files.example/download?verifier=secret",
          },
        ]);
      }
      return json({ message: "unexpected" }, { status: 404 });
    });
    const client = new CanvasRestClient(connection, { fetch });

    const [tabs, quizzes, topics, entries, pages, page, files] = await Promise.all([
      client.listCourseTabs(7),
      client.listQuizzes(7),
      client.listDiscussionTopics(7),
      client.listDiscussionEntries(7, 9),
      client.listPages(7),
      client.getPage(7, "week-1"),
      client.listFiles(7),
    ]);

    expect(tabs.items[0]?.externalToolId).toBe("123");
    expect(quizzes.items[0]?.descriptionText).toBe("Read");
    expect(topics.items[0]?.messageHtml).not.toMatch(/onclick/i);
    expect(entries.items[0]?.messageText).toBe("Answer");
    expect(pages.items[0]?.url).toBe("week-1");
    expect(page.bodyHtml).not.toMatch(/iframe/i);
    expect(JSON.stringify(files)).not.toMatch(/verifier|files\.example/i);
  });

  it("implements every supported operation through fixed read-only API paths", async () => {
    const seen = new Set<string>();
    const fetch = mockFetch((url, init) => {
      expect(init?.method).toBe("GET");
      expect(url.protocol).toBe("https:");
      expect(url.origin).toBe("https://learning.hanyang.ac.kr");
      seen.add(url.pathname);

      if (url.pathname === "/api/v1/users/self/profile") {
        return json({ id: 42, name: "Student" });
      }
      if (url.pathname === "/api/v1/courses") return json([]);
      if (url.pathname === "/api/v1/courses/7") return json({ id: 7, name: "Course" });
      if (url.pathname === "/api/v1/courses/7/assignments") return json([]);
      if (url.pathname === "/api/v1/courses/7/assignments/9") {
        return json({ id: 9, course_id: 7, name: "Assignment" });
      }
      if (url.pathname === "/api/v1/announcements") return json([]);
      if (url.pathname === "/api/v1/courses/7/modules") return json([]);
      if (url.pathname === "/api/v1/courses/7/tabs") return json([]);
      if (url.pathname === "/api/v1/courses/7/quizzes") return json([]);
      if (url.pathname === "/api/v1/courses/7/discussion_topics") return json([]);
      if (url.pathname === "/api/v1/courses/7/discussion_topics/8/entries") return json([]);
      if (url.pathname === "/api/v1/courses/7/pages") return json([]);
      if (url.pathname === "/api/v1/courses/7/pages/week-1") {
        return json({ url: "week-1", title: "Week 1", body: "<p>Welcome</p>" });
      }
      if (url.pathname === "/api/v1/courses/7/files") return json([]);
      if (url.pathname === "/api/v1/conversations") return json([]);
      if (url.pathname === "/api/v1/conversations/12") {
        expect(url.searchParams.get("auto_mark_as_read")).toBe("false");
        return json({ id: 12, messages: [] });
      }
      if (url.pathname === "/api/v1/courses/7/students/submissions") return json([]);
      if (url.pathname === "/api/v1/calendar_events") return json([]);
      if (url.pathname === "/api/v1/planner/items") return json([]);
      if (url.pathname === "/api/v1/courses/7/assignments/9/submissions/self") {
        return json({ assignment_id: 9, workflow_state: "unsubmitted" });
      }
      if (url.pathname === "/api/v1/users/self/enrollments") return json([]);
      return json({ message: "unexpected path" }, { status: 404 });
    });
    const client = new CanvasRestClient(connection, {
      fetch,
      now: () => new Date("2026-08-17T12:00:00Z"),
    });

    await client.connectionStatus();
    await client.listCourses();
    await client.getCourse(7);
    await client.listAssignments(7);
    await client.getAssignment(7, 9);
    await client.listAnnouncements(7);
    await client.listModules(7);
    await client.listCourseTabs(7);
    await client.listQuizzes(7);
    await client.listDiscussionTopics(7);
    await client.listDiscussionEntries(7, 8);
    await client.listPages(7);
    await client.getPage(7, "week-1");
    await client.listFiles(7);
    await client.listConversations();
    await client.getConversation(12);
    await client.listCourseSubmissions(7);
    await client.listCalendarEvents();
    await client.getUpcomingWork();
    await client.getSubmissionStatus(7, 9);
    await client.getGrades();
    await client.weeklySummary();

    expect(seen).toEqual(
      new Set([
        "/api/v1/users/self/profile",
        "/api/v1/courses",
        "/api/v1/courses/7",
        "/api/v1/courses/7/assignments",
        "/api/v1/courses/7/assignments/9",
        "/api/v1/announcements",
        "/api/v1/courses/7/modules",
        "/api/v1/courses/7/tabs",
        "/api/v1/courses/7/quizzes",
        "/api/v1/courses/7/discussion_topics",
        "/api/v1/courses/7/discussion_topics/8/entries",
        "/api/v1/courses/7/pages",
        "/api/v1/courses/7/pages/week-1",
        "/api/v1/courses/7/files",
        "/api/v1/conversations",
        "/api/v1/conversations/12",
        "/api/v1/courses/7/students/submissions",
        "/api/v1/calendar_events",
        "/api/v1/planner/items",
        "/api/v1/courses/7/assignments/9/submissions/self",
        "/api/v1/users/self/enrollments",
      ]),
    );
  });

  it("keeps the compatibility summary as independent fact pages with a separate notice window", async () => {
    const fetch = mockFetch((url) => {
      if (url.pathname === "/api/v1/courses") {
        return json([{ id: 7, name: "Course" }]);
      }
      if (url.pathname === "/api/v1/planner/items") {
        expect(url.searchParams.get("start_date")).toBe("2026-08-17T12:00:00.000Z");
        return json([
          {
            plannable_id: 9,
            plannable_type: "assignment",
            course_id: 7,
            plannable_date: "2026-08-18T18:00:00Z",
            plannable: { id: 9, title: "Essay", due_at: "2026-08-18T18:00:00Z" },
          },
        ]);
      }
      if (url.pathname === "/api/v1/calendar_events") {
        return json([
          {
            id: 3,
            title: "Lecture",
            context_code: "course_7",
            created_at: "2026-08-10T09:00:00Z",
            updated_at: "2026-08-17T11:30:00Z",
          },
        ]);
      }
      if (url.pathname === "/api/v1/announcements") {
        expect(url.searchParams.getAll("context_codes[]")).toEqual(["course_7"]);
        return json([
          {
            id: 4,
            context_code: "course_7",
            title: "Welcome",
            message: "<p>Hello</p>",
            posted_at: "2026-08-17T13:00:00Z",
          },
        ]);
      }
      return json({ message: "unexpected path" }, { status: 404 });
    });
    const client = new CanvasRestClient(connection, {
      fetch,
      now: () => new Date("2026-08-17T12:00:00Z"),
    });

    const summary = await client.weeklySummary();

    expect(summary.window).toEqual({
      startAt: "2026-08-17T12:00:00.000Z",
      endAt: "2026-08-24T12:00:00.000Z",
    });
    expect(summary.announcementsWindow).toEqual({
      startAt: "2026-08-03T12:00:00.000Z",
      endAt: "2026-08-24T12:00:00.000Z",
    });
    expect(summary.sources.courses.result?.items).toHaveLength(1);
    expect(summary.sources.upcomingWork.result?.items).toHaveLength(1);
    expect(summary.sources.announcements.result?.items).toHaveLength(1);
    expect(summary.sources.calendarEvents.result?.items[0]).toMatchObject({
      createdAt: "2026-08-10T09:00:00Z",
      updatedAt: "2026-08-17T11:30:00Z",
    });
    expect(summary.sources.announcements.result?.items[0]?.messageText).toBe("Hello");
  });

  it.each([
    [{ submitted: true }, "submitted", true],
    [{ needs_grading: true }, "submitted", true],
    [{ graded: true }, "graded", null],
    [{ excused: true }, "excused", true],
    [{ missing: true }, "missing", false],
    [{ submitted: false }, "unsubmitted", false],
    [{ graded: false, missing: false, needs_grading: false }, null, null],
    [false, null, null],
    [undefined, null, null],
  ])("reads Planner status flags without inventing missing Submission fields: %j", async (flags, status, completed) => {
    const client = new CanvasRestClient(connection, { fetch: mockFetch(() => json([{
      plannable_id: 9, plannable_type: "assignment", course_id: 7,
      plannable: { title: "Essay" }, submissions: flags,
    }])) });
    const page = await client.getUpcomingWork({ includeCompleted: true });
    expect(page.items[0]).toMatchObject({ submissionStatus: status, completed });
  });

  it("reads unfiltered Planner work and fills the limit after safe completion filtering", async () => {
    const fetch = mockFetch((url) => {
      if (url.searchParams.get("page") === "2") return json([
        { plannable_id: 3, plannable: { title: "Still due" }, submissions: { missing: true } },
        { plannable_id: 4, plannable: { title: "Unknown state" } },
      ]);
      expect(url.searchParams.has("filter")).toBe(false);
      return json([
        { plannable_id: 1, planner_override: { marked_complete: true } },
        { plannable_id: 2, submissions: { graded: true, submitted: true } },
      ], { headers: { Link: '<https://learning.hanyang.ac.kr/api/v1/planner/items?page=2>; rel="next"' } });
    });
    const page = await new CanvasRestClient(connection, { fetch }).getUpcomingWork({ limit: 2 });
    expect(page.items.map((item) => item.id)).toEqual(["3", "4"]);
    expect(page.nextCursor).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("resumes every remaining row when the upstream page exceeds the requested limit", async () => {
    const fetch = mockFetch((url) => url.searchParams.get("page") === "2"
      ? json([{ id: 4, subject: "Fourth" }])
      : json([{ id: 1 }, { id: 2 }, { id: 3 }], {
        headers: { Link: '<https://learning.hanyang.ac.kr/api/v1/conversations?page=2>; rel="next"' },
      }));
    const client = new CanvasRestClient(connection, { fetch });
    const first = await client.listConversations({ limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(["1", "2"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.nextCursor).not.toContain("secret-pat");
    const second = await new CanvasRestClient(connection, { fetch }).listConversations({ limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.id)).toEqual(["3", "4"]);
    expect(second.nextCursor).toBeNull();
  });

  it("rejects tampered, other-user, other-operation and changed-filter continuations before fetching", async () => {
    const fetch = mockFetch(() => json([{ id: 1 }, { id: 2 }]));
    const client = new CanvasRestClient(connection, { fetch });
    const { nextCursor } = await client.listConversations({ scope: "unread", limit: 1 });
    const args = { scope: "unread" as const, limit: 1, cursor: nextCursor! };
    const otherUser = new CanvasRestClient({ ...connection, userId: "another-app-user" }, { fetch });
    await expect(otherUser.listConversations(args)).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(client.listConversations({ ...args, scope: "sent" })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(client.listCourses({ cursor: nextCursor!, limit: 1 })).rejects.toMatchObject({ code: "invalid_argument" });
    const changed = `${nextCursor![0] === "A" ? "B" : "A"}${nextCursor!.slice(1)}`;
    await expect(client.listConversations({ ...args, cursor: changed })).rejects.toMatchObject({ code: "invalid_argument" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not let an upstream next link switch to another same-origin API operation", async () => {
    const fetch = mockFetch(() => json([{ id: 1 }], {
      headers: { Link: '<https://learning.hanyang.ac.kr/api/v1/users/self/profile>; rel="next"' },
    }));
    await expect(new CanvasRestClient(connection, { fetch }).listCourses({ limit: 1 }))
      .rejects.toMatchObject({ code: "unsafe_pagination" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("continues the original default date window even when wall time advances", async () => {
    let now = new Date("2026-09-07T12:00:00Z");
    const fetch = mockFetch(() => json([{ plannable_id: 1 }, { plannable_id: 2 }]));
    const client = new CanvasRestClient(connection, { fetch, now: () => now });
    const first = await client.getUpcomingWork({ limit: 1 });
    now = new Date("2026-09-08T12:00:00Z");
    const second = await client.getUpcomingWork({ limit: 1, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.id)).toEqual(["2"]);
    const secondUrl = new URL(String(vi.mocked(fetch).mock.calls[1]?.[0]));
    expect(secondUrl.searchParams.get("start_date")).toBe("2026-09-07T12:00:00.000Z");
  });

  it("returns a continuation when the per-call page budget is reached", async () => {
    const fetch = mockFetch((url) => url.searchParams.get("page") === "2"
      ? json([{ id: 2 }])
      : json([{ id: 1 }], { headers: { Link: '<https://learning.hanyang.ac.kr/api/v1/courses?page=2>; rel="next"' } }));
    const client = new CanvasRestClient(connection, { fetch, maxPages: 1 });
    const first = await client.listCourses({ limit: 10 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await client.listCourses({ limit: 10, cursor: first.nextCursor! });
    expect(second.items[0]?.id).toBe("2");
    expect(second.nextCursor).toBeNull();
  });

  it("keeps module metadata separate from explicitly paged child items", async () => {
    const fetch = mockFetch((url) => {
      if (url.pathname.endsWith("/modules")) return json([{ id: 8, name: "Week 1", items_count: 20 }]);
      expect(url.pathname).toBe("/api/v1/courses/7/modules/8/items");
      expect(url.searchParams.getAll("include[]")).toEqual(["content_details"]);
      return json([{ id: 80, title: "Reading", type: "File", content_id: 90 }]);
    });
    const client = new CanvasRestClient(connection, { fetch });
    const modules = await client.listModules(7);
    expect(modules.items[0]).toMatchObject({ id: "8", itemCount: 20 });
    expect(modules.items[0]).not.toHaveProperty("items");
    const items = await client.listModuleItems(7, 8);
    expect(items.items[0]).toMatchObject({ moduleId: "8", contentId: "90" });
  });

  it("keeps documented recent_replies and exposes the rest through an entry-scoped page", async () => {
    const fetch = mockFetch((url) => url.pathname.endsWith("/replies")
      ? json([{ id: 2, message: "First instructor reply" }, { id: 3, message: "Older reply" }])
      : json([{ id: 1, message: "Question", recent_replies: [{ id: 2, message: "First instructor reply" }], has_more_replies: true }]));
    const client = new CanvasRestClient(connection, { fetch });
    const entries = await client.listDiscussionEntries(7, 9);
    expect(entries.items[0]).toMatchObject({ hasMoreReplies: true, replies: [{ id: "2", messageText: "First instructor reply" }] });
    const replies = await client.listDiscussionReplies(7, 9, 1);
    expect(replies.items.map((reply) => reply.id)).toEqual(["2", "3"]);
    expect(replies.nextCursor).toBeNull();
    expect(new URL(String(vi.mocked(fetch).mock.calls[1]?.[0])).pathname)
      .toBe("/api/v1/courses/7/discussion_topics/9/entries/1/replies");
  });

  it("keeps selected courses beyond the first page and preserves successful summary sources on a denial", async () => {
    const fetch = mockFetch((url) => {
      if (url.pathname === "/api/v1/courses") return url.searchParams.get("page") === "2"
        ? json([{ id: 7, name: "Selected" }])
        : json([{ id: 1, name: "Other" }], { headers: { Link: '<https://learning.hanyang.ac.kr/api/v1/courses?page=2>; rel="next"' } });
      if (url.pathname === "/api/v1/announcements") {
        expect(url.searchParams.getAll("context_codes[]")).toEqual(["course_7"]);
        expect(url.searchParams.get("start_date")).toBe("2026-08-24T12:00:00.000Z");
        return json({ errors: [{ message: "Denied; token secret-pat" }] }, { status: 403 });
      }
      return json([]);
    });
    const summary = await new CanvasRestClient(connection, { fetch }).weeklySummary({
      courseIds: [7], limitPerCollection: 1, startAt: "2026-09-07T12:00:00Z",
    });
    expect(summary.sources.courses.result?.items[0]?.id).toBe("7");
    expect(summary.sources.upcomingWork.ok).toBe(true);
    expect(summary.sources.calendarEvents.ok).toBe(true);
    expect(summary.sources.announcements).toMatchObject({ ok: false, result: null, error: { code: "permission_denied" } });
    expect(JSON.stringify(summary)).not.toContain("secret-pat");
  });

  it.each(["用户无权执行该操作", "用户无权执行该操作。", "Invalid access token.", "secret-pat"])(
    "does not leak or interpret an upstream denial message: %s", async (message) => {
      const client = new CanvasRestClient(connection, { fetch: mockFetch(() => json({ errors: [{ message }] }, { status: 401 })) });
      await expect(client.listFiles(7)).rejects.toMatchObject({ code: "access_denied", retryable: false });
      await client.listFiles(7).catch((error: unknown) => expect(String(error)).not.toContain(message));
    },
  );

  it("parses encoded active HTML and removes verifier credentials while retaining file references", async () => {
    const client = new CanvasRestClient(connection, { fetch: mockFetch(() => json({
      id: 7,
      syllabus_body: '<p>Read &amp; explain &#1114112;</p><a href="jav&#x61;script:alert(1)">Bad link</a>' +
        '<a href="/courses/7/files/52/download?verifier=hidden-secret#secret">Notes</a>' +
        '<a href="https://learning.hanyang.ac.kr/courses/7/files/53?verifier=hidden-secret">Slides</a>' +
        '<img src="/courses/7/files/54/download?verifier=hidden-secret" alt="Figure" onload="alert(1)">',
    })) });
    const course = await client.getCourse(7);
    expect(course.syllabusBody).not.toMatch(/javascript|alert\(1\)|verifier|hidden-secret|#secret/i);
    expect(course.syllabusBody).toContain('/courses/7/files/52/download');
    expect(course.syllabusBody).toContain('https://learning.hanyang.ac.kr/courses/7/files/53');
    expect(course.syllabusBody).toContain('/courses/7/files/54/download');
    expect(course.syllabusText).toContain("Read & explain");
  });

  it("does not silently truncate source text at the old character boundary", async () => {
    const body = `Long notes ${"x".repeat(55_000)} END OF INSTRUCTIONS`;
    const client = new CanvasRestClient(connection, { fetch: mockFetch(() => json({ id: 7, syllabus_body: `<p>${body}</p>` })) });
    expect((await client.getCourse(7)).syllabusText).toBe(body);
  });

  it("handles deeply nested bounded rich text without a recursion failure", async () => {
    const body = `${"<div>".repeat(8_000)}Read this${"</div>".repeat(8_000)}`;
    const client = new CanvasRestClient(connection, { fetch: mockFetch(() => json({ id: 7, syllabus_body: body })) });
    expect((await client.getCourse(7)).syllabusText).toBe("Read this");
  });
});
