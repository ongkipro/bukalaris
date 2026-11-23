import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Executor, Tx } from "../client.ts";
import { cutoverError } from "../ledger/boundary.ts";
import { registerPlatformHandler } from "../ops/jobs/jobs.ts";
import { registerSchedule } from "../ops/jobs/scheduler.ts";
import { dbMailer } from "../platform/accounts.ts";
import { hit, type LimitRule } from "../platform/rate-limit.ts";
import { can, DomainError, requireCap, type SellerScope } from "../platform/scoped.ts";
import { withStore } from "../platform/tenant.ts";
import { auditLog, membership, order, user } from "../schema.ts";
import { applyTransition } from "../seller/commerce/orders.ts";
import { mediaExt, validateImage } from "../storefront/content.ts";
import type { BuyerOrderRef } from "./seller.ts";
import { bankTransferConfirmation, orderBankTransfer, paymentProof, storeBankAccount, storeBankTransfer, type BankAccountSnapshot, type ProofFile } from "./schema-payments.ts";

// T-113 — bank transfer to the seller's own bank account (ADR-0013 section 10, decisions 35 to 39; D-31, D-32, D-33, D-36).
//
// No provider and no platform account: the store lists its destination accounts, the buyer pays the exact order total into one of them and may
// send a private proof, and the order becomes paid only through the seller's confirmation record. Invariants, each with a named test in
// test/t113-bank-transfer.test.ts:
// - The method is offered and accepted only while the store has it switched on and lists at least one account (one function, `bankTransferState`).
// - Nothing but `confirmBankTransfer` makes such an order paid: an upload changes nothing, the bare "pay" is refused, and the database refuses
//   `awaiting_payment -> placed` without the confirmation record for every role (`order_bank_transfer_paid_guard`).
// - A proof is private: stored outside the public media directory, read only through the signed order-status link of its order or by the
//   store's finance role, served as a sandboxed attachment, and its files are purged 90 days after the order closes (the record stays).
// - The account list changes only with the owner's fresh step-up, audited, at most five listed, never edited (the database re-checks all three).

export const BANK_ACCOUNT_MAX = 5;
export const PROOF_MAX_FILES = 3;
/** Per image: three of them plus the multipart overhead stay under the Server Action body limit (11 MB, apps/web/next.config.ts). */
export const PROOF_MAX_BYTES = 3 * 1024 * 1024;
export const BANK_TRANSFER_DEFAULT_WINDOW_HOURS = 24;
/** RL-PROOF-UPLOAD (doc 16): 6 uploads per hour per order, 20 per hour per IP; a refused upload stores nothing. */
export const PROOF_UPLOAD_LIMITS = { order: { limit: 6, windowSec: 3600 }, ip: { limit: 20, windowSec: 3600 } } as const;
export const BANK_TRANSFER_EXPIRE = "bank_transfer.expire";
export const BANK_TRANSFER_SYSTEM_ACTOR = "system:bank-transfer";
export const BANK_ACCOUNT_STEP_UP = { action: "integrations.bank_account", subjectId: "bank_transfer" } as const;
const NOT_OFFERED = "Transfer bank tidak tersedia di toko ini. Pilih metode lain.";

export type BankTransferState = { enabled: boolean; paymentWindowHours: number; revision: number; accounts: (BankAccountSnapshot & { id: number })[]; ready: boolean };

/** Decision 36 and 39a: the store's switch, window and listed accounts, and whether the method may be offered. Runs in the store's context. */
export async function bankTransferState(exec: Executor, storeId: number): Promise<BankTransferState> {
  const [[s], accounts] = await Promise.all([
    exec.select().from(storeBankTransfer).where(eq(storeBankTransfer.storeId, storeId)),
    exec.select({ id: storeBankAccount.id, bankCode: storeBankAccount.bankCode, accountNumber: storeBankAccount.accountNumber, holderName: storeBankAccount.holderName })
      .from(storeBankAccount).where(and(eq(storeBankAccount.storeId, storeId), isNull(storeBankAccount.removedAt))).orderBy(asc(storeBankAccount.id)),
  ]);
  const enabled = s?.enabled ?? true;
  return { enabled, paymentWindowHours: s?.paymentWindowHours ?? BANK_TRANSFER_DEFAULT_WINDOW_HOURS, revision: s?.revision ?? 0, accounts, ready: enabled && accounts.length > 0 };
}

/** Is bank transfer ready (decision 14 counts it as a prepaid method)? */
export async function bankTransferReady(exec: Executor, storeId: number): Promise<boolean> {
  return withStore(exec, storeId, async (tx) => (await bankTransferState(tx, storeId)).ready);
}

// ── Seller: the account list and the switch (SC-32, owner) ───────────────────────────────────────────────────────────

export async function sellerBankTransfer(scope: SellerScope): Promise<BankTransferState> {
  requireCap(scope, "integrations.manage");
  return withStore(scope.exec, scope.storeId, (tx) => bankTransferState(tx, scope.storeId));
}

const accountInput = z.strictObject({
  bankCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,12}$/, "Pilih bank."),
  accountNumber: z.string().trim().regex(/^[0-9]{5,24}$/, "Nomor rekening 5 sampai 24 angka tanpa spasi atau tanda hubung."),
  holderName: z.string().trim().min(2, "Nama pemilik rekening minimal 2 karakter.").max(120),
  proofId: z.string(),
});
const pgMessage = (err: unknown): string => (err instanceof Error ? `${err.message} ${pgMessage(err.cause)}` : "");

async function audit(tx: Executor, scope: SellerScope, action: string, subjectId: string, reason: string, capability = "integrations.manage") {
  await tx.insert(auditLog).values({ storeId: scope.storeId, actorUserId: scope.userId, actorCapability: capability, action, subjectKind: "store_bank_account", subjectId, accessLevel: "write", outcome: "allowed", reason: reason.slice(0, 500) });
}

// Lazy, like `setWebhookSecret`: the step-up module imports the checkout limiter, which imports this module (no import cycle at load time).
const consumeSellerStepUp: typeof import("../ledger/stepup.ts").consumeSellerStepUp = async (...args) => (await import("../ledger/stepup.ts")).consumeSellerStepUp(...args);

/** List one more destination account (owner, fresh step-up consumed here, audited with the bank and the last four digits only). */
export async function addBankAccount(scope: SellerScope, raw: unknown): Promise<{ id: number }> {
  requireCap(scope, "integrations.manage");
  const input = accountInput.parse(raw);
  try {
    return await withStore(scope.exec, scope.storeId, async (tx) => {
      await consumeSellerStepUp(tx, scope, input.proofId, BANK_ACCOUNT_STEP_UP);
      const listed = await tx.select({ id: storeBankAccount.id }).from(storeBankAccount).where(and(eq(storeBankAccount.storeId, scope.storeId), isNull(storeBankAccount.removedAt)));
      if (listed.length >= BANK_ACCOUNT_MAX) throw new DomainError("bank_account_limit", `Maksimal ${BANK_ACCOUNT_MAX} rekening. Hapus salah satu dulu.`);
      const [row] = await tx.insert(storeBankAccount).values({ storeId: scope.storeId, bankCode: input.bankCode, accountNumber: input.accountNumber, holderName: input.holderName, createdBy: scope.userId, stepUpRef: input.proofId }).returning({ id: storeBankAccount.id });
      await audit(tx, scope, "bank_account.add", String(row!.id), `${input.bankCode} ••••${input.accountNumber.slice(-4)}`);
      return { id: row!.id };
    });
  } catch (err) {
    if (/bank_account_limit/.test(pgMessage(err))) throw new DomainError("bank_account_limit", `Maksimal ${BANK_ACCOUNT_MAX} rekening. Hapus salah satu dulu.`);
    throw cutoverError(err);
  }
}

const removeInput = z.strictObject({ id: z.coerce.number().int().positive(), proofId: z.string() });
/** Remove a listed account (owner, fresh step-up). The row stays as the record of what earlier buyers were shown; orders keep their frozen copy. */
export async function removeBankAccount(scope: SellerScope, raw: unknown): Promise<void> {
  requireCap(scope, "integrations.manage");
  const input = removeInput.parse(raw);
  await withStore(scope.exec, scope.storeId, async (tx) => {
    await consumeSellerStepUp(tx, scope, input.proofId, BANK_ACCOUNT_STEP_UP);
    const [row] = await tx.update(storeBankAccount).set({ removedAt: sql`now()` as unknown as Date, removedBy: scope.userId, removalStepUpRef: input.proofId })
      .where(and(eq(storeBankAccount.storeId, scope.storeId), eq(storeBankAccount.id, input.id), isNull(storeBankAccount.removedAt))).returning({ bankCode: storeBankAccount.bankCode, accountNumber: storeBankAccount.accountNumber });
    if (!row) throw new DomainError("not_found", "Rekening tidak ditemukan.");
    await audit(tx, scope, "bank_account.remove", String(input.id), `${row.bankCode} ••••${row.accountNumber.slice(-4)}`);
  });
}

const settingsInput = z.strictObject({ enabled: z.boolean(), paymentWindowHours: z.coerce.number().int().min(1, "Batas waktu 1 sampai 168 jam.").max(168, "Batas waktu 1 sampai 168 jam."), revision: z.coerce.number().int().min(0) });
/** The store switch and the payment window (owner). A stale form (another session saved meanwhile) changes nothing. */
export async function setBankTransferSettings(scope: SellerScope, raw: unknown): Promise<void> {
  requireCap(scope, "integrations.manage");
  const input = settingsInput.parse(raw);
  await withStore(scope.exec, scope.storeId, async (tx) => {
    const [cur] = await tx.select({ revision: storeBankTransfer.revision }).from(storeBankTransfer).where(eq(storeBankTransfer.storeId, scope.storeId)).for("update");
    if ((cur?.revision ?? 0) !== input.revision) throw new DomainError("conflict", "Pengaturan baru saja diubah di sesi lain. Muat ulang halaman lalu coba lagi.");
    const values = { enabled: input.enabled, paymentWindowHours: input.paymentWindowHours, revision: input.revision + 1, updatedAt: new Date() };
    if (cur) await tx.update(storeBankTransfer).set(values).where(eq(storeBankTransfer.storeId, scope.storeId));
    else await tx.insert(storeBankTransfer).values({ storeId: scope.storeId, ...values });
    await audit(tx, scope, "bank_transfer.settings", String(scope.storeId), `enabled=${input.enabled}; window=${input.paymentWindowHours}h`);
  });
}

// ── Checkout: the order freezes the destinations and its expiry ──────────────────────────────────────────────────────

/** Inside the order transaction (store context): refuse a store whose method is not ready, then freeze the listed accounts and the expiry. */
export async function freezeBankTransfer(tx: Executor, storeId: number, orderId: number): Promise<void> {
  const s = await bankTransferState(tx, storeId);
  if (!s.ready) throw new DomainError("payment_method", NOT_OFFERED);
  await tx.insert(orderBankTransfer).values({
    storeId,
    orderId,
    accounts: s.accounts.map(({ bankCode, accountNumber, holderName }) => ({ bankCode, accountNumber, holderName })),
    expiresAt: sql`now() + ${s.paymentWindowHours} * interval '1 hour'` as unknown as Date,
  });
}
/** Before the order transaction: the same rule, so a buyer sees the refusal without a quote round trip. */
export async function assertBankTransferOffered(exec: Executor, storeId: number): Promise<void> {
  if (!(await bankTransferReady(exec, storeId))) throw new DomainError("payment_method", NOT_OFFERED);
}

// ── Buyer: destinations, proof upload, proof download ────────────────────────────────────────────────────────────────

export type ProofView = { id: string; status: "sent" | "accepted" | "rejected"; rejectReason: string | null; files: number; purged: boolean; createdAt: Date };
export type BuyerBankTransfer = { accounts: BankAccountSnapshot[]; expiresAt: Date; totalIdr: number; orderStatus: string; confirmed: boolean; proofs: ProofView[]; canUpload: boolean };

const proofView = (p: typeof paymentProof.$inferSelect): ProofView => ({ id: p.id, status: p.status, rejectReason: p.rejectReason, files: p.files.length, purged: p.filesPurgedAt !== null, createdAt: p.createdAt });

async function orderTransfer(tx: Executor, storeId: number, orderId: number) {
  const [row] = await tx.select({ accounts: orderBankTransfer.accounts, expiresAt: orderBankTransfer.expiresAt, total: order.total, status: order.status })
    .from(orderBankTransfer).innerJoin(order, and(eq(order.storeId, orderBankTransfer.storeId), eq(order.id, orderBankTransfer.orderId)))
    .where(and(eq(orderBankTransfer.storeId, storeId), eq(orderBankTransfer.orderId, orderId)));
  return row ?? null;
}

/** What the confirmation and order-status pages show for a bank-transfer order (null for any other order). The ref comes from the signed link or the cart cookie. */
export async function buyerBankTransfer(exec: Executor, ref: BuyerOrderRef): Promise<BuyerBankTransfer | null> {
  return withStore(exec, ref.storeId, async (tx) => {
    const t = await orderTransfer(tx, ref.storeId, ref.orderId);
    if (!t) return null;
    const [proofs, [c]] = await Promise.all([
      tx.select().from(paymentProof).where(and(eq(paymentProof.storeId, ref.storeId), eq(paymentProof.orderId, ref.orderId))).orderBy(desc(paymentProof.createdAt)),
      tx.select({ id: bankTransferConfirmation.id }).from(bankTransferConfirmation).where(and(eq(bankTransferConfirmation.storeId, ref.storeId), eq(bankTransferConfirmation.orderId, ref.orderId))),
    ]);
    const waiting = proofs.some((p) => p.status === "sent");
    return { accounts: t.accounts, expiresAt: t.expiresAt, totalIdr: t.total, orderStatus: t.status, confirmed: !!c, proofs: proofs.map(proofView), canUpload: t.status === "awaiting_payment" && !c && !waiting };
  });
}

async function limitProofUpload(exec: Executor, orderId: number, clientIp: string | undefined) {
  const hits: { key: string; rule: LimitRule }[] = [{ key: `proof:order:${orderId}`, rule: PROOF_UPLOAD_LIMITS.order }, ...(clientIp ? [{ key: `proof:ip:${clientIp}`, rule: PROOF_UPLOAD_LIMITS.ip }] : [])];
  const results = await Promise.all(hits.map((h) => hit(exec, h.key, h.rule)));
  const over = results.filter((r, i) => r.count > hits[i]!.rule.limit);
  if (over.length) throw new DomainError("rate_limited", `Terlalu banyak unggahan. Coba lagi dalam ${Math.max(...over.map((r) => r.retryAfterSec))} detik.`);
}

async function notifyOwners(tx: Tx, storeId: number, subject: string, text: string) {
  const owners = await tx.select({ email: user.email }).from(membership).innerJoin(user, eq(user.id, membership.userId)).where(and(eq(membership.storeId, storeId), eq(membership.role, "owner")));
  for (const to of new Set(owners.map((o) => o.email))) await dbMailer(tx).send({ to, subject, text });
}

/**
 * Decision 37: the buyer sends up to three proof images for an unpaid bank-transfer order (RL-PROOF-UPLOAD first; each file checked by its
 * content and size). The files are written inside the transaction that records them, under keys the server chooses. The order does not change;
 * the store's owners are told to compare the proof with their own bank statement.
 */
export async function uploadPaymentProof(exec: Executor, ref: BuyerOrderRef, files: Uint8Array[], write: (key: string, bytes: Uint8Array) => Promise<void>, ctx: { clientIp?: string | undefined } = {}): Promise<{ id: string }> {
  await limitProofUpload(exec, ref.orderId, ctx.clientIp);
  const chosen = files.filter((f) => f.length > 0);
  if (chosen.length === 0) throw new DomainError("empty_file", "Pilih foto bukti transfer.");
  if (chosen.length > PROOF_MAX_FILES) throw new DomainError("too_many_files", `Maksimal ${PROOF_MAX_FILES} foto bukti transfer.`);
  if (chosen.some((f) => f.length > PROOF_MAX_BYTES)) throw new DomainError("too_large", "Ukuran tiap foto bukti maksimal 3 MB.");
  const checked = chosen.map((bytes) => ({ bytes, img: validateImage(bytes) }));
  return withStore(exec, ref.storeId, async (tx) => {
    const [o] = await tx.select({ status: order.status, method: order.paymentMethod }).from(order).where(and(eq(order.storeId, ref.storeId), eq(order.id, ref.orderId))).for("update");
    if (!o || o.method !== "bank_transfer") throw new DomainError("not_found", "Pesanan tidak ditemukan.");
    if (o.status !== "awaiting_payment") throw new DomainError("not_awaiting", "Pesanan ini tidak menunggu pembayaran lagi.");
    const [waiting] = await tx.select({ id: paymentProof.id }).from(paymentProof).where(and(eq(paymentProof.storeId, ref.storeId), eq(paymentProof.orderId, ref.orderId), eq(paymentProof.status, "sent")));
    if (waiting) throw new DomainError("proof_waiting", "Bukti transfer sebelumnya masih menunggu pemeriksaan penjual.");
    const stored: ProofFile[] = checked.map(({ bytes, img }) => ({ key: `${ref.storeId}/${randomUUID()}.${mediaExt[img.mime]}`, mime: img.mime, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
    const [row] = await tx.insert(paymentProof).values({ storeId: ref.storeId, orderId: ref.orderId, files: stored }).returning({ id: paymentProof.id });
    for (let i = 0; i < stored.length; i++) await write(stored[i]!.key, checked[i]!.bytes);
    await notifyOwners(tx, ref.storeId, `Bukti transfer untuk pesanan #${ref.orderId}`, `Pembeli mengirim bukti transfer untuk pesanan #${ref.orderId}. Cocokkan dengan mutasi rekening Anda, lalu konfirmasi atau tolak di Seller Admin. Bukti saja tidak mengubah status pesanan.`);
    return { id: row!.id };
  });
}

const fileRef = z.strictObject({ proofId: z.uuid(), n: z.coerce.number().int().min(1).max(PROOF_MAX_FILES) });
async function proofFile(tx: Executor, storeId: number, orderId: number, raw: unknown): Promise<{ file: ProofFile; n: number } | null> {
  const parsed = fileRef.safeParse(raw);
  if (!parsed.success) return null;
  const [p] = await tx.select({ files: paymentProof.files }).from(paymentProof).where(and(eq(paymentProof.storeId, storeId), eq(paymentProof.orderId, orderId), eq(paymentProof.id, parsed.data.proofId)));
  const file = p?.files[parsed.data.n - 1];
  return file ? { file, n: parsed.data.n } : null;
}
/** The buyer's own proof file, through the signed order-status link only (the ref is resolved from the verified token by the caller). */
export async function buyerProofFile(exec: Executor, ref: BuyerOrderRef, raw: unknown) {
  return withStore(exec, ref.storeId, (tx) => proofFile(tx, ref.storeId, ref.orderId, raw));
}

// ── Seller: review, confirm, reject (finance role) ───────────────────────────────────────────────────────────────────

export type SellerBankTransfer = { accounts: BankAccountSnapshot[]; expiresAt: Date; confirmation: { reason: string; proofId: string | null; createdAt: Date } | null; proofs: ProofView[] | null };
/** The order page: destinations, expiry and the confirmation for everyone who sees the order; the proofs only for the finance role (decision 39). */
export async function sellerBankTransferOrder(scope: SellerScope, orderId: number): Promise<SellerBankTransfer | null> {
  requireCap(scope, "orders.read");
  const finance = can(scope, "finance.confirm_payment");
  return withStore(scope.exec, scope.storeId, async (tx) => {
    const t = await orderTransfer(tx, scope.storeId, orderId);
    if (!t) return null;
    const [[c], proofs] = await Promise.all([
      tx.select({ reason: bankTransferConfirmation.reason, proofId: bankTransferConfirmation.proofId, createdAt: bankTransferConfirmation.createdAt }).from(bankTransferConfirmation).where(and(eq(bankTransferConfirmation.storeId, scope.storeId), eq(bankTransferConfirmation.orderId, orderId))),
      finance ? tx.select().from(paymentProof).where(and(eq(paymentProof.storeId, scope.storeId), eq(paymentProof.orderId, orderId))).orderBy(desc(paymentProof.createdAt)) : Promise.resolve(null),
    ]);
    return { accounts: t.accounts, expiresAt: t.expiresAt, confirmation: c ?? null, proofs: proofs?.map(proofView) ?? null };
  });
}
/** A proof file for the store's finance role. */
export async function sellerProofFile(scope: SellerScope, orderId: number, raw: unknown) {
  requireCap(scope, "finance.confirm_payment");
  return withStore(scope.exec, scope.storeId, (tx) => proofFile(tx, scope.storeId, orderId, raw));
}

const confirmInput = z.strictObject({ orderId: z.coerce.number().int().positive(), reason: z.string().trim().min(5, "Alasan minimal 5 karakter.").max(500), proofId: z.preprocess((v) => (v === "" ? undefined : v), z.uuid().optional()) });
/**
 * Decision 38: the seller confirms the transfer after comparing it with their own bank statement. One append-only record (who, why, the proof
 * looked at, or none), the proof accepted, then the same post-payment path as a verified provider payment (`applyTransition` "pay": paid time,
 * purchase signal, notifications). A second confirmation changes nothing.
 */
export async function confirmBankTransfer(scope: SellerScope, raw: unknown): Promise<void> {
  requireCap(scope, "finance.confirm_payment");
  const input = confirmInput.parse(raw);
  await withStore(scope.exec, scope.storeId, async (tx) => {
    const [o] = await tx.select({ status: order.status, method: order.paymentMethod }).from(order).where(and(eq(order.storeId, scope.storeId), eq(order.id, input.orderId))).for("update");
    if (!o || o.method !== "bank_transfer") throw new DomainError("not_found", "Pesanan transfer bank tidak ditemukan.");
    const [done] = await tx.select({ id: bankTransferConfirmation.id }).from(bankTransferConfirmation).where(and(eq(bankTransferConfirmation.storeId, scope.storeId), eq(bankTransferConfirmation.orderId, input.orderId)));
    if (done) throw new DomainError("already_confirmed", "Pembayaran pesanan ini sudah dikonfirmasi. Catatan konfirmasi tidak bisa diubah.");
    if (o.status !== "awaiting_payment") throw new DomainError("not_awaiting", "Pesanan ini tidak menunggu pembayaran lagi.");
    if (input.proofId) {
      const [p] = await tx.update(paymentProof).set({ status: "accepted", decidedBy: scope.userId, decidedAt: new Date() })
        .where(and(eq(paymentProof.storeId, scope.storeId), eq(paymentProof.orderId, input.orderId), eq(paymentProof.id, input.proofId), eq(paymentProof.status, "sent"))).returning({ id: paymentProof.id });
      if (!p) throw new DomainError("proof_unavailable", "Bukti transfer itu tidak bisa dipakai (sudah diputuskan atau bukan milik pesanan ini).");
    }
    await tx.insert(bankTransferConfirmation).values({ storeId: scope.storeId, orderId: input.orderId, proofId: input.proofId ?? null, confirmedBy: scope.userId, reason: input.reason });
    await applyTransition(tx, scope.storeId, input.orderId, "pay", `Transfer bank dikonfirmasi penjual: ${input.reason}`.slice(0, 500), scope.userId);
    await audit(tx, scope, "bank_transfer.confirm", String(input.orderId), `proof=${input.proofId ?? "none"}; ${input.reason}`, "finance.confirm_payment");
  });
}

const rejectInput = z.strictObject({ orderId: z.coerce.number().int().positive(), proofId: z.uuid(), reason: z.string().trim().min(5, "Alasan minimal 5 karakter.").max(500) });
/** Reject a proof with a reason the buyer reads; the buyer may then send a new one. The order does not change. */
export async function rejectPaymentProof(scope: SellerScope, raw: unknown): Promise<void> {
  requireCap(scope, "finance.confirm_payment");
  const input = rejectInput.parse(raw);
  await withStore(scope.exec, scope.storeId, async (tx) => {
    const [p] = await tx.update(paymentProof).set({ status: "rejected", decidedBy: scope.userId, decidedAt: new Date(), rejectReason: input.reason })
      .where(and(eq(paymentProof.storeId, scope.storeId), eq(paymentProof.orderId, input.orderId), eq(paymentProof.id, input.proofId), eq(paymentProof.status, "sent"))).returning({ id: paymentProof.id });
    if (!p) throw new DomainError("proof_unavailable", "Bukti transfer itu sudah diputuskan atau bukan milik pesanan ini.");
    await audit(tx, scope, "bank_transfer.proof_reject", String(input.orderId), `proof=${input.proofId}; ${input.reason}`, "finance.confirm_payment");
  });
}

// ── Worker and cleanup ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Decision 37: an unpaid bank-transfer order whose payment window passed is cancelled and its stock returned (the one status writer). An
 * order with a proof still waiting for the seller is left alone: the buyer acted within the window and only the seller can decide (D-36).
 */
export async function expireBankTransferOrders(db: Db, limit = 100): Promise<number> {
  const due = (await db.execute(sql`
    select t.store_id, t.order_id from public.order_bank_transfer t join public."order" o on o.store_id = t.store_id and o.id = t.order_id
     where o.status = 'awaiting_payment' and t.expires_at < now()
       and not exists (select 1 from public.bank_transfer_confirmation c where c.store_id = t.store_id and c.order_id = t.order_id)
       and not exists (select 1 from public.payment_proof p where p.store_id = t.store_id and p.order_id = t.order_id and p.status = 'sent')
     order by t.expires_at limit ${limit}`)) as unknown as { store_id: string; order_id: string }[];
  let n = 0;
  for (const r of due) {
    const storeId = Number(r.store_id), orderId = Number(r.order_id);
    const moved = await withStore(db, storeId, async (tx) => {
      const [o] = await tx.select({ status: order.status }).from(order).where(and(eq(order.storeId, storeId), eq(order.id, orderId))).for("update");
      if (o?.status !== "awaiting_payment") return false;
      await applyTransition(tx, storeId, orderId, "cancel", "Batas waktu pembayaran transfer bank lewat; stok dikembalikan", BANK_TRANSFER_SYSTEM_ACTOR);
      return true;
    });
    if (moved) n++;
  }
  return n;
}
registerSchedule({ kind: BANK_TRANSFER_EXPIRE, period: "minute", catchUp: 0 });
registerPlatformHandler(BANK_TRANSFER_EXPIRE, async ({ db }) => { await expireBankTransferOrders(db); }, { replaySafe: true });

/**
 * D-33: delete the proof files of orders closed (completed, cancelled or returned) longer ago than the retention period of class `payment_proof`
 * (90 days, Owner-configurable; no period = off). The row stays with `files_purged_at`, so the confirmation record keeps naming it. Platform pool.
 */
export async function purgeProofFiles(db: Db, unlinkFile: (key: string) => Promise<void>, limit = 200): Promise<{ enabled: boolean; purged: number }> {
  const [policy] = (await db.execute(sql`select period_days from public.retention_policy where class = 'payment_proof'`)) as unknown as { period_days: number }[];
  if (!policy) return { enabled: false, purged: 0 };
  const due = (await db.execute(sql`
    select p.store_id, p.id, p.files from public.payment_proof p join public."order" o on o.store_id = p.store_id and o.id = p.order_id
     where p.files_purged_at is null and o.status in ('completed', 'cancelled', 'returned') and o.updated_at < now() - ${policy.period_days} * interval '1 day'
     order by o.updated_at limit ${limit}`)) as unknown as { store_id: string; id: string; files: ProofFile[] }[];
  for (const p of due) {
    for (const f of p.files) await unlinkFile(f.key);
    await db.update(paymentProof).set({ files: [], filesPurgedAt: new Date() }).where(and(eq(paymentProof.storeId, Number(p.store_id)), eq(paymentProof.id, p.id), isNull(paymentProof.filesPurgedAt)));
  }
  return { enabled: true, purged: due.length };
}
