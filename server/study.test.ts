// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createStudyCourseClient } from "./study.js";

describe("Study course client", () => {
  it("uses the fixed internal endpoint, bearer token, and exact Hanyang course contract", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      courses: [{
        id: "123", code: "CUL123", name: "한국어", term: "2026년 2학기",
        folderName: "CUL123_한국어", label: "CUL123 한국어", status: "active", source: "canvas",
        startAt: null, endAt: null, lastSeenAt: "2026-08-18T00:00:00.000Z", archivedAt: null
      }],
      syncedAt: "2026-08-18T00:00:00.000Z",
      stale: false
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createStudyCourseClient({
      baseUrl: "http://canvas:8794",
      serviceToken: "study-token",
      fetchImpl
    });

    const result = await client.listCourses({ includeArchived: true, refresh: true });
    expect(result.courses[0]).toMatchObject({ id: "123", source: "canvas", isArchived: false });
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe("http://canvas:8794/internal/lecture/courses?include_archived=true&refresh=true");
    expect(init.headers).toMatchObject({ Authorization: "Bearer study-token" });
    expect(init.redirect).toBe("error");
  });
});
