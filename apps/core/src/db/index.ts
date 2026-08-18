import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations.js";

export type AppDatabase = Database.Database;

export function openDatabase(databasePath: string): AppDatabase {
  const resolved = databasePath === ":memory:" ? databasePath : resolve(databasePath);
  if (resolved !== ":memory:") {
    mkdirSync(dirname(resolved), { recursive: true });
  }
  const db = new Database(resolved);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  if (resolved !== ":memory:") {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  }
  runMigrations(db);
  return db;
}

export { runMigrations } from "./migrations.js";
