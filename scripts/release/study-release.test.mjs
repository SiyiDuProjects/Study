import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertRecordUnchanged, assertValidated, fingerprint, main, sharedRecordSources, validateArchiveEntries } from "../study-release.mjs";

async function fixture(t, workspace = false) {
  const parent = workspace ? resolve(dirname(fileURLToPath(import.meta.url)), "../../.deploy/release-cli-tests") : resolve(tmpdir());
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "study-release-test-"));
  t.after(async () => {
    const rel = relative(parent, resolve(root));
    assert(!isAbsolute(rel) && rel.startsWith("study-release-test-") && !rel.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  const file = async (path, contents = "synthetic test content\n") => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  };
  return { root, file };
}

test("source inventory excludes environment, credentials, dependency trees and audio but retains timetable data", async t => {
  const { root, file } = await fixture(t);
  await file("src/app.ts");
  await file("src/data/hanyang-timetable.json", "{}\n");
  for (const path of ["src/.env", "src/.env.example", "src/.dev.vars", "src/secrets/access.json", "src/auth.pem",
    "src/node_modules/package/index.js", "src/.git/config", "src/classroom.wav", "src/capture.webm", "src/recording.sqlite"])
    await file(path);
  const result = await fingerprint(root, ["src"]);
  assert.deepEqual(result.files.map(item => item.path), ["src/app.ts", "src/data/hanyang-timetable.json"]);
  assert.equal(result.sha256.length, 64);
});

test("source junctions or symlinks are rejected before traversing their targets", async t => {
  const { root, file } = await fixture(t);
  await file("src/app.ts");
  await file("outside/private.txt");
  try { await symlink(join(root, "outside"), join(root, "src/link"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("This environment cannot create test symlinks"); return; }
    throw error;
  }
  await assert.rejects(fingerprint(root, ["src"]), /符号链接/);
});

test("Skill preflight rejects forbidden resources before a generator can embed them", async t => {
  const { root, file } = await fixture(t);
  await file("plugins/study/skills/canvas/SKILL.md", "# synthetic skill\n");
  await file("plugins/study/skills/canvas/.env", "SYNTHETIC_SECRET=not-a-real-key\n");
  await assert.rejects(fingerprint(root, ["plugins/study/skills"], { rejectExcluded: true }), /不能生成快照/);
});

test("preparation rejects missing checks and changed source or build bytes", async t => {
  const { root, file } = await fixture(t);
  await file("src/app.ts");
  await file("dist/index.js");
  const source = await fingerprint(root, ["src"]);
  const build = await fingerprint(root, ["dist"]);
  const check = { schemaVersion: 1, status: "passed", source, build };
  assert.doesNotThrow(() => assertValidated(check, source, build));
  assert.throws(() => assertValidated(null, source, build), /先运行 check/);
  assert.throws(() => assertValidated({ ...check, status: "failed" }, source, build), /先运行 check/);
  await file("src/app.ts", (await readFile(join(root, "src/app.ts"), "utf8")) + "// changed\n");
  const changedSource = await fingerprint(root, ["src"]);
  assert.throws(() => assertValidated(check, changedSource, build), /源码已变化/);
  await file("dist/index.js", "changed build\n");
  const changedBuild = await fingerprint(root, ["dist"]);
  assert.throws(() => assertValidated(check, source, changedBuild), /构建产物已变化/);
});

test("Record manifest names external Core source and fails if that source is absent", async t => {
  const { root, file } = await fixture(t);
  await file("apps/core/src/lecture/types.ts", "export const schema = {};\n");
  await file("apps/core/src/logger.ts", "export const log = () => {};\n");
  await file("apps/record/worker/index.ts", 'import { schema } from "../../core/src/lecture/types";\nimport { log } from "../../core/src/logger";\n');
  const source = await fingerprint(root, ["apps"]);
  assert.deepEqual((await sharedRecordSources(root, source)).map(item => item.path), ["apps/core/src/lecture/types.ts", "apps/core/src/logger.ts"]);
  const missing = { ...source, files: source.files.filter(item => !item.path.endsWith("logger.ts")) };
  await assert.rejects(sharedRecordSources(root, missing), /外部源码未纳入/);
});

test("archive verification accepts source/build paths and rejects environment, recordings and path escapes", () => {
  assert.doesNotThrow(() => validateArchiveEntries("./\n./src/data/hanyang-timetable.json\ndist/server/index.js\ndist/.openai/hosting.json\n"));
  for (const path of ["./.env", "dist/.env.production", "dist/recordings/class.mp3", "../outside", "/etc/passwd", "C:/private/key.txt", "src/node_modules/x.js"])
    assert.throws(() => validateArchiveEntries(path), /禁止路径/);
});

test("Core-only release rejects changed, removed or added Record inputs and shared dependencies", () => {
  const files = [{ path: "apps/record/src/a.ts", sha256: "record" }, { path: "apps/core/src/logger.ts", sha256: "shared" }];
  const previous = { source: { files } };
  const shared = [files[1]];
  assert.doesNotThrow(() => assertRecordUnchanged({ files: [...files, { path: "apps/core/src/content.ts", sha256: "new" }] }, previous, shared));
  for (const changed of [files.slice(1), [...files, { path: "apps/record/src/new.ts", sha256: "new" }],
    [files[0], { ...files[1], sha256: "changed" }]])
    assert.throws(() => assertRecordUnchanged({ files: changed }, previous, shared), /配套发布/);
});

test("Core-only prepare creates a verified archive without a Sites helper", async t => {
  const { root, file } = await fixture(t, true);
  await file("apps/core/src/index.ts", "export const safe = true;\n");
  await file("apps/record/src/App.tsx", "export {};\n");
  await file("plugins/study/.codex-plugin/plugin.json", JSON.stringify({ version: "test" }));
  await file("plugins/study/.app.json", JSON.stringify({ apps: { canvas: { id: "synthetic" } } }));
  await file("apps/record/.openai/hosting.json", JSON.stringify({ project_id: "synthetic" }));
  for (const path of ["apps/core/dist/index.js", "apps/record/dist/client/index.html", "apps/record/dist/server/index.js", "apps/record/dist/.openai/hosting.json"])
    await file(path);
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=Release Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "synthetic"]);
  const source = await fingerprint(root, ["apps/core/src", "apps/record/src", "apps/record/.openai/hosting.json", "plugins/study"]);
  const build = await fingerprint(root, ["apps/core/dist", "apps/record/dist/client", "apps/record/dist/server", "apps/record/dist/.openai"]);
  await file("docs/releases/latest.json", JSON.stringify({ releaseId: "previous", sourceManifest: ".deploy/previous.json" }));
  await file(".deploy/previous.json", JSON.stringify({ source }));
  await file(".deploy/releases/check.json", JSON.stringify({ schemaVersion: 1, status: "passed", source, build }));
  await main(["prepare", "--core-only"], root);
  const directory = (await readdir(join(root, ".deploy/releases"), { withFileTypes: true })).find(item => item.isDirectory()).name;
  const candidate = join(root, ".deploy/releases", directory);
  const manifest = JSON.parse(await readFile(join(candidate, "manifest.json"), "utf8"));
  assert.equal(manifest.releaseTarget, "core");
  assert.equal(manifest.phases.recordDeployment, "unchanged");
  assert.equal(manifest.record.unchangedFromRelease, "previous");
  assert.equal(manifest.packager, null);
  assert.deepEqual(manifest.archives.map(item => item.path), ["core-source.tar.gz"]);
  assert.match(execFileSync("tar", ["-tzf", join(candidate, "core-source.tar.gz")], { encoding: "utf8" }), /src\/index\.ts/);
});

test("prepare runs the official Sites helper in an isolated fixture and omits stale root assets", { skip: !process.env.STUDY_TEST_SITES_HELPER }, async t => {
  const { root, file } = await fixture(t, true);
  const inputs = ["apps/core/src", "apps/record/src", "apps/record/.openai/hosting.json", "plugins/study"];
  const outputs = ["apps/core/dist", "apps/record/dist/client", "apps/record/dist/server", "apps/record/dist/.openai"];
  const hosting = JSON.stringify({ project_id: "synthetic-test-only", d1: "DB" });
  await file("apps/core/src/index.ts", "export const ready = true;\n");
  await file("apps/core/src/lecture/types.ts", "export const schema = {};\n");
  await file("apps/record/src/App.tsx", 'import { schema } from "../../core/src/lecture/types";\n');
  await file("apps/record/.openai/hosting.json", hosting);
  await file("plugins/study/.codex-plugin/plugin.json", JSON.stringify({ version: "test" }));
  await file("plugins/study/.app.json", JSON.stringify({ apps: { canvas: { id: "synthetic-test-only" } } }));
  await file("apps/core/dist/index.js", "export const ready = true;\n");
  await file("apps/record/dist/client/index.html", "<!doctype html><title>synthetic build</title>\n");
  await file("apps/record/dist/server/index.js", "export default { fetch() { return new Response('test'); } };\n");
  await file("apps/record/dist/.openai/hosting.json", hosting);
  await file("apps/record/dist/old-unverified.js", "stale output\n");
  await file("apps/core/src/.env", "SYNTHETIC_SECRET=not-a-real-key\n");
  await file("apps/record/src/recording.wav");
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=Release Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "synthetic release fixture"]);
  await file(".deploy/releases/check.json", JSON.stringify({ schemaVersion: 1, status: "passed", finishedAt: new Date().toISOString(),
    source: await fingerprint(root, inputs), build: await fingerprint(root, outputs) }));
  await main(["prepare", "--sites-helper", process.env.STUDY_TEST_SITES_HELPER], root);
  const directory = (await readdir(join(root, ".deploy/releases"), { withFileTypes: true })).find(item => item.isDirectory()).name;
  const candidate = join(root, ".deploy/releases", directory);
  const manifest = JSON.parse(await readFile(join(candidate, "manifest.json"), "utf8"));
  assert.equal(manifest.phases.coreDeployment, "not_recorded");
  assert.equal(manifest.record.sharedSourceFiles[0].path, "apps/core/src/lecture/types.ts");
  const coreEntries = execFileSync("tar", ["-tzf", join(candidate, "core-source.tar.gz")], { encoding: "utf8" });
  const recordEntries = execFileSync("tar", ["-tzf", join(candidate, "record-build.tar.gz")], { encoding: "utf8" });
  assert.match(coreEntries, /src\/index\.ts/);
  assert.doesNotMatch(coreEntries, /\.env|node_modules|\.git/);
  assert.match(recordEntries, /dist\/server\/index\.js/);
  assert.match(recordEntries, /dist\/client\/index\.html/);
  assert.doesNotMatch(recordEntries, /old-unverified|recording\.wav/);
});
