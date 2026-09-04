import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { CanvasConnection } from "../src/domain.js";
import { createCanvasMcpServer } from "../src/mcp/index.js";

const connection: CanvasConnection = {
  userId: "bound-user",
  institution: "hanyang",
  baseUrl: "https://learning.hanyang.ac.kr",
  accessToken: "hanyang-pat",
  canvasUserId: "42",
  canvasName: "Student",
};

const TOOL_NAMES = [
  "connection_status",
  "list_courses",
  "get_timetable",
  "get_course",
  "list_assignments",
  "get_assignment",
  "list_announcements",
  "list_modules",
  "list_course_tabs",
  "list_quizzes",
  "list_discussion_topics",
  "list_discussion_entries",
  "list_pages",
  "get_page",
  "list_files",
  "get_file",
  "list_conversations",
  "get_conversation",
  "list_course_submissions",
  "list_calendar_events",
  "get_upcoming_work",
  "get_submission_status",
  "get_grades",
  "weekly_summary",
] as const;

const oauthSecuritySchemeSchema = z
  .object({
    type: z.literal("oauth2"),
    scopes: z.array(z.string()),
  })
  .strict();

const objectJsonSchema = z
  .object({
    type: z.literal("object"),
  })
  .loose();

const advertisedToolSchema = z
  .object({
    name: z.string(),
    title: z.string(),
    description: z.string(),
    inputSchema: objectJsonSchema,
    outputSchema: objectJsonSchema,
    annotations: z
      .object({
        readOnlyHint: z.literal(true),
        destructiveHint: z.literal(false),
        idempotentHint: z.literal(true),
        openWorldHint: z.literal(false),
      })
      .strict(),
    securitySchemes: z.array(oauthSecuritySchemeSchema),
    _meta: z
      .object({
        securitySchemes: z.array(oauthSecuritySchemeSchema),
      })
      .loose(),
  })
  .loose();

const advertisedToolListSchema = z
  .object({
    tools: z.array(advertisedToolSchema),
  })
  .loose();

function profileFetch(): typeof globalThis.fetch {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        id: 42,
        name: "Student",
        sortable_name: "Student",
        login_id: "student-id",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  ) as unknown as typeof globalThis.fetch;
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
});

async function connectedClient(options: {
  getConnection: (userId: string) => CanvasConnection | null | Promise<CanvasConnection | null>;
  fetch?: typeof globalThis.fetch;
  learningXEnabled?: boolean;
  createFileLink?: (fileId: string) => { uri: string; expiresAt: string };
}) {
  const server = createCanvasMcpServer({
    userId: "bound-user",
    getConnection: options.getConnection,
    fetch: options.fetch ?? profileFetch(),
    learningXEnabled: options.learningXEnabled ?? false,
    createFileLink:
      options.createFileLink ??
      ((fileId) => ({
        uri: `https://study.siyidu.com/files/test-${fileId}`,
        expiresAt: "2030-01-01T00:00:00.000Z",
      })),
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => client.close(), async () => server.close());
  return client;
}

async function advertisedTools(client: Client) {
  const result = await client.request({ method: "tools/list" }, advertisedToolListSchema);
  return result.tools;
}

describe("Canvas MCP tools", () => {
  it("publishes the focused tool set with strict schemas, annotations, and OAuth metadata", async () => {
    const client = await connectedClient({ getConnection: () => connection });

    const tools = await advertisedTools(client);

    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.securitySchemes).toEqual([
        { type: "oauth2", scopes: ["canvas.read"] },
      ]);
      expect(tool._meta.securitySchemes).toEqual(tool.securitySchemes);
      expect(tool.outputSchema).toMatchObject({
        type: "object",
        required: ["ok", "result", "error"],
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
        },
      });
      expect(Array.isArray(tool.outputSchema.oneOf)).toBe(true);
      expect(tool.outputSchema.oneOf).toHaveLength(2);
      expect(JSON.stringify(tool.inputSchema)).not.toContain("user_id");
    }
  });

  it("publishes LearningX tools only when the server-side pilot flag is enabled", async () => {
    const client = await connectedClient({
      getConnection: () => connection,
      learningXEnabled: true,
    });

    const tools = await advertisedTools(client);

    expect(tools.map((tool) => tool.name)).toEqual([
      ...TOOL_NAMES.slice(0, 19),
      "list_learningx_attendance",
      "get_learningx_attendance_item",
      "list_learningx_modules",
      "list_learningx_boards",
      "list_learningx_board_posts",
      "get_learningx_board_post",
      ...TOOL_NAMES.slice(19),
    ]);
    for (const name of [
      "list_learningx_attendance",
      "get_learningx_attendance_item",
      "list_learningx_modules",
      "list_learningx_boards",
      "list_learningx_board_posts",
      "get_learningx_board_post",
    ]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
    }
  });

  it("binds connection lookup to the authenticated app user and returns text plus structuredContent", async () => {
    const getConnection = vi.fn(async (userId: string) => {
      expect(userId).toBe("bound-user");
      return connection;
    });
    const client = await connectedClient({ getConnection });
    const tool = (await advertisedTools(client)).find(
      (candidate) => candidate.name === "connection_status",
    );
    if (!tool) throw new Error("connection_status tool was not advertised");

    const result = await client.callTool({ name: "connection_status", arguments: {} });

    expect(getConnection).toHaveBeenCalledWith("bound-user");
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      result: {
        connected: true,
        institution: "hanyang",
        baseUrl: "https://learning.hanyang.ac.kr",
      },
      error: null,
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
    });
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toContain("Untrusted Canvas data follows");
    }
    const validate = new AjvJsonSchemaValidator().getValidator(
      tool.outputSchema as JsonSchemaType,
    );
    expect(validate(result.structuredContent)).toMatchObject({ valid: true });
  });

  it("returns the complete imported timetable with stable Canvas course mappings", async () => {
    const client = await connectedClient({ getConnection: () => connection });
    const tool = (await advertisedTools(client)).find(
      (candidate) => candidate.name === "get_timetable",
    );
    if (!tool) throw new Error("get_timetable tool was not advertised");

    const result = await client.callTool({ name: "get_timetable", arguments: {} });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      result: {
        institution: "hanyang",
        timezone: "Asia/Seoul",
        totalCredits: 16,
        term: { id: "94", academicYear: 2026, semester: 2 },
        source: { kind: "official_portal_timetable", asOf: "2026-08-30" },
      },
      error: null,
    });
    const envelope = result.structuredContent as {
      result?: { meetings?: Array<Record<string, unknown>> } | null;
    };
    expect(envelope.result?.meetings).toHaveLength(7);
    expect(envelope.result?.meetings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canvasCourseId: "215729",
          weekday: "tuesday",
          startTime: "17:00",
          endTime: "19:00",
          locationCode: "Y206-0104",
        }),
        expect.objectContaining({
          canvasCourseId: "216115",
          weekday: "thursday",
          startTime: "14:00",
          endTime: "17:00",
          locationCode: "Y202-0413",
        }),
      ]),
    );
    const validate = new AjvJsonSchemaValidator().getValidator(
      tool.outputSchema as JsonSchemaType,
    );
    expect(validate(result.structuredContent)).toMatchObject({ valid: true });
  });

  it("returns a short-lived MCP file reference without exposing the Canvas download URL", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/v1/files/52");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer hanyang-pat");
      return new Response(
        JSON.stringify({
          id: 52,
          display_name: "Course notes.pdf",
          filename: "course-notes.pdf",
          "content-type": "application/pdf",
          size: 1234,
          url: "https://learning.hanyang.ac.kr/files/52/download?verifier=do-not-expose",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;
    const createFileLink = vi.fn((fileId: string) => ({
      uri: `https://study.siyidu.com/files/signed-${fileId}`,
      expiresAt: "2030-01-01T00:00:00.000Z",
    }));
    const client = await connectedClient({
      getConnection: () => connection,
      fetch,
      createFileLink,
    });
    const tool = (await advertisedTools(client)).find(
      (candidate) => candidate.name === "get_file",
    );
    if (!tool) throw new Error("get_file tool was not advertised");

    const result = await client.callTool({ name: "get_file", arguments: { file_id: 52 } });

    expect(result.isError).not.toBe(true);
    expect(createFileLink).toHaveBeenCalledWith("52");
    expect(result.structuredContent).toMatchObject({
      ok: true,
      result: {
        id: "52",
        filename: "course-notes.pdf",
        displayName: "Course notes.pdf",
        contentType: "application/pdf",
        size: 1234,
      },
      error: null,
    });
    expect(result.content[1]).toMatchObject({
      type: "resource_link",
      uri: "https://study.siyidu.com/files/signed-52",
      name: "course-notes.pdf",
      title: "Course notes.pdf",
      mimeType: "application/pdf",
      size: 1234,
    });
    expect(JSON.stringify(result)).not.toContain("verifier");
    const validate = new AjvJsonSchemaValidator().getValidator(
      tool.outputSchema as JsonSchemaType,
    );
    expect(validate(result.structuredContent)).toMatchObject({ valid: true });
  });

  it("rejects a connection owned by another user with a standardized tool error", async () => {
    const client = await connectedClient({
      getConnection: () => ({ ...connection, userId: "different-user" }),
    });
    const tool = (await advertisedTools(client)).find(
      (candidate) => candidate.name === "connection_status",
    );
    if (!tool) throw new Error("connection_status tool was not advertised");

    const result = await client.callTool({ name: "connection_status", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      result: null,
      error: { code: "configuration_error", retryable: false },
    });
    const validate = new AjvJsonSchemaValidator().getValidator(
      tool.outputSchema as JsonSchemaType,
    );
    expect(validate(result.structuredContent)).toMatchObject({ valid: true });
    expect(
      validate({ ok: false, result: null, error: null }),
    ).toMatchObject({ valid: false });
    expect(
      validate({ ...(result.structuredContent ?? {}), unexpected: true }),
    ).toMatchObject({ valid: false });
    expect(result._meta?.["mcp/www_authenticate"]).toBeUndefined();
  });

  it("does not mislabel an invalid Canvas PAT as an MCP OAuth reauthentication error", async () => {
    const client = await connectedClient({
      getConnection: () => connection,
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ message: "Invalid access token" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ) as unknown as typeof globalThis.fetch,
    });

    const result = await client.callTool({ name: "connection_status", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      result: null,
      error: { code: "authentication_failed", status: 401 },
    });
    expect(result._meta?.["mcp/www_authenticate"]).toBeUndefined();
  });
});
