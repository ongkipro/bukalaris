import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeMoneyMode } from "../src/ledger/boundary.ts";
import { issueSellerStepUp } from "../src/ledger/stepup.ts";
import { runOnce } from "../src/ops/jobs/jobs.ts";
import { signOrderLink } from "../src/ops/jobs/notify.ts";
import {
  addBankAccount, BANK_ACCOUNT_STEP_UP, buyerBankTransfer, buyerProofFile, confirmBankTransfer, expireBankTransferOrders, PROOF_UPLOAD_LIMITS, purgeProofFiles, rejectPaymentProof,
  removeBankAccount, sellerBankTransfer, sellerBankTransferOrder, sellerProofFile, setBankTransferSettings, uploadPaymentProof,
} from "../src/payments/bank-transfer.ts";
import { FakeProviderCheck, saveProviderKey, setProviderCheckTransport, storeReadiness } from "../src/payments/provider-accounts.ts";
import { fakeProviders } from "../src/payments/providers.ts";
import { bankTransferConfirmation, orderBankTransfer, paymentProof, storeBankAccount } from "../src/payments/schema-payments.ts";
import { resolveBuyerOrder } from "../src/payments/seller.ts";
import { bindSession, type SellerScope } from "../src/platform/scoped.ts";
import { withStore } from "../src/platform/tenant.ts";
import { auditLog, membership, order, orderFinancials, orderStatusHistory, variant } from "../src/schema.ts";
import { checkoutPaymentChannels, placeOrder, searchDestinationAreas } from "../src/seller/commerce/checkout.ts";
import { transitionOrder } from "../src/seller/commerce/orders.ts";
import { formatShippingQuote, saveCourierRules } from "../src/shipping/rules.ts";
import { setPickupAddress, shippingOptions } from "../src/shipping/shipping.ts";
import { confirmDedicatedAccount } from "../src/shipping/sync.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { admin, buyer, db, DESTINATION, makeStore, makeUser, platform, seller } from "./helpers.ts";
import { sessionOf, withoutGuard } from "./t37-fixtures.ts";

// T-113 (ADR-0013 section 10, decisions 35 to 39; D-31, D-32, D-33, D-36): bank transfer to the seller's own bank account. Everything is local:
// the seller's Mengantar is the deterministic fake, files are written to an in-memory map. Each invariant has a named test; the mutation checks in
// docs/tracks/t113-bank-transfer.md break each once and name the test that fails.

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code ?? String(e));
const pgCode = (p: Promise<unknown>) => p.then(() => "allowed", (e: { cause?: { code?: string }; code?: string }) => e.cause?.code ?? e.code);
/** A 1x1 PNG (the proof check reads the type and the header dimensions from the bytes). */
const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
const files = new Map<string, Uint8Array>();
const write = async (key: string, bytes: Uint8Array) => { files.set(key, bytes); };
let phone = 0;

beforeEach(() => {
  setProviderCheckTransport(new FakeProviderCheck());
  files.clear();
});
afterEach(() => setProviderCheckTransport(null));

type Own = Awaited<ReturnType<typeof makeStore>> & { me: SellerScope };
/** A store on its own Mengantar account (ships), with the given bank accounts listed through the owner's step-up. */
async function bankStore(slug: string, accounts: { bankCode: string; accountNumber: string; holderName: string }[] = [{ bankCode: "BCA", accountNumber: "1234567890", holderName: "Budi Pemilik" }]): Promise<Own> {
  const s = await makeStore(slug);
  const me = bindSession(s.owner, await sessionOf(s.ownerId));
  await saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: `CANARY-T113-MENGANTAR-${slug}-0123456789`, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar" }) });
  await confirmDedicatedAccount(me, { confirmed: true });
  await setPickupAddress(me, { addressText: "Jl. Braga No. 10, Bandung", contactName: "Budi Pemilik", contactPhone: "081234567890" });
  await saveCourierRules(me, { couriers: [{ courierCode: "JNE", enabled: true, codEnabled: true }] });
  await searchDestinationAreas("menteng", undefined, s.sf);
  for (const a of accounts) await addBankAccount(me, { ...a, proofId: await issueSellerStepUp(me, BANK_ACCOUNT_STEP_UP) });
  return { ...s, me };
}
async function submit(s: Own, over: Record<string, unknown> = {}) {
  const quote = await shippingOptions(s.sf, DESTINATION.destinationAreaId, { lines: [{ quantity: 1, weightGrams: 1000 }], subtotal: 100_000 });
  const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
  return (await placeOrder(db, cartId, buyer({ paymentMethod: "bank_transfer", shippingQuote: formatShippingQuote(quote.options), buyerPhone: `0816${String(++phone).padStart(8, "0")}`, ...over }), fakeProviders)).orderId;
}
const ref = (s: Own, orderId: number) => ({ storeId: s.storeId, orderId });
const orderOf = async (orderId: number) => (await admin.select().from(order).where(eq(order.id, orderId)))[0]!;
const stockOf = async (variantId: number) => (await admin.select({ stock: variant.stock }).from(variant).where(eq(variant.id, variantId)))[0]!.stock;
const proofsOf = (orderId: number) => admin.select().from(paymentProof).where(eq(paymentProof.orderId, orderId));
async function staffOf(s: Own) {
  const staffId = await makeUser(`${s.sf.storeSlug}-staff`);
  await platform.insert(membership).values({ storeId: s.storeId, userId: staffId, role: "staff" });
  return seller(staffId, s.storeId);
}

describe("T-113 the store's bank accounts (decision 36)", () => {
  it("accounts are listed and removed by the owner with a fresh step-up, audited, at most five, never edited or deleted; staff and a missing proof are refused", async () => {
    const s = await bankStore("bankacc", []);
    const staff = await staffOf(s);
    expect(await code(addBankAccount(staff, { bankCode: "BCA", accountNumber: "1111111111", holderName: "Staf", proofId: "x" }))).toBe("forbidden");
    expect(await code(addBankAccount(s.me, { bankCode: "BCA", accountNumber: "1111111111", holderName: "Budi", proofId: "00000000-0000-4000-8000-000000000000" }))).toBe("reauth_required");
    for (let i = 0; i < 5; i++) await addBankAccount(s.me, { bankCode: "BRI", accountNumber: `22222222${i}`, holderName: "Budi Pemilik", proofId: await issueSellerStepUp(s.me, BANK_ACCOUNT_STEP_UP) });
    expect(await code(addBankAccount(s.me, { bankCode: "BNI", accountNumber: "3333333333", holderName: "Budi", proofId: await issueSellerStepUp(s.me, BANK_ACCOUNT_STEP_UP) }))).toBe("bank_account_limit");
    const listed = await sellerBankTransfer(s.me);
    expect(listed.accounts).toHaveLength(5);
    await removeBankAccount(s.me, { id: listed.accounts[0]!.id, proofId: await issueSellerStepUp(s.me, BANK_ACCOUNT_STEP_UP) });
    expect((await sellerBankTransfer(s.me)).accounts).toHaveLength(4);
    // The removed row stays (a stamp), the audit names the bank and the last four digits only.
    expect((await admin.select().from(storeBankAccount).where(eq(storeBankAccount.storeId, s.storeId))).filter((r) => r.removedAt !== null)).toHaveLength(1);
    const audits = await admin.select({ action: auditLog.action, reason: auditLog.reason }).from(auditLog).where(and(eq(auditLog.storeId, s.storeId), sql`${auditLog.action} like 'bank_account.%'`));
    expect(audits.map((a) => a.action).sort()).toEqual([...Array(5).fill("bank_account.add"), "bank_account.remove"].sort());
    expect(audits.every((a) => !a.reason?.includes("22222222"))).toBe(true);
    // The database refuses the same rows without the proof consumed in the transaction, an edit and a delete, for the application role.
    expect(await pgCode(withStore(db, s.storeId, (tx) => tx.insert(storeBankAccount).values({ storeId: s.storeId, bankCode: "BCA", accountNumber: "4444444444", holderName: "Budi", createdBy: s.ownerId, stepUpRef: listed.accounts[1] ? "00000000-0000-4000-8000-000000000001" : "" })))).toBe("42501");
    expect(await pgCode(withStore(db, s.storeId, (tx) => tx.update(storeBankAccount).set({ removedAt: new Date(), removedBy: s.ownerId, removalStepUpRef: "00000000-0000-4000-8000-000000000002" }).where(eq(storeBankAccount.id, listed.accounts[1]!.id))))).toBe("42501");
    expect(await pgCode(admin.execute(sql`update store_bank_account set account_number = '5555555555' where id = ${listed.accounts[1]!.id}`))).toBe("42501");
    expect(await pgCode(admin.execute(sql`delete from store_bank_account where id = ${listed.accounts[1]!.id}`))).toBe("42501");
  });

  it("store A can neither read nor change store B's accounts; a listed account makes the store seller_owned (D-36) and counts as a ready prepaid method", async () => {
    const a = await bankStore("banka");
    const b = await bankStore("bankb", [{ bankCode: "MANDIRI", accountNumber: "9876543210", holderName: "Pemilik B" }]);
    const bId = (await sellerBankTransfer(b.me)).accounts[0]!.id;
    expect((await sellerBankTransfer(a.me)).accounts.map((x) => x.accountNumber)).toEqual(["1234567890"]);
    expect(await withStore(db, a.storeId, (tx) => tx.select().from(storeBankAccount).where(eq(storeBankAccount.id, bId)))).toEqual([]);
    expect(await code(removeBankAccount(a.me, { id: bId, proofId: await issueSellerStepUp(a.me, BANK_ACCOUNT_STEP_UP) }))).toBe("not_found");
    expect((await sellerBankTransfer(b.me)).accounts).toHaveLength(1);
    const plain = await makeStore("bankplain");
    expect(await storeMoneyMode(admin, plain.storeId)).toBe("platform_held");
    expect(await storeMoneyMode(admin, a.storeId)).toBe("seller_owned");
    expect((await storeReadiness(a.me)).bankTransfer).toBe(true);
  });
});

describe("T-113 the method at checkout (decisions 36, 37, 39a)", () => {
  it("the method is absent and refused without an account or while switched off; a direct submit to a store without one is refused", async () => {
    const none = await bankStore("banknone", []);
    expect((await checkoutPaymentChannels(db, none.storeId, fakeProviders.payment)).bankTransfer).toBe(false);
    expect(await code(submit(none))).toBe("payment_method");
    const plain = await makeStore("bankplain2");
    expect(await code(submit({ ...plain, me: plain.owner }))).toBe("payment_method");
    const on = await bankStore("bankon");
    expect((await checkoutPaymentChannels(db, on.storeId, fakeProviders.payment)).bankTransfer).toBe(true);
    await setBankTransferSettings(on.me, { enabled: false, paymentWindowHours: 24, revision: 0 });
    expect((await checkoutPaymentChannels(db, on.storeId, fakeProviders.payment)).bankTransfer).toBe(false);
    expect(await code(submit(on))).toBe("payment_method");
    // The database refuses a frozen record for an order that is not a bank transfer.
    await setBankTransferSettings(on.me, { enabled: true, paymentWindowHours: 24, revision: 1 });
    const cod = await submit(on, { paymentMethod: "cod" });
    expect(await pgCode(withStore(db, on.storeId, (tx) => tx.insert(orderBankTransfer).values({ storeId: on.storeId, orderId: cod, accounts: [{ bankCode: "BCA", accountNumber: "1234567890", holderName: "X" }], expiresAt: new Date(Date.now() + 3_600_000) })))).toBe("23514");
  });

  it("an order by bank transfer freezes the listed accounts and the end of the payment window; the bill is the exact order total with no fee", async () => {
    const s = await bankStore("bankorder", [{ bankCode: "BCA", accountNumber: "1234567890", holderName: "Budi Pemilik" }, { bankCode: "BRI", accountNumber: "5555666677", holderName: "Budi Pemilik" }]);
    await setBankTransferSettings(s.me, { enabled: true, paymentWindowHours: 6, revision: 0 });
    const before = await stockOf(s.variantId);
    const orderId = await submit(s);
    const o = await orderOf(orderId);
    expect(o).toMatchObject({ status: "awaiting_payment", paymentMethod: "bank_transfer", paidAt: null });
    expect(await stockOf(s.variantId)).toBe(before - 1);
    const view = (await buyerBankTransfer(db, ref(s, orderId)))!;
    expect(view.accounts).toEqual([{ bankCode: "BCA", accountNumber: "1234567890", holderName: "Budi Pemilik" }, { bankCode: "BRI", accountNumber: "5555666677", holderName: "Budi Pemilik" }]);
    expect(view.totalIdr).toBe(o.total);
    expect(Math.round((view.expiresAt.getTime() - o.createdAt.getTime()) / 3_600_000)).toBe(6);
    const [f] = await admin.select().from(orderFinancials).where(eq(orderFinancials.orderId, orderId));
    expect(f).toMatchObject({ moneyMode: "seller_owned", buyerFeeIdr: 0, expectedGatewayFeeIdr: 0, expectedCodFeeIdr: 0 });
    // A later change of the store's list never alters the order.
    const listed = (await sellerBankTransfer(s.me)).accounts;
    await removeBankAccount(s.me, { id: listed[1]!.id, proofId: await issueSellerStepUp(s.me, BANK_ACCOUNT_STEP_UP) });
    expect((await buyerBankTransfer(db, ref(s, orderId)))!.accounts).toHaveLength(2);
  });
});

describe("T-113 proof of transfer and the paid rule (decisions 37 to 39)", () => {
  it("no path other than the seller's confirmation makes the order paid: not an upload, not the bare pay, not the database for any role", async () => {
    const s = await bankStore("bankpaid");
    const orderId = await submit(s);
    await uploadPaymentProof(db, ref(s, orderId), [PNG], write);
    expect((await orderOf(orderId)).status).toBe("awaiting_payment");
    expect(await code(transitionOrder(s.owner, orderId, "pay"))).toBe("bank_transfer_confirmation_required");
    expect(await pgCode(withStore(db, s.storeId, (tx) => tx.update(order).set({ status: "placed", paidAt: new Date() }).where(eq(order.id, orderId))))).toBe("42501");
    expect(await pgCode(withStore(platform, s.storeId, (tx) => tx.update(order).set({ status: "placed", paidAt: new Date() }).where(eq(order.id, orderId))))).toBe("42501");
    expect((await orderOf(orderId)).status).toBe("awaiting_payment");
  });

  it("the seller confirms with a reason and the proof looked at: one append-only record, the proof accepted, the order paid; a second confirmation changes nothing; staff is refused", async () => {
    const s = await bankStore("bankconfirm");
    const orderId = await submit(s);
    const { id: proofId } = await uploadPaymentProof(db, ref(s, orderId), [PNG, PNG], write);
    expect(await code(confirmBankTransfer(await staffOf(s), { orderId, reason: "dana masuk BCA", proofId }))).toBe("forbidden");
    await confirmBankTransfer(s.me, { orderId, reason: "dana masuk di mutasi BCA", proofId });
    const o = await orderOf(orderId);
    expect(o.status).toBe("placed");
    expect(o.paidAt).not.toBeNull();
    expect((await proofsOf(orderId))[0]).toMatchObject({ status: "accepted", decidedBy: s.ownerId });
    const [c] = await admin.select().from(bankTransferConfirmation).where(eq(bankTransferConfirmation.orderId, orderId));
    expect(c).toMatchObject({ proofId, confirmedBy: s.ownerId, reason: "dana masuk di mutasi BCA" });
    const history = await admin.select({ to: orderStatusHistory.toStatus, note: orderStatusHistory.note }).from(orderStatusHistory).where(eq(orderStatusHistory.orderId, orderId));
    expect(history.at(-1)).toMatchObject({ to: "placed" });
    expect(await code(confirmBankTransfer(s.me, { orderId, reason: "konfirmasi kedua" }))).toBe("already_confirmed");
    expect(await admin.select().from(bankTransferConfirmation).where(eq(bankTransferConfirmation.orderId, orderId))).toHaveLength(1);
    expect(await pgCode(admin.execute(sql`update bank_transfer_confirmation set reason = 'diubah sekali' where order_id = ${orderId}`))).toBe("42501");
    expect((await buyerBankTransfer(db, ref(s, orderId)))!).toMatchObject({ confirmed: true, canUpload: false });
  });

  it("a non-image, an oversized file, more than three files, a second upload while one waits and a burst over RL-PROOF-UPLOAD are refused and store nothing; a rejected proof allows a new upload", async () => {
    const s = await bankStore("bankupload");
    const orderId = await submit(s);
    expect(await code(uploadPaymentProof(db, ref(s, orderId), [new TextEncoder().encode("<html>not an image</html>")], write))).toBe("bad_type");
    const big = new Uint8Array(3 * 1024 * 1024 + 1); big.set(PNG);
    expect(await code(uploadPaymentProof(db, ref(s, orderId), [big], write))).toBe("too_large");
    expect(await code(uploadPaymentProof(db, ref(s, orderId), [PNG, PNG, PNG, PNG], write))).toBe("too_many_files");
    expect(await proofsOf(orderId)).toEqual([]);
    expect(files.size).toBe(0);
    const { id: first } = await uploadPaymentProof(db, ref(s, orderId), [PNG], write);
    expect(await code(uploadPaymentProof(db, ref(s, orderId), [PNG], write))).toBe("proof_waiting");
    await rejectPaymentProof(s.me, { orderId, proofId: first, reason: "nominal tidak sesuai mutasi" });
    const view = (await buyerBankTransfer(db, ref(s, orderId)))!;
    expect(view.proofs[0]).toMatchObject({ status: "rejected", rejectReason: "nominal tidak sesuai mutasi" });
    expect(view.canUpload).toBe(true);
    await uploadPaymentProof(db, ref(s, orderId), [PNG], write);
    expect((await orderOf(orderId)).status).toBe("awaiting_payment");
    // RL-PROOF-UPLOAD per order: the attempts above already count; the window refuses once the limit is passed.
    for (let i = 0; i < PROOF_UPLOAD_LIMITS.order.limit; i++) await uploadPaymentProof(db, ref(s, orderId), [PNG], write).catch(() => undefined);
    expect(await code(uploadPaymentProof(db, ref(s, orderId), [PNG], write))).toBe("rate_limited");
  });

  it("a proof is read only through its own order's signed link or by the store's finance role: another buyer's link, store A's finance role and staff get nothing", async () => {
    const a = await bankStore("bankreada");
    const b = await bankStore("bankreadb");
    const orderA = await submit(a);
    const orderOther = await submit(a);
    const orderB = await submit(b);
    const { id: proofA } = await uploadPaymentProof(db, ref(a, orderA), [PNG], write);
    const { id: proofB } = await uploadPaymentProof(db, ref(b, orderB), [PNG], write);
    const own = await resolveBuyerOrder(db, { token: signOrderLink(orderA) });
    expect((await buyerProofFile(db, own!, { proofId: proofA, n: 1 }))?.file.mime).toBe("image/png");
    const other = await resolveBuyerOrder(db, { token: signOrderLink(orderOther) });
    expect(await buyerProofFile(db, other!, { proofId: proofA, n: 1 })).toBeNull();
    expect((await sellerProofFile(a.me, orderA, { proofId: proofA, n: 1 }))?.file.key).toMatch(new RegExp(`^${a.storeId}/`));
    expect(await sellerProofFile(a.me, orderB, { proofId: proofB, n: 1 })).toBeNull();
    expect(await code(sellerProofFile(await staffOf(a), orderA, { proofId: proofA, n: 1 }))).toBe("forbidden");
    expect((await sellerBankTransferOrder(await staffOf(a), orderA))!.proofs).toBeNull();
    // Keys are the server's: the store id and a random UUID, never a name from the request, never under the public media key shape.
    const [p] = await proofsOf(orderA);
    expect(p!.files[0]!.key).toMatch(/^[0-9]+\/[0-9a-f-]{36}\.png$/);
    expect(p!.files[0]!.key).not.toMatch(/^[0-9]+\/[0-9]+\.(jpg|png|webp)$/);
  });
});

describe("T-113 expiry and retention (decision 37, D-33)", () => {
  it("an unpaid order past its payment window is cancelled and its stock returned; one with a proof waiting for the seller is kept", async () => {
    const s = await bankStore("bankexpire");
    const start = await stockOf(s.variantId);
    const late = await submit(s);
    const waiting = await submit(s);
    await uploadPaymentProof(db, ref(s, waiting), [PNG], write);
    await withoutGuard("order_bank_transfer", "order_bank_transfer_append_only", () => admin.execute(sql`update order_bank_transfer set expires_at = created_at + interval '1 second' where store_id = ${s.storeId}`));
    await new Promise((r) => setTimeout(r, 1100));
    expect(await expireBankTransferOrders(platform)).toBe(1);
    expect((await orderOf(late)).status).toBe("cancelled");
    expect((await orderOf(waiting)).status).toBe("awaiting_payment");
    expect(await stockOf(s.variantId)).toBe(start - 1);
    expect(await expireBankTransferOrders(platform)).toBe(0);
    // The scheduled job runs the same sweep.
    await runOnce(platform, { workerId: "t113" });
  });

  it("retention deletes the proof files of an order closed longer ago than the period and keeps the proof row and the confirmation record", async () => {
    const s = await bankStore("bankretain");
    const paid = await submit(s);
    const { id: proofId } = await uploadPaymentProof(db, ref(s, paid), [PNG, PNG], write);
    await confirmBankTransfer(s.me, { orderId: paid, reason: "dana masuk di mutasi", proofId });
    const keys = (await proofsOf(paid))[0]!.files.map((f) => f.key);
    const removed: string[] = [];
    const unlink = async (k: string) => { removed.push(k); };
    expect(await purgeProofFiles(platform, unlink)).toEqual({ enabled: true, purged: 0 }); // still open
    await withoutGuard(`"order"`, "order_status_guard", () => admin.execute(sql`update "order" set status = 'completed', tracking_number = 'RESI1', updated_at = now() - interval '91 days' where id = ${paid}`));
    expect(await purgeProofFiles(platform, unlink)).toEqual({ enabled: true, purged: 1 });
    expect(removed.sort()).toEqual([...keys].sort());
    expect((await proofsOf(paid))[0]).toMatchObject({ files: [], status: "accepted" });
    expect((await proofsOf(paid))[0]!.filesPurgedAt).not.toBeNull();
    expect(await admin.select().from(bankTransferConfirmation).where(eq(bankTransferConfirmation.orderId, paid))).toHaveLength(1);
    expect(await purgeProofFiles(platform, unlink)).toEqual({ enabled: true, purged: 0 });
    await admin.execute(sql`delete from retention_policy where class = 'payment_proof'`);
    expect(await purgeProofFiles(platform, unlink)).toEqual({ enabled: false, purged: 0 });
    await admin.execute(sql`insert into retention_policy (class, period_days) values ('payment_proof', 90)`);
  });
});
