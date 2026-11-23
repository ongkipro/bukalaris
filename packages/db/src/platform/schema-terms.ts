import { sql } from "drizzle-orm";
import { bigint, check, date, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { store } from "../schema.ts";

// T-116 (PR-27, ADR-0013 section 8 & D-33, ADR-0015 decision 8, ADR-0016 decision 23):
// Versioned seller-terms text for the seller-owned model, its adviser-review record (gates the
// production switch of T-105 and T-106), and each store owner's append-only acceptance record
// (gates saving a provider key or bank account). All three tables are append-only in the database.

/** Versioned seller terms (shared-read; append-only). Version 1 is seeded by migration 0024 as a draft until reviewed. */
export const sellerTermsVersion = pgTable(
  "seller_terms_version",
  {
    version: integer("version").primaryKey(),
    title: text("title").notNull(),
    /** Plain Indonesian text (paragraphs separated by blank lines), always rendered as text, never HTML. */
    body: text("body").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "seller_terms_version_chk",
      sql`${t.version} >= 1 and length(btrim(${t.title})) between 5 and 200 and length(btrim(${t.body})) between 50 and 20000 and length(btrim(${t.createdBy})) between 1 and 120`,
    ),
  ],
);

/**
 * Adviser review of one terms version (shared-read; append-only). Without a row for the current version, the terms stay marked as draft and the
 * T-105 / T-106 production switches cannot be turned on.
 */
export const sellerTermsReview = pgTable(
  "seller_terms_review",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    version: integer("version")
      .notNull()
      .references(() => sellerTermsVersion.version),
    adviserName: text("adviser_name").notNull(),
    reviewedOn: date("reviewed_on").notNull(),
    note: text("note").notNull(),
    recordedBy: text("recorded_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "seller_terms_review_chk",
      sql`length(btrim(${t.adviserName})) between 2 and 200 and length(btrim(${t.note})) between 5 and 500 and length(btrim(${t.recordedBy})) between 1 and 120`,
    ),
  ],
);

/**
 * Store owner's acceptance of one terms version (store-scoped under FORCE RLS, append-only: never edited or deleted). One row per store and
 * version. A new version asks for acceptance again without blocking anything already running.
 */
export const storeTermsAcceptance = pgTable(
  "store_terms_acceptance",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: bigint("store_id", { mode: "number" })
      .notNull()
      .references(() => store.id),
    version: integer("version")
      .notNull()
      .references(() => sellerTermsVersion.version),
    acceptedBy: text("accepted_by").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("store_terms_acceptance_uq").on(t.storeId, t.version),
    check("store_terms_acceptance_actor_chk", sql`length(btrim(${t.acceptedBy})) between 1 and 120`),
  ],
);
