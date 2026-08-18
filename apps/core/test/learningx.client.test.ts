import { describe, expect, it, vi } from "vitest";

import type { CanvasConnection } from "../src/domain.js";
import { CanvasApiError } from "../src/canvas/index.js";
import { LearningXReadClient } from "../src/learningx/index.js";

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

describe("LearningXReadClient", () => {
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
      if (url.pathname === "/api/v1/users/self/profile") {
        return json({ id: 42, login_id: "student-id" });
      }
      if (url.pathname.endsWith("/allcomponents_db")) {
        expect(url.searchParams.get("user_id")).toBe("42");
        expect(url.searchParams.get("user_login")).toBe("student-id");
        return json([
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
        ]);
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
});
