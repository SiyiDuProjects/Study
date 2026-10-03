import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { installRecordPro } from "./install-record-pro.mjs";
import { checkRecordDependencies, REVIEWED_PRO_VERSION } from "./check-record-dependencies.mjs";

const key = "hp_00000000000000000000000000000000"; // Synthetic test value.
const required = ["dist/index.js", "dist/index.d.ts", "dist/css/components/sheet.css",
  ...["action-bar", "sheet", "list-view"].flatMap(name => [`dist/components/${name}/index.js`, `dist/components/${name}/index.d.ts`])];
async function write(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); }
async function archive(root, { version = REVIEWED_PRO_VERSION, missing } = {}) {
  await write(join(root, "package.json"), JSON.stringify({ name: "@heroui-pro/react", version }));
  for (const path of required) if (path !== missing) await write(join(root, path), "synthetic fixture\n");
}
async function fixture(t) {
  const repository = await mkdtemp(join(tmpdir(), "study-pro-install-test-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const recordRoot = join(repository, "apps/record");
  const target = join(recordRoot, "node_modules/@heroui-pro/react");
  await write(join(recordRoot, "package.json"), JSON.stringify({ dependencies: { "@heroui-pro/react": REVIEWED_PRO_VERSION } }));
  await write(join(recordRoot, "package-lock.json"), JSON.stringify({ packages: {
    "": { dependencies: { "@heroui-pro/react": REVIEWED_PRO_VERSION } },
    "node_modules/@heroui-pro/react": { version: REVIEWED_PRO_VERSION }
  } }));
  await write(join(repository, "node_modules/hpsetup/package.json"), JSON.stringify({ version: "4.7.1" }));
  await write(join(recordRoot, "src/main.css"), '@import "@heroui-pro/react/css/components/sheet.css";');
  await archive(target);
  return { repository, recordRoot, target };
}

test("installs the reviewed archive, checks real CSS imports, and preserves manifests", async t => {
  const h = await fixture(t);
  const manifest = await readFile(join(h.recordRoot, "package.json"));
  const lock = await readFile(join(h.recordRoot, "package-lock.json"));
  await rm(join(h.target, "dist"), { recursive: true }); // Public bootstrap has no licensed runtime.
  let staged;
  await installRecordPro({ repository: h.repository, key, fetchPackage: async (path, supplied) => {
    staged = path;
    assert.equal(supplied, key);
    await archive(path);
    await write(join(path, "dist/index.js"), "reviewed replacement");
  } });
  assert.equal(await readFile(join(h.target, "dist/index.js"), "utf8"), "reviewed replacement");
  assert.equal(await checkRecordDependencies(h), REVIEWED_PRO_VERSION);
  assert.deepEqual(await readFile(join(h.recordRoot, "package.json")), manifest);
  assert.deepEqual(await readFile(join(h.recordRoot, "package-lock.json")), lock);
  await assert.rejects(access(staged));
});

for (const failure of ["wrong-version", "missing-component", "empty-css", "provider-secret-error"]) {
  test(`rejects ${failure} before replacing the existing installation and suppresses provider details`, async t => {
    const h = await fixture(t);
    const original = await readFile(join(h.target, "dist/index.js"));
    let staged;
    await assert.rejects(installRecordPro({ repository: h.repository, key, fetchPackage: async path => {
      staged = path;
      if (failure === "provider-secret-error") throw new Error(`https://provider.invalid/?key=${key}`);
      await archive(path, { version: failure === "wrong-version" ? "1.0.0-beta.9" : REVIEWED_PRO_VERSION,
        missing: failure === "missing-component" ? "dist/components/sheet/index.js" : undefined });
      if (failure === "empty-css") await write(join(path, "dist/css/components/sheet.css"), "");
    } }), error => {
      assert.match(error.message, /Study's authorized HEROUI_KEY/);
      assert(!String(error).includes(key));
      assert(!String(error).includes("provider.invalid"));
      return true;
    });
    assert.deepEqual(await readFile(join(h.target, "dist/index.js")), original);
    await assert.rejects(access(staged));
  });
}

for (const failure of ["missing-key", "website-token", "manifest-range", "wrong-lock", "wrong-helper"]) {
  test(`rejects ${failure} without requesting a download`, async t => {
    const h = await fixture(t);
    if (failure === "manifest-range") await write(join(h.recordRoot, "package.json"), JSON.stringify({ dependencies: { "@heroui-pro/react": "^1.0.0-beta.8" } }));
    if (failure === "wrong-lock") await write(join(h.recordRoot, "package-lock.json"), JSON.stringify({ packages: {} }));
    if (failure === "wrong-helper") await write(join(h.repository, "node_modules/hpsetup/package.json"), JSON.stringify({ version: "4.8.0" }));
    let called = false;
    await assert.rejects(installRecordPro({ repository: h.repository,
      key: failure === "missing-key" ? "" : failure === "website-token" ? "synthetic_other_channel" : key,
      fetchPackage: async () => { called = true; } }), /Record CollectUI installation requires/);
    assert.equal(called, false);
  });
}
