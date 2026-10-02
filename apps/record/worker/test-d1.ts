import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
class TestStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: Database.Database,
    private readonly query: string
  ) {}

  bind(...values: unknown[]): TestStatement {
    this.values = values;
    return this;
  }

  async all<T>(): Promise<D1Result<T>> {
    const rows = this.database.prepare(this.query).all(...this.values) as T[];
    return { results: rows, success: true, meta: {} } as D1Result<T>;
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.query).get(...this.values) as T | undefined) ?? null;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.runSync<T>();
  }

  runSync<T = unknown>(): D1Result<T> {
    const result = this.database.prepare(this.query).run(...this.values);
    return {
      results: [],
      success: true,
      meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) }
    } as unknown as D1Result<T>;
  }
}

export function createTestD1(): D1Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const migration of ["0000_funny_rictor.sql", "0001_study_record.sql", "0002_school_captions.sql"]) {
    const sql = readFileSync(join(process.cwd(), "drizzle", migration), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  return {
    prepare(query: string) {
      return new TestStatement(sqlite, query) as unknown as D1PreparedStatement;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      return sqlite.transaction(() =>
        statements.map((statement) => (statement as unknown as TestStatement).runSync<T>())
      )();
    }
  } as unknown as D1Database;
}
