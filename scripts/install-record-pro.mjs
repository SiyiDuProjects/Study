import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRecordDependencies, REVIEWED_PRO_VERSION } from "./check-record-dependencies.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helperVersion = "4.7.1";
const guidance = "Record CollectUI installation requires Study's authorized HEROUI_KEY and exact hpsetup 4.7.1 / Pro 1.0.0-beta.8. See docs/record-cloud-build.md. No website-token or cached-version fallback is used.";
const metadata = async path => JSON.parse(await readFile(path, "utf8"));

// Capture provider output, including errors, so authenticated URLs and keys
// cannot reach CI logs. Only this child calls the pinned versioned downloader.
async function download(stagedPackage, key) {
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--download", stagedPackage], {
    cwd: root, env: { ...process.env, HEROUI_KEY: key }, stdio: "pipe", timeout: 120_000
  });
}

export async function installRecordPro({ repository = root, key = process.env.HEROUI_KEY, fetchPackage = download } = {}) {
  let staging;
  try {
    const recordRoot = join(repository, "apps/record");
    const manifest = await metadata(join(recordRoot, "package.json"));
    const lock = await metadata(join(recordRoot, "package-lock.json"));
    if (manifest.dependencies?.["@heroui-pro/react"] !== REVIEWED_PRO_VERSION ||
        lock.packages?.[""]?.dependencies?.["@heroui-pro/react"] !== REVIEWED_PRO_VERSION ||
        lock.packages?.["node_modules/@heroui-pro/react"]?.version !== REVIEWED_PRO_VERSION) {
      throw new Error("Unreviewed Pro version");
    }
    const helper = await metadata(join(repository, "node_modules/hpsetup/package.json"));
    if (helper.version !== helperVersion) throw new Error("Unreviewed helper");
    const target = await realpath(join(recordRoot, "node_modules/@heroui-pro/react"));
    const installed = await metadata(join(target, "package.json"));
    if (installed.name !== "@heroui-pro/react" || installed.version !== REVIEWED_PRO_VERSION) {
      throw new Error("Restore the frozen dependency set first");
    }
    if (typeof key !== "string" || !/^hp_[0-9a-f]+$/.test(key.trim())) throw new Error("Missing installation key");
    staging = await mkdtemp(join(tmpdir(), "study-reviewed-pro-"));
    const stagedPackage = join(staging, "node_modules/@heroui-pro/react");
    await mkdir(stagedPackage, { recursive: true });
    await fetchPackage(stagedPackage, key.trim());
    await checkRecordDependencies({ recordRoot, packageRoot: stagedPackage });
    await cp(stagedPackage, target, { recursive: true, force: true });
    await checkRecordDependencies({ recordRoot, packageRoot: target });
  } catch {
    // Provider errors may contain credentials; report only static guidance.
    throw new Error(guidance);
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "--download") {
      if (!/^hp_[0-9a-f]+$/.test(process.env.HEROUI_KEY ?? "") || !process.argv[3]) {
        throw new Error("Missing installation input");
      }
      const helper = await metadata(join(root, "node_modules/hpsetup/package.json"));
      if (helper.version !== helperVersion) throw new Error("Unreviewed helper");
      const { PRODUCTS } = await import("hpsetup/src/constants.js");
      const { downloadFromProxy } = await import("hpsetup/src/download.js");
      await downloadFromProxy(PRODUCTS.react, REVIEWED_PRO_VERSION, process.argv[3], process.env.HEROUI_KEY, false, true);
    } else {
      await installRecordPro();
      console.log(`Record CollectUI artifacts installed: ${REVIEWED_PRO_VERSION}`);
    }
  } catch {
    console.error(guidance);
    process.exitCode = 1;
  }
}
