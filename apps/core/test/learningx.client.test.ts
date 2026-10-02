import { describe, expect, it, vi } from "vitest";

import type { CanvasConnection } from "../src/domain.js";
import { CanvasApiError } from "../src/canvas/index.js";
import { LearningXReadClient } from "../src/learningx/index.js";
import { LearningXSessionCache } from "../src/learningx/client.js";

const hanyangConnection: CanvasConnection = {
  userId: "hanyang-user",
  institution: "hanyang",
  baseUrl: "https://learning.hanyang.ac.kr",
  accessToken: "hanyang-pat-value-long-enough",
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

function protocolFetch(
  read: (url: URL) => Response = (url) => {
    if (url.pathname.endsWith("/attendance_items")) return json({ attendance_items: [] });
    if (url.pathname.endsWith("/attendance_items/summary")) return json({ attendance_summaries: {} });
    return json([]);
  },
  options: { tabs?: unknown; jwt?: () => string; form?: string } = {},
): typeof globalThis.fetch {
  return mockFetch((url) => {
    if (url.pathname.endsWith("/tabs")) {
      return json(options.tabs ?? [{ id: "context_external_tool_132", label: "Board" }]);
    }
    if (url.pathname.endsWith("/sessionless_launch")) return json({ url: "https://lti.xinics.com/verifier" });
    if (url.pathname === "/verifier") {
      return new Response(options.form ?? '<form action="https://lti.xinics.com/launch"><input name="oauth" value="safe"></form>');
    }
    if (url.pathname === "/launch") {
      return new Response("", { status: 302, headers: { "set-cookie": `xn_api_token=${options.jwt?.() ?? "aaa.bbb.ccc"}; Secure` } });
    }
    if (url.pathname.endsWith("/profile")) return json({ id: 42 });
    return read(url);
  });
}

describe("LearningXReadClient", () => {
  it("exposes the real TransLive viewer separately from the Canvas module and attendance IDs", async () => {
    const fetch = protocolFetch(url => url.pathname.endsWith("/modules") ? json([{ module_id: 1, course_id: 7, title: "Week 1",
      module_items: [{ module_item_id: 8587482, content_type: "attendance_item", title: "Caption", content_data: {
        item_id: 1262728, course_id: 7, item_content_type: "translive", item_content_data: { translive_id: "5239483487", duration: 150 },
      } }],
    }]) : json([]));
    const modules = await new LearningXReadClient(hanyangConnection, { fetch }).listModules(7, 140);
    expect(modules[0]?.items[0]).toMatchObject({ id: "1262728", moduleItemId: "8587482", type: "translive", durationSeconds: null,
      translive: { id: "5239483487", viewerUrl: "https://learning.hanyang.ac.kr/translive/v/5239483487" } });
  });
  it("keeps the Canvas PAT, signed LTI form, and LearningX JWT on separate allowlisted routes", async () => {
    const seen: Array<{ url: string; authorization: string | null; method: string }> = [];
    const fetch = mockFetch((url, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: url.toString(),
        authorization: headers.get("authorization"),
        method: init?.method ?? "GET",
      });

      if (url.pathname === "/api/v1/courses/7/tabs") {
        return json([{ id: "context_external_tool_123", label: "출결/학습 현황" }]);
      }
      if (url.pathname.endsWith("/external_tools/sessionless_launch")) {
        return json({ url: "https://lti.xinics.com/verifier" });
      }
      if (url.href === "https://lti.xinics.com/verifier") {
        return new Response(
          '<form action="https://lti.xinics.com/launch"><input type="hidden" name="oauth_consumer_key" value="safe"></form>',
          { status: 200 },
        );
      }
      if (url.href === "https://lti.xinics.com/launch") {
        expect(init?.body).toBe("oauth_consumer_key=safe");
        return new Response("", {
          status: 302,
          headers: { "set-cookie": "xn_api_token=aaa.bbb.ccc; Secure; HttpOnly" },
        });
      }
      if (url.pathname.endsWith("/attendance_items")) {
        expect(url.search).toBe("?include_detail=true");
        return json({ attendance_items: [
          {
            id: 99,
            course_id: 7,
            title: "Lecture 1",
            type: "video",
            use_attendance: true,
            attendance_status: "attendance",
            completed: true,
            url: "https://attacker.example/private-media",
          },
        ] });
      }
      if (url.pathname.endsWith("/attendance_items/summary")) {
        expect(url.search).toBe("?only_use_attendance=true");
        return json({ attendance_summaries: { "99": { attendance_status: "attendance" } } });
      }
      return json({ message: "unexpected" }, { status: 404 });
    });
    const client = new LearningXReadClient(hanyangConnection, { fetch });

    const result = await client.listAttendance(7);

    expect(result).toEqual([
      expect.objectContaining({
        id: "99",
        courseId: "7",
        title: "Lecture 1",
        completed: true,
        viewerUrl: "https://learning.hanyang.ac.kr/courses/7/external_tools/123",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("attacker.example");

    const canvasCalls = seen.filter((call) => call.url.startsWith("https://learning.hanyang.ac.kr/api/"));
    expect(canvasCalls).not.toHaveLength(0);
    expect(canvasCalls.every((call) => call.authorization === "Bearer hanyang-pat-value-long-enough")).toBe(true);
    const externalCalls = seen.filter((call) => call.url.startsWith("https://lti.xinics.com/"));
    expect(externalCalls.every((call) => call.authorization === null)).toBe(true);
    const learningXCall = seen.find((call) => call.url.includes("/learningx/api/"));
    expect(learningXCall?.authorization).toBe("Bearer aaa.bbb.ccc");
    expect(seen.some((call) => call.url.includes("/profile") || call.url.includes("/allcomponents_db"))).toBe(false);
  });

  it("discovers Hanyang Weekly Learning and normalizes its module tree", async () => {
    const fetch = mockFetch((url, init) => {
      if (url.pathname.endsWith("/tabs")) {
        return json([{ id: "context_external_tool_140", label: "Weekly Learning" }]);
      }
      if (url.pathname.endsWith("/external_tools/sessionless_launch")) {
        return json({ url: "https://lti.xinics.com/verifier" });
      }
      if (url.href === "https://lti.xinics.com/verifier") {
        return new Response(
          '<form action="https://lti.xinics.com/launch"><input name="oauth" value="safe"></form>',
        );
      }
      if (url.href === "https://lti.xinics.com/launch") {
        expect(init?.method).toBe("POST");
        return new Response("", {
          status: 302,
          headers: { "set-cookie": "xn_api_token=aaa.bbb.ccc; Secure" },
        });
      }
      if (url.pathname.endsWith("/learningx/api/v1/courses/7/modules")) {
        return json([{ module_id: 1, course_id: 7, title: "Week 1", module_items: [] }]);
      }
      return json({ message: "unexpected" }, { status: 404 });
    });
    const client = new LearningXReadClient(hanyangConnection, { fetch });

    const modules = await client.listModules(7);

    expect(modules).toEqual([
      expect.objectContaining({ id: "1", courseId: "7", name: "Week 1" }),
    ]);
  });

  it("reads LearningX boards through discovered Hanyang Board tabs without exposing download URLs", async () => {
    const fetch = mockFetch((url) => {
      if (url.pathname.endsWith("/tabs")) {
        return json([{ id: "context_external_tool_132", label: "Board" }]);
      }
      if (url.pathname.endsWith("/external_tools/sessionless_launch")) {
        return json({ url: "https://lti.xinics.com/verifier" });
      }
      if (url.href === "https://lti.xinics.com/verifier") {
        return new Response(
          '<form action="https://lti.xinics.com/launch"><input name="oauth" value="safe"></form>',
        );
      }
      if (url.href === "https://lti.xinics.com/launch") {
        return new Response("", {
          status: 302,
          headers: { "set-cookie": "xn_api_token=aaa.bbb.ccc; Secure" },
        });
      }
      if (url.pathname.endsWith("/boards/8/posts/9")) {
        return json({
          id: 9,
          board_id: 8,
          title: "Details",
          content: '<p onclick="steal()">Body</p><script>bad()</script>',
          attachments: [{ id: 10, filename: "file.pdf", url: "https://attacker.example/file" }],
          comments: [{ id: 11, content: "<p>Reply</p>", is_deleted: false }],
        });
      }
      if (url.pathname.endsWith("/boards/8/posts")) {
        expect(url.searchParams.get("page")).toBe("2");
        expect(url.searchParams.get("filter")).toBe("title");
        expect(url.searchParams.get("keyword")).toBe("exam");
        return json({
          items: [{ id: 9, board_id: 8, title: "Details", attachment_count: 1 }],
          pagination: { current_page: 2, total_count: 1, total_pages: 1 },
        });
      }
      if (url.pathname.endsWith("/learningx_board/courses/7/boards")) {
        return json([
          {
            id: 8,
            course_id: 7,
            title: "Q&A",
            description: '<p onmouseover="steal()">Questions</p>',
            total_post_count: 1,
            unread_post_count: 1,
            use_attachment: true,
          },
        ]);
      }
      return json({ message: "unexpected" }, { status: 404 });
    });
    const client = new LearningXReadClient(hanyangConnection, { fetch });

    const boards = await client.listBoards(7);
    const page = await client.listBoardPosts(7, 8, { page: 2, keyword: "exam" });
    const post = await client.getBoardPost(7, 8, 9);

    expect(boards[0]).toMatchObject({ title: "Q&A", descriptionText: "Questions" });
    expect(boards[0]?.descriptionHtml).not.toMatch(/onmouseover/i);
    expect(page.posts[0]).toMatchObject({ id: "9", boardId: "8", attachmentCount: 1 });
    expect(post).toMatchObject({ contentText: "Body", comments: [{ contentText: "Reply" }] });
    expect(post.contentHtml).not.toMatch(/onclick|script/i);
    expect(JSON.stringify(post)).not.toContain("attacker.example");
  });

  it("rejects an untrusted verifier before sending LTI data", async () => {
    const fetch = mockFetch((url) => {
      if (url.pathname.endsWith("/tabs")) {
        return json([{ id: "context_external_tool_123", label: "Attendance" }]);
      }
      if (url.pathname.endsWith("/external_tools/sessionless_launch")) {
        return json({ url: "https://attacker.example/verifier" });
      }
      throw new Error("unsafe verifier must not be fetched");
    });
    const client = new LearningXReadClient(hanyangConnection, { fetch });

    await expect(client.listAttendance(7)).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects non-Hanyang connections before any request", () => {
    expect(
      () =>
        new LearningXReadClient({
          ...hanyangConnection,
          institution: "unsupported" as never,
          baseUrl: "https://unsupported.example",
        }),
    ).toThrowError(CanvasApiError);
  });

  it.each(["attendance", "modules", "boards", "boardPosts"] as const)(
    "rejects malformed %s collections rather than returning no records",
    async (operation) => {
      const fetch = protocolFetch(() => json({ error: "application failure" }));
      const client = new LearningXReadClient(hanyangConnection, { fetch });
      const read = {
        attendance: () => client.listAttendance(7, 132),
        modules: () => client.listModules(7, 132),
        boards: () => client.listBoards(7, 132),
        boardPosts: () => client.listBoardPosts(7, 8, {}, 132),
      }[operation];
      await expect(read()).rejects.toMatchObject({ code: "invalid_response" });
    },
  );

  it("distinguishes empty collections from malformed rows and missing nested module items", async () => {
    let payload: unknown = [];
    const client = new LearningXReadClient(hanyangConnection, { fetch: protocolFetch(() => json(payload)) });
    await expect(client.listBoards(7, 132)).resolves.toEqual([]);
    payload = [null];
    await expect(client.listBoards(7, 132)).rejects.toMatchObject({ code: "invalid_response" });
    payload = [{}];
    await expect(client.listBoards(7, 132)).rejects.toMatchObject({ code: "invalid_response" });
    payload = [{ module_id: 1 }];
    await expect(client.listModules(7, 132)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects ambiguous attendance tabs before launching and accepts an explicit returned ID", async () => {
    const fetch = protocolFetch(undefined, { tabs: [
      { id: "context_external_tool_148", label: "Offline Attendance" },
      { id: "context_external_tool_138", label: "Lecture/Attendance" },
    ] });
    const client = new LearningXReadClient(hanyangConnection, { fetch });
    await expect(client.listAttendance(7)).rejects.toMatchObject({
      code: "invalid_argument", message: expect.stringContaining("148, 138"),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(client.listAttendance(7, 138)).resolves.toEqual([]);
    const paths = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(paths.some((url) => url.includes("sessionless_launch?id=148"))).toBe(false);
    expect(paths.some((url) => url.includes("sessionless_launch?id=138"))).toBe(true);
  });

  it("does not mistake native or hidden tabs for discovered external modules", async () => {
    const fetch = protocolFetch(() => json([]), { tabs: [
      { id: "modules", label: "Modules" },
      { id: "context_external_tool_9", label: "Weekly Learning", hidden: true },
      { id: "context_external_tool_140", label: "Weekly Learning" },
    ] });
    await new LearningXReadClient(hanyangConnection, { fetch }).listModules(7);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("sessionless_launch?id=140"))).toBe(true);
  });

  it("preserves the same attendance facts in list, module and exact item responses", async () => {
    const item = {
      item_id: 99, course_id: 7, title: "Lecture", use_attendance: true,
      attendance_data: { completed: true, attendance_status: "attendance", progress: 1443.34 },
      item_content_data: { content_type: "video", duration: 1400 },
    };
    const fetch = protocolFetch((url) => {
      if (url.pathname.endsWith("/modules")) return json([{ module_id: 1, module_items: [{ content_data: item }] }]);
      if (url.pathname.endsWith("/attendance_items")) return json({ attendance_items: [item] });
      if (url.pathname.endsWith("/attendance_items/summary")) return json({ attendance_summaries: { "99": { attendance_status: "attendance" } } });
      return json(item);
    });
    const client = new LearningXReadClient(hanyangConnection, { fetch });
    const list = await client.listAttendance(7, 138);
    const modules = await client.listModules(7, 138);
    const detail = await client.getAttendanceItem(7, 99, 138);
    expect(list[0]).toEqual(detail);
    expect(modules[0]?.items[0]).toEqual(detail);
    expect(detail).toMatchObject({ id: "99", completed: true, progressSeconds: 1443.34 });
  });

  it("reads the student total-attendance endpoints and joins only attendance-enabled rows", async () => {
    const fetch = protocolFetch((url) => {
      if (url.pathname.endsWith("/allcomponents_db")) return json([]);
      if (url.pathname === "/learningx/api/v1/courses/7/attendance_items" && url.search === "?include_detail=true") {
        return json({ attendance_items: [
          {
            item_id: 99, course_id: 7, title: "Video 1", use_attendance: true, item_content_type: "commons",
            attendance_data: { completed: true, attendance_status: "absent", progress: 1443.34 },
            item_content_data: { content_type: "video", duration: 1400 },
          },
          { item_id: 100, course_id: 7, title: "Video 2", use_attendance: true, completed: true, item_content_type: "commons" },
          { item_id: 101, course_id: 7, title: "Optional video", use_attendance: false, completed: false },
          { item_id: 102, course_id: 7, title: "Completed assignment", use_attendance: false, completed: true },
        ] });
      }
      if (url.pathname === "/learningx/api/v1/courses/7/attendance_items/summary" && url.search === "?only_use_attendance=true") {
        return json({ attendance_summaries: {
          "99": { item_id: 99, course_id: 7, attendance_status: "attendance" },
          "100": { attendance_status: "attendance" },
        } });
      }
      throw new Error(`Unexpected read: ${url.pathname}${url.search}`);
    });
    const result = await new LearningXReadClient(hanyangConnection, { fetch }).listAttendance(7, 138);
    expect(result.map((item) => item.id)).toEqual(["99", "100"]);
    expect(result).toEqual([
      expect.objectContaining({ id: "99", type: "video", completed: true, useAttendance: true, attendanceStatus: "attendance", progressSeconds: 1443.34 }),
      expect.objectContaining({ id: "100", type: "commons", completed: true, useAttendance: true, attendanceStatus: "attendance" }),
    ]);
    const requests = vi.mocked(fetch).mock.calls.map(([url, init]) => ({ url: new URL(String(url)), method: init?.method ?? "GET" }));
    expect(requests).toHaveLength(5);
    expect(requests.filter(({ method }) => method === "POST").map(({ url }) => url.pathname)).toEqual(["/launch"]);
    expect(requests.filter(({ url }) => url.pathname.startsWith("/learningx/api/")).every(({ method }) => method === "GET")).toBe(true);
    expect(requests.some(({ url }) => /allcomponents_db|profile|progress|play/.test(url.pathname))).toBe(false);
  });

  it("keeps absent summary status and absent completion separate from a confirmed attendance status", async () => {
    const fetch = protocolFetch((url) => {
      if (url.pathname.endsWith("/attendance_items")) return json({ attendance_items: [
        { item_id: 99, item_content_type: "smart_attendance", use_attendance: true },
        { item_id: 100, use_attendance: true, completed: false, attendance_status: "attendance" },
      ] });
      if (url.pathname.endsWith("/attendance_items/summary")) {
        return json({ attendance_summaries: { "99": { attendance_status: "attendance" } } });
      }
      throw new Error(`Unexpected read: ${url.pathname}`);
    });
    const result = await new LearningXReadClient(hanyangConnection, { fetch }).listAttendance(7, 138);
    expect(result).toEqual([
      expect.objectContaining({ id: "99", type: "smart_attendance", attendanceStatus: "attendance", completed: null }),
      expect.objectContaining({ id: "100", attendanceStatus: null, completed: false }),
    ]);
  });

  it.each([
    { label: "array items root", items: [], summary: { attendance_summaries: {} } },
    { label: "missing items collection", items: {}, summary: { attendance_summaries: {} } },
    { label: "missing summary collection", items: { attendance_items: [] }, summary: {} },
    { label: "array summary collection", items: { attendance_items: [] }, summary: { attendance_summaries: [] } },
    { label: "invalid summary value", items: { attendance_items: [] }, summary: { attendance_summaries: { "99": null } } },
    { label: "invalid summary item key", items: { attendance_items: [] }, summary: { attendance_summaries: { invalid: {} } } },
    { label: "different summary item", items: { attendance_items: [] }, summary: { attendance_summaries: { "99": { item_id: 100 } } } },
    { label: "different summary course", items: { attendance_items: [] }, summary: { attendance_summaries: { "99": { course_id: 8 } } } },
    { label: "missing item ID", items: { attendance_items: [{ use_attendance: true }] }, summary: { attendance_summaries: {} } },
    { label: "different item course", items: { attendance_items: [{ item_id: 99, course_id: 8, use_attendance: true }] }, summary: { attendance_summaries: {} } },
  ])("rejects $label instead of returning a successful empty attendance list", async ({ items, summary }) => {
    const fetch = protocolFetch((url) => {
      if (url.pathname.endsWith("/attendance_items")) return json(items);
      if (url.pathname.endsWith("/attendance_items/summary")) return json(summary);
      throw new Error(`Unexpected read: ${url.pathname}`);
    });
    await expect(new LearningXReadClient(hanyangConnection, { fetch }).listAttendance(7, 138))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    { label: "true", value: true, expected: true },
    { label: "false", value: false, expected: false },
    { label: "missing", value: undefined, expected: null },
    { label: "null", value: null, expected: null },
    { label: "string true", value: "true", expected: null },
    { label: "string false", value: "false", expected: null },
    { label: "one", value: 1, expected: null },
    { label: "zero", value: 0, expected: null },
    { label: "object", value: {}, expected: null },
    { label: "array", value: [], expected: null },
  ])("preserves $label flags while only listing explicit attendance items", async ({ value, expected }) => {
    const item = {
      item_id: 99, course_id: 7, title: "Completed required attendance",
      use_attendance: value, completed: value, required: value,
    };
    const fetch = protocolFetch((url) => {
      if (url.pathname.endsWith("/modules")) return json([{ module_id: 1, module_items: [{ content_data: item }] }]);
      if (url.pathname.endsWith("/attendance_items")) return json({ attendance_items: [item] });
      if (url.pathname.endsWith("/attendance_items/summary")) return json({ attendance_summaries: {} });
      return json(item);
    });
    const client = new LearningXReadClient(hanyangConnection, { fetch });
    const modules = await client.listModules(7, 138);
    const detail = await client.getAttendanceItem(7, 99, 138);
    expect(detail).toMatchObject({ completed: expected, useAttendance: expected, required: expected });
    expect(modules[0]?.items[0]).toEqual(detail);
    if (value === true) {
      await expect(client.listAttendance(7, 138)).resolves.toEqual([detail]);
    } else if (value === false) {
      await expect(client.listAttendance(7, 138)).resolves.toEqual([]);
    } else {
      await expect(client.listAttendance(7, 138)).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("uses known module wrapper flags without overriding explicit false values", async () => {
    const wrappers = [
      {
        completed: true, use_attendance: true, required: true,
        content_data: { item_id: 99 },
      },
      {
        completed: false, use_attendance: false, required: false,
        content_data: { item_id: 100 },
      },
      {
        completed: true, use_attendance: true, required: false,
        content_data: {
          item_id: 101, use_attendance: false, completed: true, required: true,
          attendance_data: { completed: false },
        },
      },
      {
        completed: false, use_attendance: true, required: false,
        content_data: { item_id: 102, use_attendance: false, completed: true, required: true },
      },
    ];
    const client = new LearningXReadClient(hanyangConnection, {
      fetch: protocolFetch(() => json([{ module_id: 1, module_items: wrappers }])),
    });
    const modules = await client.listModules(7, 138);
    expect(modules[0]?.items.map(({ completed, useAttendance, required }) => ({ completed, useAttendance, required }))).toEqual([
      { completed: true, useAttendance: true, required: true },
      { completed: false, useAttendance: false, required: false },
      { completed: false, useAttendance: false, required: false },
      { completed: false, useAttendance: false, required: false },
    ]);
  });

  it("rejects details that identify a different requested item or course", async () => {
    let item: unknown = { item_id: 100, course_id: 7 };
    const client = new LearningXReadClient(hanyangConnection, { fetch: protocolFetch(() => json(item)) });
    await expect(client.getAttendanceItem(7, 99, 138)).rejects.toMatchObject({ code: "invalid_response" });
    item = { id: 9, course_id: 8, board_id: 1 };
    await expect(client.getBoardPost(7, 1, 9, 138)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("reuses one bounded board launch across independently created tool clients", async () => {
    const fetch = protocolFetch((url) => {
      if (url.pathname.endsWith("/posts/9")) return json({ id: 9, board_id: 8, title: "Details" });
      if (url.pathname.endsWith("/posts")) return json({ items: [{ id: 9 }], pagination: { current_page: 1 } });
      return json([{ id: 8 }]);
    });
    const sessionCache = new LearningXSessionCache();
    const client = () => new LearningXReadClient(hanyangConnection, { fetch, sessionCache });
    await client().listBoards(7);
    await client().listBoardPosts(7, 8);
    await client().getBoardPost(7, 8, 9);
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("isolates cached launches by App user, Canvas user, PAT, course and tool", async () => {
    const fetch = protocolFetch();
    const sessionCache = new LearningXSessionCache();
    const client = (connection = hanyangConnection) => new LearningXReadClient(connection, { fetch, sessionCache });
    await client().listBoards(7, 132);
    await client().listBoards(7, 132);
    await client({ ...hanyangConnection, userId: "another-user" }).listBoards(7, 132);
    await client({ ...hanyangConnection, canvasUserId: "43" }).listBoards(7, 132);
    await client({ ...hanyangConnection, accessToken: "replacement-synthetic-token-long-enough" }).listBoards(7, 132);
    await client().listBoards(8, 132);
    await client().listBoards(7, 133);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(6);
    expect(fetch).toHaveBeenCalledTimes(25);
  });

  it("expires cached launches and honors earlier JWT expiry", async () => {
    let now = 1_000;
    let jwt = "aaa.bbb.ccc";
    const fetch = protocolFetch(undefined, { jwt: () => jwt });
    const client = new LearningXReadClient(hanyangConnection, { fetch, now: () => now });
    await client.listBoards(7, 132);
    now += 59_999;
    await client.listBoards(7, 132);
    now += 1;
    jwt = `aaa.${Buffer.from(JSON.stringify({ exp: (now + 10_000) / 1_000 })).toString("base64url")}.ccc`;
    await client.listBoards(7, 132);
    now += 5_001;
    await client.listBoards(7, 132);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(3);
  });

  it.each([
    { userId: "second-user" },
    { accessToken: "replacement-synthetic-token-long-enough" },
  ])("evicts a rejected session without auto-retrying or invalidating another identity %j", async (identity) => {
    let reject = false;
    const fetch = protocolFetch(() => reject ? json({}, { status: 401 }) : json([]));
    const sessionCache = new LearningXSessionCache();
    const first = new LearningXReadClient(hanyangConnection, { fetch, sessionCache });
    const second = new LearningXReadClient({ ...hanyangConnection, ...identity }, { fetch, sessionCache });
    await first.listBoards(7, 132);
    await second.listBoards(7, 132);
    reject = true;
    await expect(first.listBoards(7, 132)).rejects.toMatchObject({ code: "authentication_failed" });
    expect(fetch).toHaveBeenCalledTimes(9);
    reject = false;
    await second.listBoards(7, 132);
    expect(fetch).toHaveBeenCalledTimes(10);
    await first.listBoards(7, 132);
    expect(fetch).toHaveBeenCalledTimes(14);
  });

  it("evicts old sessions when the cache budget is reached", async () => {
    const fetch = protocolFetch();
    const client = new LearningXReadClient(hanyangConnection, { fetch });
    for (let course = 1; course <= 65; course += 1) await client.listBoards(course, 132);
    await client.listBoards(1, 132);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(66);
  });

  it("parses signed form entities once and ignores inputs outside the launch form", async () => {
    const fetch = protocolFetch(undefined, {
      form: '<input name="outside" value="bad"><form action="https://lti.xinics.com/launch"><input name="oauth" value="a&amp;b&#x1F600;"></form>',
    });
    await new LearningXReadClient(hanyangConnection, { fetch }).listBoards(7, 132);
    const launch = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST");
    expect(String(launch?.[1]?.body)).toBe(new URLSearchParams({ oauth: "a&b😀" }).toString());
  });

  it("cancels oversized streamed JSON before buffering the full upstream body", async () => {
    let cancelled = false;
    const fetch = protocolFetch(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    })));
    const client = new LearningXReadClient(hanyangConnection, { fetch, maxResponseBytes: 2048 });
    await expect(client.listBoards(7, 132)).rejects.toMatchObject({ code: "invalid_response" });
    expect(cancelled).toBe(true);
  });
});
