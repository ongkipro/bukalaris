// T-63 account governance tables for stores and seller team accounts (DATA-14, ADR-0011). Platform class: no `bukalaris_app`
// grant, written only through the named services of `ops/accounts-governance*.ts`. The history and decision tables are
// append-only (trigger plus INSERT-only privileges); rules that must hold even when a caller is wrong live in the migration.
import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { platformOperator, store } from "../schema.ts";
import { approvalRequest, fourEyesRule } from "./schema-ops.ts";

const id = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const at = (name = "created_at") => timestamp(name, { withTimezone: true }).notNull().defaultNow();
const sqlList = (names: readonly string[]) => sql.raw(names.map((n) => `'${n}'`).join(", "));

export const CASE_KINDS = ["support", "verification", "risk", "merge_request", "tax_correction"] as const;
export const CASE_STATUSES = ["open", "in_progress", "waiting", "resolved", "closed"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const CASE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const CASE_SOURCES = ["operator", "system", "payee_request", "external"] as const;
export const SUBJECT_KINDS = ["store", "user", "affiliate", "buyer"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];
/** Legal moves of a case (DATA-14): open -> in_progress <-> waiting, in_progress -> resolved -> closed, resolved -> open only by an audited reopen. */
export const CASE_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  open: ["in_progress"],
  in_progress: ["waiting", "resolved"],
  waiting: ["in_progress"],
  resolved: ["closed", "open"],
  closed: [],
};

export const supportCase = pgTable(
  "support_case",
  {
    id: id(),
    /** `C-000123`: what staff say aloud and what audit and access rows store as the case reference. */
    caseNumber: text("case_number").generatedAlwaysAs(sql`'C-' || lpad(id::text, 6, '0')`),
    kind: text("kind", { enum: CASE_KINDS }).notNull().default("support"),
    subjectKind: text("subject_kind", { enum: [...SUBJECT_KINDS, "order_ref"] }),
    subjectId: text("subject_id"),
    title: text("title").notNull(),
    status: text("status", { enum: CASE_STATUSES }).notNull().default("open"),
    priority: text("priority", { enum: CASE_PRIORITIES }).notNull().default("normal"),
    assigneeUserId: text("assignee_user_id").references(() => platformOperator.userId),
    openedByUserId: text("opened_by_user_id").notNull().references(() => platformOperator.userId),
    source: text("source", { enum: CASE_SOURCES }).notNull().default("operator"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    resolutionCode: text("resolution_code"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: at(),
    updatedAt: at("updated_at"),
  },
  (t) => [
    uniqueIndex("support_case_number_uq").on(t.caseNumber),
    index("support_case_subject_idx").on(t.subjectKind, t.subjectId),
    index("support_case_status_idx").on(t.status, t.id.desc()),
    check("support_case_kind_chk", sql`${t.kind} in (${sqlList(CASE_KINDS)})`),
    check("support_case_status_chk", sql`${t.status} in (${sqlList(CASE_STATUSES)})`),
    check("support_case_priority_chk", sql`${t.priority} in (${sqlList(CASE_PRIORITIES)})`),
    check("support_case_source_chk", sql`${t.source} in (${sqlList(CASE_SOURCES)})`),
    check("support_case_subject_chk", sql`(${t.subjectKind} is null) = (${t.subjectId} is null)`),
    check("support_case_title_chk", sql`length(btrim(${t.title})) between 1 and 200`),
    // closed implies resolved; a resolved or closed case carries its resolution
    check("support_case_closed_chk", sql`${t.status} <> 'closed' or ${t.resolvedAt} is not null`),
    check("support_case_resolved_chk", sql`${t.status} not in ('resolved', 'closed') or (${t.resolvedAt} is not null and ${t.resolutionCode} is not null)`),
  ],
);

/** Append-only. Free text is scrubbed of contact and URL shapes before it is stored; sensitive data is referenced by id only. */
export const supportCaseNote = pgTable(
  "support_case_note",
  {
    id: id(),
    caseId: bigint("case_id", { mode: "number" }).notNull().references(() => supportCase.id),
    authorUserId: text("author_user_id").notNull().references(() => platformOperator.userId),
    kind: text("kind", { enum: ["note", "system"] }).notNull().default("note"),
    body: text("body").notNull(),
    createdAt: at(),
  },
  (t) => [index("support_case_note_case_idx").on(t.caseId, t.id), check("support_case_note_body_chk", sql`length(btrim(${t.body})) between 1 and 2000`), check("support_case_note_kind_chk", sql`${t.kind} in ('note', 'system')`)],
);

/** One row per status change of a store or an identity, written in the transition's own transaction. Append-only. */
export const accountStatusEvent = pgTable(
  "account_status_event",
  {
    id: id(),
    subjectKind: text("subject_kind", { enum: SUBJECT_KINDS }).notNull(),
    subjectId: text("subject_id").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    reasonCode: text("reason_code").notNull(),
    reasonNote: text("reason_note"),
    /** NULL only for the system (migration backfill, automatic transitions). */
    actorUserId: text("actor_user_id"),
    caseId: bigint("case_id", { mode: "number" }).references(() => supportCase.id),
    requestId: text("request_id"),
    createdAt: at(),
  },
  (t) => [
    index("account_status_event_subject_idx").on(t.subjectKind, t.subjectId, t.createdAt.desc()),
    check("account_status_event_kind_chk", sql`${t.subjectKind} in (${sqlList(SUBJECT_KINDS)})`),
    check("account_status_event_reason_chk", sql`${t.reasonCode} ~ '^[a-z][a-z0-9_.-]{1,63}$'`),
    check("account_status_event_change_chk", sql`${t.fromStatus} is distinct from ${t.toStatus}`),
  ],
);

export const SUPPORT_ACTION_KINDS = ["resend_verification", "revoke_sessions", "reset_mfa", "start_recovery", "suspend", "reinstate", "request_merge", "execute_merge", "recover_ownership", "start_export", "close_account"] as const;
export type SupportActionKind = (typeof SUPPORT_ACTION_KINDS)[number];
export const SUPPORT_ACTION_STATUSES = ["requested", "awaiting_approval", "approved", "executed", "failed", "cancelled"] as const;

/**
 * One staff action on an account. `idempotency_key` is unique, so a replay returns the first row instead of acting twice.
 * `action_key` (FK to `four_eyes_rule`, set by the service from the kind) makes the row four-eyes: the migration trigger refuses
 * `executed` unless `approval_request_id` points at an executed approval of that action key requested by the same person.
 */
export const supportAction = pgTable(
  "support_action",
  {
    id: id(),
    caseId: bigint("case_id", { mode: "number" }).references(() => supportCase.id),
    subjectKind: text("subject_kind", { enum: SUBJECT_KINDS }).notNull(),
    subjectId: text("subject_id").notNull(),
    actionKind: text("action_kind", { enum: SUPPORT_ACTION_KINDS }).notNull(),
    actionKey: text("action_key").references(() => fourEyesRule.actionKey),
    status: text("status", { enum: SUPPORT_ACTION_STATUSES }).notNull().default("requested"),
    requestedBy: text("requested_by").notNull().references(() => platformOperator.userId),
    approvalRequestId: bigint("approval_request_id", { mode: "number" }).references(() => approvalRequest.id),
    idempotencyKey: text("idempotency_key").notNull(),
    reasonCode: text("reason_code").notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    resultCode: text("result_code"),
    failureReason: text("failure_reason"),
    createdAt: at(),
    updatedAt: at("updated_at"),
  },
  (t) => [
    uniqueIndex("support_action_idempotency_uq").on(t.idempotencyKey),
    index("support_action_subject_idx").on(t.subjectKind, t.subjectId, t.id.desc()),
    index("support_action_case_idx").on(t.caseId),
    check("support_action_kind_chk", sql`${t.actionKind} in (${sqlList(SUPPORT_ACTION_KINDS)})`),
    check("support_action_status_chk", sql`${t.status} in (${sqlList(SUPPORT_ACTION_STATUSES)})`),
    check("support_action_subject_kind_chk", sql`${t.subjectKind} in (${sqlList(SUBJECT_KINDS)})`),
    check("support_action_executed_chk", sql`(${t.status} = 'executed') = (${t.executedAt} is not null)`),
    check("support_action_key_chk", sql`${t.actionKey} is null or ${t.status} not in ('approved', 'executed') or ${t.approvalRequestId} is not null`),
    check("support_action_idem_chk", sql`length(${t.idempotencyKey}) between 8 and 128`),
  ],
);

/**
 * Optional, versioned verification record of a store (SA-16, DATA-14). It never blocks store creation, approval, activation,
 * billing or payout: nothing references it. Name and contact are protected (class `name`/`email`/`phone`): the service masks
 * them before serialization and a full value is a PRIV-9 reveal. A submitted version is immutable (trigger); a new
 * submission is a new version.
 */
export const VERIFICATION_STATUSES = ["not_started", "submitted", "in_review", "verified", "rejected", "expired", "revoked"] as const;
export const accountVerification = pgTable(
  "account_verification",
  {
    id: id(),
    subjectKind: text("subject_kind", { enum: ["store", "affiliate"] }).notNull(),
    subjectId: bigint("subject_id", { mode: "number" }).notNull(),
    kind: text("kind", { enum: ["identity", "business"] }).notNull(),
    version: integer("version").notNull(),
    status: text("status", { enum: VERIFICATION_STATUSES }).notNull().default("submitted"),
    submittedBy: text("submitted_by").notNull().references(() => platformOperator.userId),
    submittedAt: at("submitted_at"),
    reviewerUserId: text("reviewer_user_id").references(() => platformOperator.userId),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReasonCode: text("decision_reason_code"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Opaque reference only (no document image is collected, PRIV-6). */
    evidenceRef: text("evidence_ref"),
    verifiedName: text("verified_name"),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    contactConfirmedAt: timestamp("contact_confirmed_at", { withTimezone: true }),
    registrationNumber: text("registration_number"),
    createdAt: at(),
  },
  (t) => [
    uniqueIndex("account_verification_version_uq").on(t.subjectKind, t.subjectId, t.kind, t.version),
    uniqueIndex("account_verification_verified_uq").on(t.subjectKind, t.subjectId, t.kind).where(sql`${t.status} = 'verified'`),
    index("account_verification_subject_idx").on(t.subjectKind, t.subjectId, t.id.desc()),
    check("account_verification_status_chk", sql`${t.status} in (${sqlList(VERIFICATION_STATUSES)})`),
    check("account_verification_version_chk", sql`${t.version} >= 1`),
    check("account_verification_decision_chk", sql`(${t.status} not in ('verified', 'rejected', 'revoked')) or (${t.reviewerUserId} is not null and ${t.decidedAt} is not null and ${t.decisionReasonCode} is not null)`),
    check("account_verification_evidence_chk", sql`${t.evidenceRef} is null or ${t.evidenceRef} ~ '^[A-Za-z0-9_.:/-]{1,120}$'`),
  ],
);

/** A reviewed risk flag the staff member has seen (SA-18): the flag stays derived from its source, the acknowledgement only hides it until `expires_at`. */
export const storeRiskAck = pgTable(
  "store_risk_ack",
  {
    id: id(),
    // Named `store_ref`, not `store_id`: this is a platform-class table (no RLS), the tenancy key name stays reserved for tenant tables.
    storeRef: bigint("store_ref", { mode: "number" }).notNull().references(() => store.id),
    flagKey: text("flag_key").notNull(),
    acknowledgedBy: text("acknowledged_by").notNull().references(() => platformOperator.userId),
    reason: text("reason").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: at(),
  },
  (t) => [
    index("store_risk_ack_store_idx").on(t.storeRef, t.flagKey, t.id.desc()),
    check("store_risk_ack_flag_chk", sql`${t.flagKey} ~ '^[a-z][a-z0-9_.-]{1,63}$'`),
    check("store_risk_ack_reason_chk", sql`length(btrim(${t.reason})) between 5 and 500`),
    check("store_risk_ack_expiry_chk", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

/**
 * Support recovery link (IAM-15, ADR-0011 section 4): only the SHA-256 of the token is stored. The link itself leaves the server
 * inside one `support_recovery` mail to the contact on file; the operator is never shown it. The token is redeemed once, and
 * only through `support_recovery_redeem()` (the app role cannot read this table).
 */
export const supportRecoveryLink = pgTable(
  "support_recovery_link",
  {
    id: id(),
    tokenSha256: text("token_sha256").notNull(),
    userId: text("user_id").notNull(),
    supportActionId: bigint("support_action_id", { mode: "number" }).notNull().references(() => supportAction.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: at(),
  },
  (t) => [
    uniqueIndex("support_recovery_link_token_uq").on(t.tokenSha256),
    index("support_recovery_link_user_idx").on(t.userId, t.id.desc()),
    check("support_recovery_link_token_chk", sql`${t.tokenSha256} ~ '^[0-9a-f]{64}$'`),
    check("support_recovery_link_expiry_chk", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

/** Access-review decisions (SA-39, IAM-15): which grant a reviewer confirmed or revoked, with the last use they saw. Append-only. */
export const accessReviewDecision = pgTable(
  "access_review_decision",
  {
    id: id(),
    reviewerUserId: text("reviewer_user_id").notNull().references(() => platformOperator.userId),
    operatorUserId: text("operator_user_id").notNull(),
    capability: text("capability").notNull(),
    decision: text("decision", { enum: ["confirmed", "revoked"] }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    grantCreatedAt: timestamp("grant_created_at", { withTimezone: true }),
    reason: text("reason").notNull(),
    createdAt: at(),
  },
  (t) => [
    index("access_review_decision_operator_idx").on(t.operatorUserId, t.id.desc()),
    check("access_review_decision_chk", sql`${t.decision} in ('confirmed', 'revoked')`),
    check("access_review_reason_chk", sql`length(btrim(${t.reason})) between 5 and 500`),
    // A reviewer never confirms their own access; the revoke path is separate (staff.manage).
    check("access_review_self_chk", sql`${t.reviewerUserId} <> ${t.operatorUserId}`),
  ],
);
