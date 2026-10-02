import { createHash } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { registerScopedTool } from "./canvasTools.js";

export const studyMcpInstructions =
  "Verify school with get_study_profile; never mix accounts. If Skills are missing, use get_study_skill: canvas for facts, uploads, submissions and messages; daily-brief for daily checks; study for facts plus lectures; study-lecture for recordings. Check tools before denying capabilities. Files may be attached or generated. Canvas tools serve both schools; LearningX, timetable and Lecture are Hanyang-only. Send/submit requires user intent; drafts and daily checks do not authorize writes.";

const studySkillNames = ["canvas", "daily-brief", "study", "study-lecture"] as const;
const studySkillNameSchema = z.enum(studySkillNames);
const studySkillResultSchema = z.object({
  name: studySkillNameSchema,
  description: z.string(),
  instructions: z.string(),
}).strict();

export interface StaticSkillEntry {
  readonly uri: string;
  readonly frontmatter: Readonly<Record<string, unknown>> & {
    readonly name: string;
    readonly description: string;
  };
  readonly resources: readonly { readonly uri: string; readonly digest: string }[];
}

export type StaticSkillResource = {
  readonly uri: string;
  readonly mimeType: string;
} & ({ readonly text: string; readonly blob?: never } | { readonly blob: string; readonly text?: never });

export interface StaticSkillCatalog {
  readonly skills: readonly StaticSkillEntry[];
  readonly resources: readonly StaticSkillResource[];
}

const listRequestSchema = z.object({ method: z.literal("skills/list"), params: z.unknown().optional() });
const getRequestSchema = z.object({ method: z.literal("skills/get"), params: z.unknown().optional() });
const readRequestSchema = z.object({ method: z.literal("resources/read"), params: z.unknown().optional() });
const listParamsSchema = z.object({ cursor: z.string().optional() });
const uriParamsSchema = z.object({ uri: z.string().min(1) });
// MCP resource-not-found code; SDK 1.30 does not include it in ErrorCode.
const RESOURCE_NOT_FOUND = -32002;

function params<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new McpError(ErrorCode.InvalidParams, "Invalid request parameters");
  return parsed.data;
}

/**
 * Register the bounded static MCP Skills import surface. The build creates the
 * catalog from reviewed plugin files; no request is ever interpreted as a path.
 * Call before connecting the server. This service owns the resources/read route.
 */
export function registerStaticSkills(server: McpServer, catalog: StaticSkillCatalog): void {
  // Detach from caller-owned objects so instructions and digests stay consistent.
  const snapshot = structuredClone(catalog);
  const skills = new Map<string, StaticSkillEntry>();
  const resources = new Map<string, StaticSkillResource>();
  const names = new Set<string>();
  const listedResources = new Set<string>();

  for (const resource of snapshot.resources) {
    if (resources.has(resource.uri)) throw new Error(`Duplicate skill resource: ${resource.uri}`);
    resources.set(resource.uri, resource);
  }
  for (const skill of snapshot.skills) {
    if (skills.has(skill.uri) || names.has(skill.frontmatter.name)) throw new Error("Duplicate static skill");
    if (!skill.resources.some((resource) => resource.uri === skill.uri)) throw new Error("Missing SKILL.md resource");
    skills.set(skill.uri, skill);
    names.add(skill.frontmatter.name);
    for (const reference of skill.resources) {
      if (listedResources.has(reference.uri)) throw new Error(`Duplicate listed skill resource: ${reference.uri}`);
      const resource = resources.get(reference.uri);
      if (!resource) throw new Error(`Missing skill resource: ${reference.uri}`);
      const bytes = resource.text !== undefined ? Buffer.from(resource.text, "utf8") : Buffer.from(resource.blob, "base64");
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (digest !== reference.digest) throw new Error(`Skill resource digest mismatch: ${reference.uri}`);
      listedResources.add(reference.uri);
    }
  }
  if (listedResources.size !== resources.size) throw new Error("Unlisted static skill resource");

  const skillInstructions = new Map<string, z.output<typeof studySkillResultSchema>>();
  for (const name of studySkillNames) {
    const skill = snapshot.skills.find((entry) => entry.frontmatter.name === name);
    const resource = skill && resources.get(skill.uri);
    if (!skill || resource?.text === undefined) throw new Error(`Missing text Skill: ${name}`);
    skillInstructions.set(name, { name, description: skill.frontmatter.description, instructions: resource.text });
  }
  // Compatibility read tool for clients that cannot load the native Skill body.
  // It serves the same reviewed catalog text, without a second set of rules.
  registerScopedTool(server, "get_study_skill", {
    title: "Read Study Skill instructions",
    description: "Load maintained Study instructions for both schools when native Skills are unavailable. Use canvas for official facts and requested uploads, submissions or messages; daily-brief for a complete daily reminder (also load canvas); study for official records plus lecture evidence; study-lecture for recordings or transcripts. Then use the relevant existing tools.",
    inputSchema: z.object({ name: studySkillNameSchema }).strict(),
    outputSchema: studySkillResultSchema,
    scopes: ["canvas.read"],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    dataLabel: "Study Skill",
    serviceLabel: "Study Skill",
    formatSuccess: (data) => {
      const result = studySkillResultSchema.parse(data);
      return { structuredContent: result, content: [{ type: "text", text: result.instructions }] };
    },
  }, async ({ name }) => skillInstructions.get(name)!);

  server.server.registerCapabilities({ extensions: { "io.modelcontextprotocol/skills": {} } });
  server.server.setRequestHandler(listRequestSchema, (request) => {
    const { cursor } = params(listParamsSchema, request.params === undefined ? {} : request.params);
    if (cursor) throw new McpError(ErrorCode.InvalidParams, "This static skill catalog has no continuation cursor");
    return { skills: structuredClone(snapshot.skills) };
  });
  server.server.setRequestHandler(getRequestSchema, (request) => {
    const { uri } = params(uriParamsSchema, request.params);
    const skill = skills.get(uri);
    if (!skill) throw new McpError(ErrorCode.InvalidParams, "Unknown skill URI");
    return { skill: structuredClone(skill) };
  });
  for (const resource of resources.values()) {
    server.registerResource(resource.uri, resource.uri, { mimeType: resource.mimeType }, async () => ({
      contents: [{ ...resource }],
    }));
  }
  // The SDK normalizes URLs before matching. Use the original URI so aliases,
  // traversal and queries cannot resolve to a different catalog resource.
  server.server.setRequestHandler(readRequestSchema, (request) => {
    const { uri } = params(uriParamsSchema, request.params);
    const resource = resources.get(uri);
    if (!resource) throw new McpError(RESOURCE_NOT_FOUND, "Unknown skill resource URI");
    return { contents: [{ ...resource }] };
  });
}
