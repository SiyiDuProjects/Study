import "dotenv/config";
import { createAuthService } from "../auth/service.js";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/index.js";
import { INSTITUTIONS, type InstitutionKey } from "../domain.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const institutionRaw = argument("--institution");
if (!institutionRaw || !Object.hasOwn(INSTITUTIONS, institutionRaw)) {
  throw new Error("Use --institution hanyang");
}
const ttlHoursRaw = argument("--ttl-hours");
const ttlHours = ttlHoursRaw === undefined ? 48 : Number(ttlHoursRaw);
if (!Number.isFinite(ttlHours) || ttlHours < 1 || ttlHours > 168) {
  throw new Error("--ttl-hours must be between 1 and 168");
}

const config = loadConfig();
const database = openDatabase(config.databasePath);
try {
  const service = createAuthService({
    db: database,
    config,
    validatePat: async () => {
      throw new Error("PAT validation is not used while creating an invitation");
    },
  });
  const invite = service.createInvite({
    institution: institutionRaw as InstitutionKey,
    ttlSeconds: Math.round(ttlHours * 60 * 60),
  });
  const url = `${config.publicOrigin}/setup#token=${encodeURIComponent(invite.inviteToken)}`;
  process.stdout.write(`${url}\nExpires: ${new Date(invite.expiresAt).toISOString()}\n`);
} finally {
  database.close();
}
