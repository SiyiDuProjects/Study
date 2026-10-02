import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { registerStaticSkills, studyMcpInstructions, type StaticSkillCatalog, type StaticSkillEntry, type StaticSkillResource } from "../src/mcp/staticSkills.js";
import { studySkillCatalog } from "../src/mcp/studySkillCatalog.generated.js";
import { registerScopedTool } from "../src/mcp/canvasTools.js";

const skillSchema = z.object({
  uri: z.string(),
  frontmatter: z.object({ name: z.string(), description: z.string() }).loose(),
  resources: z.array(z.object({ uri: z.string(), digest: z.string() })),
});
const listSchema = z.object({ skills: z.array(skillSchema), nextCursor: z.string().optional() });
const getSchema = z.object({ skill: skillSchema });
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
});

function fixture(): StaticSkillCatalog {
  const skills: StaticSkillEntry[] = [];
  const resources: StaticSkillResource[] = [];
  for (const name of ["canvas", "daily-brief", "study", "study-lecture"]) {
    const uri = `skill://hanyang-study/${name}/SKILL.md`;
    const frontmatter = { name, description: `${name} description`, metadata: { institution: "한양" } };
    const files = [
      {
        uri,
        mimeType: "text/markdown",
        text: `---\nname: ${name}\ndescription: ${name} description\nmetadata:\n  institution: 한양\n---\n\n# ${name}\n\n中文 한국어 instructions.\n`,
      },
      {
        uri: `skill://hanyang-study/${name}/agents/openai.yaml`,
        mimeType: "application/yaml",
        text: `interface:\n  display_name: "${name}"\n`,
      },
    ];
    resources.push(...files);
    skills.push({
      uri,
      frontmatter,
      resources: files.map((resource) => ({
        uri: resource.uri,
        digest: `sha256:${createHash("sha256").update(resource.text, "utf8").digest("hex")}`,
      })),
    });
  }
  return { skills, resources };
}

async function connect(catalog = fixture()) {
  const server = new McpServer({ name: "static-skills-test", version: "1.0.0" }, { instructions: studyMcpInstructions });
  registerScopedTool(server, "ordinary_read", {
    title: "Ordinary read",
    description: "An existing ordinary read",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ message: z.string() }).strict(),
    scopes: ["canvas.read"],
    formatSuccess: () => ({
      content: [{ type: "text", text: "ordinary result" }],
      structuredContent: { message: "ordinary result" },
    }),
  }, async () => ({ message: "ordinary result" }));
  registerStaticSkills(server, catalog);
  const client = new Client({ name: "skill-import-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  closers.push(() => client.close(), () => server.close());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("static MCP Skills import", () => {
  it("advertises the extension alongside resources and leaves ordinary tools usable", async () => {
    const client = await connect();
    expect(client.getServerCapabilities()).toMatchObject({
      extensions: { "io.modelcontextprotocol/skills": {} },
      resources: {},
      tools: {},
    });
    expect(client.getServerCapabilities()?.experimental).toBeUndefined();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["ordinary_read", "get_study_skill"]);
    expect((await client.callTool({ name: "ordinary_read", arguments: {} })).content).toEqual([
      { type: "text", text: "ordinary result" },
    ]);
  });

  it("advertises a scoped read-only compatibility tool with bounded Skill names", async () => {
    const client = await connect(studySkillCatalog);
    expect(studyMcpInstructions.length).toBeLessThan(512);
    expect(client.getInstructions()).toBe(studyMcpInstructions);
    const result = await client.request({ method: "tools/list" }, z.object({ tools: z.array(z.object({ name: z.string() }).loose()) }));
    const tool = result.tools.find((entry) => entry.name === "get_study_skill");
    expect(tool).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      securitySchemes: [{ type: "oauth2", scopes: ["canvas.read"] }],
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["canvas.read"] }] },
      inputSchema: { type: "object", additionalProperties: false, properties: { name: { enum: ["canvas", "daily-brief", "study", "study-lecture"] } }, required: ["name"] },
      outputSchema: { type: "object", additionalProperties: false, required: ["name", "description", "instructions"] },
    });
  });

  it("returns the exact canonical Skill body for each of the four compatibility tool names", async () => {
    const client = await connect(studySkillCatalog);
    for (const skill of studySkillCatalog.skills) {
      const resource = studySkillCatalog.resources.find((entry) => entry.uri === skill.uri)!;
      const result = await client.callTool({ name: "get_study_skill", arguments: { name: skill.frontmatter.name } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        name: skill.frontmatter.name,
        description: skill.frontmatter.description,
        instructions: resource.text,
      });
      expect(result.content).toEqual([{ type: "text", text: resource.text }]);
      expect((await client.readResource({ uri: skill.uri })).contents).toEqual([resource]);
    }
  });

  it("rejects unsupported compatibility names and resource paths without serving any Skill body", async () => {
    const client = await connect(studySkillCatalog);
    for (const name of ["missing", "../../.env", "file:///etc/passwd", "skill://hanyang-study/canvas/SKILL.md", "canvas/agents/openai.yaml"]) {
      const result = await client.callTool({ name: "get_study_skill", arguments: { name } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      for (const resource of studySkillCatalog.resources) {
        expect(JSON.stringify(result.content)).not.toContain(resource.text);
      }
    }
  });

  it("lists all four skills in one page and returns the identical complete entries from skills/get", async () => {
    const catalog = fixture();
    const client = await connect(catalog);
    const result = await client.request({ method: "skills/list", params: {} }, listSchema);
    expect(result).toEqual({ skills: catalog.skills });
    expect(result).not.toHaveProperty("nextCursor");
    for (const entry of result.skills) {
      expect(await client.request({ method: "skills/get", params: { uri: entry.uri } }, getSchema)).toEqual({ skill: entry });
    }
  });

  it("returns exactly the requested resource, with correct UTF-8 digest and full frontmatter", async () => {
    const catalog = fixture();
    const client = await connect(catalog);
    const { skills } = await client.request({ method: "skills/list", params: {} }, listSchema);
    expect((await client.listResources()).resources.map((resource) => resource.uri).sort()).toEqual(
      catalog.resources.map((resource) => resource.uri).sort(),
    );
    let count = 0;
    for (const skill of skills) {
      for (const resource of skill.resources) {
        const response = await client.readResource({ uri: resource.uri });
        const expected = catalog.resources.find((entry) => entry.uri === resource.uri);
        expect(response.contents).toEqual([expected]);
        const content = response.contents[0]!;
        expect("text" in content).toBe(true);
        const text = content.text as string;
        expect(resource.digest).toBe(`sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`);
        if (resource.uri === skill.uri) {
          const [, yaml] = text.split("---\n");
          expect(yaml).toBe(`name: ${skill.frontmatter.name}\ndescription: ${skill.frontmatter.description}\nmetadata:\n  institution: 한양\n`);
          expect(skill.frontmatter.metadata).toEqual({ institution: "한양" });
        }
        count += 1;
      }
    }
    expect(count).toBe(8);
  });

  it("rejects unknown cursors and invalid parameters without internal errors", async () => {
    const client = await connect();
    for (const params of [{ cursor: "second-page" }, { cursor: 2 }, { cursor: null }]) {
      await expect(client.request({ method: "skills/list", params }, listSchema)).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
    for (const params of [{}, { uri: 2 }, { uri: "" }]) {
      await expect(client.request({ method: "skills/get", params }, getSchema)).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(client.request({ method: "resources/read", params }, z.object({}).loose())).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
  });

  it("does not resolve unknown, filesystem, traversal or normalized-alias URIs", async () => {
    const client = await connect();
    const uris = [
      "skill://hanyang-study/missing/SKILL.md",
      "file:///etc/passwd",
      "file:///C:/Windows/win.ini",
      "skill://hanyang-study/canvas/../daily-brief/SKILL.md",
      "skill://hanyang-study/canvas/%2e%2e/daily-brief/SKILL.md",
      "skill://hanyang-study/canvas/./SKILL.md",
      "skill://hanyang-study/canvas/SKILL.md?download=1",
      "skill://hanyang-study/canvas/SKILL.md#fragment",
      "../../.env",
    ];
    for (const uri of uris) {
      await expect(client.request({ method: "skills/get", params: { uri } }, getSchema)).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(client.readResource({ uri })).rejects.toMatchObject({ code: -32002 });
    }
  });

  it("keeps the registered snapshot stable when a caller mutates its source catalog", async () => {
    const catalog = fixture();
    const expected = structuredClone(catalog);
    const client = await connect(catalog);
    Object.assign(catalog.skills[0]!.frontmatter, { description: "changed later" });
    Object.assign(catalog.resources[0]!, { text: "changed later" });
    expect(await client.request({ method: "skills/list", params: {} }, listSchema)).toEqual({ skills: expected.skills });
    expect((await client.readResource({ uri: expected.resources[0]!.uri })).contents).toEqual([expected.resources[0]]);
  });

  it("refuses a catalog whose advertised digest does not match the served bytes", () => {
    const catalog = fixture();
    Object.assign(catalog.resources[0]!, { text: "unexpected replacement" });
    const server = new McpServer({ name: "invalid-skill-test", version: "1.0.0" });
    expect(() => registerStaticSkills(server, catalog)).toThrow("Skill resource digest mismatch");
  });
});
