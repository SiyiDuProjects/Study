import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const recordRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/record");
const packageRoot = resolve(recordRoot, "node_modules/@heroui-pro/react");

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} is missing or invalid.`);
  }
}

async function importedStyles(directory) {
  const styles = new Set();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      for (const style of await importedStyles(path)) styles.add(style);
    } else if (entry.isFile() && entry.name.endsWith(".css")) {
      const source = (await readFile(path, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
      const imports = source.matchAll(/@import\s+(?:url\(\s*)?["']@heroui-pro\/react\/(css(?:\/[^"']+)?)["']/g);
      for (const [, style] of imports) styles.add(style === "css" ? "dist/css/index.css" : `dist/${style}`);
    }
  }
  return styles;
}

try {
  const lock = await readJson(resolve(recordRoot, "package-lock.json"), "Record package lock");
  const expectedVersion = lock.packages?.["node_modules/@heroui-pro/react"]?.version;
  if (typeof expectedVersion !== "string" || !expectedVersion) {
    throw new Error("Record package lock does not pin @heroui-pro/react.");
  }
  const installed = await readJson(resolve(packageRoot, "package.json"), "HeroUI Pro package");
  if (installed.name !== "@heroui-pro/react" || installed.version !== expectedVersion) {
    throw new Error(`HeroUI Pro must match the locked version ${expectedVersion}.`);
  }

  const required = new Set(["dist/index.js", "dist/index.d.ts"]);
  for (const component of ["action-bar", "sheet", "list-view"]) {
    required.add(`dist/components/${component}/index.js`);
    required.add(`dist/components/${component}/index.d.ts`);
  }
  for (const style of await importedStyles(resolve(recordRoot, "src"))) required.add(style);

  const missing = [];
  for (const name of [...required].sort()) {
    const path = resolve(packageRoot, name);
    const local = relative(packageRoot, path);
    if (isAbsolute(local) || local === ".." || local.startsWith("../") || local.startsWith("..\\")) {
      throw new Error("A HeroUI Pro CSS import leaves its package directory.");
    }
    const file = await stat(path).catch(() => null);
    if (!file?.isFile() || file.size === 0) missing.push(name);
  }
  if (missing.length) throw new Error(`HeroUI Pro artifacts are missing or empty: ${missing.join(", ")}.`);

  console.log(`HeroUI Pro artifacts: ${installed.version}`);
} catch (error) {
  console.error(`Record dependency check failed: ${error.message}`);
  console.error("Configure the encrypted HEROUI_AUTH_TOKEN secret with a HeroUI CI/CD token, then rerun npm ci --prefix apps/record with install scripts enabled.");
  process.exitCode = 1;
}
