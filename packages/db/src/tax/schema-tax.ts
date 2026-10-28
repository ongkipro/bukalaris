import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { PolicyBracket } from "./compute.ts";

const id = () => bigserial("id", { mode: "number" }).primaryKey();
const money = (name: string) => bigint(name, { mode: "bigint" }).notNull();
const instant = (name: string) => timestamp(name, { withTimezone: true });

export const taxEntityProfile = pgTable("tax_entity_profile", {
  id: id(), version: integer("version").notNull().unique(), effectiveFrom: instant("effective_from").notNull(),
  legalName: text("legal_name"), entityKindLabel: text("entity_kind_label"), npwpSealed: text("npwp_sealed"), npwpKeyVersion: text("npwp_key_version"),
  pkpStatus: text("pkp_status").notNull().default("unknown"), pkpSince: date("pkp_since"), registeredAddress: text("registered_address"), accountantLabel: text("accountant_label"),
  ebupotAccessConfirmedAt: instant("ebupot_access_confirmed_at"), efakturAccessConfirmedAt: instant("efaktur_access_confirmed_at"), depositAccountLabel: text("deposit_account_label"),
  status: text("status").notNull().default("draft"), confirmedBy: text("confirmed_by"), advisorRef: text("advisor_ref"),
}, (t) => [check("tax_entity_profile_state", sql`${t.status} in ('draft','confirmed') and ${t.pkpStatus} in ('unknown','pkp','non_pkp')`), check("tax_entity_profile_confirmed", sql`${t.status} <> 'confirmed' or (${t.legalName} is not null and ${t.entityKindLabel} is not null and ${t.npwpSealed} is not null and ${t.npwpKeyVersion} is not null and ${t.pkpStatus} <> 'unknown' and ${t.confirmedBy} is not null)`)]);

export const taxSetting = pgTable("tax_setting", {
  id: id(), version: integer("version").notNull().unique(), effectiveFrom: instant("effective_from").notNull().unique(),
  statementsEnabled: boolean("statements_enabled").notNull().default(true), identityCaptureEnabled: boolean("identity_capture_enabled").notNull().default(false),
  taxIdentityRequiredForPayout: boolean("tax_identity_required_for_payout").notNull().default(false), withholdingEnabled: boolean("withholding_enabled").notNull().default(false), pkpGateEnabled: boolean("pkp_gate_enabled").notNull().default(false),
  activationRef: text("activation_ref"), entityProfileId: bigint("entity_profile_id", { mode: "number" }).references(() => taxEntityProfile.id),
  noticeApprovalRef: text("notice_approval_ref"), reason: text("reason").notNull(), createdBy: text("created_by"), createdAt: instant("created_at").notNull().defaultNow(),
}, (t) => [check("tax_setting_withholding", sql`not ${t.withholdingEnabled} or (${t.taxIdentityRequiredForPayout} and nullif(btrim(${t.activationRef}), '') is not null and ${t.entityProfileId} is not null)`), check("tax_setting_pkp", sql`not ${t.pkpGateEnabled} or ${t.entityProfileId} is not null`), check("tax_setting_notice", sql`not ${t.identityCaptureEnabled} or nullif(btrim(${t.noticeApprovalRef}), '') is not null`)]);

export const taxIdentity = pgTable("tax_identity", {
  id: id(), subjectKind: text("subject_kind").notNull(), affiliateId: bigint("affiliate_id", { mode: "number" }), storeId: bigint("store_id", { mode: "number" }),
  version: integer("version").notNull(), status: text("status").notNull().default("submitted"), payeeClass: text("payee_class").notNull(), idKind: text("id_kind").notNull(),
  idSealed: text("id_sealed"), idKeyVersion: text("id_key_version"), idLast4: text("id_last4").notNull(), idFingerprint: text("id_fingerprint"), fingerprintKeyId: text("fingerprint_key_id"), registeredNameSealed: text("registered_name_sealed"),
  pkpStatus: text("pkp_status"), pkpSince: date("pkp_since"), pkpEvidenceRef: text("pkp_evidence_ref"), clientRequestKey: text("client_request_key").notNull(),
  submittedAt: instant("submitted_at").notNull().defaultNow(), reviewedBy: text("reviewed_by"), reviewedAt: instant("reviewed_at"), rejectionReasonCode: text("rejection_reason_code"),
}, (t) => [
  check("tax_identity_subject", sql`(${t.subjectKind} = 'affiliate' and coalesce(${t.affiliateId} > 0, false) and ${t.storeId} is null) or (${t.subjectKind} = 'store' and coalesce(${t.storeId} > 0, false) and ${t.affiliateId} is null)`),
  check("tax_identity_class", sql`${t.payeeClass} in ('individual','entity') and ${t.idKind} in ('npwp','nik') and (${t.payeeClass} <> 'entity' or ${t.idKind} = 'npwp')`),
  check("tax_identity_status", sql`${t.status} in ('submitted','in_review','approved','rejected','superseded','revoked','withdrawn') and ${t.version} > 0`),
  check("tax_identity_sealed", sql`(${t.idSealed} is not null and ${t.idKeyVersion} is not null and ${t.registeredNameSealed} is not null and ${t.idFingerprint} is not null and ${t.fingerprintKeyId} is not null) or (${t.status} = 'withdrawn' and ${t.idSealed} is null and ${t.idKeyVersion} is null and ${t.registeredNameSealed} is null and ${t.idFingerprint} is null and ${t.fingerprintKeyId} is null)`),
  unique("tax_identity_subject_ref").on(t.id, t.affiliateId), unique("tax_identity_affiliate_version").on(t.affiliateId, t.version), unique("tax_identity_store_version").on(t.storeId, t.version),
  unique("tax_identity_affiliate_request").on(t.affiliateId, t.clientRequestKey), unique("tax_identity_store_request").on(t.storeId, t.clientRequestKey),
  uniqueIndex("tax_identity_affiliate_approved").on(t.affiliateId).where(sql`${t.status} = 'approved'`), uniqueIndex("tax_identity_store_approved").on(t.storeId).where(sql`${t.status} = 'approved'`),
  index("tax_identity_duplicates").on(t.idKind, t.idFingerprint).where(sql`${t.status} in ('submitted','in_review','approved')`),
]);

export const taxPolicyVersion = pgTable("tax_policy_version", {
  id: id(), taxTypeCode: text("tax_type_code").notNull(), categoryCode: text("category_code").notNull(), version: integer("version").notNull(), status: text("status").notNull().default("draft"),
  effectiveFrom: date("effective_from").notNull(), effectiveTo: date("effective_to"), taxLabel: text("tax_label").notNull(), sourceCitation: text("source_citation").notNull(),
  baseFractionBps: integer("base_fraction_bps").notNull(), rateMethod: text("rate_method").notNull(), brackets: jsonb("brackets").$type<PolicyBracket[]>().notNull(), rounding: text("rounding").notNull(), recognitionEvent: text("recognition_event").notNull(),
  depositDueDay: integer("deposit_due_day"), reportDueDay: integer("report_due_day"), identityKindsAccepted: text("identity_kinds_accepted").array().notNull(), clawbackTreatment: text("clawback_treatment").notNull().default("manual_review"),
  confirmationBasis: text("confirmation_basis"), advisorConfirmationRef: text("advisor_confirmation_ref"), authoredBy: text("authored_by").notNull(), confirmedBy: text("confirmed_by"), confirmedAt: instant("confirmed_at"), supersedesVersionId: bigint("supersedes_version_id", { mode: "number" }),
}, (t) => [
  unique("tax_policy_version_series").on(t.taxTypeCode, t.categoryCode, t.version), unique("tax_policy_version_ref").on(t.id, t.taxTypeCode, t.categoryCode),
  check("tax_policy_type", sql`(${t.taxTypeCode} = 'commission_withholding' and ${t.categoryCode} in ('individual','entity') and ${t.recognitionEvent} = 'payout_paid') or (${t.taxTypeCode} = 'vat_output' and ${t.categoryCode} in ('subscription','cod_fee') and ${t.recognitionEvent} in ('invoice_created','payment_confirmed'))`),
  check("tax_policy_parameters", sql`${t.baseFractionBps} between 0 and 10000 and ${t.rateMethod} in ('per_payment','cumulative_true_up') and ${t.rounding} in ('floor','half_up','ceil') and jsonb_typeof(${t.brackets}) = 'array' and jsonb_array_length(${t.brackets}) > 0 and (${t.depositDueDay} is null or ${t.depositDueDay} between 1 and 31) and (${t.reportDueDay} is null or ${t.reportDueDay} between 1 and 31)`),
  check("tax_policy_state", sql`${t.status} in ('draft','submitted','confirmed','rejected','retired') and ${t.version} > 0 and (${t.effectiveTo} is null or ${t.effectiveTo} > ${t.effectiveFrom})`),
  check("tax_policy_confirmation", sql`${t.status} not in ('confirmed','retired') or (${t.confirmedBy} is not null and ${t.confirmedAt} is not null and coalesce(${t.confirmationBasis} in ('advisor','owner_decision'), false) and (${t.confirmationBasis} is distinct from 'advisor' or nullif(btrim(${t.advisorConfirmationRef}), '') is not null) and (${t.taxTypeCode} <> 'commission_withholding' or (${t.confirmationBasis} is not distinct from 'advisor' and ${t.authoredBy} <> ${t.confirmedBy} and ${t.depositDueDay} is not null and ${t.reportDueDay} is not null)))`),
]);

export const taxComputation = pgTable("tax_computation", {
  id: id(), taxTypeCode: text("tax_type_code").notNull(), categoryCode: text("category_code").notNull(), affiliateId: bigint("affiliate_id", { mode: "number" }).notNull(),
  sourceKind: text("source_kind").notNull(), sourceId: uuid("source_id").notNull(), kind: text("kind").notNull().default("original"), correctsComputationId: bigint("corrects_computation_id", { mode: "number" }), correctionKey: text("correction_key"), status: text("status").notNull().default("computed"), taxYear: integer("tax_year").notNull(),
  taxIdentityId: bigint("tax_identity_id", { mode: "number" }).notNull(), policyVersionId: bigint("policy_version_id", { mode: "number" }).notNull(), taxSettingVersionId: bigint("tax_setting_version_id", { mode: "number" }).notNull().references(() => taxSetting.id),
  grossIdr: money("gross_idr"), baseIdr: money("base_idr"), ytdBaseBeforeIdr: money("ytd_base_before_idr"), ytdTaxBeforeIdr: money("ytd_tax_before_idr"), taxIdr: money("tax_idr"), netIdr: money("net_idr"), clamped: boolean("clamped").notNull(), inputs: jsonb("inputs").notNull(), inputsSha256: text("inputs_sha256").notNull(), computedAt: instant("computed_at").notNull().defaultNow(), recognizedAt: instant("recognized_at"),
}, (t) => [
  unique("tax_computation_payout_ref").on(t.id, t.affiliateId, t.grossIdr, t.taxIdr, t.netIdr),
  foreignKey({ name: "tax_computation_identity_fk", columns: [t.taxIdentityId, t.affiliateId], foreignColumns: [taxIdentity.id, taxIdentity.affiliateId] }), foreignKey({ name: "tax_computation_policy_fk", columns: [t.policyVersionId, t.taxTypeCode, t.categoryCode], foreignColumns: [taxPolicyVersion.id, taxPolicyVersion.taxTypeCode, taxPolicyVersion.categoryCode] }),
  foreignKey({ name: "tax_computation_correction_fk", columns: [t.correctsComputationId], foreignColumns: [t.id] }),
  uniqueIndex("tax_computation_original").on(t.sourceKind, t.sourceId).where(sql`${t.kind} = 'original'`), uniqueIndex("tax_computation_correction").on(t.correctsComputationId, t.correctionKey).where(sql`${t.kind} = 'correction'`),
  check("tax_computation_amounts", sql`${t.grossIdr} = ${t.taxIdr} + ${t.netIdr} and (${t.kind} <> 'original' or (${t.grossIdr} >= 0 and ${t.baseIdr} >= 0 and ${t.taxIdr} >= 0 and ${t.netIdr} >= 0))`),
  check("tax_computation_kind", sql`${t.sourceKind} = 'affiliate_payout' and ((${t.kind} = 'original' and ${t.correctsComputationId} is null and ${t.correctionKey} is null) or (${t.kind} = 'correction' and ${t.correctsComputationId} is not null and ${t.correctionKey} is not null))`),
  check("tax_computation_state", sql`${t.status} in ('computed','recognized','void') and ((${t.status} = 'recognized') = (${t.recognizedAt} is not null))`),
]);

export const taxDocument = pgTable("tax_document", {
  id: id(), kind: text("kind").notNull(), subjectKind: text("subject_kind").notNull(), affiliateId: bigint("affiliate_id", { mode: "number" }), storeId: bigint("store_id", { mode: "number" }), periodStart: date("period_start").notNull(), periodEnd: date("period_end").notNull(), revision: integer("revision").notNull(), status: text("status").notNull().default("issued"), number: text("number").notNull(), replacesDocumentId: bigint("replaces_document_id", { mode: "number" }), payload: jsonb("payload").notNull(), payloadSha256: text("payload_sha256").notNull(), taxComputationId: bigint("tax_computation_id", { mode: "number" }).references(() => taxComputation.id), subscriptionInvoiceId: bigint("subscription_invoice_id", { mode: "number" }), issuedAt: instant("issued_at").notNull().defaultNow(), issuedBy: text("issued_by"), deliveredAt: instant("delivered_at"), officialNumber: text("official_number"), filedOn: date("filed_on"),
}, (t) => [
  unique("tax_document_number").on(t.kind, t.number),
  uniqueIndex("tax_document_affiliate_revision").on(t.kind, t.affiliateId, t.periodStart, t.periodEnd, t.revision), uniqueIndex("tax_document_store_revision").on(t.kind, t.storeId, t.periodStart, t.periodEnd, t.revision),
  uniqueIndex("tax_document_affiliate_issued").on(t.kind, t.affiliateId, t.periodStart, t.periodEnd).where(sql`${t.status} = 'issued'`), uniqueIndex("tax_document_store_issued").on(t.kind, t.storeId, t.periodStart, t.periodEnd).where(sql`${t.status} = 'issued'`), uniqueIndex("tax_document_invoice_issued").on(t.subscriptionInvoiceId, t.kind).where(sql`${t.status} = 'issued'`),
  check("tax_document_subject", sql`(${t.subjectKind} = 'affiliate' and coalesce(${t.affiliateId} > 0, false) and ${t.storeId} is null) or (${t.subjectKind} = 'store' and coalesce(${t.storeId} > 0, false) and ${t.affiliateId} is null)`),
  check("tax_document_state", sql`${t.status} in ('issued','replaced','cancelled') and ${t.revision} > 0 and ${t.periodEnd} > ${t.periodStart}`),
  check("tax_document_kind", sql`${t.kind} in ('earnings_statement','withholding_slip','vat_invoice','credit_note','annual_tax_statement') and (${t.kind} = 'earnings_statement' or ${t.taxComputationId} is not null or ${t.subscriptionInvoiceId} is not null)`),
]);
export const taxDocumentSequence = pgTable("tax_document_sequence", { kind: text("kind").notNull(), scopeKey: text("scope_key").notNull(), lastValue: bigint("last_value", { mode: "bigint" }).notNull() }, (t) => [primaryKey({ columns: [t.kind, t.scopeKey] }), check("tax_document_sequence_positive", sql`${t.lastValue} > 0`)]);
export const taxEvent = pgTable("tax_event", { id: id(), entityKind: text("entity_kind").notNull(), entityId: bigint("entity_id", { mode: "number" }).notNull(), event: text("event").notNull(), actorUserId: text("actor_user_id"), reason: text("reason"), evidenceRef: text("evidence_ref"), requestId: text("request_id"), createdAt: instant("created_at").notNull().defaultNow() }, (t) => [index("tax_event_entity").on(t.entityKind, t.entityId, t.createdAt)]);
