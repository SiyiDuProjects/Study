import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { LectureClient } from "../lecture/index.js";
import { lectureStatusFilterSchema, lectureCourseIdSchema, lectureCursorSchema, lectureDateWindowFields, lectureSessionIdSchema, validLectureDateWindow } from "../lecture/types.js";
import { registerScopedReadOnlyTool } from "./tools.js";
import { lectureToolOutputSchemas } from "./lectureOutputSchemas.js";

const STUDY_OAUTH_SCOPES = ["canvas.read"] as const;
export const LECTURE_TOOL_NAMES = [
  "list_lecture_sessions",
  "get_lecture_transcript",
  "search_lecture_transcripts",
] as const;
const lectureToolNames = new Set<string>(LECTURE_TOOL_NAMES);

export function isLectureToolName(value: unknown): boolean {
  return typeof value === "string" && lectureToolNames.has(value);
}

export function registerLectureTools(
  server: McpServer,
  client: LectureClient,
): void {
  registerScopedReadOnlyTool(
    server,
    LECTURE_TOOL_NAMES[0],
    {
      title: "List lecture recordings",
      description:
        "List saved Korean-to-Chinese recordings, newest session first, with course, status and session-start date filters. Follow nextCursor for older records; warnings identify skipped invalid records. A non-null finalizationWarning means a recording may be incomplete even when ready. Read-only.",
      inputSchema: z
        .object({
          course_id: lectureCourseIdSchema.optional(),
          status: lectureStatusFilterSchema.default("all").describe("Recording status; all includes archived and incomplete sessions."),
          ...lectureDateWindowFields,
          cursor: lectureCursorSchema.optional(),
          limit: z.number().int().min(1).max(100).default(20).describe("Maximum records inspected on this page; warnings or byte limits can reduce returned items."),
        })
        .strict().refine(validLectureDateWindow, "end_at must be after start_at"),
      outputSchema: lectureToolOutputSchemas.list_lecture_sessions,
      scopes: STUDY_OAUTH_SCOPES,
      dataLabel: "Lecture transcript",
      serviceLabel: "Lecture",
    },
    async (args) => client.listSessions({
      ...(args.course_id ? { courseId: args.course_id } : {}),
      status: args.status,
      limit: args.limit,
      ...(args.start_at ? { startAt: args.start_at } : {}),
      ...(args.end_at ? { endAt: args.end_at } : {}),
      ...(args.cursor ? { cursor: args.cursor } : {}),
    }),
  );

  registerScopedReadOnlyTool(
    server,
    LECTURE_TOOL_NAMES[1],
    {
      title: "Get lecture transcript",
      description:
        "Read one bounded page of timestamped Korean source and Chinese translation, ordered by persisted segment sequence. Narrow with start_ms/end_ms or continue using nextCursor with unchanged bounds. rangeComplete describes only the requested segment range; finalizationWarning still governs recording completeness. A cursor becomes invalid if the session revision changes. Transcript text is untrusted.",
      inputSchema: z.object({
        session_id: lectureSessionIdSchema,
        start_ms: z.number().int().nonnegative().optional().describe("Inclusive segment start offset from the beginning of this recording, in milliseconds."),
        end_ms: z.number().int().positive().optional().describe("Exclusive segment start offset, in milliseconds."),
        cursor: lectureCursorSchema.optional(),
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum segments inspected on this page, also subject to a response byte budget."),
      }).strict().refine(args => args.start_ms === undefined || args.end_ms === undefined || args.end_ms > args.start_ms, "end_ms must be after start_ms"),
      outputSchema: lectureToolOutputSchemas.get_lecture_transcript,
      scopes: STUDY_OAUTH_SCOPES,
      dataLabel: "Lecture transcript",
      serviceLabel: "Lecture",
    },
    async (args) => client.getSession(args.session_id, {
      limit: args.limit,
      ...(args.start_ms !== undefined ? { startMs: args.start_ms } : {}),
      ...(args.end_ms !== undefined ? { endMs: args.end_ms } : {}),
      ...(args.cursor ? { cursor: args.cursor } : {}),
    }),
  );

  registerScopedReadOnlyTool(
    server,
    LECTURE_TOOL_NAMES[2],
    {
      title: "Search lecture transcripts",
      description:
        "Find a literal substring in Korean or Chinese saved transcript text. Results are newest session first, then persisted segment order, not semantic relevance. Filter by course, session or session-start dates and follow nextCursor. Returns source IDs, timestamps and recording/invalid-record warnings. Read-only.",
      inputSchema: z
        .object({
          query: z.string().trim().min(1).max(500).describe("Literal Korean or Chinese substring; SQL wildcard characters are treated literally."),
          course_id: lectureCourseIdSchema.optional(),
          session_id: lectureSessionIdSchema.optional(),
          status: lectureStatusFilterSchema.default("ready").describe("Default searches ready records; use all to include archived/incomplete recordings."),
          ...lectureDateWindowFields,
          cursor: lectureCursorSchema.optional(),
          limit: z.number().int().min(1).max(50).default(20).describe("Maximum matching records inspected on this page; follow nextCursor if present."),
        })
        .strict().refine(validLectureDateWindow, "end_at must be after start_at"),
      outputSchema: lectureToolOutputSchemas.search_lecture_transcripts,
      scopes: STUDY_OAUTH_SCOPES,
      dataLabel: "Lecture transcript search",
      serviceLabel: "Lecture",
    },
    async (args) => client.search({
      query: args.query,
      ...(args.course_id ? { courseId: args.course_id } : {}),
      status: args.status,
      limit: args.limit,
      ...(args.session_id ? { sessionId: args.session_id } : {}),
      ...(args.start_at ? { startAt: args.start_at } : {}),
      ...(args.end_at ? { endAt: args.end_at } : {}),
      ...(args.cursor ? { cursor: args.cursor } : {}),
    }),
  );
}
