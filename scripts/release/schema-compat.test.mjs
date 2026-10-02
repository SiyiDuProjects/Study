import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { verifySchema } from "../../apps/core/scripts/verify-schema-compat.mjs";
const Database = createRequire(new URL("../../apps/core/package.json", import.meta.url))("better-sqlite3");

test("coursework writes require the exact additive v10 ledger and preserve existing schema", async t => {
  const directory = await mkdtemp(join(tmpdir(), "study-writes-schema-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const before = join(directory, "before.sqlite"), after = join(directory, "after.sqlite");
  const old = new Database(before);
  old.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); CREATE TABLE users(id TEXT PRIMARY KEY);");
  for (let version = 1; version <= 9; version++) old.prepare("INSERT INTO schema_migrations VALUES (?,0)").run(version);
  old.close(); await copyFile(before, after);
  const source = await readFile(resolve("apps/core/src/db/migrations.ts"), "utf8");
  const next = new Database(after);
  next.exec(source.match(/version: 10,\s+sql: `(.*?)`/s)[1]);
  next.exec("INSERT INTO schema_migrations VALUES (10,1)"); next.close();
  assert.throws(() => verifySchema(before, after));
  assert.equal(verifySchema(before, after, "coursework-writes-v10"), "coursework-writes-v10");
  const altered = new Database(after); altered.exec("ALTER TABLE users ADD COLUMN unsafe TEXT"); altered.close();
  assert.throws(() => verifySchema(before, after, "coursework-writes-v10"));
});

test("recovery schema gate accepts only the explicit additive v9 table", async t => {
  const directory = await mkdtemp(join(tmpdir(), "study-recovery-schema-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const before = join(directory, "before.sqlite"), after = join(directory, "after.sqlite");
  const old = new Database(before);
  old.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); CREATE TABLE users(id TEXT PRIMARY KEY);");
  for (let version = 1; version <= 8; version++) old.prepare("INSERT INTO schema_migrations VALUES (?,0)").run(version);
  old.close(); await copyFile(before, after);
  const source = await readFile(resolve("apps/core/src/db/migrations.ts"), "utf8");
  const next = new Database(after);
  next.exec(source.match(/version: 9,\s+sql: `(.*?)`/s)[1]);
  next.exec("INSERT INTO schema_migrations VALUES (9,1)"); next.close();
  assert.throws(() => verifySchema(before, after));
  assert.equal(verifySchema(before, after, "passkey-recovery-v9"), "passkey-recovery-v9");
  const altered = new Database(after); altered.exec("ALTER TABLE users ADD COLUMN unsafe TEXT"); altered.close();
  assert.throws(() => verifySchema(before, after, "passkey-recovery-v9"));
});

test("schema release gate permits only the explicit v8 migration and rejects unrelated changes", async t => {
  const directory = await mkdtemp(join(tmpdir(), "study-schema-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const before = join(directory, "before.sqlite"), after = join(directory, "after.sqlite");
  const old = new Database(before);
  old.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); CREATE TABLE canvas_connections(user_id TEXT PRIMARY KEY,institution TEXT); CREATE UNIQUE INDEX canvas_connections_single_owner_idx ON canvas_connections((1));");
  for (let version = 1; version <= 7; version++) old.prepare("INSERT INTO schema_migrations VALUES (?,0)").run(version);
  old.close();
  await copyFile(before, after);
  const source = await readFile(resolve("apps/core/src/db/migrations.ts"), "utf8");
  const migration = source.match(/version: 8,\s+sql: `(.*?)`/s)[1];
  const next = new Database(after);
  next.exec(migration);
  next.exec("INSERT INTO schema_migrations VALUES (8,1)");
  next.close();
  assert.equal(verifySchema(before, before), "unchanged");
  assert.throws(() => verifySchema(before, after));
  assert.equal(verifySchema(before, after, "study-unification-v8"), "study-unification-v8");
  const altered = new Database(after);
  altered.exec("ALTER TABLE canvas_connections ADD COLUMN unsafe TEXT"); altered.close();
  assert.throws(() => verifySchema(before, after, "study-unification-v8"));
});
