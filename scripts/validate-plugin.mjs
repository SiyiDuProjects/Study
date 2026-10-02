import assert from "node:assert/strict";
import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

// Portable repository checks. The official Codex ingestion validators remain
// a separate release check; this does not emulate their evolving full schema.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(root, "plugins/study");
const read = (path) => readFile(path, "utf8");
const json = async (path) => JSON.parse(await read(path));
const object = (value, label) => {
  assert(value && typeof value === "object" && !Array.isArray(value), label);
  return value;
};
const nonempty = (value, label) => assert(typeof value === "string" && value.trim(), label);
const yaml = (source, label) => {
  const doc = parseDocument(source, { uniqueKeys: true });
  assert.equal(doc.errors.length, 0, label + ": " + doc.errors.map(e => e.message).join(", "));
  return object(doc.toJS(), label);
};
async function localPath(base, path) {
  nonempty(path, "missing local path");
  assert(path.startsWith("./"), "plugin paths must be relative");
  const target = await realpath(resolve(base, path));
  const rel = relative(pluginRoot, target);
  assert(!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"), "path leaves plugin");
  return target;
}
const manifest = object(await json(resolve(pluginRoot, ".codex-plugin/plugin.json")), "manifest");
assert.equal(manifest.name, "study");
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/);
nonempty(manifest.description, "plugin description");
const apps = object(await json(await localPath(pluginRoot, manifest.apps)), "apps").apps;
assert.deepEqual(Object.keys(apps), ["canvas"]);
assert.match(apps.canvas.id, /^asdk_app_[a-zA-Z0-9]+$/);
const skillsRoot = await localPath(pluginRoot, manifest.skills);
for (const field of ["composerIcon", "logo"]) await localPath(pluginRoot, manifest.interface[field]);
const marketplace = await json(resolve(root, ".agents/plugins/marketplace.json"));
assert(Array.isArray(marketplace.plugins), "marketplace plugin list required");
const entries = marketplace.plugins.filter(entry => entry.name === manifest.name);
assert(entries.length <= 1, "at most one optional local marketplace entry");
assert.equal(marketplace.plugins.length, entries.length, "no obsolete plugin entries");
for (const entry of entries) {
  assert.equal(entry.source.source, "local");
  assert.equal(resolve(root, entry.source.path), pluginRoot);
  assert(["AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"].includes(entry.policy.installation));
  assert(["ON_INSTALL", "ON_USE"].includes(entry.policy.authentication));
}
const skillNames = [];
for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const path = resolve(skillsRoot, entry.name);
  const source = (await read(resolve(path, "SKILL.md"))).replaceAll("\r\n", "\n");
  const header = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  assert(header, entry.name + ": YAML frontmatter required");
  const frontmatter = yaml(header[1], entry.name);
  assert.equal(frontmatter.name, entry.name);
  assert.match(frontmatter.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert(frontmatter.name.length <= 64);
  nonempty(frontmatter.description, "skill description");
  assert(frontmatter.description.length <= 1024 && !/[<>]/.test(frontmatter.description));
  assert(source.slice(header[0].length).trim(), "skill body");
  const agent = yaml(await read(resolve(path, "agents/openai.yaml")), entry.name + " agent");
  nonempty(agent.interface.display_name, "display name");
  assert(agent.interface.short_description.length >= 25 && agent.interface.short_description.length <= 64);
  assert(agent.interface.default_prompt.includes("$" + entry.name), "default prompt references its skill");
  assert.equal(agent.policy.allow_implicit_invocation, true);
  assert.deepEqual(agent.dependencies.tools.map(tool => [tool.type, tool.value, tool.transport, tool.url]),
    [["mcp", "canvas", "streamable_http", "https://study.siyidu.com/mcp"]]);
  skillNames.push(entry.name);
}
assert.deepEqual(skillNames.sort(), ["canvas", "daily-brief", "study", "study-lecture"]);
console.log(`Plugin package, marketplace references, YAML and ${skillNames.length} skill entrypoints passed.`);
