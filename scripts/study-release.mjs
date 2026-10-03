#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaVersion = 1;
const sourceTrees = [
  "apps/core/src", "apps/core/scripts", "apps/core/test",
  "apps/record/src", "apps/record/worker", "apps/record/services", "apps/record/shared",
  "apps/record/build", "apps/record/scripts", "apps/record/tests", "apps/record/public", "apps/record/drizzle",
  "plugins/study", "scripts", "infra",
];
const sourceFiles = [
  "package.json", "package-lock.json", "AGENTS.md", "README.md", "DEPLOY_CICD.md",
  ".gitattributes", ".github/workflows/ci.yml", ".agents/plugins/marketplace.json", "docs/release-workflow.md",
  ...["package.json", "package-lock.json", "tsconfig.json", "Dockerfile", ".dockerignore"].map(name => `apps/core/${name}`),
  ...["package.json", "package-lock.json", "index.html", "tsconfig.json", "tsconfig.app.json", "tsconfig.worker.json",
    "vite.config.mts", "vite.sites.config.mts", "vitest.config.mts", "wrangler.sites.jsonc", ".openai/hosting.json"].map(name => `apps/record/${name}`),
];
const buildTrees = ["apps/core/dist", "apps/record/dist/client", "apps/record/dist/server", "apps/record/dist/.openai"];
const requiredBuildFiles = [
  "apps/core/dist/index.js", "apps/record/dist/client/index.html", "apps/record/dist/server/index.js",
  "apps/record/dist/.openai/hosting.json",
];
const steps = [
  ["发布工具测试", ".", "test:release"],
  ["插件校验", ".", "validate:plugin"],
  ["Core 类型检查", "apps/core", "typecheck"],
  ["Core 测试", "apps/core", "test"],
  ["Core 构建", "apps/core", "build"],
  ["Record 授权组件预检", ".", "check:record-dependencies"],
  ["Record 类型检查", "apps/record", "typecheck"],
  ["Record 测试", "apps/record", "test"],
  ["Record Sites 构建", "apps/record", "sites:build"],
  ["Record Worker 冒烟检查", "apps/record", "test:worker"],
];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const slash = path => path.split(sep).join("/");
const fileKey = files => sha256(JSON.stringify(files));
const releaseBase = root => join(root, ".deploy", "releases");
const checkPath = root => join(releaseBase(root), "check.json");

export function isExcluded(path) {
  const parts = path.replaceAll("\\", "/").split("/");
  return parts.some(part => /^(?:node_modules|\.git|\.wrangler|secrets?|credentials?|recordings?|uploads?|backups?)$/i.test(part)
    || /^\.(?:env|dev\.vars)(?:\.|$)/i.test(part)
    || /^(?:\.npmrc|\.netrc|id_rsa|id_ed25519)$/i.test(part)
    || /(?:password|credential|secret)[._-]?(?:backup|export)?\.(?:txt|json|ya?ml)$/i.test(part))
    || /\.(?:pem|key|p12|pfx|sqlite(?:-.*)?|db|log|wav|mp3|m4a|aac|flac|ogg|opus|webm|mp4|mov|aiff|caf)$/i.test(path);
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function inside(root, path) {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("路径超出 Study 工作区");
  return rel;
}

async function regular(root, path) {
  inside(root, path);
  // Check every existing component: an ancestor junction is also a symlink.
  let cursor = root;
  for (const component of relative(root, path).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`发布输入不能包含符号链接：${slash(relative(root, cursor))}`);
  }
  return lstat(path);
}

async function walk(root, path, found, rejectExcluded) {
  const rel = slash(inside(root, path));
  if (isExcluded(rel)) {
    if (rejectExcluded) throw new Error(`Skills 输入含禁止文件或目录，不能生成快照：${rel}`);
    return;
  }
  if (!await exists(path)) return;
  if (/[\x00-\x1f]/.test(rel)) throw new Error("发布输入含不支持的控制字符文件名");
  const info = await regular(root, path);
  if (info.isDirectory()) {
    for (const name of (await readdir(path)).sort()) await walk(root, join(path, name), found, rejectExcluded);
  } else if (info.isFile()) {
    const bytes = await readFile(path);
    found.set(rel, { path: rel, bytes: bytes.length, sha256: sha256(bytes) });
  } else throw new Error(`发布输入不是普通文件：${rel}`);
}

export async function fingerprint(root, paths, { rejectExcluded = false } = {}) {
  const found = new Map();
  for (const path of paths) await walk(root, resolve(root, path), found, rejectExcluded);
  const files = [...found.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { sha256: fileKey(files), files };
}

const sources = root => fingerprint(root, [...sourceTrees, ...sourceFiles]);
const builds = root => fingerprint(root, buildTrees);

async function json(path) { return JSON.parse(await readFile(path, "utf8")); }
async function optionalJson(path) { return await exists(path) ? json(path) : null; }

async function outputDirectory(root, path) {
  inside(root, path);
  let cursor = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (!await exists(cursor)) await mkdir(cursor);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("发布输出目录不能是文件或符号链接");
  }
}

async function writeJson(root, path, value) {
  await outputDirectory(root, dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  await rename(temporary, path);
}

async function run(command, args, cwd, capture = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let output = "";
    if (capture) {
      child.stdout.on("data", chunk => { output += chunk; });
      // Do not echo arbitrary subprocess diagnostics (which could contain env values).
      child.stderr.resume();
    }
    child.once("error", () => reject(new Error(`无法启动 ${command === process.execPath ? "Node.js" : command}`)));
    child.once("close", code => code === 0 ? resolveRun(output.trimEnd()) : reject(new Error(`命令失败（退出码 ${code}）：${args[0] ?? command}`)));
  });
}

async function npmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")].filter(Boolean);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    candidates.push(join(directory.replace(/^"|"$/g, ""), "node_modules/npm/bin/npm-cli.js"));
    const executable = join(directory, "npm");
    if (process.platform !== "win32" && await exists(executable)) candidates.push(await realpath(executable));
  }
  for (const candidate of candidates) if (await exists(candidate) && candidate.endsWith(".js")) return candidate;
  throw new Error("找不到本机 npm CLI；请通过 npm 运行此入口，或安装 Node.js/npm。不会自动下载安装。");
}

async function gitState(root) {
  const [head, branch, dirty] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], root, true),
    run("git", ["branch", "--show-current"], root, true),
    run("git", ["status", "--porcelain=v1", "--untracked-files=all"], root, true),
  ]);
  return { head, branch: branch || "detached", dirty: Boolean(dirty), changedPaths: dirty ? dirty.split("\n").length : 0 };
}

async function targets(root) {
  const hosting = await json(join(root, "apps/record/.openai/hosting.json"));
  const plugin = await json(join(root, "plugins/study/.codex-plugin/plugin.json"));
  const app = await json(join(root, "plugins/study/.app.json"));
  if (typeof hosting.project_id !== "string" || typeof app.apps?.canvas?.id !== "string") throw new Error("缺少 Record Sites 或 Canvas 在线应用标识");
  return {
    core: { ssh: "ubuntu@49.51.38.235:22", directory: "/home/ubuntu/siyi/canvas", origin: "https://study.siyidu.com" },
    record: { projectId: hosting.project_id },
    chatgpt: { appId: app.apps.canvas.id, pluginVersion: plugin.version },
  };
}

async function lastManifest(root) {
  const base = releaseBase(root);
  if (!await exists(base)) return null;
  const directories = (await readdir(base, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name).sort().reverse();
  for (const directory of directories) {
    const path = join(base, directory, "manifest.json");
    if (await exists(path)) return { path: slash(relative(root, path)), manifest: await json(path) };
  }
  return null;
}

export function assertValidated(check, source, build) {
  if (check?.schemaVersion !== schemaVersion || check.status !== "passed") throw new Error("尚无成功的本地校验；先运行 check。");
  if (check.source.sha256 !== source.sha256) throw new Error("源码已变化；先重新运行 check，不能沿用旧校验制作候选。");
  if (check.build.sha256 !== build.sha256) throw new Error("构建产物已变化；先重新运行 check，不能打包未验证产物。");
}

async function status(root) {
  const [git, target, check, last, source, build, deployed] = await Promise.all([
    gitState(root), targets(root), optionalJson(checkPath(root)), lastManifest(root), sources(root), builds(root),
    optionalJson(join(root, "docs/releases/latest.json")),
  ]);
  console.log("Study 发布状态（仅本地记录，未查询线上）");
  console.log(`源码：${git.branch} / ${git.head.slice(0, 12)}；${git.dirty ? `有 ${git.changedPaths} 个改动路径` : "工作区干净"}。dirty 不代表未上线。`);
  console.log(`Core 目标：${target.core.origin}；${target.core.ssh} ${target.core.directory}`);
  console.log(`Record Sites：${target.record.projectId}；ChatGPT：${target.chatgpt.appId}（本地包 ${target.chatgpt.pluginVersion}）`);
  console.log(`最近校验：${check?.status ?? "无记录"}${check?.finishedAt ? ` / ${check.finishedAt}` : ""}`);
  if (check?.status === "passed") console.log(`当前源码${check.source.sha256 === source.sha256 ? "匹配" : "不匹配"}校验；当前构建${check.build.sha256 === build.sha256 ? "匹配" : "不匹配"}校验。`);
  console.log(`最近候选清单：${last?.path ?? "无记录"}`);
  console.log(`最近部署回执：${deployed ? "docs/releases/latest.json（本地历史回执，未实时查询线上）" : "无本地回执"}`);
  if (deployed) {
    const statuses = { succeeded: "成功", deployed: "已部署", complete: "完成", completed: "完成", passed: "通过", verified: "已验证",
      pending: "待完成", failed: "失败", not_recorded: "未记录", not_run: "未执行", partial: "部分完成" };
    const describe = item => statuses[typeof item === "string" ? item : item?.status] ?? "状态未标明，见回执";
    const component = name => deployed[name] ?? deployed.components?.[name] ?? deployed.stages?.[name];
    console.log(`回执所记：Core ${describe(component("core"))}；Record ${describe(component("record"))}；ChatGPT ${describe(component("chatgpt"))}；实测 ${describe(component("liveVerification"))}。`);
  }
  console.log("服务器部署、Record 部署、ChatGPT 刷新和线上实测：本命令均未核验。不会更新本机插件。");
}

async function check(root) {
  const startedAt = new Date().toISOString();
  const results = [];
  await writeJson(root, checkPath(root), { schemaVersion, status: "running", startedAt });
  try {
    const npm = await npmCli();
    // The catalog generator embeds every Skill resource in TypeScript. Reject
    // forbidden files before generation; excluding their original paths later
    // would not remove bytes already embedded in the generated source.
    await fingerprint(root, ["plugins/study/skills"], { rejectExcluded: true });
    console.log("先生成四个 canonical MCP Skills；随后校验本次完整源码。");
    await run(process.execPath, [npm, "run", "build:mcp-skills"], root);
    const before = await sources(root);
    for (const [label, directory, script] of steps) {
      console.log(`\n[校验] ${label}`);
      const start = Date.now();
      await run(process.execPath, [npm, "run", script], resolve(root, directory));
      results.push({ label, directory, script, status: "passed", durationMs: Date.now() - start });
    }
    const source = await sources(root);
    if (source.sha256 !== before.sha256) throw new Error("校验期间源码发生变化；请等编辑完成后重跑 check。");
    for (const path of requiredBuildFiles) if (!await exists(join(root, path))) throw new Error(`缺少构建产物：${path}`);
    const receipt = { schemaVersion, status: "passed", startedAt, finishedAt: new Date().toISOString(),
      git: await gitState(root), source, build: await builds(root), steps: results };
    await writeJson(root, checkPath(root), receipt);
    console.log(`\n本地校验完成；源码 SHA256 ${source.sha256.slice(0, 16)}。下一步：node scripts/study-release.mjs prepare`);
    console.log("本次未部署服务器、未刷新 ChatGPT、未做线上实测、未更新本机插件。");
  } catch (error) {
    await writeJson(root, checkPath(root), { schemaVersion, status: "failed", startedAt, finishedAt: new Date().toISOString(), steps: results });
    throw error;
  }
}

async function helperPath(explicit) {
  if (explicit) {
    const path = resolve(explicit);
    if (await exists(path)) return path;
    throw new Error("指定的 Sites package-site.sh 不存在");
  }
  const cache = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "plugins/cache/openai-bundled/sites");
  if (await exists(cache)) {
    const versions = (await readdir(cache)).sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
    for (const version of versions) {
      const path = join(cache, version, "scripts/package-site.sh");
      if (await exists(path)) return path;
    }
  }
  throw new Error("找不到已安装 Sites 官方打包 helper；使用 prepare --sites-helper <package-site.sh路径>。不会安装插件。");
}

async function bashPath() {
  if (process.platform !== "win32") return "bash";
  for (const path of [join(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe"), "C:/Program Files/Git/usr/bin/bash.exe"])
    if (await exists(path)) return path;
  throw new Error("需要本机 Git Bash 运行官方 Sites 打包 helper；不会自动安装。");
}

const bashArgument = path => process.platform === "win32"
  ? path.replaceAll("\\", "/").replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`)
  : path;

async function copyVerified(root, entry, destination) {
  const path = join(root, entry.path);
  const info = await regular(root, path);
  if (!info.isFile()) throw new Error(`输入已不是普通文件：${entry.path}`);
  const bytes = await readFile(path);
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`复制期间文件发生变化：${entry.path}`);
  await outputDirectory(root, dirname(destination));
  await writeFile(destination, bytes, { flag: "wx" });
}

export async function sharedRecordSources(root, source) {
  const shared = new Set();
  const byPath = new Map(source.files.map(file => [file.path, file]));
  for (const entry of source.files.filter(file => file.path.startsWith("apps/record/") && /\.[cm]?[jt]sx?$/.test(file.path))) {
    const body = await readFile(join(root, entry.path), "utf8");
    for (const match of body.matchAll(/\b(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']/g)) {
      const target = resolve(dirname(join(root, entry.path)), match[1]);
      const rel = slash(inside(root, target));
      if (rel.startsWith("apps/record/")) continue;
      const stem = rel.replace(/\.js$/, "");
      const resolved = [rel, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`].find(candidate => byPath.has(candidate));
      if (!resolved) throw new Error(`Record 的外部源码未纳入发布清单：${rel}`);
      shared.add(resolved);
    }
  }
  return [...shared].sort().map(path => byPath.get(path));
}

export function validateArchiveEntries(output) {
  for (const raw of output.split(/\r?\n/).filter(Boolean)) {
    const path = raw.replace(/^\.\//, "").replace(/\/$/, "");
    if (path === "." || path === "") continue;
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes("..") || isExcluded(path))
      throw new Error("归档出现禁止路径；此候选不可发布。");
  }
}

export function assertRecordUnchanged(source, previous, shared) {
  const paths = new Set(shared.map(file => file.path));
  const select = files => files.filter(file => file.path.startsWith("apps/record/") || paths.has(file.path));
  if (!previous?.source?.files || fileKey(select(source.files)) !== fileKey(select(previous.source.files)))
    throw new Error("Core-only 候选要求 Record 及其共享源码与最近已发布清单一致；否则必须配套发布。");
}

async function prepare(root, explicitHelper, coreOnly = false) {
  const receipt = await optionalJson(checkPath(root));
  const [source, build] = await Promise.all([sources(root), builds(root)]);
  assertValidated(receipt, source, build);
  const shared = await sharedRecordSources(root, source);
  const latest = coreOnly ? await optionalJson(join(root, "docs/releases/latest.json")) : null;
  if (coreOnly) {
    if (!latest?.sourceManifest) throw new Error("Core-only 候选缺少最近已发布清单。");
    const previousPath = resolve(root, latest.sourceManifest);
    await regular(root, previousPath);
    assertRecordUnchanged(source, await json(previousPath), shared);
  }
  const helper = coreOnly ? null : await helperPath(explicitHelper);
  const bash = coreOnly ? null : await bashPath();
  const git = await gitState(root);
  const preparedAt = new Date().toISOString();
  const id = `${preparedAt.replace(/[-:.]/g, "")}-${git.head.slice(0, 12)}-${source.sha256.slice(0, 12)}`;
  const directory = join(releaseBase(root), id);
  await outputDirectory(root, releaseBase(root));
  await mkdir(directory); // Never overwrite another candidate, even for identical source.
  for (const entry of source.files) await copyVerified(root, entry, join(directory, "source", entry.path));
  const record = join(directory, "record-build");
  for (const entry of build.files.filter(file => !coreOnly && file.path.startsWith("apps/record/")))
    await copyVerified(root, entry, join(record, entry.path.slice("apps/record/".length)));
  for (const entry of source.files.filter(file => !coreOnly && (file.path === "apps/record/.openai/hosting.json" || file.path.startsWith("apps/record/drizzle/"))))
    await copyVerified(root, entry, join(record, entry.path.slice("apps/record/".length)));
  const coreArchive = join(directory, "core-source.tar.gz");
  const recordArchive = join(directory, "record-build.tar.gz");
  await run("tar", ["-czf", coreArchive, "-C", join(directory, "source/apps/core"), "."], root);
  if (!coreOnly) await run(bash, ["--noprofile", "--norc", bashArgument(helper), bashArgument(record), bashArgument(recordArchive)], root);
  const archives = [];
  for (const path of coreOnly ? [coreArchive] : [coreArchive, recordArchive]) {
    validateArchiveEntries(await run("tar", ["-tzf", path], root, true));
    const bytes = await readFile(path);
    archives.push({ path: slash(relative(directory, path)), bytes: bytes.length, sha256: sha256(bytes) });
  }
  assertValidated(receipt, await sources(root), await builds(root));
  const manifest = {
    schemaVersion, id, preparedAt, git, targets: await targets(root), validatedAt: receipt.finishedAt,
    source, build, archives,
    releaseTarget: coreOnly ? "core" : "core-and-record",
    record: { sharedSourceFiles: shared, unchangedFromRelease: latest?.releaseId ?? null,
      sourceSnapshot: "source/apps/record", buildPreparation: coreOnly ? null : "record-build",
      note: "Record 引用 source/apps/core 中的共享源码。不能仅复制 Record 后宣称独立源码完整；Sites 所有者须保留这些依赖并推送精确源码，再保存/部署版本。" },
    packager: helper ? { path: helper, sha256: sha256(await readFile(helper)) } : null,
    phases: { localValidation: "passed", localPreparation: "complete", coreDeployment: "not_recorded",
      recordDeployment: coreOnly ? "unchanged" : "not_recorded", chatgptRefresh: "not_recorded", liveVerification: "not_recorded", localPluginInstall: "not_requested" },
  };
  await writeJson(root, join(directory, "manifest.json"), manifest);
  console.log(`本地候选准备完成：${slash(relative(root, directory))}`);
  console.log(`源码 ${source.files.length} 个文件；${archives.length} 个归档已记录 SHA256；Record 共享源码 ${manifest.record.sharedSourceFiles.length} 个。`);
  console.log("本候选尚无服务器部署、Record 部署、ChatGPT 刷新或线上实测记录。不会自动部署或更新本机插件。");
}

export async function main(args = process.argv.slice(2), root = repository) {
  const [command, option, value, ...extra] = args;
  if (extra.length || (option && !(command === "prepare" && ((option === "--sites-helper" && value) || (option === "--core-only" && !value)))) || (!option && value))
    throw new Error("参数不正确。用法：node scripts/study-release.mjs status|check|prepare [--sites-helper <路径> | --core-only]");
  if (command === "status") return status(root);
  if (command === "check") return check(root);
  if (command === "prepare") return prepare(root, value, option === "--core-only");
  console.log("Study 发布准备入口（不会部署）\n  status   查看本地版本、改动、目标和最近候选\n  check    生成 Skills，校验插件并测试/构建 Core 与 Record\n  prepare  从仍匹配 check 的源码和构建制作发布候选\n详见 docs/release-workflow.md");
  if (command && !["help", "--help", "-h"].includes(command)) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`发布准备未完成：${error.message}`); process.exitCode = 1; });
}
