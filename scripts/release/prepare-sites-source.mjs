import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [candidateArg, previousArg] = process.argv.slice(2);
assert(candidateArg && previousArg, "Pass the prepared release directory and previous Sites checkout");
const candidate = resolve(root, candidateArg);
const previous = resolve(root, previousArg);
const rel = relative(resolve(root, ".deploy/releases"), candidate);
assert(rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel), "Use a prepared release under .deploy/releases");
const manifest = JSON.parse(readFileSync(resolve(candidate, "manifest.json"), "utf8"));
const destination = resolve(candidate, "sites-source");
assert(!existsSync(destination), "Source capsule already exists; preserve it");
const git = (args, cwd) => execFileSync("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
git(["clone", "--no-hardlinks", previous, destination], root);
const previousCommit = git(["rev-parse", "HEAD"], destination);
git(["rm", "-r", "--", "."], destination);
const shared = new Set(manifest.record.sharedSourceFiles.map(x => x.path));
const entries = manifest.source.files.filter(x => x.path.startsWith("apps/record/") || shared.has(x.path));
for (const entry of entries) {
  const source = resolve(candidate, "source", entry.path);
  const bytes = readFileSync(source);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, "Source snapshot changed");
  const target = resolve(destination, entry.path);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
mkdirSync(resolve(destination, ".openai"), { recursive: true });
copyFileSync(resolve(destination, "apps/record/.openai/hosting.json"), resolve(destination, ".openai/hosting.json"));
writeFileSync(resolve(destination, ".gitignore"), "node_modules/\ndist/\n.wrangler/\n.env*\n.dev.vars*\n");
writeFileSync(resolve(destination, "package.json"), JSON.stringify({ name: "study-record-source", private: true, scripts: { build: "npm --prefix apps/record run sites:build" } }, null, 2) + "\n");
writeFileSync(resolve(destination, "release-source.json"), JSON.stringify({ releaseId: manifest.id, sourceSha256: manifest.source.sha256, previousCommit, sharedSources: [...shared], files: entries }, null, 2) + "\n");
git(["add", "--all"], destination);
console.log(JSON.stringify({ directory: destination, previousCommit, stagedFiles: entries.length, next: "Review staged source; commit; build with licensed dependencies; use official Sites packager; push with short-lived per-command authentication; then save that exact HEAD." }));
