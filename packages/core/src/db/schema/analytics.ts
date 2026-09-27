// Daily traffic totals copied from Analytics Engine by stats.rollup (DESIGN §4.5, §18). Counts only:
// nothing here identifies a reader.

import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const pageViewsDaily = sqliteTable(
  "page_views_daily",
  {
    day: text("day").notNull(),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    views: integer("views").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.kind, t.key] })],
);

export const referrersDaily = sqliteTable(
  "referrers_daily",
  {
    day: text("day").notNull(),
    host: text("host").notNull(),
    views: integer("views").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.host] })],
);
