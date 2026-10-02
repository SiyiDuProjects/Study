import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { CanvasConnection } from "../src/domain.js";
import { LectureClient } from "../src/lecture/index.js";
import { createCanvasMcpServer } from "../src/mcp/index.js";

const connection: CanvasConnection = {
  userId: "bound-user",
  institution: "hanyang",
  baseUrl: "https://learning.hanyang.ac.kr",
  accessToken: "test-pat",
  canvasUserId: "42",
  canvasName: "Student",
};

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
});

describe("Lecture MCP tools", () => {
  it("publishes the shared Study authorization and returns strict lecture content", async () => {
    const lectureFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/search")) {
        return new Response(JSON.stringify({
          query: "homework",
          nextCursor: null, warnings: [],
          items: [{
            sessionId: "session-1",
            sessionTitle: "Week 1",
            sessionStatus: "ready",
            finalizationWarning: "The final sentence may be incomplete.",
            sessionStartedAt: "2026-09-01T10:00:00.000Z",
            courseId: "7",
            courseCode: "ACC-7",
            courseName: "Accounting",
            segmentId: "segment-1",
            startedAtMs: 1_000,
            endedAtMs: 2_000,
            sourceText: "homework source",
            translatedText: "homework translation",
          }],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ items: [], nextCursor: null, warnings: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const lectureClient = new LectureClient({
      baseUrl: "http://lecture:8091",
      serviceToken: "lecture-service-token-for-tests-1234",
      fetch: lectureFetch,
    });
    const server = createCanvasMcpServer({
      userId: "bound-user",
      getConnection: () => connection,
      lectureClient,
      fetch: vi.fn(async () => new Response(JSON.stringify({ id: 42, name: "Student" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch,
    });
    const client = new Client({ name: "lecture-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(async () => client.close(), async () => server.close());

    const listed = await client.request(
      { method: "tools/list" },
      z.object({
        tools: z.array(z.object({
          name: z.string(),
          inputSchema: z.record(z.string(), z.unknown()),
          outputSchema: z.record(z.string(), z.unknown()),
          annotations: z.record(z.string(), z.unknown()),
          securitySchemes: z.array(z.object({ type: z.string(), scopes: z.array(z.string()) })),
        }).loose()),
      }).loose(),
    );
    const lectureTools = listed.tools.filter((tool) => tool.name.includes("lecture"));
    expect(lectureTools.map((tool) => tool.name)).toEqual([
      "list_lecture_sessions",
      "get_lecture_transcript",
      "search_lecture_transcripts",
    ]);
    for (const tool of listed.tools) {
      expect(tool.securitySchemes).toEqual([{
        type: "oauth2",
        scopes: ["canvas.read"],
      }]);
    }
    for (const tool of lectureTools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(JSON.stringify(tool.inputSchema)).not.toContain("user_id");
      expect(tool.outputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["ok", "result", "error"],
      });
    }

    const result = await client.callTool({
      name: "search_lecture_transcripts",
      arguments: { query: "homework", course_id: "7" },
    });
    const daily = await client.callTool({ name: "list_lecture_sessions", arguments: { course_id: "daily", limit: 1 } });
    expect(daily.isError).not.toBe(true);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      ok: true,
      result: {
        query: "homework",
        nextCursor: null, warnings: [],
        items: [expect.objectContaining({
          finalizationWarning: "The final sentence may be incomplete.",
        })],
      },
      error: null,
    });
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toContain("Untrusted Lecture transcript search data");
    }
  });
});
