// M2 checkout2 track (T-30, SEC-16): Postgres-backed fixed-window counters for
// checkout and cart abuse controls. Re-exported by schema.ts.
import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One row per (key, window). `key` is `<scope>:<dimension>:<value>`, e.g.
 * `order:ip:203.0.113.7`, `order:cart:<uuid>`, `order:phone:0812…`. Rows are
 * upserted atomically (`count + 1`) and swept by the cleanup command.
 */
export const rateLimit = pgTable(
  "rate_limit",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);
