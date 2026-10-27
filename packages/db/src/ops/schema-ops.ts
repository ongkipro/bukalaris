// M2 track tables (see AGENTS.md "Parallel tracks"). Re-exported by schema.ts.
import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { platformOperator } from "../schema.ts";

export const LOG_LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Log System sink (PR-11, OBS-5): sanitized warn/error events only. `store_id`
 * is trusted internal context (no FK: diagnostics outlive tenants and must never
 * block a tenant write). `fields` holds allowlisted keys only (see ops.ts).
 */
export const systemLog = pgTable(
  "system_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    time: timestamp("time", { withTimezone: true }).notNull().defaultNow(),
    level: text("level", { enum: LOG_LEVELS }).notNull(),
    module: text("module").notNull(),
    operation: text("operation"),
    pageId: text("page_id"),
    storeId: bigint("store_id", { mode: "number" }),
    requestId: text("request_id"),
    code: text("code"),
    message: text("message").notNull(),
    route: text("route"),
    environment: text("environment").notNull(),
    release: text("release_revision"),
    fields: jsonb("fields").$type<Record<string, string | number | boolean>>().notNull().default({}),
  },
  (t) => [
    // Listing and retention both walk time (retention = `delete where time < now() - interval`).
    index("system_log_time_idx").on(t.time.desc(), t.id.desc()),
    index("system_log_request_idx").on(t.requestId),
    index("system_log_module_time_idx").on(t.module, t.time.desc()),
    index("system_log_store_time_idx").on(t.storeId, t.time.desc()),
    check("system_log_level_chk", sql`${t.level} in ('debug', 'info', 'warn', 'error', 'fatal')`),
  ],
);

export const PLATFORM_CAPABILITIES = ["logs.read"] as const;
export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

/** Explicit per-operator platform grants; never inferred from seller membership (IAM-1). */
export const operatorGrant = pgTable(
  "operator_grant",
  {
    userId: text("user_id").notNull().references(() => platformOperator.userId, { onDelete: "cascade" }),
    capability: text("capability", { enum: PLATFORM_CAPABILITIES }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.capability] }), check("operator_grant_cap_chk", sql`${t.capability} in ('logs.read')`)],
);
