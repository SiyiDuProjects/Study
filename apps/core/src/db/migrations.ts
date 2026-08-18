import type Database from "better-sqlite3";

interface Migration {
  version: number;
  sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        institution TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE canvas_connections (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        institution TEXT NOT NULL,
        base_url TEXT NOT NULL,
        canvas_user_id TEXT NOT NULL,
        canvas_name TEXT NOT NULL,
        pat_version INTEGER NOT NULL,
        pat_iv BLOB NOT NULL,
        pat_ciphertext BLOB NOT NULL,
        pat_auth_tag BLOB NOT NULL,
        pat_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE invites (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        institution TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        used_by_user_id TEXT REFERENCES users(id),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX invites_active_idx ON invites(token_hash, expires_at, used_at);

      CREATE TABLE setup_flows (
        flow_hash TEXT PRIMARY KEY,
        invite_id TEXT NOT NULL REFERENCES invites(id),
        pending_user_id TEXT NOT NULL,
        institution TEXT NOT NULL,
        base_url TEXT NOT NULL,
        canvas_user_id TEXT NOT NULL,
        canvas_name TEXT NOT NULL,
        pat_version INTEGER NOT NULL,
        pat_iv BLOB NOT NULL,
        pat_ciphertext BLOB NOT NULL,
        pat_auth_tag BLOB NOT NULL,
        pat_hash TEXT NOT NULL,
        challenge TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE webauthn_credentials (
        credential_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL,
        transports_json TEXT NOT NULL,
        device_type TEXT NOT NULL,
        backed_up INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE INDEX webauthn_credentials_user_idx ON webauthn_credentials(user_id);

      CREATE TABLE login_flows (
        flow_hash TEXT PRIMARY KEY,
        challenge TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX sessions_user_idx ON sessions(user_id, expires_at, revoked_at);

      CREATE TABLE oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_name TEXT NOT NULL,
        redirect_uris_json TEXT NOT NULL,
        grant_types_json TEXT NOT NULL,
        response_types_json TEXT NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE oauth_codes (
        code_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        redirect_uri TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX oauth_codes_lookup_idx ON oauth_codes(client_id, expires_at, used_at);

      CREATE TABLE oauth_tokens (
        token_hash TEXT PRIMARY KEY,
        token_type TEXT NOT NULL CHECK(token_type IN ('access', 'refresh')),
        family_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        resource TEXT NOT NULL,
        scope TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        rotated_at INTEGER,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX oauth_tokens_lookup_idx ON oauth_tokens(token_hash, token_type, expires_at, revoked_at);
      CREATE INDEX oauth_tokens_family_idx ON oauth_tokens(family_id, revoked_at);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE setup_flows ADD COLUMN device_name TEXT;
      ALTER TABLE webauthn_credentials ADD COLUMN device_name TEXT;

      CREATE TABLE passkey_registration_flows (
        flow_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_name TEXT,
        challenge TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX passkey_registration_flows_user_idx
        ON passkey_registration_flows(user_id, expires_at, used_at);
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE webauthn_credentials
        ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE step_up_flows (
        flow_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK(action IN ('add_passkey', 'delete_account')),
        challenge TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX step_up_flows_user_idx
        ON step_up_flows(user_id, action, expires_at);

      CREATE TABLE step_up_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK(action IN ('add_passkey', 'delete_account')),
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX step_up_tokens_user_idx
        ON step_up_tokens(user_id, action, expires_at, used_at);

      CREATE INDEX setup_flows_expiry_idx ON setup_flows(expires_at);
      CREATE INDEX login_flows_expiry_idx ON login_flows(expires_at);
      CREATE INDEX passkey_registration_flows_expiry_idx
        ON passkey_registration_flows(expires_at);
      CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
      CREATE INDEX oauth_codes_expiry_idx ON oauth_codes(expires_at);
      CREATE INDEX oauth_tokens_expiry_idx ON oauth_tokens(expires_at);
    `,
  },
  {
    version: 4,
    sql: `
      -- Remove the superseded global-singleton guard from any database that
      -- briefly applied the pre-release v3 migration while it existed.
      DROP TRIGGER IF EXISTS oauth_clients_singleton_insert;

      -- Step-up authorization is ephemeral. Discard any v3 rows while adding
      -- exact-session binding rather than attempting to preserve weaker grants.
      DROP TABLE step_up_tokens;
      DROP TABLE step_up_flows;
      DROP TABLE passkey_registration_flows;

      CREATE TABLE passkey_registration_flows (
        flow_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
        device_name TEXT,
        challenge TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX passkey_registration_flows_user_idx
        ON passkey_registration_flows(user_id, session_hash, expires_at, used_at);
      CREATE INDEX passkey_registration_flows_expiry_idx
        ON passkey_registration_flows(expires_at);

      CREATE TABLE step_up_flows (
        flow_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK(action IN ('add_passkey', 'delete_account')),
        challenge TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX step_up_flows_user_idx
        ON step_up_flows(user_id, session_hash, action, expires_at);

      CREATE TABLE step_up_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK(action IN ('add_passkey', 'delete_account')),
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX step_up_tokens_user_idx
        ON step_up_tokens(user_id, session_hash, action, expires_at);
    `,
  },
  {
    version: 5,
    sql: `
      -- This private release has one Hanyang owner. Fail closed rather than
      -- allowing a second connection to inherit the shared lecture archive.
      CREATE UNIQUE INDEX canvas_connections_single_owner_idx
        ON canvas_connections((1));

      CREATE TABLE course_catalog (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        canvas_course_id TEXT NOT NULL,
        course_code TEXT,
        name TEXT NOT NULL,
        term_id TEXT,
        term_name TEXT,
        workflow_state TEXT,
        enrollment_state TEXT NOT NULL CHECK(enrollment_state IN ('active', 'completed')),
        start_at TEXT,
        end_at TEXT,
        folder_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        archived_at INTEGER,
        snapshot_hash TEXT NOT NULL,
        present_in_latest_sync INTEGER NOT NULL CHECK(present_in_latest_sync IN (0, 1)),
        PRIMARY KEY(user_id, canvas_course_id)
      );
      CREATE INDEX course_catalog_user_status_idx
        ON course_catalog(user_id, status, last_seen_at DESC);

      CREATE TABLE course_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        canvas_course_id TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        snapshot_hash TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        FOREIGN KEY(user_id, canvas_course_id)
          REFERENCES course_catalog(user_id, canvas_course_id) ON DELETE CASCADE
      );
      CREATE INDEX course_snapshots_course_idx
        ON course_snapshots(user_id, canvas_course_id, captured_at DESC);

      CREATE TABLE course_sync_state (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        last_attempt_at INTEGER,
        last_success_at INTEGER,
        last_nonempty_at INTEGER,
        last_result_count INTEGER,
        last_error_code TEXT
      );
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((row) => (row as { version: number }).version),
  );
  const apply = db.transaction((migration: Migration) => {
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
      migration.version,
      Date.now(),
    );
  });
  for (const migration of migrations) {
    if (!applied.has(migration.version)) {
      apply(migration);
    }
  }
}
