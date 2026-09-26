import { getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { BACKUP_EXCLUDED, BACKUP_TABLES } from "../src/db/backup";
import * as schema from "../src/db/schema";

describe("backup coverage", () => {
  it("every table is either backed up or deliberately excluded", () => {
    const tables = Object.values(schema)
      .filter((v) => is(v, SQLiteTable))
      .map((t) => getTableName(t as SQLiteTable))
      .sort();
    const listed = [...BACKUP_TABLES, ...BACKUP_EXCLUDED].sort();
    expect(listed).toEqual(tables);
  });
});
