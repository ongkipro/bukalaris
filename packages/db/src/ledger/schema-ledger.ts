// Seller ledger, order financials, COD reconciliation, payouts and buyer refunds (T-37, ADR-0006, DATA-7, BILL-4, BILL-5). Re-exported by schema.ts.
// Rules that must hold even if a caller is wrong live in the database: CHECKs here, triggers and RLS in the hand-written section of the migration.
import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { order, orderLine } from "../schema.ts";
import { affiliate } from "../affiliate/schema-affiliate.ts";
import { paymentAttempt } from "../payments/schema-payments.ts";
import { storeShippingAccount } from "../shipping/schema-accounts.ts";

const idr = (name: string) => bigint(name, { mode: "number" });
const at = (name = "created_at") => timestamp(name, { withTimezone: true }).notNull().defaultNow();
const tsz = (name: string) => timestamp(name, { withTimezone: true });
const ident = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const storeCol = () => bigint("store_id", { mode: "number" }).notNull();

export const LEDGER_KINDS = ["sale", "cashback", "shipping_debit", "shipping_debit_reversal", "return_reversal", "payout", "payout_reversal", "adjustment"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];
export const RELEASE_BASES = ["delivery", "reconciliation", "netting", "direct"] as const;
export type ReleaseBasis = (typeof RELEASE_BASES)[number];
export const PAYOUT_STATUSES = ["requested", "processing", "paid", "rejected"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
export const REFUND_STATUSES = ["pending", "processing", "completed", "failed"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
export const BATCH_STATUSES = ["draft", "pending_approval", "applied", "void"] as const;

/** Immutable checkout snapshot (BILL-4). Written once with the order; no UPDATE or DELETE exists for any login role and a trigger refuses both. */
export const orderFinancials = pgTable(
  "order_financials",
  {
    orderId: bigint("order_id", { mode: "number" }).primaryKey(),
    storeId: storeCol(),
    shippingAccountId: bigint("shipping_account_id", { mode: "number" }).notNull().default(0),
    shippingAccountKind: text("shipping_account_kind", { enum: ["partner_managed", "platform_master"] }).notNull().default("platform_master"),
    subtotalIdr: idr("subtotal_idr").notNull(),
    goodsDiscountIdr: idr("goods_discount_idr").notNull().default(0),
    shippingDiscountIdr: idr("shipping_discount_idr").notNull().default(0),
    /** Platform-funded shipping discount (T-48 fix): paid from the platform margin, frozen with the order, never charged to the seller. Immutable with the rest of the snapshot. */
    platformShippingDiscountIdr: idr("platform_shipping_discount_idr").notNull().default(0),
    includedSalesTaxIdr: idr("included_sales_tax_idr").notNull().default(0),
    addedSalesTaxIdr: idr("added_sales_tax_idr").notNull().default(0),
    goodsProceedsIdr: idr("goods_proceeds_idr").notNull(),
    shippingChargedIdr: idr("shipping_charged_idr").notNull(),
    shippingCashbackGrossIdr: idr("shipping_cashback_gross_idr").notNull().default(0),
    platformCashbackIdr: idr("platform_cashback_idr").notNull().default(0),
    sellerCashbackIdr: idr("seller_cashback_idr").notNull().default(0),
    /** T-52 (BILL-8): the attributed affiliate, written with the commission. NULL exactly when no commission was earned. */
    affiliateId: bigint("affiliate_id", { mode: "number" }),
    affiliateCommissionIdr: idr("affiliate_commission_idr").notNull().default(0),
    codFeeIdr: idr("cod_fee_idr").notNull().default(0),
    codFeeVatIdr: idr("cod_fee_vat_idr").notNull().default(0),
    codFeeVatRateBps: integer("cod_fee_vat_rate_bps"),
    codFeeVatPolicyVersionId: bigint("cod_fee_vat_policy_version_id", { mode: "number" }),
    payableIdr: idr("payable_idr").notNull(),
    saleAmountIdr: idr("sale_amount_idr").notNull(),
    expectedGatewayFeeIdr: idr("expected_gateway_fee_idr").notNull().default(0),
    createdAt: at(),
  },
  (t) => [
    unique("order_financials_store_order_uq").on(t.storeId, t.orderId),
    foreignKey({ name: "order_financials_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }),
    foreignKey({ name: "order_financials_affiliate_fk", columns: [t.affiliateId], foreignColumns: [affiliate.id] }),
    check("order_financials_affiliate_chk", sql`${t.affiliateCommissionIdr} = 0 or ${t.affiliateId} is not null`),
    foreignKey({ name: "order_financials_account_fk", columns: [t.storeId, t.shippingAccountId, t.shippingAccountKind], foreignColumns: [storeShippingAccount.storeId, storeShippingAccount.id, storeShippingAccount.kind] }),
    check(
      "order_financials_amounts_chk",
      sql`${t.subtotalIdr} >= 0 and ${t.goodsDiscountIdr} >= 0 and ${t.shippingDiscountIdr} >= 0 and ${t.platformShippingDiscountIdr} >= 0 and ${t.includedSalesTaxIdr} >= 0 and ${t.addedSalesTaxIdr} >= 0 and ${t.goodsProceedsIdr} >= 0 and ${t.shippingChargedIdr} >= 0 and ${t.shippingCashbackGrossIdr} >= 0 and ${t.platformCashbackIdr} >= 0 and ${t.sellerCashbackIdr} >= 0 and ${t.affiliateCommissionIdr} >= 0 and ${t.codFeeIdr} >= 0 and ${t.codFeeVatIdr} >= 0 and ${t.payableIdr} >= 0 and ${t.saleAmountIdr} >= 0 and ${t.expectedGatewayFeeIdr} >= 0`,
    ),
    check("order_financials_cashback_chk", sql`${t.shippingCashbackGrossIdr} = ${t.platformCashbackIdr} + ${t.sellerCashbackIdr}`),
    // BILL-4 allocation identity, both statements, to the rupiah.
    check("order_financials_payable_chk", sql`${t.payableIdr} = ${t.goodsProceedsIdr} + ${t.includedSalesTaxIdr} + ${t.addedSalesTaxIdr} + ${t.shippingChargedIdr} + ${t.codFeeIdr} + ${t.codFeeVatIdr}`),
    check("order_financials_sale_chk", sql`${t.saleAmountIdr} = ${t.goodsProceedsIdr} + ${t.includedSalesTaxIdr} + ${t.addedSalesTaxIdr} - ${t.affiliateCommissionIdr}`),
    check("order_financials_distribution_chk", sql`${t.payableIdr} = ${t.saleAmountIdr} + ${t.affiliateCommissionIdr} + ${t.shippingChargedIdr} + ${t.codFeeIdr} + ${t.codFeeVatIdr}`),
    check("order_financials_vat_chk", sql`${t.codFeeVatPolicyVersionId} is not null or (${t.codFeeVatIdr} = 0 and ${t.codFeeVatRateBps} is null)`),
  ],
);

/** One row per order line from the single BILL-4 allocation; written once with the order. */
export const orderLineFinancials = pgTable(
  "order_line_financials",
  {
    orderId: bigint("order_id", { mode: "number" }).notNull(),
    lineNo: integer("line_no").notNull(),
    storeId: storeCol(),
    variantId: bigint("variant_id", { mode: "number" }).notNull(),
    lineGrossIdr: idr("line_gross_idr").notNull(),
    discountAllocIdr: idr("discount_alloc_idr").notNull(),
    shippingDiscountIdr: idr("shipping_discount_idr").notNull().default(0),
    netGoodsIdr: idr("net_goods_idr").notNull(),
    includedTaxIdr: idr("included_tax_idr").notNull(),
    addedTaxIdr: idr("added_tax_idr").notNull(),
    commissionBaseIdr: idr("commission_base_idr").notNull(),
    commissionRateBps: integer("commission_rate_bps"),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.lineNo] }),
    foreignKey({ name: "order_line_financials_fin_fk", columns: [t.storeId, t.orderId], foreignColumns: [orderFinancials.storeId, orderFinancials.orderId] }),
    foreignKey({ name: "order_line_financials_line_fk", columns: [t.orderId, t.variantId], foreignColumns: [orderLine.orderId, orderLine.variantId] }),
    check("order_line_financials_chk", sql`${t.lineNo} >= 1 and ${t.discountAllocIdr} >= 0 and ${t.discountAllocIdr} <= ${t.lineGrossIdr} and ${t.netGoodsIdr} = ${t.lineGrossIdr} - ${t.discountAllocIdr} and ${t.includedTaxIdr} >= 0 and ${t.includedTaxIdr} <= ${t.netGoodsIdr} and ${t.addedTaxIdr} >= 0 and ${t.commissionBaseIdr} = ${t.netGoodsIdr} - ${t.includedTaxIdr}`),
    check("order_line_shipping_discount_chk", sql`${t.shippingDiscountIdr} >= 0`),
    check("order_line_commission_rate_chk", sql`${t.commissionRateBps} is null or ${t.commissionRateBps} between 0 and 10000`),
  ],
);

export const courierServicePolicy = pgTable(
  "courier_service_policy",
  {
    id: ident(),
    courierCode: text("courier_code").notNull(),
    serviceCode: text("service_code").notNull().default(""),
    codAllowed: boolean("cod_allowed").notNull().default(false),
    returnFree: boolean("return_free").notNull().default(false),
    /** The free-return belief is UNVERIFIED (OPEN-F7) until the terms are recorded here. */
    returnFreeEvidenceRef: text("return_free_evidence_ref"),
    status: text("status").notNull().default("active"),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("courier_service_policy_uq").on(t.courierCode, t.serviceCode), check("courier_service_policy_status_chk", sql`${t.status} in ('active', 'disabled')`)],
);

export const reconciliationBatch = pgTable(
  "reconciliation_batch",
  {
    id: ident(),
    shippingAccountId: bigint("shipping_account_id", { mode: "number" }).references(() => storeShippingAccount.id),
    status: text("status", { enum: BATCH_STATUSES }).notNull().default("draft"),
    source: text("source", { enum: ["owner_batch", "provider"] }).notNull().default("owner_batch"),
    /** Opaque reference to the carrier invoice or statement the evidence lines come from. */
    evidenceRef: text("evidence_ref").notNull(),
    evidenceTotalIdr: idr("evidence_total_idr").notNull().default(0),
    itemCount: integer("item_count").notNull().default(0),
    payloadSha256: text("payload_sha256"),
    preparedByUserId: text("prepared_by_user_id"),
    approvalRequestId: bigint("approval_request_id", { mode: "number" }),
    approvedByUserId: text("approved_by_user_id"),
    appliedAt: tsz("applied_at"),
    voidReason: text("void_reason"),
    createdAt: at(),
  },
  (t) => [
    index("reconciliation_batch_status_idx").on(t.status, t.id),
    uniqueIndex("reconciliation_batch_approval_uq").on(t.approvalRequestId).where(sql`${t.approvalRequestId} is not null`),
    check("reconciliation_batch_status_chk", sql`${t.status} in ('draft', 'pending_approval', 'applied', 'void') and ${t.source} in ('owner_batch', 'provider')`),
    check("reconciliation_batch_amounts_chk", sql`${t.evidenceTotalIdr} >= 0 and ${t.itemCount} >= 0 and length(btrim(${t.evidenceRef})) > 0`),
    // An applied batch carries the approval, applied time, the approver, and the approver is never the preparer.
    check("reconciliation_batch_applied_chk", sql`${t.status} <> 'applied' or (${t.approvalRequestId} is not null and ${t.appliedAt} is not null and ${t.payloadSha256} is not null and ${t.itemCount} > 0 and (${t.source} = 'provider' or (${t.approvedByUserId} is not null and ${t.preparedByUserId} is not null and ${t.approvedByUserId} <> ${t.preparedByUserId})))`),
    check("reconciliation_batch_provider_chk", sql`${t.source} <> 'provider' or ${t.preparedByUserId} is null`),
    check("reconciliation_batch_owner_chk", sql`${t.source} <> 'owner_batch' or ${t.preparedByUserId} is not null`),
    check("reconciliation_batch_void_chk", sql`(${t.status} = 'void') = (${t.voidReason} is not null)`),
  ],
);

export const reconciliationBatchItem = pgTable(
  "reconciliation_batch_item",
  {
    id: ident(),
    batchId: bigint("batch_id", { mode: "number" }).notNull().references(() => reconciliationBatch.id),
    orderId: bigint("order_id", { mode: "number" }).notNull(),
    storeId: storeCol(),
    /** The order `payable_idr`: what the courier collected in cash. */
    codAmountIdr: idr("cod_amount_idr").notNull(),
    evidenceLineRef: text("evidence_line_ref").notNull(),
    evidenceAmountIdr: idr("evidence_amount_idr").notNull(),
    evidenceDate: date("evidence_date", { mode: "string" }).notNull(),
    reconciledAt: tsz("reconciled_at"),
    reconciliationSource: text("reconciliation_source", { enum: ["owner_batch", "provider"] }).notNull().default("owner_batch"),
    voidedAt: tsz("voided_at"),
  },
  (t) => [
    unique("reconciliation_item_batch_order_uq").on(t.batchId, t.orderId),
    unique("reconciliation_item_id_store_uq").on(t.id, t.storeId),
    uniqueIndex("reconciliation_item_order_live_uq").on(t.orderId).where(sql`${t.voidedAt} is null`),
    foreignKey({ name: "reconciliation_item_fin_fk", columns: [t.storeId, t.orderId], foreignColumns: [orderFinancials.storeId, orderFinancials.orderId] }),
    check("reconciliation_item_amounts_chk", sql`${t.codAmountIdr} > 0 and ${t.evidenceAmountIdr} >= 0 and length(btrim(${t.evidenceLineRef})) > 0`),
    check("reconciliation_item_source_chk", sql`${t.reconciliationSource} in ('owner_batch', 'provider')`),
  ],
);

export const payoutDestination = pgTable(
  "payout_destination",
  {
    id: ident(),
    storeId: storeCol(),
    bankCode: text("bank_code").notNull(),
    /** Bank account number: personal data of class `bank`; operators read it only through `withPersonalDataAccess`. */
    accountNumber: text("account_number").notNull(),
    accountHolderName: text("account_holder_name").notNull(),
    holderNameCheck: text("holder_name_check", { enum: ["match", "mismatch", "unchecked"] }).notNull(),
    status: text("status", { enum: ["held", "active", "superseded"] }).notNull().default("held"),
    holdUntil: tsz("hold_until"),
    createdByUserId: text("created_by_user_id").notNull(),
    /** Opaque reference to the single-use step-up proof that authorised the change. */
    stepUpRef: uuid("step_up_ref").notNull(),
    previousContactNotifiedAt: tsz("previous_contact_notified_at"),
    createdAt: at(),
    supersededAt: tsz("superseded_at"),
  },
  (t) => [
    unique("payout_destination_store_id_uq").on(t.storeId, t.id),
    uniqueIndex("payout_destination_one_active_uq").on(t.storeId).where(sql`${t.status} = 'active'`),
    uniqueIndex("payout_destination_one_held_uq").on(t.storeId).where(sql`${t.status} = 'held'`),
    check("payout_destination_chk", sql`${t.status} in ('held', 'active', 'superseded') and ${t.holderNameCheck} in ('match', 'mismatch', 'unchecked') and (${t.status} <> 'held' or ${t.holdUntil} is not null) and (${t.status} <> 'superseded') = (${t.supersededAt} is null)`),
    check("payout_destination_fields_chk", sql`length(btrim(${t.bankCode})) > 0 and ${t.accountNumber} ~ '^[0-9]{5,24}$' and length(btrim(${t.accountHolderName})) > 0`),
  ],
);

export const payout = pgTable(
  "payout",
  {
    id: ident(),
    storeId: storeCol(),
    requestedByUserId: text("requested_by_user_id").notNull(),
    requestKey: text("request_key").notNull(),
    /** The single-use step-up proof consumed by the request (the guard checks it is consumed, bound to this store and user). */
    stepUpRef: uuid("step_up_ref").notNull(),
    amountIdr: idr("amount_idr").notNull(),
    status: text("status", { enum: PAYOUT_STATUSES }).notNull().default("requested"),
    destinationId: bigint("destination_id", { mode: "number" }).notNull(),
    // Immutable snapshot of the destination at request time (the approver sees it, the payload hash covers it).
    bankCode: text("bank_code").notNull(),
    bankAccountNumber: text("bank_account_number").notNull(),
    bankAccountHolder: text("bank_account_holder").notNull(),
    holderNameCheck: text("holder_name_check", { enum: ["match", "mismatch", "unchecked"] }).notNull(),
    approvalRequestId: bigint("approval_request_id", { mode: "number" }),
    /** The four-eyes approval (`payout.reject_processing`) of a rejection from `processing`: written once, checked by the guard against this payout (T-37 finish). */
    rejectApprovalRequestId: bigint("reject_approval_request_id", { mode: "number" }),
    approvedAt: tsz("approved_at"),
    claimedByUserId: text("claimed_by_user_id"),
    claimExpiresAt: tsz("claim_expires_at"),
    /** Set when an operator reports the transfer outcome could not be told; the payout then stays allocated until finance proves the effect. */
    transferUnknownAt: tsz("transfer_unknown_at"),
    transferEvidenceRef: text("transfer_evidence_ref"),
    evidenceArtifactId: bigint("evidence_artifact_id", { mode: "number" }),
    noTransferEvidenceRef: text("no_transfer_evidence_ref"),
    processedByUserId: text("processed_by_user_id"),
    rejectionReason: text("rejection_reason"),
    createdAt: at(),
    processedAt: tsz("processed_at"),
  },
  (t) => [
    unique("payout_store_id_uq").on(t.storeId, t.id),
    unique("payout_request_key_uq").on(t.storeId, t.requestKey),
    foreignKey({ name: "payout_destination_fk", columns: [t.storeId, t.destinationId], foreignColumns: [payoutDestination.storeId, payoutDestination.id] }),
    index("payout_status_idx").on(t.status, t.id),
    uniqueIndex("payout_reject_approval_uq").on(t.rejectApprovalRequestId).where(sql`${t.rejectApprovalRequestId} is not null`),
    check("payout_amount_chk", sql`${t.amountIdr} > 0 and ${t.amountIdr} <= 9007199254740991`),
    check("payout_status_chk", sql`${t.status} in ('requested', 'processing', 'paid', 'rejected')`),
    // Four-eyes sits on approve-for-transfer: processing and paid both need the approved request; paid also the evidence.
    check("payout_approval_chk", sql`${t.status} not in ('processing', 'paid') or (${t.approvalRequestId} is not null and ${t.approvedAt} is not null)`),
    check("payout_paid_chk", sql`${t.status} <> 'paid' or (${t.transferEvidenceRef} is not null and ${t.evidenceArtifactId} is not null and ${t.processedByUserId} is not null and ${t.processedAt} is not null and ${t.transferUnknownAt} is null)`),
    check("payout_rejected_chk", sql`${t.status} <> 'rejected' or (${t.rejectionReason} is not null and ${t.processedAt} is not null and (${t.approvalRequestId} is null or ${t.noTransferEvidenceRef} is not null))`),
    check("payout_claim_chk", sql`(${t.claimedByUserId} is null) = (${t.claimExpiresAt} is null)`),
    check("payout_unknown_chk", sql`${t.transferUnknownAt} is null or ${t.status} = 'processing'`),
    uniqueIndex("payout_evidence_artifact_uq").on(t.evidenceArtifactId).where(sql`${t.evidenceArtifactId} is not null`),
    uniqueIndex("payout_approval_uq").on(t.approvalRequestId).where(sql`${t.approvalRequestId} is not null`),
    uniqueIndex("payout_step_up_uq").on(t.stepUpRef),
  ],
);

/** The books. Append-only: only a controlled pending -> available release may update a row (trigger). */
export const ledgerEntry = pgTable(
  "ledger_entry",
  {
    id: ident(),
    storeId: storeCol(),
    orderId: bigint("order_id", { mode: "number" }),
    payoutId: bigint("payout_id", { mode: "number" }),
    kind: text("kind", { enum: LEDGER_KINDS }).notNull(),
    status: text("status", { enum: ["pending", "available"] }).notNull(),
    amountIdr: idr("amount_idr").notNull(),
    businessRef: text("business_ref"),
    approvalRequestId: bigint("approval_request_id", { mode: "number" }),
    note: text("note"),
    createdAt: at(),
    releasedAt: tsz("released_at"),
    releaseBasis: text("release_basis", { enum: RELEASE_BASES }),
    reconciliationItemId: bigint("reconciliation_item_id", { mode: "number" }),
  },
  (t) => [
    unique("ledger_entry_store_id_uq").on(t.storeId, t.id),
    foreignKey({ name: "ledger_entry_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [orderFinancials.storeId, orderFinancials.orderId] }),
    foreignKey({ name: "ledger_entry_payout_fk", columns: [t.storeId, t.payoutId], foreignColumns: [payout.storeId, payout.id] }),
    foreignKey({ name: "ledger_entry_item_fk", columns: [t.reconciliationItemId, t.storeId], foreignColumns: [reconciliationBatchItem.id, reconciliationBatchItem.storeId] }),
    uniqueIndex("ledger_one_sale_per_order").on(t.storeId, t.orderId).where(sql`${t.kind} = 'sale'`),
    uniqueIndex("ledger_one_cashback_per_order").on(t.storeId, t.orderId).where(sql`${t.kind} = 'cashback'`),
    uniqueIndex("ledger_one_return_per_order").on(t.storeId, t.orderId).where(sql`${t.kind} = 'return_reversal'`),
    uniqueIndex("ledger_one_shipping_debit_per_order").on(t.storeId, t.orderId).where(sql`${t.kind} = 'shipping_debit'`),
    uniqueIndex("ledger_one_shipping_reversal_per_order").on(t.storeId, t.orderId).where(sql`${t.kind} = 'shipping_debit_reversal'`),
    uniqueIndex("ledger_one_payout_per_payout").on(t.storeId, t.payoutId).where(sql`${t.kind} = 'payout'`),
    uniqueIndex("ledger_one_payout_reversal_per_payout").on(t.storeId, t.payoutId).where(sql`${t.kind} = 'payout_reversal'`),
    uniqueIndex("ledger_adjustment_business_ref").on(t.storeId, t.businessRef).where(sql`${t.kind} = 'adjustment'`),
    index("ledger_balance_idx").on(t.storeId, t.status, t.amountIdr),
    index("ledger_store_created_idx").on(t.storeId, t.createdAt, t.id),
    index("ledger_release_idx").on(t.storeId).where(sql`${t.kind} in ('sale', 'cashback') and ${t.status} = 'pending'`),
    check("ledger_kind_chk", sql`${t.kind} in ('sale', 'cashback', 'shipping_debit', 'shipping_debit_reversal', 'return_reversal', 'payout', 'payout_reversal', 'adjustment') and ${t.status} in ('pending', 'available')`),
    check(
      "ledger_sign_chk",
      sql`(${t.kind} in ('sale', 'cashback', 'shipping_debit_reversal', 'payout_reversal') and ${t.amountIdr} > 0) or (${t.kind} in ('shipping_debit', 'return_reversal', 'payout') and ${t.amountIdr} < 0) or (${t.kind} = 'adjustment' and ${t.amountIdr} <> 0)`,
    ),
    check("ledger_refs_chk", sql`(${t.kind} in ('payout', 'payout_reversal')) = (${t.payoutId} is not null) and (${t.kind} in ('sale', 'cashback', 'shipping_debit', 'shipping_debit_reversal', 'return_reversal')) = (${t.orderId} is not null) and (${t.kind} <> 'adjustment' or (${t.businessRef} is not null and ${t.approvalRequestId} is not null and ${t.orderId} is null and ${t.payoutId} is null))`),
    // The money states: pending carries nothing; available always carries when and why; only sale and cashback use delivery or reconciliation.
    check("ledger_release_chk", sql`(${t.status} = 'pending' and ${t.releasedAt} is null and ${t.releaseBasis} is null and ${t.reconciliationItemId} is null) or (${t.status} = 'available' and ${t.releasedAt} is not null and ${t.releaseBasis} is not null)`),
    check("ledger_basis_chk", sql`${t.releaseBasis} is null or ${t.releaseBasis} in ('delivery', 'reconciliation', 'netting', 'direct')`),
    check("ledger_basis_kind_chk", sql`${t.releaseBasis} is null or (${t.releaseBasis} in ('delivery', 'reconciliation') and ${t.kind} in ('sale', 'cashback', 'shipping_debit', 'shipping_debit_reversal')) or (${t.releaseBasis} = 'netting' and ${t.kind} in ('shipping_debit', 'shipping_debit_reversal')) or (${t.releaseBasis} = 'direct' and ${t.kind} not in ('sale', 'cashback'))`),
    check("ledger_item_chk", sql`(${t.releaseBasis} = 'reconciliation') = (${t.reconciliationItemId} is not null)`),
    // A return reversal and a payout movement are never pending; a debit may be pending only against a pending sale or a COD sale to come.
    check("ledger_pending_kind_chk", sql`${t.status} = 'available' or ${t.kind} in ('sale', 'cashback', 'shipping_debit', 'shipping_debit_reversal', 'return_reversal')`),
    check("ledger_note_chk", sql`${t.note} is null or length(${t.note}) <= 500`),
  ],
);

export const shipmentCost = pgTable(
  "shipment_cost",
  {
    orderId: bigint("order_id", { mode: "number" }).primaryKey(),
    storeId: storeCol(),
    shippingAccountId: bigint("shipping_account_id", { mode: "number" }).notNull().default(0),
    shippingAccountKind: text("shipping_account_kind", { enum: ["partner_managed", "platform_master"] }).notNull().default("platform_master"),
    shippingDiscountIdr: idr("shipping_discount_idr").notNull().default(0),
    platformShippingDiscountIdr: idr("platform_shipping_discount_idr").notNull().default(0),
    bookedShippingIdr: idr("booked_shipping_idr").notNull(),
    shippingChargedIdr: idr("shipping_charged_idr").notNull(),
    sellerShippingDebitIdr: idr("seller_shipping_debit_idr").notNull(),
    platformShippingMarginIdr: idr("platform_shipping_margin_idr").notNull(),
    providerCodFeeIdr: idr("provider_cod_fee_idr").notNull().default(0),
    codAmountSentIdr: idr("cod_amount_sent_idr"),
    shippingDebitEntryId: bigint("shipping_debit_entry_id", { mode: "number" }),
    createdAt: at(),
  },
  (t) => [
    foreignKey({ name: "shipment_cost_fin_fk", columns: [t.storeId, t.orderId], foreignColumns: [orderFinancials.storeId, orderFinancials.orderId] }),
    foreignKey({ name: "shipment_cost_entry_fk", columns: [t.storeId, t.shippingDebitEntryId], foreignColumns: [ledgerEntry.storeId, ledgerEntry.id] }),
    foreignKey({ name: "shipment_cost_account_fk", columns: [t.storeId, t.shippingAccountId, t.shippingAccountKind], foreignColumns: [storeShippingAccount.storeId, storeShippingAccount.id, storeShippingAccount.kind] }),
    check("shipment_cost_amounts_chk", sql`${t.bookedShippingIdr} >= 0 and ${t.shippingChargedIdr} >= 0 and ${t.platformShippingDiscountIdr} >= 0 and ${t.sellerShippingDebitIdr} >= 0 and ${t.platformShippingMarginIdr} >= 0 and ${t.providerCodFeeIdr} >= 0 and (${t.codAmountSentIdr} is null or ${t.codAmountSentIdr} > 0)`),
    // Money collected (buyer's charge plus the platform-funded discount) plus the seller's debit pay the courier and leave the gross margin. The platform discount is never a seller debit.
    check("shipment_cost_identity_chk", sql`${t.shippingChargedIdr} + ${t.platformShippingDiscountIdr} + ${t.sellerShippingDebitIdr} = ${t.bookedShippingIdr} + ${t.platformShippingMarginIdr}`),
    check("shipment_cost_discount_chk", sql`${t.shippingDiscountIdr} >= 0 and ${t.sellerShippingDebitIdr} >= ${t.shippingDiscountIdr} and (${t.sellerShippingDebitIdr} = ${t.shippingDiscountIdr} or ${t.platformShippingMarginIdr} = 0)`),
  ],
);

export const refund = pgTable(
  "refund",
  {
    id: ident(),
    storeId: storeCol(),
    orderId: bigint("order_id", { mode: "number" }).notNull(),
    paymentAttemptId: uuid("payment_attempt_id").notNull(),
    goodsRefundIdr: idr("goods_refund_idr").notNull(),
    shippingRefundIdr: idr("shipping_refund_idr").notNull(),
    feeRefundIdr: idr("fee_refund_idr").notNull(),
    amountIdr: idr("amount_idr").notNull(),
    status: text("status", { enum: REFUND_STATUSES }).notNull().default("pending"),
    /** `order_cancelled`, `order_returned` or `late_payment` (a payment verified after the order was terminal). */
    reason: text("reason").notNull(),
    // The destination the buyer supplies on the signed order-status page (D-20, closes OPEN-F4); a typed phone or e-mail never authorises a refund.
    destinationBank: text("destination_bank"),
    destinationAccount: text("destination_account"),
    destinationHolder: text("destination_holder"),
    destinationSubmittedAt: tsz("destination_submitted_at"),
    approvalRequestId: bigint("approval_request_id", { mode: "number" }),
    /** The four-eyes approval (`refund.fail`) of a failure: the buyer's money stays owed, so no single operator can fail a refund (T-37 finish). */
    failApprovalRequestId: bigint("fail_approval_request_id", { mode: "number" }),
    approvedAt: tsz("approved_at"),
    claimedByUserId: text("claimed_by_user_id"),
    claimExpiresAt: tsz("claim_expires_at"),
    transferUnknownAt: tsz("transfer_unknown_at"),
    transferEvidenceRef: text("transfer_evidence_ref"),
    evidenceArtifactId: bigint("evidence_artifact_id", { mode: "number" }),
    noTransferEvidenceRef: text("no_transfer_evidence_ref"),
    processedByUserId: text("processed_by_user_id"),
    failureReason: text("failure_reason"),
    createdAt: at(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("refund_store_id_uq").on(t.storeId, t.id),
    foreignKey({ name: "refund_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }),
    foreignKey({ name: "refund_attempt_fk", columns: [t.storeId, t.paymentAttemptId], foreignColumns: [paymentAttempt.storeId, paymentAttempt.id] }),
    uniqueIndex("refund_one_open_per_payment").on(t.paymentAttemptId).where(sql`${t.status} in ('pending', 'processing')`),
    uniqueIndex("refund_one_per_order").on(t.storeId, t.orderId).where(sql`${t.status} <> 'failed'`),
    uniqueIndex("refund_evidence_artifact_uq").on(t.evidenceArtifactId).where(sql`${t.evidenceArtifactId} is not null`),
    uniqueIndex("refund_approval_uq").on(t.approvalRequestId).where(sql`${t.approvalRequestId} is not null`),
    index("refund_status_idx").on(t.status, t.id),
    uniqueIndex("refund_fail_approval_uq").on(t.failApprovalRequestId).where(sql`${t.failApprovalRequestId} is not null`),
    check("refund_composition_chk", sql`${t.goodsRefundIdr} >= 0 and ${t.shippingRefundIdr} >= 0 and ${t.feeRefundIdr} >= 0 and ${t.amountIdr} = ${t.goodsRefundIdr} + ${t.shippingRefundIdr} + ${t.feeRefundIdr} and ${t.amountIdr} > 0`),
    check("refund_status_chk", sql`${t.status} in ('pending', 'processing', 'completed', 'failed') and ${t.reason} in ('order_cancelled', 'order_returned', 'late_payment')`),
    check("refund_approval_chk", sql`${t.status} not in ('processing', 'completed') or (${t.approvalRequestId} is not null and ${t.approvedAt} is not null)`),
    check("refund_completed_chk", sql`${t.status} <> 'completed' or (${t.transferEvidenceRef} is not null and ${t.evidenceArtifactId} is not null and ${t.processedByUserId} is not null and ${t.transferUnknownAt} is null and ${t.destinationAccount} is not null)`),
    check("refund_failed_chk", sql`${t.status} <> 'failed' or ${t.failureReason} is not null`),
    check("refund_claim_chk", sql`(${t.claimedByUserId} is null) = (${t.claimExpiresAt} is null)`),
    check("refund_unknown_chk", sql`${t.transferUnknownAt} is null or ${t.status} = 'processing'`),
    // The destination is all or nothing, and an approver can only approve a refund that has one.
    check("refund_destination_chk", sql`((${t.destinationBank} is null) = (${t.destinationAccount} is null)) and ((${t.destinationBank} is null) = (${t.destinationHolder} is null)) and ((${t.destinationBank} is null) = (${t.destinationSubmittedAt} is null)) and (${t.status} = 'pending' or ${t.status} = 'failed' or ${t.destinationAccount} is not null)`),
  ],
);

/** Single-use proof of a fresh second factor of a SELLER session, bound to action and subject; issued only by `issue_store_step_up`. */
export const storeStepUpProof = pgTable(
  "store_step_up_proof",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeCol(),
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    actionKey: text("action_key").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    createdAt: at(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: tsz("consumed_at"),
  },
  (t) => [index("store_step_up_user_idx").on(t.storeId, t.userId, t.createdAt), check("store_step_up_chk", sql`${t.expiresAt} > ${t.createdAt}`)],
);

/** Receipt files of manual transfers: one row per distinct file (SHA-256 unique), claimed once by a payout or a refund. */
export const transferEvidenceArtifact = pgTable(
  "transfer_evidence_artifact",
  {
    id: ident(),
    sha256: text("sha256").notNull().unique(),
    kind: text("kind", { enum: ["png", "jpeg", "webp", "pdf"] }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    content: text("content_base64").notNull(),
    uploadedByUserId: text("uploaded_by_user_id").notNull(),
    claimedBy: text("claimed_by"),
    createdAt: at(),
  },
  (t) => [check("transfer_evidence_artifact_chk", sql`${t.sizeBytes} between 1 and 10485760 and ${t.sha256} ~ '^[0-9a-f]{64}$'`)],
);

/** Every transfer reference ever recorded, compared after normalisation; the trigger computes `norm_ref`, so no caller can bypass it. */
export const transferEvidenceRegistry = pgTable(
  "transfer_evidence_registry",
  {
    id: ident(),
    refRaw: text("ref_raw").notNull(),
    normRef: text("norm_ref").notNull(),
    subjectKind: text("subject_kind", { enum: ["payout", "refund"] }).notNull(),
    subjectId: bigint("subject_id", { mode: "number" }).notNull(),
    createdAt: at(),
  },
  (t) => [uniqueIndex("transfer_evidence_norm_uq").on(t.normRef)],
);

/**
 * Singleton: the post-restore payout freeze (RUNBOOK 14, DR-1). While `frozen`, the database refuses a new payout request, every payout/refund status or claim change
 * and the application of a COD reconciliation batch (triggers in migration 0014); a buyer's refund destination and an operator's "outcome unknown" note stay possible.
 * Flipped by the Owner console under `payouts.process` with a reason (audited). The app login may read it so the seller screen can say why a request is refused.
 */
export const payoutControl = pgTable(
  "payout_control",
  {
    id: integer("id").primaryKey().default(1),
    frozen: boolean("frozen").notNull().default(false),
    reason: text("reason"),
    changedBy: text("changed_by"),
    /** D-19: a new or changed payout destination is held this many hours before a payout may use it (the database enforces it at insert and activation). */
    destinationHoldHours: integer("destination_hold_hours").notNull().default(72),
    changedAt: at("changed_at"),
  },
  (t) => [check("payout_control_singleton_chk", sql`${t.id} = 1`), check("payout_control_hold_chk", sql`${t.destinationHoldHours} between 1 and 720`)],
);
