import { readFileSync, statSync, realpathSync } from "node:fs";
import Database from "better-sqlite3";
import { parse } from "dotenv";
import { openDatabase } from "../dist/db/index.js";
import { importBerkeleyAccount } from "../dist/migration/berkeley.js";

// Run in the reviewed candidate image with read-only source backup mounts.
const [sourcePath, sourceEnvPath] = process.argv.slice(2);
if (!sourcePath || !sourceEnvPath || !process.env.DATABASE_PATH) throw new Error("Source backup, source env and target DATABASE_PATH are required");
if (realpathSync(sourcePath) === realpathSync(process.env.DATABASE_PATH)) throw new Error("Source and target databases must be different files");
if (process.platform !== "win32" && (statSync(sourceEnvPath).mode & 0o077)) throw new Error("Source secrets file must be owner-only");
const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
const target = openDatabase(process.env.DATABASE_PATH);
try {
  const env = parse(readFileSync(sourceEnvPath));
  const result = importBerkeleyAccount(source, target, Buffer.from(env.MASTER_KEY_BASE64 ?? "", "base64"), Buffer.from(process.env.MASTER_KEY_BASE64 ?? "", "base64"));
  console.log(JSON.stringify({ ...result, integrity: target.pragma("integrity_check", { simple: true }) }));
} finally { source.close(); target.close(); }
