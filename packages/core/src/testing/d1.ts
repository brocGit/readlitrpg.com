// Test-only: a D1Database stand-in backed by Node's built-in SQLite, so unit tests run the real
// migrations and the real Drizzle D1 driver without Miniflare. Never import this from Worker code.
// Behavior differences from D1 that matter here: none for the statements we use. D1's `batch` is
// atomic, and so is this one (it wraps the statements in a transaction).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

type Row = Record<string, unknown>;

function toSqlValue(value: unknown): SQLInputValue {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value as SQLInputValue;
}

class ShimStatement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): ShimStatement {
    return new ShimStatement(this.db, this.sql, values);
  }

  private prepared(): StatementSync {
    return this.db.prepare(this.sql);
  }

  private values(): SQLInputValue[] {
    return this.params.map(toSqlValue);
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const row = this.prepared().get(...this.values()) as Row | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async all<T = Row>() {
    return this.allSync<T>();
  }

  allSync<T = Row>() {
    const stmt = this.prepared();
    const started = performance.now();
    if (stmt.columns().length === 0) {
      const info = stmt.run(...this.values());
      return {
        success: true as const,
        results: [] as T[],
        meta: meta(info.changes, info.lastInsertRowid, started),
      };
    }
    const results = stmt.all(...this.values()) as T[];
    return { success: true as const, results, meta: meta(0, 0, started) };
  }

  async run() {
    return this.allSync();
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const stmt = this.prepared();
    if (stmt.columns().length === 0) {
      stmt.run(...this.values());
      return [];
    }
    stmt.setReturnArrays(true);
    const rows = stmt.all(...this.values()) as unknown as T[];
    if (options?.columnNames) return [stmt.columns().map((c) => c.name) as unknown as T, ...rows];
    return rows;
  }
}

function meta(changes: number | bigint, lastRowId: number | bigint, started: number) {
  return {
    changes: Number(changes),
    last_row_id: Number(lastRowId),
    duration: performance.now() - started,
    changed_db: Number(changes) > 0,
    size_after: 0,
    rows_read: 0,
    rows_written: Number(changes),
  };
}

export class TestD1 {
  readonly sqlite: DatabaseSync;

  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
  }

  prepare(sql: string): ShimStatement {
    return new ShimStatement(this.sqlite, sql);
  }

  async batch(statements: ShimStatement[]) {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((s) => s.allSync());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}

export const MIGRATIONS_DIR = join(import.meta.dirname, "../../../../migrations");

/** A fresh in-memory database with every migration applied, in file order. */
export function createTestD1(migrationsDir = MIGRATIONS_DIR): TestD1 {
  const d1 = new TestD1();
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const text = readFileSync(join(migrationsDir, file), "utf8");
    for (const statement of text.split("--> statement-breakpoint")) {
      if (statement.trim()) d1.sqlite.exec(statement);
    }
  }
  return d1;
}
