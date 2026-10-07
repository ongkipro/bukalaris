// M2 feeds track (T-40, PR-12): per-store catalog feed tokens. Re-exported by schema.ts.
import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { store } from "./schema.ts";

/**
 * One secret per store that lets an unauthenticated fetcher (Meta Commerce Manager, Google
 * Merchant Center) read that store's catalog feeds. The token is shown once at creation; only
 * its SHA-256 hash is stored and verification compares hashes in constant time (feeds.ts).
 * Regenerating revokes the current token and issues a new one; at most one is active per store.
 */
export const feedToken = pgTable(
  "feed_token",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("feed_token_prefix_idx").on(t.tokenPrefix),
    uniqueIndex("feed_token_store_active_uq").on(t.storeId).where(sql`${t.status} = 'active'`),
    check("feed_token_status_chk", sql`${t.status} in ('active', 'revoked')`),
    check("feed_token_revoked_chk", sql`(${t.status} = 'revoked') = (${t.revokedAt} is not null)`),
  ],
);
