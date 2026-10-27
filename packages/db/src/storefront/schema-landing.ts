// M2 landing track (T-42, PR-9): store-owned landing pages with immutable revisions.
// Re-exported by schema.ts. A page carries two pointers (draft, published) into its own
// revisions; the page/revision pointer FKs and the RLS policies are hand-written in
// drizzle/0009_landing_rls.sql (drizzle-kit cannot type a circular table reference).
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, integer, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { store } from "../schema.ts";

const id = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const storeId = () => bigint("store_id", { mode: "number" }).notNull();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const LANDING_STATUSES = ["draft", "published"] as const;
export type LandingStatus = (typeof LANDING_STATUSES)[number];

export const landingPage = pgTable(
  "landing_page",
  {
    id: id(),
    storeId: storeId().references(() => store.id),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    status: text("status", { enum: LANDING_STATUSES }).notNull().default("draft"),
    /** Latest saved revision (always set after creation); every edit appends a revision and moves this. */
    draftRevisionId: bigint("draft_revision_id", { mode: "number" }),
    /** Revision the public route renders; null while unpublished. */
    publishedRevisionId: bigint("published_revision_id", { mode: "number" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("landing_page_store_id_uq").on(t.storeId, t.id),
    unique("landing_page_store_slug_uq").on(t.storeId, t.slug),
    check("landing_page_slug_chk", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("landing_page_status_chk", sql`${t.status} in ('draft', 'published')`),
    // Published ⇔ a published pointer exists (05-DATA-MODEL "unpublished pages have no published pointer").
    check("landing_page_published_chk", sql`(${t.status} = 'published') = (${t.publishedRevisionId} is not null)`),
  ],
);

/** Immutable snapshot of one saved document (layout, content, LP design settings). Never updated. */
export const landingPageRevision = pgTable(
  "landing_page_revision",
  {
    id: id(),
    storeId: storeId(),
    pageId: bigint("page_id", { mode: "number" }).notNull(),
    revisionNumber: integer("revision_number").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    document: jsonb("document").$type<Record<string, unknown>>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("landing_page_revision_store_id_uq").on(t.storeId, t.id),
    // Pointer FKs on landing_page target (page_id, id), so a pointer can never leave its page.
    unique("landing_page_revision_page_id_uq").on(t.pageId, t.id),
    unique("landing_page_revision_number_uq").on(t.pageId, t.revisionNumber),
    foreignKey({ name: "landing_page_revision_page_fk", columns: [t.storeId, t.pageId], foreignColumns: [landingPage.storeId, landingPage.id] }).onDelete("cascade"),
    check("landing_page_revision_number_chk", sql`${t.revisionNumber} >= 1`),
    check("landing_page_revision_size_chk", sql`octet_length(${t.document}::text) <= 262144`),
  ],
);
