// M2 track tables (see AGENTS.md "Parallel tracks"). Re-exported by schema.ts.
import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, interval, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { platformOperator, session } from "../schema.ts";

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

// ---------------------------------------------------------------------------
// Owner console capabilities (T-60, IAM-8, IAM-15). The catalogue below is the single source of truth:
// the `operator_grant`, `operator_grant_event` and `four_eyes_rule` CHECKs are built from it, and
// test/capabilities.test.ts fails when it differs from the IAM-15 table in docs/07-IAM-RBAC-ABAC.md.
// `P1` is startup core, `P1.5` an optional update-log feature, `P2` stays dormant (cannot be granted)
// until the Compliance center or the tax workflows are activated (ADR-0011 §3, ADR-0012).
// ---------------------------------------------------------------------------
export const CAPABILITY_CATALOGUE = [
  { name: "dashboard.read", phase: "P1" },
  { name: "tenants.read", phase: "P1" },
  { name: "tenants.manage", phase: "P1" },
  { name: "tenants.verify", phase: "P1" },
  { name: "shipping.manage", phase: "P1" },
  { name: "billing.read", phase: "P1" },
  { name: "billing.manage", phase: "P1" },
  { name: "finance.read", phase: "P1" },
  { name: "payouts.process", phase: "P1" },
  { name: "refunds.process", phase: "P1" },
  { name: "payouts.reconcile", phase: "P1" },
  { name: "ledger.adjust", phase: "P1" },
  { name: "affiliate.accounts.read", phase: "P1" },
  { name: "affiliate.accounts.review", phase: "P1" },
  { name: "affiliate.policy.manage", phase: "P1" },
  { name: "affiliate.payout.process", phase: "P1" },
  { name: "affiliate.disputes.manage", phase: "P2" },
  { name: "accounts.read", phase: "P1" },
  { name: "accounts.support", phase: "P1" },
  { name: "accounts.suspend", phase: "P1" },
  { name: "accounts.identifiers.review", phase: "P1" },
  { name: "accounts.reveal", phase: "P1" },
  { name: "members.recover", phase: "P1" },
  { name: "cases.read", phase: "P1" },
  { name: "cases.write", phase: "P1" },
  { name: "moderation.manage", phase: "P2" },
  { name: "complaints.manage", phase: "P2" },
  { name: "privacy.requests.manage", phase: "P2" },
  { name: "incidents.manage", phase: "P2" },
  { name: "compliance.read", phase: "P2" },
  { name: "privacy.export.approve", phase: "P2" },
  { name: "tax.read", phase: "P1" },
  { name: "tax.manage", phase: "P1" },
  { name: "tax.approve", phase: "P2" },
  { name: "tax.remit", phase: "P2" },
  { name: "tax.documents.issue", phase: "P2" },
  { name: "tax.identity.review", phase: "P2" },
  { name: "tax.period.close", phase: "P2" },
  { name: "settings.manage", phase: "P1" },
  { name: "providers.read", phase: "P1" },
  { name: "providers.manage", phase: "P1" },
  { name: "logs.read", phase: "P1" },
  { name: "ops.read", phase: "P1" },
  { name: "audit.read", phase: "P1" },
  { name: "audit.export", phase: "P2" },
  { name: "ops.issues.report", phase: "P1" },
  { name: "ops.issues.manage", phase: "P1" },
  { name: "ops.issues.attachments", phase: "P2" },
  { name: "ops.jobs.manage", phase: "P1" },
  { name: "updates.write", phase: "P1.5" },
  { name: "updates.publish", phase: "P1.5" },
  { name: "staff.read", phase: "P1" },
  { name: "staff.manage", phase: "P1" },
  { name: "access.review", phase: "P1" },
  { name: "break_glass.approve", phase: "P1" },
] as const;
export type PlatformCapability = (typeof CAPABILITY_CATALOGUE)[number]["name"];
export const PLATFORM_CAPABILITIES: readonly PlatformCapability[] = CAPABILITY_CATALOGUE.map((c) => c.name);

/** SQL list of quoted names for CHECK constraints built from a constant (never from input). */
const sqlList = (names: readonly string[]) => sql.raw(names.map((n) => `'${n}'`).join(", "));
const capabilityIn = (column: unknown) => sql`${column} in (${sqlList(PLATFORM_CAPABILITIES)})`;

/**
 * Break-glass (PRIV-9, IAM-15) is limited to read and reveal capabilities. It never confers `staff.*`,
 * `break_glass.*`, `audit.*`, `ledger.adjust` or any write capability, and never counts as holding a
 * capability when a four-eyes action is approved.
 */
export const BREAK_GLASS_ALLOWLIST = ["accounts.read", "accounts.reveal", "finance.read", "tax.read"] as const satisfies readonly PlatformCapability[];

export const FOUR_EYES_PHASES = ["P1", "P2"] as const;
/**
 * The IAM-15 four-eyes matrix ("single source"), seeded into `four_eyes_rule` by the migration and
 * changed only by a later migration. `active: false` = decided disabled in Phase 1 (merge, ownership
 * recovery) or dormant (P2 and the optional update-log publish). `mfa.reset` lists its customer-target
 * capability; staff targets need `staff.manage` instead (IAM-15), which a later service chooses.
 */
export const FOUR_EYES_MATRIX = [
  { actionKey: "grant.sensitive", capability: "staff.manage", phase: "P1", active: true },
  { actionKey: "breakglass.approve", capability: "break_glass.approve", phase: "P1", active: true },
  { actionKey: "payout.approve_transfer", capability: "payouts.process", phase: "P1", active: true },
  { actionKey: "refund.approve_transfer", capability: "refunds.process", phase: "P1", active: true },
  // T-37 finish: a rejection of a payout in `processing` ("no transfer was sent") and the failure of a refund each need a second person (D-21 b, the buyer's money stays owed).
  { actionKey: "payout.reject_processing", capability: "payouts.process", phase: "P1", active: true },
  { actionKey: "refund.fail", capability: "refunds.process", phase: "P1", active: true },
  { actionKey: "affiliate_payout.approve_transfer", capability: "affiliate.payout.process", phase: "P1", active: true },
  { actionKey: "cod.manual_complete", capability: "payouts.process", phase: "P1", active: true },
  { actionKey: "cod.reconcile_release", capability: "payouts.reconcile", phase: "P1", active: true },
  { actionKey: "ledger.adjust", capability: "ledger.adjust", phase: "P1", active: true },
  { actionKey: "billing.comp", capability: "billing.manage", phase: "P1", active: true },
  { actionKey: "billing.mark_paid", capability: "billing.manage", phase: "P1", active: true },
  { actionKey: "billing.plan_price", capability: "billing.manage", phase: "P1", active: true },
  { actionKey: "shipping.margin", capability: "shipping.manage", phase: "P1", active: true },
  { actionKey: "affiliate.rate_bounds", capability: "affiliate.policy.manage", phase: "P1", active: true },
  { actionKey: "providers.rotate", capability: "providers.manage", phase: "P1", active: true },
  { actionKey: "mfa.reset", capability: "accounts.support", phase: "P1", active: true },
  // T-63: the staff-target variant of the IAM-15 `mfa.reset` row (capability `staff.manage`, never `accounts.*`).
  { actionKey: "staff.mfa_reset", capability: "staff.manage", phase: "P1", active: true },
  { actionKey: "account.close", capability: "accounts.suspend", phase: "P1", active: true },
  { actionKey: "merge.execute", capability: "accounts.identifiers.review", phase: "P1", active: false },
  { actionKey: "ownership.recover", capability: "members.recover", phase: "P1", active: false },
  { actionKey: "privacy.export", capability: "privacy.export.approve", phase: "P2", active: false },
  { actionKey: "audit.export", capability: "audit.export", phase: "P2", active: false },
  { actionKey: "tax.approve", capability: "tax.approve", phase: "P2", active: false },
  { actionKey: "tax.remit", capability: "tax.remit", phase: "P2", active: false },
  { actionKey: "tax.period_reopen", capability: "tax.period.close", phase: "P2", active: false },
  { actionKey: "updates.publish", capability: "updates.publish", phase: "P2", active: false },
] as const satisfies readonly { actionKey: string; capability: PlatformCapability; phase: (typeof FOUR_EYES_PHASES)[number]; active: boolean }[];
export type FourEyesAction = (typeof FOUR_EYES_MATRIX)[number]["actionKey"];

/** Every ◆ capability plus `accounts.reveal` and `audit.export`: granted only through an approved `grant.sensitive` request (IAM-15). */
export const SENSITIVE_CAPABILITIES: readonly PlatformCapability[] = [
  ...new Set<PlatformCapability>([...FOUR_EYES_MATRIX.map((r) => r.capability), "accounts.reveal", "audit.export"]),
];
/** The last active holder of these cannot be removed (UX-22, D-21). */
export const LAST_HOLDER_PROTECTED = ["staff.manage", "break_glass.approve"] as const satisfies readonly PlatformCapability[];

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired", "executed", "cancelled"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const GRANT_SOURCES = ["product", "system_bootstrap", "system_recovery"] as const;
export type GrantSource = (typeof GRANT_SOURCES)[number];

/** Explicit per-operator platform grants; never inferred from seller membership (IAM-1). A revoked grant is deleted (history: `operator_grant_event`). */
export const operatorGrant = pgTable(
  "operator_grant",
  {
    userId: text("user_id").notNull().references(() => platformOperator.userId, { onDelete: "cascade" }),
    capability: text("capability").$type<PlatformCapability>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** NULL = standing grant; a grant past this instant no longer counts (IAM-15 "expired grant"). */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** T-63 (SA-39): last time a console operation passed this capability check; written at most once per `GRANT_USE_RESOLUTION`, NULL = never used. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.capability] }), check("operator_grant_cap_chk", capabilityIn(t.capability))],
);

/** Append-only grant/revoke history. No FK to the operator: the history outlives the identity. Written in the grant transaction. */
export const operatorGrantEvent = pgTable(
  "operator_grant_event",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    operatorUserId: text("operator_user_id").notNull(),
    capability: text("capability").$type<PlatformCapability>().notNull(),
    action: text("action", { enum: ["grant", "revoke"] }).notNull(),
    source: text("source", { enum: GRANT_SOURCES }).notNull(),
    actorUserId: text("actor_user_id"),
    reason: text("reason").notNull(),
    approvalRequestId: bigint("approval_request_id", { mode: "number" }).references(() => approvalRequest.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("operator_grant_event_operator_idx").on(t.operatorUserId, t.id.desc()),
    check("operator_grant_event_cap_chk", capabilityIn(t.capability)),
    check("operator_grant_event_action_chk", sql`${t.action} in ('grant', 'revoke')`),
    check("operator_grant_event_source_chk", sql`${t.source} in ('product', 'system_bootstrap', 'system_recovery')`),
    check("operator_grant_event_reason_chk", sql`length(btrim(${t.reason})) > 0`),
    // A product grant names who did it; the out-of-band runbook paths name no person and no approval (IAM-15 bootstrap).
    check(
      "operator_grant_event_source_actor_chk",
      sql`(${t.source} = 'product' and ${t.actorUserId} is not null) or (${t.source} <> 'product' and ${t.actorUserId} is null and ${t.approvalRequestId} is null)`,
    ),
  ],
);

/** The four-eyes matrix as data. Seeded by migration; the platform role has no write privilege (changed only by a migration). */
export const fourEyesRule = pgTable(
  "four_eyes_rule",
  {
    actionKey: text("action_key").primaryKey(),
    capability: text("capability").$type<PlatformCapability>().notNull(),
    phase: text("phase", { enum: FOUR_EYES_PHASES }).notNull(),
    /** Upper bound of an approval's life; the default is a conservative placeholder, not an owner decision (D-22 item 3). */
    maxValidity: interval("max_validity").notNull(),
    active: boolean("active").notNull(),
  },
  (t) => [
    check("four_eyes_rule_cap_chk", capabilityIn(t.capability)),
    check("four_eyes_rule_phase_chk", sql`${t.phase} in ('P1', 'P2')`),
    check("four_eyes_rule_validity_chk", sql`${t.maxValidity} > interval '0'`),
  ],
);

/**
 * A second person's decision on one exact payload (DATA-14). Rows are never deleted; moves are
 * pending -> approved|rejected|expired|cancelled and approved -> executed|expired|cancelled, enforced by a trigger
 * that also re-checks, at decision and at execution, that the approver still holds the rule's capability.
 */
export const approvalRequest = pgTable(
  "approval_request",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    actionKey: text("action_key").notNull().references(() => fourEyesRule.actionKey),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    /** The canonical text the hash is computed over, so an approver (and the T-62 inbox) can read exactly what is approved. */
    payloadCanonical: text("payload_canonical").notNull(),
    requestedBy: text("requested_by").notNull().references(() => platformOperator.userId),
    reason: text("reason").notNull(),
    status: text("status", { enum: APPROVAL_STATUSES }).notNull().default("pending"),
    decidedBy: text("decided_by").references(() => platformOperator.userId),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // An approved or pending request for the same action, target and payload exists once (a changed payload is a new request).
    uniqueIndex("approval_request_open_uq").on(t.actionKey, t.targetKind, t.targetId, t.payloadSha256).where(sql`${t.status} in ('pending', 'approved')`),
    index("approval_request_requester_idx").on(t.requestedBy, t.status),
    check("approval_request_status_chk", sql`${t.status} in ('pending', 'approved', 'rejected', 'expired', 'executed', 'cancelled')`),
    check("approval_request_payload_chk", sql`${t.payloadSha256} ~ '^[0-9a-f]{64}$'`),
    // The stored text IS what was hashed (the database recomputes it), and it stays readable.
    check("approval_request_canonical_chk", sql`${t.payloadSha256} = encode(sha256(convert_to(${t.payloadCanonical}, 'UTF8')), 'hex') and length(${t.payloadCanonical}) <= 4000`),
    check("approval_request_reason_chk", sql`length(btrim(${t.reason})) between 5 and 500`),
    // Requester and approver are different people, enforced by the database (never only by the service).
    check("approval_request_two_people_chk", sql`${t.decidedBy} is null or ${t.requestedBy} <> ${t.decidedBy}`),
    check("approval_request_decision_chk", sql`(${t.decidedBy} is null) = (${t.decidedAt} is null)`),
    check("approval_request_state_chk", sql`(${t.status} not in ('approved', 'rejected', 'executed') or ${t.decidedBy} is not null) and (${t.status} <> 'pending' or ${t.decidedBy} is null)`),
    check("approval_request_executed_chk", sql`(${t.status} = 'executed') = (${t.executedAt} is not null)`),
    check("approval_request_expiry_chk", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

/**
 * Time-boxed elevation to allowlisted read/reveal capabilities (PRIV-9). `case_id` has no FK until
 * `support_case` exists (T-63). Only the revoke and review fields may change, once (trigger).
 * Nothing in the capability or approval code reads this table, so it can never satisfy a four-eyes approval.
 */
export const breakGlassGrant = pgTable(
  "break_glass_grant",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    requestedBy: text("requested_by").notNull().references(() => platformOperator.userId),
    approvedBy: text("approved_by").notNull().references(() => platformOperator.userId),
    capabilities: text("capabilities").array().notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    caseId: text("case_id").notNull(),
    reason: text("reason").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by").references(() => platformOperator.userId),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (t) => [
    check("break_glass_two_people_chk", sql`${t.requestedBy} <> ${t.approvedBy}`),
    check("break_glass_window_chk", sql`${t.expiresAt} > ${t.startsAt}`),
    check("break_glass_case_chk", sql`length(btrim(${t.caseId})) > 0 and length(btrim(${t.reason})) > 0`),
    // Non-empty and contained in the read/reveal allowlist: staff.*, break_glass.*, audit.*, ledger.adjust and writes can never be listed.
    check("break_glass_allowlist_chk", sql`cardinality(${t.capabilities}) > 0 and ${t.capabilities} <@ array[${sqlList(BREAK_GLASS_ALLOWLIST)}]::text[]`),
  ],
);

/**
 * Written by the Better Auth verification hook (apps/web/src/lib/auth.ts) when a second-factor code is
 * verified in a session. Owner console routes accept a session only if its row exists (D-21: MFA is bound
 * to the session, not to the account flag). Deleting the session deletes the row.
 */
export const sessionMfa = pgTable("session_mfa", {
  sessionId: text("session_id").primaryKey().references(() => session.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  method: text("method", { enum: ["totp", "backup_code", "otp"] }).notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Single-use reauthentication proof, bound to one session, action and subject (D-21). Issued only while the
 * session's last verified second-factor code is fresh; consumed with `UPDATE ... WHERE consumed_at IS NULL
 * RETURNING` inside the mutation's transaction, so a failed write un-consumes it.
 */
export const operatorStepUpProof = pgTable(
  "operator_step_up_proof",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("session_id").notNull().references(() => session.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    actionKey: text("action_key").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [index("operator_step_up_session_idx").on(t.sessionId)],
);
