import { and, desc, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../client.ts";
import { dbMailer } from "../platform/accounts.ts";
import { pgCode, requirePlatformCap } from "../ops/capabilities.ts";
import { withPersonalDataAccess } from "../ops/console-access.ts";
import { auditLog, ledgerEntry, payout, payoutDestination, refund, user } from "../schema.ts";
import { DomainError, requireCap, type OperatorScope, type SellerScope } from "../platform/scoped.ts";
import { inStore, withStore } from "../platform/tenant.ts";
import { assertPayoutsNotFrozen, frozenOr, payoutFreeze, payoutHoldHours } from "./control.ts";
import { ledgerBalance, lockStore } from "./ledger.ts";
import { CONSOLE_QUEUE_LIMIT, MIN_PAYOUT_IDR, STATEMENT_PAGE } from "./settings.ts";
import { consumeSellerStepUp } from "./stepup.ts";
import type { TransferKind } from "./transfer.ts";

// Seller payouts (ADR-0006 decision 5, BILL-5, UX-14, D-19). The store OWNER (capability `finance.payout`) requests a payout above `MIN_PAYOUT_IDR` to an
// ACTIVE destination whose 72-hour hold elapsed, after a step-up. The request takes the per-store lock, re-checks `available >= amount`, snapshots the
// destination onto the payout row and inserts the negative `payout` ledger entry in ONE transaction, guarded by the unique request key (a replay returns the
// first payout and debits nothing). Operators decide the payout in `transfer.ts` (four-eyes on approve-for-transfer).

const bankInput = z.strictObject({
  bankCode: z.string().trim().min(2, "Pilih bank.").max(20).regex(/^[A-Za-z0-9_-]+$/, "Kode bank tidak valid."),
  accountNumber: z.string().trim().regex(/^[0-9]{5,24}$/, "Nomor rekening harus 5 sampai 24 angka."),
  accountHolderName: z.string().trim().min(2, "Nama pemilik rekening wajib diisi.").max(120),
});

/** Names compare after lower-casing and dropping everything but letters and digits (spaces, titles' punctuation). */
export const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export const holderNameCheck = (holder: string, registered: string): "match" | "mismatch" => (nameKey(holder) === nameKey(registered) && nameKey(holder).length > 0 ? "match" : "mismatch");
export const maskAccount = (n: string | null) => (n ? `••••${n.slice(-4)}` : "—");

/**
 * Create or change the payout destination: step-up consumed in this transaction, the previous destination notified, a new destination HELD for
 * `PAYOUT_DESTINATION_HOLD_HOURS` (a newer held one supersedes the older held one; the active one keeps serving until the new one activates), and the
 * account-holder name checked against the store owner's registered name.
 */
export async function setPayoutDestination(scope: SellerScope, input: { proofId: string; bankCode: string; accountNumber: string; accountHolderName: string }): Promise<{ destinationId: number; holdUntil: string }> {
  requireCap(scope, "finance.payout");
  const bank = bankInput.parse({ bankCode: input.bankCode, accountNumber: input.accountNumber, accountHolderName: input.accountHolderName });
  const out = await withStore(scope.exec, scope.storeId, async (tx) => {
    await lockStore(tx, scope.storeId);
    await consumeSellerStepUp(tx, scope, input.proofId, { action: "payout.destination", subjectId: String(scope.storeId) });
    const holdHours = await payoutHoldHours(tx);
    const [me] = await tx.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, scope.userId));
    const previous = await tx.select({ id: payoutDestination.id, by: payoutDestination.createdByUserId, status: payoutDestination.status }).from(payoutDestination).where(and(eq(payoutDestination.storeId, scope.storeId), sql`${payoutDestination.status} in ('held', 'active')`));
    await tx.update(payoutDestination).set({ status: "superseded", supersededAt: sql`now()` as unknown as Date }).where(and(eq(payoutDestination.storeId, scope.storeId), eq(payoutDestination.status, "held")));
    const prevUsers = [...new Set(previous.map((p) => p.by))];
    const [row] = await tx
      .insert(payoutDestination)
      .values({
        storeId: scope.storeId,
        bankCode: bank.bankCode.toUpperCase(),
        accountNumber: bank.accountNumber,
        accountHolderName: bank.accountHolderName,
        holderNameCheck: holderNameCheck(bank.accountHolderName, me?.name ?? ""),
        status: "held",
        holdUntil: sql`now() + make_interval(hours => ${holdHours})` as unknown as Date,
        createdByUserId: scope.userId,
        stepUpRef: input.proofId,
        previousContactNotifiedAt: previous.length > 0 ? (sql`now()` as unknown as Date) : null,
      })
      .returning({ id: payoutDestination.id, holdUntil: payoutDestination.holdUntil });
    // Every change is announced to the account that held the previous destination and to the acting account, without the account number.
    const recipients = new Set<string>(me?.email ? [me.email] : []);
    for (const id of prevUsers) {
      const [u] = await tx.select({ email: user.email }).from(user).where(eq(user.id, id));
      if (u) recipients.add(u.email);
    }
    for (const to of recipients) {
      await dbMailer(tx).send({
        to,
        subject: "Rekening penarikan dana toko Anda diubah",
        text: `Tujuan penarikan dana toko ${scope.storeName} diganti ke rekening ${bank.bankCode.toUpperCase()} ${maskAccount(bank.accountNumber)}. Rekening baru ditahan ${holdHours} jam sebelum bisa dipakai. Jika bukan Anda, segera amankan akun Anda.`,
      });
    }
    return { destinationId: row!.id, holdUntil: String(row!.holdUntil) };
  });
  return out;
}

/** Promote a held destination whose hold elapsed (the previous active one becomes superseded). Inside the payout lock. */
async function promoteHeldDestination(tx: Tx, storeId: number): Promise<void> {
  const [held] = await tx.select({ id: payoutDestination.id }).from(payoutDestination).where(and(eq(payoutDestination.storeId, storeId), eq(payoutDestination.status, "held"), sql`${payoutDestination.holdUntil} <= now()`));
  if (!held) return;
  await tx.update(payoutDestination).set({ status: "superseded", supersededAt: sql`now()` as unknown as Date }).where(and(eq(payoutDestination.storeId, storeId), eq(payoutDestination.status, "active")));
  await tx.update(payoutDestination).set({ status: "active" }).where(eq(payoutDestination.id, held.id));
}

export type PayoutRequestResult = { payoutId: number; replayed: boolean };
const requestInput = z.strictObject({ proofId: z.string().min(1), requestKey: z.string().trim().min(8).max(80), amountIdr: z.number().int().positive() });

/**
 * Request a payout. Replays (same key) return the first payout before anything else, so a double click or a retried request never debits twice. Everything
 * else happens under the per-store lock in one transaction: step-up consumed, destination promoted if its hold elapsed, minimum and balance checked
 * against the SUM of `available`, snapshot written, debit entry inserted. A failure anywhere rolls the whole request back (the proof stays unconsumed).
 */
export async function requestPayout(scope: SellerScope, raw: unknown): Promise<PayoutRequestResult> {
  requireCap(scope, "finance.payout");
  const input = requestInput.parse(raw);
  if (input.amountIdr < MIN_PAYOUT_IDR) throw new DomainError("below_minimum", `Penarikan minimal Rp${MIN_PAYOUT_IDR.toLocaleString("id-ID")}.`);
  try {
    return await withStore(scope.exec, scope.storeId, async (tx) => {
      await lockStore(tx, scope.storeId);
      const [first] = await tx.select({ id: payout.id }).from(payout).where(and(eq(payout.storeId, scope.storeId), eq(payout.requestKey, input.requestKey)));
      if (first) return { payoutId: first.id, replayed: true };
      await assertPayoutsNotFrozen(tx);
      await consumeSellerStepUp(tx, scope, input.proofId, { action: "payout.request", subjectId: input.requestKey });
      await promoteHeldDestination(tx, scope.storeId);
      const [dest] = await tx.select().from(payoutDestination).where(and(eq(payoutDestination.storeId, scope.storeId), eq(payoutDestination.status, "active")));
      if (!dest) throw new DomainError("no_active_destination", "Belum ada rekening tujuan yang aktif. Rekening baru ditahan 72 jam sebelum bisa dipakai.");
      const bal = await ledgerBalance(tx, scope.storeId);
      if (input.amountIdr > bal.availableIdr) throw new DomainError("insufficient_balance", "Jumlah melebihi Saldo Tersedia.");
      const [p] = await tx
        .insert(payout)
        .values({ storeId: scope.storeId, requestedByUserId: scope.userId, requestKey: input.requestKey, stepUpRef: input.proofId, amountIdr: input.amountIdr, destinationId: dest.id, bankCode: dest.bankCode, bankAccountNumber: dest.accountNumber, bankAccountHolder: dest.accountHolderName, holderNameCheck: dest.holderNameCheck })
        .returning({ id: payout.id });
      await tx.insert(ledgerEntry).values({ storeId: scope.storeId, payoutId: p!.id, kind: "payout", status: "available", amountIdr: -input.amountIdr, releasedAt: sql`now()` as unknown as Date, releaseBasis: "direct", note: "Permintaan penarikan dana" });
      await tx.insert(auditLog).values({ storeId: scope.storeId, actorUserId: scope.userId, action: "payout.request", subjectKind: "payout", subjectId: String(p!.id), outcome: "allowed" });
      return { payoutId: p!.id, replayed: false };
    });
  } catch (err) {
    // Two requests with one key racing: the loser hits the unique index after the winner committed; it returns the winner's payout.
    if (pgCode(err) === "23505") {
      const [won] = await inStore(scope, ({ exec }) => exec.select({ id: payout.id }).from(payout).where(and(eq(payout.storeId, scope.storeId), eq(payout.requestKey, input.requestKey))));
      if (won) return { payoutId: won.id, replayed: true };
    }
    throw frozenOr(err);
  }
}

// ── Seller reads (SC-25) ──────────────────────────────────────────────────────────────────────────────────────────

export type StatementPage = { rows: (typeof ledgerEntry.$inferSelect)[]; next: number | null };
/** The append-only statement, newest first, keyset-paged on the entry id. Reads `ledger_entry` alone: no join with `order`. */
export async function ledgerStatement(scope: SellerScope, opts: { cursor?: number; limit?: number } = {}): Promise<StatementPage> {
  requireCap(scope, "finance.read");
  const limit = Math.min(opts.limit ?? STATEMENT_PAGE, 100);
  return inStore(scope, async ({ exec }) => {
    const rows = await exec
      .select()
      .from(ledgerEntry)
      .where(and(eq(ledgerEntry.storeId, scope.storeId), opts.cursor ? lt(ledgerEntry.id, opts.cursor) : undefined))
      .orderBy(desc(ledgerEntry.id))
      .limit(limit + 1);
    return { rows: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1]!.id : null };
  });
}

/** Balances, destinations (number masked) and the latest payouts and refunds of the store, for the finance screen. */
export async function sellerFinance(scope: SellerScope) {
  requireCap(scope, "finance.read");
  return inStore(scope, async ({ exec }) => {
    const balance = await ledgerBalance(exec, scope.storeId);
    const dests = await exec
      .select({ id: payoutDestination.id, bankCode: payoutDestination.bankCode, last4: sql<string>`right(${payoutDestination.accountNumber}, 4)`, holder: payoutDestination.accountHolderName, check: payoutDestination.holderNameCheck, status: payoutDestination.status, holdUntil: payoutDestination.holdUntil, held: sql<boolean>`(${payoutDestination.status} = 'held' and ${payoutDestination.holdUntil} > now())` })
      .from(payoutDestination)
      .where(and(eq(payoutDestination.storeId, scope.storeId), sql`${payoutDestination.status} in ('held', 'active')`))
      .orderBy(desc(payoutDestination.id));
    const payouts = await exec
      .select({ id: payout.id, amountIdr: payout.amountIdr, status: payout.status, bankCode: payout.bankCode, last4: sql<string>`right(${payout.bankAccountNumber}, 4)`, createdAt: payout.createdAt, processedAt: payout.processedAt, rejectionReason: payout.rejectionReason })
      .from(payout)
      .where(eq(payout.storeId, scope.storeId))
      .orderBy(desc(payout.id))
      .limit(10);
    const refunds = await exec
      .select({ id: refund.id, orderId: refund.orderId, amountIdr: refund.amountIdr, goodsRefundIdr: refund.goodsRefundIdr, shippingRefundIdr: refund.shippingRefundIdr, feeRefundIdr: refund.feeRefundIdr, status: refund.status, reason: refund.reason, createdAt: refund.createdAt })
      .from(refund)
      .where(eq(refund.storeId, scope.storeId))
      .orderBy(desc(refund.id))
      .limit(10);
    // `Dana dalam proses`: payouts the seller requested that no operator has finished (their debit already left `available`). A payout-table sum, never a ledger join.
    const [inFlight] = await exec.select({ n: sql<string>`coalesce(sum(${payout.amountIdr}), 0)` }).from(payout).where(and(eq(payout.storeId, scope.storeId), sql`${payout.status} in ('requested', 'processing')`));
    const frozen = (await payoutFreeze(exec)).frozen;
    return { balance, processingIdr: Number(inFlight!.n), payoutsFrozen: frozen, destinations: dests, payouts, refunds, minPayoutIdr: MIN_PAYOUT_IDR, holdHours: await payoutHoldHours(exec) };
  });
}

// ── Owner console reads (SA-08): masked by default, recorded ─────────────────────────────────────────────────────

export type TransferListItem = { id: number; storeId: number; storeName: string; orderId: number | null; amountIdr: number; status: string; accountLast4: string | null; bank: string | null; holderCheck: string | null; createdAt: string; claimedBy: string | null; transferUnknownAt: string | null; approvalRequestId: number | null; hasDestination: boolean };

/**
 * The payout or refund queue (SA-08). Only the LAST FOUR digits of an account ever leave the database in a list; the list read is itself an access event of
 * level `masked`. Money classes of the whole platform float come from `platform_money_position` (`consoleMoneyPosition`).
 */
export async function transferQueue(op: OperatorScope, kind: TransferKind, statuses: readonly string[]): Promise<TransferListItem[]> {
  const cap = kind === "payout" ? "payouts.process" : "refunds.process";
  await requirePlatformCap(op, cap);
  return withPersonalDataAccess(op, { capability: cap, targetKind: kind, targetId: "queue", fieldClass: "bank", purposeCode: "payout_review", reason: "queue listing (last four digits only)", accessLevel: "masked" }, async (tx) => {
    const list = z.array(z.string()).parse([...statuses]);
    const statusList = sql.join(list.map((s) => sql`${s}`), sql`, `);
    const rows =
      kind === "payout"
        ? await tx.execute(sql`select p.id, p.store_id, s.name as store_name, null::bigint as order_id, p.amount_idr, p.status, right(p.bank_account_number, 4) as last4, p.bank_code as bank, p.holder_name_check as holder_check, p.created_at, p.claimed_by_user_id, p.transfer_unknown_at, p.approval_request_id, true as has_destination
            from payout p join store s on s.id = p.store_id where p.status in (${statusList}) order by p.id desc limit ${CONSOLE_QUEUE_LIMIT}`)
        : await tx.execute(sql`select r.id, r.store_id, s.name as store_name, r.order_id, r.amount_idr, r.status, right(r.destination_account, 4) as last4, r.destination_bank as bank, null::text as holder_check, r.created_at, r.claimed_by_user_id, r.transfer_unknown_at, r.approval_request_id, (r.destination_account is not null) as has_destination
            from refund r join store s on s.id = r.store_id where r.status in (${statusList}) order by r.id desc limit ${CONSOLE_QUEUE_LIMIT}`);
    return (rows as unknown as Record<string, string | boolean | null>[]).map((r) => ({
      id: Number(r.id),
      storeId: Number(r.store_id),
      storeName: String(r.store_name),
      orderId: r.order_id == null ? null : Number(r.order_id),
      amountIdr: Number(r.amount_idr),
      status: String(r.status),
      accountLast4: (r.last4 as string | null) ?? null,
      bank: (r.bank as string | null) ?? null,
      holderCheck: (r.holder_check as string | null) ?? null,
      createdAt: String(r.created_at),
      claimedBy: (r.claimed_by_user_id as string | null) ?? null,
      transferUnknownAt: (r.transfer_unknown_at as string | null) ?? null,
      approvalRequestId: r.approval_request_id == null ? null : Number(r.approval_request_id),
      hasDestination: Boolean(r.has_destination),
    }));
  });
}

/** The full bank snapshot of ONE payout or refund (SA-08 detail): `full` access with a case and an expiry, recorded before the value leaves. */
export async function transferBankDetail(op: OperatorScope, kind: TransferKind, id: number, access: { caseId: string; reason: string; purposeCode?: string }): Promise<{ bank: string | null; account: string | null; holder: string | null; holderCheck: string | null }> {
  const cap = kind === "payout" ? "payouts.process" : "refunds.process";
  return withPersonalDataAccess(op, { capability: cap, targetKind: kind, targetId: String(id), fieldClass: "bank", purposeCode: access.purposeCode ?? "payout_review", caseId: access.caseId, reason: access.reason, accessLevel: "full", expiresAt: new Date(Date.now() + 15 * 60_000) }, async (tx) => {
    const rows =
      kind === "payout"
        ? await tx.execute(sql`select bank_code as bank, bank_account_number as account, bank_account_holder as holder, holder_name_check as holder_check from payout where id = ${id}`)
        : await tx.execute(sql`select destination_bank as bank, destination_account as account, destination_holder as holder, null::text as holder_check from refund where id = ${id}`);
    const r = (rows as unknown as Record<string, string | null>[])[0];
    if (!r) throw new DomainError("not_found", "Tidak ditemukan.");
    return { bank: r.bank ?? null, account: r.account ?? null, holder: r.holder ?? null, holderCheck: r.holder_check ?? null };
  });
}


export type TransferApprovalView = { id: number; actionKey: string; status: string; requestedBy: string; decidedBy: string | null; reason: string; payloadCanonical: string; payloadSha256: string; createdAt: string; expiresAt: string };
export type TransferDetail = {
  kind: TransferKind;
  id: number;
  storeId: number;
  storeName: string;
  orderId: number | null;
  status: string;
  amountIdr: number;
  createdAt: string;
  reason: string | null;
  bank: string | null;
  account: string | null;
  holder: string | null;
  holderCheck: string | null;
  composition: { goodsIdr: number; shippingIdr: number; feeIdr: number } | null;
  claimedBy: string | null;
  claimExpiresAt: string | null;
  transferUnknownAt: string | null;
  evidenceRef: string | null;
  rejectionReason: string | null;
  approvalRequestId: number | null;
  approvals: TransferApprovalView[];
};

/**
 * SA-08 detail of ONE payout or refund: the full bank snapshot AND the canonical text of every approval request filed for it (that text embeds the same snapshot).
 * Both are bank values, so the whole read is one `full` access event with a case and a ten-minute expiry, recorded in the transaction before anything leaves.
 */
export async function transferDetail(op: OperatorScope, kind: TransferKind, id: number): Promise<TransferDetail> {
  const cap = kind === "payout" ? "payouts.process" : "refunds.process";
  return withPersonalDataAccess(op, { capability: cap, targetKind: kind, targetId: String(id), fieldClass: "bank", purposeCode: "payout_review", caseId: `${kind}:${id}`, reason: "review the transfer and its approval", accessLevel: "full", expiresAt: new Date(Date.now() + 10 * 60_000) }, async (tx) => {
    type Row = Record<string, string | null>;
    const rows = (await (kind === "payout"
      ? tx.execute(sql`select p.id, p.store_id, s.name as store_name, null::bigint as order_id, p.status, p.amount_idr, p.created_at, null::text as reason, p.bank_code as bank, p.bank_account_number as account, p.bank_account_holder as holder, p.holder_name_check as holder_check,
            null::bigint as goods, null::bigint as shipping, null::bigint as fee, p.claimed_by_user_id, p.claim_expires_at, p.transfer_unknown_at, p.transfer_evidence_ref as evidence_ref, p.rejection_reason as rejected, p.approval_request_id
            from payout p join store s on s.id = p.store_id where p.id = ${id}`)
      : tx.execute(sql`select r.id, r.store_id, s.name as store_name, r.order_id, r.status, r.amount_idr, r.created_at, r.reason, r.destination_bank as bank, r.destination_account as account, r.destination_holder as holder,
            case when r.destination_holder is null then null when lower(regexp_replace(r.destination_holder, '[^a-zA-Z0-9]', '', 'g')) = lower(regexp_replace(o.buyer_name, '[^a-zA-Z0-9]', '', 'g')) then 'match' else 'mismatch' end as holder_check,
            r.goods_refund_idr as goods, r.shipping_refund_idr as shipping, r.fee_refund_idr as fee, r.claimed_by_user_id, r.claim_expires_at, r.transfer_unknown_at, r.transfer_evidence_ref as evidence_ref, r.failure_reason as rejected, r.approval_request_id
            from refund r join store s on s.id = r.store_id join "order" o on o.store_id = r.store_id and o.id = r.order_id where r.id = ${id}`))) as unknown as Row[];
    const r = rows[0];
    if (!r) throw new DomainError("not_found", "Tidak ditemukan.");
    const approvals = (await tx.execute(sql`select id, action_key, status, requested_by, decided_by, reason, payload_canonical, payload_sha256, created_at, expires_at from approval_request where target_kind = ${kind} and target_id = ${String(id)} and action_key in ('payout.approve_transfer', 'refund.approve_transfer', 'payout.reject_processing', 'refund.fail') order by id desc limit 20`)) as unknown as Row[];
    return {
      kind,
      id: Number(r.id),
      storeId: Number(r.store_id),
      storeName: r.store_name!,
      orderId: r.order_id == null ? null : Number(r.order_id),
      status: r.status!,
      amountIdr: Number(r.amount_idr),
      createdAt: String(r.created_at),
      reason: r.reason ?? null,
      bank: r.bank ?? null,
      account: r.account ?? null,
      holder: r.holder ?? null,
      holderCheck: r.holder_check ?? null,
      composition: r.goods == null ? null : { goodsIdr: Number(r.goods), shippingIdr: Number(r.shipping), feeIdr: Number(r.fee) },
      claimedBy: r.claimed_by_user_id ?? null,
      claimExpiresAt: r.claim_expires_at ?? null,
      transferUnknownAt: r.transfer_unknown_at ?? null,
      evidenceRef: r.evidence_ref ?? null,
      rejectionReason: r.rejected ?? null,
      approvalRequestId: r.approval_request_id == null ? null : Number(r.approval_request_id),
      approvals: approvals.map((a) => ({ id: Number(a.id), actionKey: a.action_key!, status: a.status!, requestedBy: a.requested_by!, decidedBy: a.decided_by ?? null, reason: a.reason!, payloadCanonical: a.payload_canonical!, payloadSha256: a.payload_sha256!, createdAt: String(a.created_at), expiresAt: String(a.expires_at) })),
    };
  });
}
