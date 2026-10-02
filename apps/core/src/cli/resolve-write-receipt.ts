import "dotenv/config";
import { listUnresolvedWriteReceipts, resolveWriteReceipt } from "../canvas/writeLedger.js";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/index.js";

const argument = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const usage = "Use --list, or --user <account UUID> --request <request_id> --outcome applied|not_applied after inspecting the LMS records";
const list = process.argv.includes("--list");
const userId = argument("--user");
const requestId = argument("--request");
const outcome = argument("--outcome");
if (!list && (!userId || !requestId || (outcome !== "applied" && outcome !== "not_applied"))) throw new Error(usage);

const db = openDatabase(loadConfig().databasePath);
try {
  // Receipts hold only IDs, fingerprints and targets; no message text, file bytes or credentials are printed.
  console.log(JSON.stringify(list ? listUnresolvedWriteReceipts(db)
    : resolveWriteReceipt(db, userId!, requestId!, outcome as "applied" | "not_applied"), null, 2));
} finally { db.close(); }
