import "dotenv/config";
import { approvePasskeyRecovery } from "../auth/recovery.js";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/index.js";
import { INSTITUTIONS, type InstitutionKey } from "../domain.js";

const argument = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const requestId = argument("--request");
const userId = argument("--user");
const institution = argument("--institution");
if (!requestId || !userId || !institution || !Object.hasOwn(INSTITUTIONS, institution)) {
  throw new Error("Use --request <public request ID> --user <exact account UUID> --institution hanyang|berkeley");
}
const db = openDatabase(loadConfig().databasePath);
try {
  // No secret is emitted. Only the browser holding its HttpOnly cookie can use this approval.
  console.log(JSON.stringify(approvePasskeyRecovery(db, requestId, userId, institution as InstitutionKey)));
} finally { db.close(); }
