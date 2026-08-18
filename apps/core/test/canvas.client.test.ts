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
  it("requires the connection base URL to match the institution allowlist", () => {
    expect(
      () =>
        new CanvasRestClient({
          ...connection,
          baseUrl: "https://attacker.example",
        }),
    ).toThrowError(CanvasApiError);
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

    expect(courses.map((course) => course.id)).toEqual(["1", "2"]);
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
      message: "Invalid access token",
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

    expect(grades[0]).toMatchObject({ currentScore: 91, currentGrade: "A-" });
    expect(grades[0]).not.toHaveProperty("unpostedCurrentScore");
    expect(grades[0]).not.toHaveProperty("unpostedCurrentGrade");
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
        return json([{ id: 10, message: "<p>Answer</p>", replies: [] }]);
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

    expect(tabs[0]?.externalToolId).toBe("123");
    expect(quizzes[0]?.descriptionText).toBe("Read");
    expect(topics[0]?.messageHtml).not.toMatch(/onclick/i);
    expect(entries[0]?.messageText).toBe("Answer");
    expect(pages[0]?.url).toBe("week-1");
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
        "/api/v1/calendar_events",
        "/api/v1/planner/items",
        "/api/v1/courses/7/assignments/9/submissions/self",
        "/api/v1/users/self/enrollments",
      ]),
    );
  });

  it("builds a bounded weekly summary from courses, planner, calendar, and announcements", async () => {
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
        return json([{ id: 3, title: "Lecture", context_code: "course_7" }]);
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
    expect(summary.counts).toEqual({
      courses: 1,
      upcomingWork: 1,
      incompleteWork: 1,
      calendarEvents: 1,
      announcements: 1,
    });
    expect(summary.announcements[0]?.messageText).toBe("Hello");
  });
});
