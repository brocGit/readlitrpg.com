import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export { schema };

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof createDb>;

/** True when a D1/SQLite error is a UNIQUE constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  const message = collectMessages(error);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|SQLITE_CONSTRAINT_PRIMARYKEY/i.test(message);
}

function collectMessages(error: unknown, depth = 0): string {
  if (!error || depth > 4) return "";
  if (error instanceof Error) return `${error.message} ${collectMessages(error.cause, depth + 1)}`;
  return String(error);
}
