import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { platformOperator } from "../schema.ts";
const id = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const at = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const personalDataAccessEvent = pgTable("personal_data_access_event", {
  id: id(), actorUserId: text("actor_user_id").notNull(), targetKind: text("target_kind").notNull(), targetId: text("target_id").notNull(),
  fieldClass: text("field_class").notNull(), purposeCode: text("purpose_code").notNull(), caseId: text("case_id"),
  breakGlassGrantId: bigint("break_glass_grant_id", { mode: "number" }), reason: text("reason").notNull(),
  accessLevel: text("access_level", { enum: ["masked", "full", "export"] }).notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }), createdAt: at(),
}, (t) => [
  index("access_event_target_idx").on(t.targetKind, t.targetId, t.createdAt), index("access_event_actor_idx").on(t.actorUserId, t.createdAt), index("access_event_case_idx").on(t.caseId),
  check("access_event_class_chk", sql`${t.fieldClass} in ('tax_identity','bank','phone','email','name','address','verification_evidence','buyer_store_links')`),
  check("access_event_level_chk", sql`${t.accessLevel} in ('masked','full','export')`),
  check("access_event_purpose_chk", sql`length(btrim(${t.purposeCode})) > 0 and length(btrim(${t.reason})) > 0`),
  check("access_event_full_chk", sql`${t.accessLevel} = 'masked' or (${t.caseId} is not null and ${t.expiresAt} is not null and ${t.expiresAt} > ${t.createdAt})`),
]);
export const ISSUE_CATEGORIES = ["no_response", "wrong_result", "error_message", "page_broken", "other"] as const;
export const ISSUE_SEVERITIES = ["low", "medium", "high", "blocking"] as const;
export const ISSUE_STATUSES = ["new", "triaged", "in_progress", "resolved", "wont_fix", "duplicate"] as const;
export const issueReport = pgTable("issue_report", {
  id: id(), surface: text("surface").notNull().default("owner"), reporterKind: text("reporter_kind").notNull().default("operator"),
  reporterId: text("reporter_id").notNull().references(() => platformOperator.userId), clientRequestId: text("client_request_id").notNull(),
  pageId: text("page_id").notNull(), route: text("route").notNull(), subjectKind: text("subject_kind"), subjectId: text("subject_id"), controlId: text("control_id"),
  category: text("category", { enum: ISSUE_CATEGORIES }).notNull(), severity: text("severity", { enum: ISSUE_SEVERITIES }).notNull(), description: text("description").notNull(), scrubbed: boolean("scrubbed").notNull(),
  context: jsonb("context").$type<Record<string, unknown>>().notNull(), linkedLogEventIds: bigint("linked_log_event_ids", { mode: "number" }).array().notNull().default(sql`'{}'::bigint[]`),
  status: text("status", { enum: ISSUE_STATUSES }).notNull().default("new"), duplicateOf: bigint("duplicate_of", { mode: "number" }), assigneeId: text("assignee_id"), resolutionNote: text("resolution_note"), dedupeKey: text("dedupe_key").notNull(),
  createdAt: at(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("issue_report_idempotency_uq").on(t.reporterId, t.clientRequestId), index("issue_report_status_idx").on(t.status, t.createdAt), index("issue_report_page_idx").on(t.pageId, t.status), index("issue_report_dedupe_idx").on(t.dedupeKey),
  check("issue_report_surface_chk", sql`${t.surface} = 'owner' and ${t.reporterKind} = 'operator'`),
  check("issue_report_category_chk", sql`${t.category} in ('no_response','wrong_result','error_message','page_broken','other')`), check("issue_report_severity_chk", sql`${t.severity} in ('low','medium','high','blocking')`),
  check("issue_report_status_chk", sql`${t.status} in ('new','triaged','in_progress','resolved','wont_fix','duplicate')`),
  check("issue_report_description_chk", sql`length(${t.description}) between 1 and 2000`), check("issue_report_context_chk", sql`octet_length(${t.context}::text) <= 16384`),
  check("issue_report_duplicate_chk", sql`(${t.status} = 'duplicate') = (${t.duplicateOf} is not null)`),
]);
export const issueReportEvent = pgTable("issue_report_event", {
  id: id(), reportId: bigint("report_id", { mode: "number" }).notNull().references(() => issueReport.id), actorUserId: text("actor_user_id").notNull(), kind: text("kind").notNull(), fromValue: text("from_value"), toValue: text("to_value"), reason: text("reason"), createdAt: at(),
}, (t) => [index("issue_event_report_idx").on(t.reportId, t.id), check("issue_event_kind_chk", sql`${t.kind} in ('status','assign','note','view','export')`)]);

/** OBS-6 durable in-product alert. No description, contact or captured context enters a delivery sink. */
export const issueNotification = pgTable("issue_notification", {
  id: id(), reportId: bigint("report_id", { mode: "number" }).notNull().references(() => issueReport.id),
  urgency: text("urgency", { enum: ["immediate", "digest"] }).notNull(), createdAt: at(),
}, (t) => [uniqueIndex("issue_notification_report_uq").on(t.reportId), check("issue_notification_urgency_chk", sql`${t.urgency} in ('immediate','digest')`)]);
