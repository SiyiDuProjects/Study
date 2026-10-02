import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const normalize = sql => (sql ?? "").trim().replace(/;$/, "").replace(/\s+/g, " ");
function snapshot(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    return { versions: db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(),
      objects: Object.fromEntries(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()
        .map(row => [`${row.type}:${row.name}`, [row.tbl_name, normalize(row.sql)]])) };
  } finally { db.close(); }
}

export function verifySchema(before, after, policy = "unchanged") {
  const old = snapshot(before), next = snapshot(after);
  if (JSON.stringify(old) === JSON.stringify(next)) return "unchanged";
  if (policy === "coursework-writes-v10") {
    assert.deepEqual(old.versions.map(row => row.version), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(next.versions.slice(0, -1), old.versions);
    assert.equal(next.versions.at(-1).version, 10);
    const additions = {
      "table:canvas_write_receipts": ["canvas_write_receipts", "CREATE TABLE canvas_write_receipts ( user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, request_id TEXT NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','unknown','complete')), result_json TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(user_id, request_id) )"],
      "index:sqlite_autoindex_canvas_write_receipts_1": ["canvas_write_receipts", ""],
      "index:canvas_write_active_target": ["canvas_write_receipts", "CREATE UNIQUE INDEX canvas_write_active_target ON canvas_write_receipts(user_id,kind,target) WHERE status IN ('pending','unknown')"],
    };
    for (const [name, definition] of Object.entries(additions)) {
      assert.deepEqual(next.objects[name], definition, `Unexpected migration object: ${name}`);
      delete next.objects[name];
    }
    assert.deepEqual(next.objects, old.objects, "Existing schema changed outside coursework writes migration");
    return policy;
  }
  if (policy === "passkey-recovery-v9") {
    assert.deepEqual(old.versions.map(row => row.version), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(next.versions.slice(0, -1), old.versions);
    assert.equal(next.versions.at(-1).version, 9);
    const table = "passkey_recovery_requests";
    assert.deepEqual(next.objects[`table:${table}`], [table, "CREATE TABLE passkey_recovery_requests ( id TEXT PRIMARY KEY, browser_hash TEXT NOT NULL UNIQUE, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, approved_at INTEGER, used_at INTEGER, challenge TEXT, challenge_expires_at INTEGER, rp_id TEXT NOT NULL, expected_origin TEXT NOT NULL )"]);
    delete next.objects[`table:${table}`];
    for (const i of [1, 2]) {
      assert.deepEqual(next.objects[`index:sqlite_autoindex_${table}_${i}`], [table, ""]);
      delete next.objects[`index:sqlite_autoindex_${table}_${i}`];
    }
    assert.deepEqual(next.objects, old.objects, "Existing schema changed outside recovery migration");
    return policy;
  }
  assert.equal(policy, "study-unification-v8", "Schema changed without an explicit reviewed migration policy");
  assert.deepEqual(old.versions.map(row => row.version), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(next.versions.slice(0, -1), old.versions);
  assert.equal(next.versions.at(-1).version, 8);
  const oldIndex = "index:canvas_connections_single_owner_idx";
  assert.deepEqual(old.objects[oldIndex], ["canvas_connections", "CREATE UNIQUE INDEX canvas_connections_single_owner_idx ON canvas_connections((1))"]);
  delete old.objects[oldIndex];
  const additions = {
    "table:lecture_owner": ["lecture_owner", "CREATE TABLE lecture_owner ( singleton INTEGER PRIMARY KEY CHECK(singleton = 1), user_id TEXT NOT NULL UNIQUE )"],
    "index:sqlite_autoindex_lecture_owner_1": ["lecture_owner", ""],
    "index:canvas_connections_institution_owner_idx": ["canvas_connections", "CREATE UNIQUE INDEX canvas_connections_institution_owner_idx ON canvas_connections(institution)"],
    "trigger:lecture_owner_initial_bind": ["canvas_connections", "CREATE TRIGGER lecture_owner_initial_bind AFTER INSERT ON canvas_connections WHEN NEW.institution = 'hanyang' AND NOT EXISTS(SELECT 1 FROM lecture_owner) BEGIN INSERT INTO lecture_owner(singleton, user_id) VALUES (1, NEW.user_id); END"],
  };
  for (const [name, definition] of Object.entries(additions)) {
    assert.deepEqual(next.objects[name], definition, `Unexpected migration object: ${name}`);
    delete next.objects[name];
  }
  assert.deepEqual(next.objects, old.objects, "Existing schema changed outside the reviewed migration");
  return policy;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("Schema policy verified: " + verifySchema(...process.argv.slice(2)));
}
