import { createHmac } from "node:crypto";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { type Attempt, assertPaymentOwner, createOrderPaymentAttempt, PAYMENT_VERIFY, recordPaymentInquiry, redactPaymentCallbacks, setCallbackRetention } from "../src/payments/attempts.ts";
import { acceptPaymentCallback, callbackBodyShape } from "../src/payments/callback.ts";
import { buildSubmit, classifyAdvice, expiryStampWib, feeLabel, paymentFee, PaymentContractError, parseListPayment, parseSubmit, type PaymentCreateInput } from "../src/payments/contract.ts";
import { FakeAutoLaris } from "../src/payments/fake.ts";
import { pollAdvice, setPaymentAdapter } from "../src/payments/jobs.ts";
import { fakeProviders, type Providers } from "../src/payments/providers.ts";
import { latePaymentObligation, paymentAttempt, paymentAttemptEvent, paymentCallback, paymentObservation } from "../src/payments/schema-payments.ts";
import { callbackToken, verifyCallbackToken } from "../src/payments/signature.ts";
import { ADVICE_MAX_POLLS, CALLBACK_MAX_PER_ATTEMPT } from "../src/payments/settings.ts";
import { reconcileUnknownJobs } from "../src/ops/jobs/manage.ts";
import { runOnce } from "../src/ops/jobs/jobs.ts";
import { registeredSchedules, schedulerTick } from "../src/ops/jobs/scheduler.ts";
import type { StorefrontScope } from "../src/platform/scoped.ts";
import { withStore } from "../src/platform/tenant.ts";
import { checkoutPaymentChannels, getBuyerOrder, placeOrder } from "../src/seller/commerce/checkout.ts";
import { getOrder, transitionOrder } from "../src/seller/commerce/orders.ts";
import { job, order, orderStatusHistory, variant } from "../src/schema.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { admin, buyer, db, makeOperator, makeStore, platform } from "./helpers.ts";

// T-49 (ADR-0006 decision 6, D-21 K): the AutoLaris contract against the FAKE adapter. Every case below is a lesson of the
// Tokophi / 99ribu study that must stay true; the names say which. No network, no real provider, no real secret.

const SECRET = process.env.AUTOLARIS_CALLBACK_SECRET!;
const providersOf = (p: FakeAutoLaris): Providers => ({ ...fakeProviders, payment: p });
afterEach(() => setPaymentAdapter(null));

type Store = { sf: StorefrontScope; variantId: number; storeId: number };
async function placeTransfer(s: Store, p: FakeAutoLaris, over: Record<string, unknown> = {}) {
  const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
  const r = await placeOrder(db, cartId, buyer({ paymentMethod: "manual_transfer", paymentChannel: "VABCA", ...over }), providersOf(p));
  return { ...r, cartId };
}
const attemptOf = async (orderId: number) => (await platform.select().from(paymentAttempt).where(eq(paymentAttempt.orderId, orderId)))[0]!;
const orderRow = async (orderId: number) => (await platform.select().from(order).where(eq(order.id, orderId)))[0]!;
const jobsOf = (kind: string) => platform.select().from(job).where(eq(job.kind, kind)).orderBy(job.id);
/** Run the worker until it has nothing due (instruction jobs, verification jobs). */
async function drain(p: FakeAutoLaris, workerId = "t49") {
  const all = [];
  for (let i = 0; i < 5; i++) {
    const out = await runOnce(platform, { workerId, providers: providersOf(p) });
    if (out.length === 0) break;
    all.push(...out);
  }
  return all;
}
/** A transfer order whose instruction exists: returns the attempt with its provider transaction id. */
async function openPayment(s: Store, p: FakeAutoLaris, over: Record<string, unknown> = {}) {
  setPaymentAdapter(p);
  const placed = await placeTransfer(s, p, over);
  await drain(p);
  return { ...placed, a: await attemptOf(placed.orderId) };
}
const paidAdvice = (p: FakeAutoLaris, a: Attempt, over: Record<string, unknown> = {}) => p.adviceResults.set(a.transactionId!, { rc: "00", ket: "Sukses", data: { status: "PAID", amount: a.totalIdr, ...over } });
const callback = (a: Attempt, over: Record<string, unknown> = {}, secret?: string) => ({
  token: callbackToken(a.reffId, secret),
  rawBody: JSON.stringify({ reff_id: a.reffId, trx_id: a.transactionId, amount: a.totalIdr, status: "PAID", ...over }),
});
const makeDue = (id: number) => platform.update(job).set({ nextAttemptAt: sql`now() - interval '1 second'`, lockedUntil: sql`case when ${job.lockedUntil} is null then null else now() - interval '1 second' end` }).where(eq(job.id, id));
/** Superuser time travel on immutable columns: the guard trigger is the thing under test elsewhere, so it is lifted only here. */
async function withoutGuard(table: "payment_attempt" | "payment_callback", trigger: string, fn: () => Promise<unknown>) {
  await admin.execute(sql.raw(`alter table ${table} disable trigger ${trigger}`));
  try {
    await fn();
  } finally {
    await admin.execute(sql.raw(`alter table ${table} enable trigger ${trigger}`));
  }
}
const pgCode = (p: Promise<unknown>) => p.then(() => "allowed", (e: { cause?: { code?: string } }) => e.cause?.code);
const rejects = async (p: Promise<unknown>): Promise<PaymentContractError> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(PaymentContractError);
  return e as PaymentContractError;
};

const input = (over: Partial<PaymentCreateInput> = {}): PaymentCreateInput => ({
  reffId: "123456789012345678901234567", channelCode: "VABCA", owner: { kind: "order", id: "7" },
  customer: { id: "7", name: "Budi", phone: "081234567890", email: null }, amountIdr: 100_000, adminFeeIdr: 6_500, totalIdr: 106_500,
  expiresAt: new Date("2026-10-28T10:00:00Z"), callbackUrl: "https://bukalaris.example/api/payments/autolaris/callback?cb=x", ...over,
});
const created = (data: Record<string, unknown>) => ({ rc: "00", data: { reff_id: "123456789012345678901234567", channel_code: "VABCA", transaction_id: "874546", total: 106_500, biaya_admin: 5_000, ...data } });

describe("contract: request and response parsing (pure)", () => {
  it("the enabled channel list comes only from the provider's list: absence is the sole disabled signal, a failed or malformed list enables nothing, and discovery never creates a bill", async () => {
    const p = new FakeAutoLaris();
    p.channels = { rc: "00", data: [{ channel_code: "QRIS", name: "QRIS", admin: "0.7", tipe_admin: "persen" }] };
    expect((await p.listChannels()).map((c) => c.code)).toEqual(["QRIS"]); // VABCA is absent, hence disabled; no `active` flag exists
    expect(p.createCalls).toHaveLength(0); // never probed through create_payment
    expect(() => parseListPayment({ rc: "01", data: [] })).toThrow(PaymentContractError);
    expect(() => parseListPayment({ rc: "00", data: [{ channel_code: "VABCA" }] })).toThrow();
    expect(() => parseListPayment({ rc: "00", data: [{ channel_code: "VABCA", name: "a", admin: "1", tipe_admin: "fix" }, { channel_code: "VABCA", name: "b", admin: "1", tipe_admin: "fix" }] })).toThrow(/duplicate/);
  });

  it("checkout offers exactly the provider's list narrowed to channels the fee schedule can price (COD is not a gateway channel)", async () => {
    const p = new FakeAutoLaris();
    p.channels = { rc: "00", data: ["VABCA", "COD", "QRIS", "MYSTERY"].map((c) => ({ channel_code: c, name: c, admin: "0", tipe_admin: "fix" })) };
    expect((await checkoutPaymentChannels(p)).map((c) => c.code)).toEqual(["VABCA", "QRIS"]);
    p.channels = { rc: "00", data: [] };
    expect(await checkoutPaymentChannels(p)).toEqual([]); // a provider with no channels leaves nothing to choose: no hard-coded roster
  });

  it("the /submit request is the account-approved non-physical profile: 24 keys, courir_id 1, cod_value '0', grand_total is the buyer payable, one summary row", () => {
    const body = buildSubmit(input());
    expect(Object.keys(body)).toHaveLength(24);
    expect(body).toMatchObject({ courir_id: 1, cod_value: "0", grand_total: "106500", channel_code: "VABCA", reff_id: "123456789012345678901234567" });
    expect(body).not.toHaveProperty("courier_id");
    expect(body.order_details).toEqual([{ name: "Pembayaran Bukalaris", qty: "1", unit_price: "106500" }]);
  });

  it("expiry is YYYYMMDDHHMMSS in WIB whatever the container timezone", () => {
    const at = new Date("2026-10-28T10:00:00Z");
    for (const tz of ["UTC", "America/New_York", "Asia/Jakarta", "Pacific/Auckland"]) {
      const before = process.env.TZ;
      process.env.TZ = tz;
      try {
        expect(expiryStampWib(at)).toBe("20261028170000");
      } finally {
        if (before === undefined) delete process.env.TZ;
        else process.env.TZ = before;
      }
    }
    expect(expiryStampWib(new Date("2026-12-31T20:59:59Z"))).toBe("20270101035959"); // crosses midnight and the year in WIB
  });

  it("exactly one instruction field is accepted in a create response; none, two, oversized, a total that is not ours or a logical failure are refused", () => {
    const one = parseSubmit(created({ payment_info: { va: "8779611150001393", qr: "", url: "", expired: "2026-10-29 10:00:00" } }), input());
    expect(one).toMatchObject({ virtualAccount: "8779611150001393", qr: null, paymentCode: null, url: null, transactionId: "874546", totalIdr: 106_500, providerFeeIdr: 5_000, expiresAt: "2026-10-29 10:00:00" });
    const bad = (payment_info: Record<string, unknown>, rest: Record<string, unknown> = {}) => () => parseSubmit(created({ payment_info, ...rest }), input());
    expect(bad({ va: "", qr: "", url: "", expired: "x" })).toThrow(/exactly one/);
    expect(bad({ va: "123", qr: "000201", expired: "x" })).toThrow(/exactly one/);
    expect(bad({ qr: "x".repeat(2049), expired: "x" })).toThrow(/exactly one/);
    expect(bad({ va: 12345, expired: "x" })).toThrow(/invalid instruction/);
    expect(bad({ url: "http://insecure.example/pay", expired: "x" })).toThrow(/unsafe/);
    expect(bad({ va: "123", expired: "x" }, { total: 106_499 })).toThrow(/total mismatch/);
    expect(bad({ va: "123", expired: "x" }, { reff_id: "other" })).toThrow(/reference mismatch/);
    expect(() => parseSubmit({ rc: "07", ket: "Channel tidak aktif", data: { payment_info: { va: "123" } } }, input())).toThrow(expect.objectContaining({ code: "rejected" }));
  });

  it("the QR payload is preserved byte for byte (merchant name and CRC would break otherwise)", () => {
    const qr = "00020101021226\n  merchant NAME 6304ABCD \t";
    expect(parseSubmit(created({ payment_info: { qr, expired: "x" } }), input()).qr).toBe(qr);
  });

  it("gateway fee: each channel declares its base: QRIS 0.7% of goods omset (never shipping), VABCA Rp6.500, other VA Rp3.000, e-wallet 3.0% of payable", () => {
    expect(paymentFee("QRIS", 100_000, 123_000)).toBe(700); // payable (with shipping) is NOT the base
    expect(paymentFee("QRIS", 100_714, 150_000)).toBe(705); // 704.998 rounds half up
    expect(paymentFee("VABCA", 100_000, 123_000)).toBe(6_500);
    for (const c of ["VABNI", "VABRI", "VAMANDIRI", "VAPERMATA"]) expect(paymentFee(c, 1, 1)).toBe(3_000);
    expect(paymentFee("OVO", 100_000, 123_000)).toBe(3_690);
    expect(() => paymentFee("MYSTERY", 1, 1)).toThrow(expect.objectContaining({ code: "configuration" }));
    expect(() => paymentFee("constructor", 1, 1)).toThrow(PaymentContractError);
    expect(feeLabel("VABCA")).toBe("Biaya layanan Rp6.500");
    expect(feeLabel("QRIS")).toMatch(/0,7% dari nilai belanja/);
    expect(feeLabel("toString")).toBeNull();
  });

  it("only rc 00 + PAID + the attempt's own total is paid; rc 02 is pending; generic words, a wrong amount or a wrong code never settle", () => {
    const advice = (rc: string, status: unknown, amount: unknown = 106_500) => ({ rc, ket: "x", data: { status, amount } });
    expect(classifyAdvice(advice("00", "PAID"), 106_500)).toBe("paid");
    expect(classifyAdvice(advice("00", "PAID", "106500"), 106_500)).toBe("paid");
    expect(classifyAdvice({ rc: "02", ket: "FAILED" }, 106_500)).toBe("pending"); // Tokophi: live unpaid bills answer 02/FAILED
    for (const word of ["SUCCESS", "BERHASIL", "SUKSES", "DELIVERED", "TERKIRIM", "LUNAS", "SETTLED", "paid", "Paid", "PAID ", "", null, true]) expect(classifyAdvice(advice("00", word), 106_500), String(word)).toBe("unknown");
    expect(classifyAdvice(advice("00", "PAID", 100_000), 106_500)).toBe("unknown"); // the amount without the fee
    expect(classifyAdvice(advice("00", "PAID", 106_501), 106_500)).toBe("unknown");
    expect(classifyAdvice(advice("00", "PAID", "106500.0"), 106_500)).toBe("unknown");
    expect(classifyAdvice(advice("00", "PAID", null), 106_500)).toBe("unknown");
    for (const rc of ["01", "07", "99", "", "0"]) expect(classifyAdvice(advice(rc, "PAID"), 106_500)).toBe("unknown");
    for (const junk of [null, undefined, "PAID", 7, [], { rc: "00" }]) expect(classifyAdvice(junk, 106_500)).toBe("unknown");
  });
});

describe("signed reference (HTTP-17 authentication)", () => {
  it("a valid signed reference verifies; an invalid, tampered, re-bound or malformed one is refused; no shared-secret URL token works", () => {
    const token = callbackToken("123456789012345678901234567", SECRET);
    expect(verifyCallbackToken(token, SECRET)).toBe("123456789012345678901234567");
    const [ref, mac] = token.split(".");
    const flip = mac!.replace(/^./, mac![0] === "0" ? "1" : "0");
    for (const bad of [`${ref}.${flip}`, `999999.${mac}`, `${ref}.`, `${ref}`, ".", "", `${ref}.${mac}.x`, `${ref}.${mac!.slice(0, 31)}`, `${ref}.${mac!.toUpperCase()}`, SECRET, null]) {
      expect(() => verifyCallbackToken(bad, SECRET), String(bad)).toThrow(expect.objectContaining({ code: "binding" }));
    }
    expect(() => verifyCallbackToken(token, `${SECRET}x`)).toThrow(expect.objectContaining({ code: "binding" })); // signed with another secret
  });

  it("the signature is domain-separated and bound to the reference (a plain HMAC of the reference does not verify)", () => {
    const ref = "123456789012345678901234567";
    const naive = createHmac("sha256", SECRET).update(ref).digest("hex").slice(0, 32);
    expect(() => verifyCallbackToken(`${ref}.${naive}`, SECRET)).toThrow(expect.objectContaining({ code: "binding" }));
    expect(callbackToken(ref, SECRET)).not.toBe(callbackToken("123456789012345678901234568", SECRET));
  });

  it("a missing, empty or too short secret fails closed: nothing is signed and nothing verifies, even a valid-looking token", () => {
    for (const secret of ["", "short", "   ".repeat(20)]) {
      expect(() => callbackToken("123", secret), secret).toThrow(expect.objectContaining({ code: "configuration" }));
      expect(() => verifyCallbackToken(`123.${"a".repeat(32)}`, secret)).toThrow(expect.objectContaining({ code: "configuration" }));
    }
    const before = process.env.AUTOLARIS_CALLBACK_SECRET;
    delete process.env.AUTOLARIS_CALLBACK_SECRET;
    try {
      expect(() => verifyCallbackToken("123.abc")).toThrow(expect.objectContaining({ code: "configuration" }));
    } finally {
      process.env.AUTOLARIS_CALLBACK_SECRET = before!;
    }
    expect(() => callbackToken("bad ref!", SECRET)).toThrow(expect.objectContaining({ code: "identity" }));
  });
});

describe("persistence: reff_id first, structured instruction, one bill", () => {
  it("reff_id is persisted with the order BEFORE any provider call, and every retry replays that same reff_id", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    setPaymentAdapter(p);
    const { orderId } = await placeTransfer(s, p);
    const a = await attemptOf(orderId);
    expect(a.reffId).toMatch(/^[0-9]{1,30}$/); // the provider's documented 30-digit limit
    expect(p.createCalls).toHaveLength(0); // nothing was called yet
    expect(a).toMatchObject({ requestState: "in_progress", status: "pending", ownerKind: "order", ownerId: String(orderId), revision: 1 });
    expect(await platform.select().from(paymentAttemptEvent).where(eq(paymentAttemptEvent.attemptId, a.id))).toMatchObject([{ revision: 1, kind: "created" }]);

    p.down = true; // the first call never reaches the provider
    await drain(p);
    p.down = false;
    await reconcileUnknownJobs(platform);
    await drain(p);
    expect(p.createCalls.map((c) => c.reffId)).toEqual([a.reffId, a.reffId]);
    expect(p.bills.size).toBe(1);
    expect(await attemptOf(orderId)).toMatchObject({ reffId: a.reffId, requestState: "accepted" });
  });

  it("the instruction is stored structured and atomically with the provider transaction id; the buyer view hides provider data and keeps the QR byte for byte", async () => {
    const s = await makeStore("toko-a", { price: 100_000 });
    const p = new FakeAutoLaris();
    const { orderId, cartId, a } = await openPayment(s, p, { paymentChannel: "QRIS" });
    expect(a).toMatchObject({ requestState: "accepted", channelCode: "QRIS", transactionId: expect.stringMatching(/^SIM-/) });
    expect(a.instruction).toMatchObject({ qr: "000201010212\n  QRIS-BYTES-UNCHANGED-6304ABCD ", virtualAccount: null, paymentCode: null, url: null, reference: a.reffId, transactionId: a.transactionId });
    const view = (await getBuyerOrder(db, orderId, cartId))!.payment!;
    expect(view.instruction).toEqual({ qr: "000201010212\n  QRIS-BYTES-UNCHANGED-6304ABCD ", virtualAccount: null, paymentCode: null, url: null, expiresAt: expect.stringMatching(/^[0-9]{14}$/) });
    expect(JSON.stringify(view)).not.toContain(a.transactionId!);
    expect(view).not.toHaveProperty("providerFeeIdr");
    // QRIS is 0.7% of the goods omset (the subtotal), not of the payable total that includes shipping.
    const o = await orderRow(orderId);
    expect(view).toMatchObject({ amountIdr: o.total, adminFeeIdr: 700, totalIdr: o.total + 700 });
    // The instruction is one value: every column that depends on it exists together, enforced by the database.
    expect(await pgCode(admin.execute(sql`update payment_attempt set request_state = 'accepted', transaction_id = null where id = ${a.id}`))).toBe("23514");
  });

  it("a logical rejection ends the attempt as failed (job done); a malformed or ambiguous answer is an UNKNOWN outcome that blocks a second bill", async () => {
    const s = await makeStore("toko-a");
    const rejected = new FakeAutoLaris();
    rejected.createResult = { rc: "07", ket: "Channel tidak aktif" };
    const r = await openPayment(s, rejected);
    expect(r.a).toMatchObject({ requestState: "failed", transactionId: null });
    expect(rejected.bills.size).toBe(0);
    expect((await jobsOf("payment.instruction"))[0]).toMatchObject({ status: "done" });

    const ambiguous = new FakeAutoLaris();
    ambiguous.createResult = { rc: "00", data: { payment_info: { va: "123", qr: "000201", expired: "x" } } }; // two instruction fields
    const s2 = await makeStore("toko-b");
    const u = await openPayment(s2, ambiguous);
    expect(u.a).toMatchObject({ requestState: "unknown", transactionId: null });
    const j = (await jobsOf("payment.instruction")).find((x) => x.storeId === s2.storeId)!;
    expect(j).toMatchObject({ status: "unknown" }); // dispatched: never re-run
    await makeDue(j.id);
    await drain(ambiguous);
    expect(ambiguous.createCalls).toHaveLength(1);
  });

  it("a channel the provider no longer lists at creation time is never sent: the attempt fails without a provider create call", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    setPaymentAdapter(p);
    const { orderId } = await placeTransfer(s, p, { paymentChannel: "QRIS" });
    p.channels = { rc: "00", data: [{ channel_code: "VABCA", name: "BCA", admin: "6500", tipe_admin: "fix" }] };
    await drain(p);
    expect(p.createCalls).toHaveLength(0);
    expect(await attemptOf(orderId)).toMatchObject({ requestState: "failed" });
  });

  it("checkout refuses a channel that is not in the provider's current list, a COD channel and a missing channel", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    p.channels = { rc: "00", data: [{ channel_code: "VABCA", name: "BCA", admin: "6500", tipe_admin: "fix" }, { channel_code: "COD", name: "COD", admin: "0", tipe_admin: "fix" }] };
    for (const paymentChannel of ["QRIS", "COD", "MYSTERY", undefined]) {
      const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
      await expect(placeOrder(db, cartId, buyer({ paymentMethod: "manual_transfer", paymentChannel }), providersOf(p)), String(paymentChannel)).rejects.toMatchObject({ code: "payment_channel" });
    }
    expect(await platform.select().from(paymentAttempt)).toHaveLength(0);
    expect(await platform.select().from(order)).toHaveLength(0); // the order was not created either
  });

  it("a duplicate submit of the same checkout creates one order, one attempt, one reff_id and one instruction job", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const body = buyer({ paymentMethod: "manual_transfer", paymentChannel: "VABCA" });
    const results = await Promise.all(Array.from({ length: 4 }, () => placeOrder(db, cartId, body, providersOf(p))));
    expect(new Set(results.map((r) => r.orderId)).size).toBe(1);
    expect(await platform.select().from(paymentAttempt)).toHaveLength(1);
    expect(await jobsOf("payment.instruction")).toHaveLength(1);
    expect(await platform.select().from(paymentAttemptEvent)).toHaveLength(1);
  });

  it("a second attempt for an order is refused while one exists (pending or order cancelled); the same request replays the same attempt", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { orderId } = await placeTransfer(s, p);
    const a = await attemptOf(orderId);
    const scope = { exec: db, storeId: s.storeId };
    const same = { orderId, requestKey: a.requestKey, channelCode: a.channelCode, customer: a.customer, amountIdr: a.amountIdr, adminFeeIdr: a.adminFeeIdr };
    const replay = await Promise.all([createOrderPaymentAttempt(scope, same), createOrderPaymentAttempt(scope, same)]);
    expect(replay.map((r) => r.reffId)).toEqual([a.reffId, a.reffId]);
    await expect(createOrderPaymentAttempt(scope, { ...same, requestKey: "another-request" })).rejects.toMatchObject({ code: "payment_conflict" });
    await expect(createOrderPaymentAttempt(scope, { ...same, channelCode: "QRIS" })).rejects.toMatchObject({ code: "payment_conflict" });
    await transitionOrder(s.owner, orderId, "cancel", { reason: "Pembeli berubah pikiran" });
    await expect(createOrderPaymentAttempt(scope, { ...same, requestKey: "after-cancel" })).rejects.toMatchObject({ code: "payment_conflict" });
    expect(await platform.select().from(paymentAttempt)).toHaveLength(1);
  });

  it("the instruction job fails closed without a callback secret: no provider call is made and the order keeps its explicit pending state", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    setPaymentAdapter(p);
    const { orderId } = await placeTransfer(s, p);
    const before = process.env.AUTOLARIS_CALLBACK_SECRET;
    delete process.env.AUTOLARIS_CALLBACK_SECRET;
    try {
      const out = (await drain(p)).filter((o) => o.kind === "payment.instruction");
      expect(out).toMatchObject([{ status: "pending", error: expect.stringContaining("configuration missing") }]);
    } finally {
      process.env.AUTOLARIS_CALLBACK_SECRET = before!;
    }
    expect(p.createCalls).toHaveLength(0);
    expect(await attemptOf(orderId)).toMatchObject({ requestState: "in_progress", transactionId: null });
  });

  it("the callback URL handed to the provider carries the signed reference of THIS attempt and no shared-secret token", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { a } = await openPayment(s, p);
    const url = new URL(p.createCalls[0]!.callbackUrl);
    expect(url.pathname).toBe("/api/payments/autolaris/callback");
    expect([...url.searchParams.keys()]).toEqual(["cb"]);
    expect(verifyCallbackToken(url.searchParams.get("cb"), SECRET)).toBe(a.reffId);
    expect(url.toString()).not.toContain(SECRET);
  });
});

describe("callback = trigger only; verification by pull settles (D-21 K)", () => {
  it("a callback alone never moves money: even a perfect 'PAID' body only records the digest and enqueues a verification job", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { orderId, a } = await openPayment(s, p);
    const res = await acceptPaymentCallback(db, callback(a));
    expect(res).toEqual({ outcome: "accepted", quarantined: false });
    expect(await orderRow(orderId)).toMatchObject({ status: "awaiting_payment", paidAt: null });
    expect(await attemptOf(orderId)).toMatchObject({ status: "pending", paidAt: null, revision: 2 }); // untouched since the instruction was stored
    const rows = await platform.select().from(paymentCallback);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attemptId: a.id, storeId: s.storeId, quarantined: null, bodyShape: { amount: "number", reff_id: `string(${a.reffId.length})`, status: "string(4)", trx_id: expect.any(String) } });
    expect(rows[0]!.bodySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await jobsOf(PAYMENT_VERIFY)).toMatchObject([{ status: "pending", storeId: s.storeId, payload: { attemptId: a.id } }]);
    expect(p.adviceCalls).toEqual([]); // the request itself did not call the provider
  });

  it("a verification job pulls the provider inquiry and settles: rc 00 + PAID + equal amount marks the attempt paid and the order paid exactly once, with history", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { orderId, a } = await openPayment(s, p);
    paidAdvice(p, a);
    await acceptPaymentCallback(db, callback(a));
    expect((await drain(p)).filter((o) => o.kind === PAYMENT_VERIFY)).toMatchObject([{ status: "done" }]);
    expect(p.adviceCalls).toEqual([a.transactionId]); // by the provider's transaction id, never our reff_id
    expect(await attemptOf(orderId)).toMatchObject({ status: "paid", paidAt: expect.any(Date) });
    expect(await orderRow(orderId)).toMatchObject({ status: "placed", paidAt: expect.any(Date) });
    expect(await platform.select().from(orderStatusHistory).where(eq(orderStatusHistory.orderId, orderId))).toMatchObject([{ fromStatus: "awaiting_payment", toStatus: "placed", actorUserId: "system:payment-inquiry" }]);
    expect((await platform.select().from(paymentAttemptEvent).where(eq(paymentAttemptEvent.attemptId, a.id))).map((e) => e.kind)).toEqual(["created", "accepted", "paid"]);
    expect(await platform.select().from(latePaymentObligation)).toHaveLength(0);
  });

  it("generic words, delivery vocabulary, pending, a wrong amount or a wrong code never settle, whatever the callback body claimed", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { orderId, a } = await openPayment(s, p);
    const answers: [string, unknown, string][] = [
      ["generic SUCCESS", { rc: "00", ket: "SUCCESS", data: { status: "SUCCESS", amount: a.totalIdr } }, "unknown"],
      ["shipping DELIVERED", { rc: "00", ket: "DELIVERED", data: { status: "DELIVERED", amount: a.totalIdr } }, "unknown"],
      ["PAID with the amount without fee", { rc: "00", data: { status: "PAID", amount: a.amountIdr } }, "unknown"],
      ["PAID with a non-00 code", { rc: "01", data: { status: "PAID", amount: a.totalIdr } }, "unknown"],
      ["02 pending", { rc: "02", ket: "PENDING", data: { awb: "" } }, "pending"],
    ];
    for (const [label, answer, status] of answers) {
      p.adviceResults.set(a.transactionId!, answer);
      await acceptPaymentCallback(db, callback(a, { status: "PAID", nonce: label })); // the callback body CLAIMS paid every time
      await drain(p);
      expect(await attemptOf(orderId), label).toMatchObject({ status, paidAt: null });
      expect(await orderRow(orderId), label).toMatchObject({ status: "awaiting_payment", paidAt: null });
    }
    expect(await platform.select().from(orderStatusHistory).where(eq(orderStatusHistory.orderId, orderId))).toHaveLength(0);
    expect(await platform.select().from(paymentObservation)).toHaveLength(answers.length); // every inquiry is recorded
  });

  it("an amount mismatch is refused: the amount without the gateway fee, off by one, non-integer, missing or negative creates no evidence and no job", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { a } = await openPayment(s, p);
    for (const amount of [a.amountIdr, a.totalIdr - 1, a.totalIdr + 1, `${a.totalIdr}.5`, "abc", null, undefined, -a.totalIdr, 0, [a.totalIdr], { v: 1 }, true]) {
      const err = await rejects(acceptPaymentCallback(db, callback(a, { amount })));
      expect(err.code, String(amount)).toBe("amount");
      expect(err.message).not.toContain(a.reffId); // only a redacted shape is reported
    }
    expect(await platform.select().from(paymentCallback)).toHaveLength(0);
    expect(await jobsOf(PAYMENT_VERIFY)).toHaveLength(0);
    expect(callbackBodyShape({ amount: 123, name: "Budi", nested: {}, list: [] })).toEqual({ amount: "number", list: "array", name: "string(4)", nested: "object" });
    // The exact total (number or digit string) passes.
    await acceptPaymentCallback(db, callback(a, { amount: String(a.totalIdr) }));
    expect(await platform.select().from(paymentCallback)).toHaveLength(1);
  });

  it("the signed reference is bound to its attempt: another order's body, another provider transaction, a missing identity or an unknown reference are refused", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const first = await openPayment(s, p);
    const second = await openPayment(s, p);
    const ok = callback(first.a);
    expect((await rejects(acceptPaymentCallback(db, { token: ok.token, rawBody: callback(second.a).rawBody }))).code).toBe("binding"); // valid URL replayed with the other order's body
    expect((await rejects(acceptPaymentCallback(db, callback(first.a, { reff_id: second.a.reffId, trx_id: undefined })))).code).toBe("binding"); // another order's reference, nothing else wrong
    expect((await rejects(acceptPaymentCallback(db, callback(first.a, { trx_id: second.a.transactionId })))).code).toBe("binding");
    expect((await rejects(acceptPaymentCallback(db, callback(first.a, { reff_id: undefined, trx_id: undefined })))).code).toBe("identity");
    expect((await rejects(acceptPaymentCallback(db, callback(first.a, { reff_id: "", trx_id: " " })))).code).toBe("identity");
    expect((await rejects(acceptPaymentCallback(db, { token: callbackToken("999999999999999999999999999", SECRET), rawBody: ok.rawBody }))).code).toBe("not_found");
    expect((await rejects(acceptPaymentCallback(db, { token: ok.token, rawBody: "not json" }))).code).toBe("malformed");
    expect((await rejects(acceptPaymentCallback(db, { token: ok.token, rawBody: "[1]" }))).code).toBe("malformed");
    expect((await rejects(acceptPaymentCallback(db, { token: ok.token, rawBody: JSON.stringify({ reff_id: first.a.reffId, amount: first.a.totalIdr, pad: "x".repeat(20_000) }) }))).code).toBe("too_large");
    expect((await rejects(acceptPaymentCallback(db, { token: `${ok.token}0`, rawBody: ok.rawBody }))).code).toBe("binding");
    expect((await rejects(acceptPaymentCallback(db, { token: null, rawBody: ok.rawBody }))).code).toBe("binding");
    expect((await rejects(acceptPaymentCallback(db, { ...ok, secret: "" }))).code).toBe("configuration"); // missing configuration fails closed
    expect(await platform.select().from(paymentCallback)).toHaveLength(0);
    expect(await jobsOf(PAYMENT_VERIFY)).toHaveLength(0);
    // A body that names only the provider transaction (no reff_id) is accepted for the matching attempt.
    expect(await acceptPaymentCallback(db, callback(first.a, { reff_id: undefined }))).toMatchObject({ outcome: "accepted" });
  });

  it("a replayed callback is harmless: one evidence row and one verification job however many times the same body arrives", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { a } = await openPayment(s, p);
    const c = callback(a);
    expect((await acceptPaymentCallback(db, c)).outcome).toBe("accepted");
    expect((await acceptPaymentCallback(db, c)).outcome).toBe("replayed");
    expect((await acceptPaymentCallback(db, c)).outcome).toBe("replayed");
    expect(await platform.select().from(paymentCallback)).toHaveLength(1);
    expect(await jobsOf(PAYMENT_VERIFY)).toHaveLength(1);
  });

  it("concurrent duplicate callbacks and verifications settle once: one paid event, one order transition, one history row", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { orderId, a } = await openPayment(s, p);
    paidAdvice(p, a);
    // The same body five times at once: one is accepted, the rest are replays.
    const same = callback(a);
    const dups = await Promise.all(Array.from({ length: 5 }, () => acceptPaymentCallback(db, same)));
    expect(dups.filter((d) => d.outcome === "accepted")).toHaveLength(1);
    // Four distinct bodies (a provider that retries with new fields): four verification jobs, run by four workers at once.
    await Promise.all([1, 2, 3, 4].map((n) => acceptPaymentCallback(db, callback(a, { retry: n }))));
    expect(await jobsOf(PAYMENT_VERIFY)).toHaveLength(5);
    const outs = await Promise.all([1, 2, 3, 4, 5].map((n) => runOnce(platform, { workerId: `w${n}`, batch: 1, providers: providersOf(p) })));
    expect(outs.flat().filter((o) => o.kind === PAYMENT_VERIFY && o.status === "done").length).toBeGreaterThanOrEqual(5);
    expect(await attemptOf(orderId)).toMatchObject({ status: "paid" });
    expect(await orderRow(orderId)).toMatchObject({ status: "placed" });
    expect(await platform.select().from(orderStatusHistory).where(eq(orderStatusHistory.orderId, orderId))).toHaveLength(1);
    expect((await platform.select().from(paymentAttemptEvent).where(and(eq(paymentAttemptEvent.attemptId, a.id), eq(paymentAttemptEvent.kind, "paid")))).length).toBe(1);
    // A late replay after settlement changes nothing and `paid` is never regressed by a later pending answer.
    p.adviceResults.set(a.transactionId!, { rc: "02", ket: "FAILED" });
    await acceptPaymentCallback(db, callback(a, { retry: "late" }));
    await drain(p);
    expect(await attemptOf(orderId)).toMatchObject({ status: "paid" });
    expect(await orderRow(orderId)).toMatchObject({ status: "placed" });
  });

  it("a callback for a terminal (cancelled) order is quarantined: the verified payment is paid for audit only, opens a refund obligation and never marks the order paid", async () => {
    const s = await makeStore("toko-a", { stock: 5 });
    const p = new FakeAutoLaris();
    const { orderId, a } = await openPayment(s, p);
    await transitionOrder(s.owner, orderId, "cancel", { reason: "Pembeli berubah pikiran" });
    paidAdvice(p, a);
    expect(await acceptPaymentCallback(db, callback(a))).toEqual({ outcome: "accepted", quarantined: true });
    expect((await platform.select().from(paymentCallback))[0]).toMatchObject({ quarantined: "terminal_order" });
    await drain(p);
    expect(await attemptOf(orderId)).toMatchObject({ status: "paid" }); // audit: money was received
    expect(await platform.select().from(latePaymentObligation)).toMatchObject([{ attemptId: a.id, orderId, amountIdr: a.totalIdr, status: "open" }]); // the whole payable incl. the gateway fee (D-20 item 7)
    expect(await orderRow(orderId)).toMatchObject({ status: "cancelled", paidAt: null });
    expect(await platform.select().from(orderStatusHistory).where(and(eq(orderStatusHistory.orderId, orderId), eq(orderStatusHistory.toStatus, "placed")))).toHaveLength(0);
    expect((await platform.select().from(variant).where(eq(variant.id, s.variantId)))[0]!.stock).toBe(5); // the cancellation restock is untouched
    // More callbacks and verifications create no second obligation.
    await acceptPaymentCallback(db, callback(a, { retry: 2 }));
    await drain(p);
    expect(await platform.select().from(latePaymentObligation)).toHaveLength(1);
  });

  it("an order the seller confirmed manually stays untouched when the provider later verifies the payment: the attempt becomes paid, the order gets no second transition", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { orderId, a } = await openPayment(s, p);
    await transitionOrder(s.owner, orderId, "pay");
    paidAdvice(p, a);
    await acceptPaymentCallback(db, callback(a));
    await drain(p);
    expect(await attemptOf(orderId)).toMatchObject({ status: "paid" });
    expect(await platform.select().from(orderStatusHistory).where(eq(orderStatusHistory.orderId, orderId))).toHaveLength(1);
    expect(await platform.select().from(latePaymentObligation)).toHaveLength(0);
  });

  it("an inquiry that crashes after dispatch becomes unknown, is never re-dispatched blindly, and is reconciled by pull", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { orderId, a } = await openPayment(s, p);
    paidAdvice(p, a);
    p.crashAdvice = true;
    await acceptPaymentCallback(db, callback(a));
    const out = (await drain(p)).filter((o) => o.kind === PAYMENT_VERIFY);
    expect(out).toMatchObject([{ status: "unknown", attempts: 1 }]);
    const verify = (await jobsOf(PAYMENT_VERIFY))[0]!;
    expect(verify).toMatchObject({ status: "unknown" });
    await makeDue(verify.id);
    expect((await drain(p)).filter((o) => o.kind === PAYMENT_VERIFY)).toEqual([]); // not claimed again
    expect(p.adviceCalls).toHaveLength(1);
    expect(await orderRow(orderId)).toMatchObject({ status: "awaiting_payment" });
    p.crashAdvice = false;
    expect(await reconcileUnknownJobs(platform)).toMatchObject({ settled: 1 });
    expect(p.adviceCalls).toHaveLength(2); // the reconciler PULLED; the job itself was not re-run
    expect(await jobsOf(PAYMENT_VERIFY)).toMatchObject([{ status: "done", attempts: 1 }]);
    expect(await attemptOf(orderId)).toMatchObject({ status: "paid" });
    expect(await orderRow(orderId)).toMatchObject({ status: "placed" });
  });

  it("a creation that crashes after dispatch becomes unknown, no second bill is created, and recovery by the same reff_id stores the existing bill", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    p.crashAfterCreate = true; // the provider created the bill, the response was lost
    setPaymentAdapter(p);
    const { orderId } = await placeTransfer(s, p);
    const out = (await drain(p)).filter((o) => o.kind === "payment.instruction");
    expect(out).toMatchObject([{ status: "unknown" }]);
    expect(await attemptOf(orderId)).toMatchObject({ requestState: "unknown", transactionId: null });
    const j = (await jobsOf("payment.instruction"))[0]!;
    await makeDue(j.id);
    expect(await drain(p)).toEqual([]);
    expect(p.createCalls).toHaveLength(1);
    p.crashAfterCreate = false;
    expect(await reconcileUnknownJobs(platform)).toMatchObject({ settled: 1 });
    expect(p.createCalls).toHaveLength(1); // recovered, not re-created
    expect(p.bills.size).toBe(1);
    expect(await attemptOf(orderId)).toMatchObject({ requestState: "accepted", transactionId: expect.stringMatching(/^SIM-/) });
    expect(await jobsOf("payment.instruction")).toMatchObject([{ status: "done" }]);
  });

  it("an adapter that cannot look a bill up (a live account) leaves the unknown creation blocked for manual recovery", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    p.crashAfterCreate = true;
    const blind = { mode: "fake" as const, listChannels: () => p.listChannels(), submit: (i: PaymentCreateInput) => p.submit(i), advice: (i: { transactionId: string }) => p.advice(i) }; // no recoverCreate
    setPaymentAdapter(blind);
    const { orderId } = await placeTransfer(s, p);
    await drain(p);
    expect(await reconcileUnknownJobs(platform)).toMatchObject({ settled: 0, pending: 1 });
    expect(await attemptOf(orderId)).toMatchObject({ requestState: "unknown" });
    expect(await jobsOf("payment.instruction")).toMatchObject([{ status: "unknown" }]);
  });

  it("live settlement stays operator-confirmed: a live adapter's verified PAID is recorded but settles nothing while ADVICE_SETTLED is empty", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { orderId, a } = await openPayment(s, p);
    const scope = { exec: platform, storeId: s.storeId };
    const live = await recordPaymentInquiry(scope, a.id, { rc: "00", data: { status: "PAID", amount: a.totalIdr } }, { source: "callback", mode: "live" });
    expect(live).toEqual({ classification: "paid", applied: false, quarantined: false });
    expect(await attemptOf(orderId)).toMatchObject({ status: "pending" });
    expect(await orderRow(orderId)).toMatchObject({ status: "awaiting_payment" });
    const observed = await platform.select().from(paymentObservation);
    expect(observed).toMatchObject([{ source: "callback", classification: "paid" }]);
    expect(await recordPaymentInquiry(scope, a.id, { rc: "00", data: { status: "PAID", amount: a.totalIdr } }, { source: "poll", mode: "fake" })).toMatchObject({ applied: false }); // the poll is observe-only even for the fake
    expect(await attemptOf(orderId)).toMatchObject({ status: "pending" });
  });
});

describe("JOB-25 advice poll: bounded, observe-only, scheduled through T-74", () => {
  const due = async (id: string) => admin.execute(sql`update payment_attempt set next_advice_at = now() - interval '1 minute' where id = ${id}`);

  it("is a registered minute schedule on a registered platform kind; a tick enqueues it once per period and the job polls the due attempt", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { orderId, a } = await openPayment(s, p);
    expect(registeredSchedules().find((x) => x.kind === "payment.advice_poll")).toEqual({ kind: "payment.advice_poll", period: "minute", catchUp: 0 });
    expect(registeredSchedules().find((x) => x.kind === "payment.callback_redact")).toMatchObject({ period: "day" });
    await due(a.id);
    const now = new Date();
    const tick = await schedulerTick(platform, { now, tickIntervalMs: 30_000 });
    expect(tick.enqueued.filter((e) => e.kind === "payment.advice_poll")).toHaveLength(1);
    expect((await schedulerTick(platform, { now, tickIntervalMs: 30_000 })).enqueued.filter((e) => e.kind === "payment.advice_poll")).toHaveLength(0);
    expect((await drain(p)).filter((o) => o.kind === "payment.advice_poll")).toMatchObject([{ status: "done" }]);
    expect(p.adviceCalls).toEqual([a.transactionId]);
    expect(await attemptOf(orderId)).toMatchObject({ advicePolls: 1, status: "pending" });
  });

  it("records what the provider answered and NEVER changes payment or order state, even when the answer says PAID", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { orderId, a } = await openPayment(s, p);
    paidAdvice(p, a);
    await due(a.id);
    expect(await pollAdvice(platform, p)).toBe(1);
    expect(await platform.select().from(paymentObservation)).toMatchObject([{ source: "poll", classification: "paid", attemptId: a.id }]);
    expect(await attemptOf(orderId)).toMatchObject({ status: "pending", paidAt: null, revision: 2 });
    expect(await orderRow(orderId)).toMatchObject({ status: "awaiting_payment", paidAt: null });
    expect(await pollAdvice(platform, p)).toBe(0); // not due again for the interval
  });

  it("is bounded: ADVICE_MAX_POLLS regular polls, then one final poll after expiry, then nothing; an unreachable provider counts as an unknown observation", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { a } = await openPayment(s, p);
    p.crashAdvice = true;
    await due(a.id);
    expect(await pollAdvice(platform, p)).toBe(1);
    expect(await platform.select().from(paymentObservation)).toMatchObject([{ classification: "unknown" }]);
    await admin.execute(sql`update payment_attempt set advice_polls = ${ADVICE_MAX_POLLS}, next_advice_at = now() - interval '1 minute' where id = ${a.id}`);
    expect(await pollAdvice(platform, p)).toBe(0); // regular budget spent
    await withoutGuard("payment_attempt", "payment_attempt_guard", () => admin.execute(sql`update payment_attempt set expires_at = now() - interval '1 hour' where id = ${a.id}`));
    expect(await pollAdvice(platform, p)).toBe(1); // the final poll at expiry
    expect(await attemptOf(a.orderId)).toMatchObject({ finalAdviceAt: expect.any(Date) });
    expect(await pollAdvice(platform, p)).toBe(0);
    expect(p.adviceCalls).toHaveLength(2);
  });

  it("does not poll attempts without a provider bill (in progress, failed, unknown) or already paid", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    setPaymentAdapter(p);
    const { orderId } = await placeTransfer(s, p); // instruction job not run: no transaction id
    await admin.execute(sql`update payment_attempt set next_advice_at = now() - interval '1 minute'`);
    expect(await pollAdvice(platform, p)).toBe(0);
    expect((await attemptOf(orderId)).transactionId).toBeNull();
  });
});

describe("isolation and database guarantees", () => {
  it("cross-store denial: the callback of one store's payment lands only in that store; another store's seller and context never see it", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const p = new FakeAutoLaris();
    const first = await openPayment(a, p);
    const second = await openPayment(b, p);
    await acceptPaymentCallback(db, callback(second.a));
    expect(await platform.select().from(paymentCallback)).toMatchObject([{ storeId: b.storeId, attemptId: second.a.id }]);
    expect(await jobsOf(PAYMENT_VERIFY)).toMatchObject([{ storeId: b.storeId }]);
    const seenFromA = await withStore(db, a.storeId, (tx) => tx.select({ id: paymentAttempt.id }).from(paymentAttempt));
    expect(seenFromA).toEqual([{ id: first.a.id }]);
    expect(await withStore(db, a.storeId, (tx) => tx.select({ id: paymentCallback.id }).from(paymentCallback))).toEqual([]);
    expect(await getOrder(a.owner, second.orderId)).toBeNull(); // the seller of store A cannot open store B's order or its payment
    expect(await getBuyerOrder(db, second.orderId, first.cartId)).toBeNull();
    // Without a store context the app role reads and writes nothing (fail closed).
    expect(await db.select().from(paymentAttempt)).toEqual([]);
    expect(await pgCode(db.insert(paymentAttemptEvent).values({ storeId: b.storeId, attemptId: second.a.id, revision: 9, kind: "forged" }))).toBe("42501");
  });

  it("an order attempt never settles an invoice reference and the reverse: owner kind and id must match, and this table holds order attempts only", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { orderId, a } = await openPayment(s, p);
    expect(() => assertPaymentOwner(a, { kind: "order", id: String(orderId) })).not.toThrow();
    expect(() => assertPaymentOwner(a, { kind: "subscription_invoice", id: String(orderId) })).toThrow(expect.objectContaining({ code: "binding" }));
    expect(() => assertPaymentOwner(a, { kind: "order", id: String(orderId + 1) })).toThrow(expect.objectContaining({ code: "binding" }));
    expect(() => assertPaymentOwner({ ownerKind: "subscription_invoice", ownerId: "9" }, { kind: "order", id: "9" })).toThrow(expect.objectContaining({ code: "binding" }));
    expect(await pgCode(admin.execute(sql`update payment_attempt set owner_kind = 'subscription_invoice' where id = ${a.id}`))).toBe("23514");
  });

  it("money and identity are immutable and `paid` is monotonic, in the database, whoever writes", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { orderId, a } = await openPayment(s, p);
    paidAdvice(p, a);
    await acceptPaymentCallback(db, callback(a));
    await drain(p);
    for (const set of [sql`total_idr = total_idr - 1000, admin_fee_idr = admin_fee_idr - 1000`, sql`amount_idr = amount_idr + 1, total_idr = total_idr + 1`, sql`reff_id = '1'`, sql`channel_code = 'QRIS'`, sql`status = 'pending'`, sql`status = 'unknown'`, sql`paid_at = now() + interval '1 day'`, sql`transaction_id = 'OTHER'`, sql`instruction = '{}'::jsonb`, sql`request_state = 'unknown'`, sql`revision = 1`, sql`expires_at = now()`]) {
      await expect(platform.execute(sql`update payment_attempt set ${set} where id = ${a.id}`), set.queryChunks.join("")).rejects.toMatchObject({ cause: { code: "23514" } });
    }
    expect(await attemptOf(orderId)).toMatchObject({ status: "paid", totalIdr: a.totalIdr });
    // The total is also fixed by its own identity: no fee-netting drift (UNVERIFIED for Bukalaris) can rewrite it.
    expect(await pgCode(platform.execute(sql`update payment_attempt set total_idr = 1 where id = ${a.id}`))).toBe("23514");
  });

  it("role boundaries: the app role cannot update an attempt or read provider observations; the platform role cannot touch callback evidence; evidence is append-only", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { a } = await openPayment(s, p);
    await acceptPaymentCallback(db, callback(a));
    paidAdvice(p, a);
    await drain(p);
    const asApp = (stmt: SQL) => pgCode(withStore(db, s.storeId, (tx) => tx.execute(stmt)));
    expect(await asApp(sql`update payment_attempt set status = 'paid'`)).toBe("42501");
    expect(await asApp(sql`delete from payment_attempt`)).toBe("42501");
    expect(await asApp(sql`select * from payment_observation`)).toBe("42501");
    expect(await asApp(sql`select * from late_payment_obligation`)).toBe("42501");
    expect(await asApp(sql`update payment_callback set raw_body = null`)).toBe("42501");
    expect(await pgCode(platform.execute(sql`update payment_callback set raw_body = null`))).toBe("42501");
    expect(await pgCode(platform.execute(sql`delete from payment_callback`))).toBe("42501");
    expect(await pgCode(platform.execute(sql`delete from payment_attempt`))).toBe("42501");
    for (const t of ["payment_attempt_event", "payment_observation"]) {
      expect(await pgCode(platform.execute(sql.raw(`update ${t} set kind = 'x'`.replace("kind", t === "payment_observation" ? "source" : "kind")))), `${t} update`).toBe("42501");
      expect(await pgCode(platform.execute(sql.raw(`delete from ${t}`))), `${t} delete`).toBe("42501");
      expect(await pgCode(admin.execute(sql.raw(`delete from ${t}`))), `${t} delete as owner`).toBe("42501"); // the append-only trigger holds against the owner too
    }
  });

  it("a terminal order never receives a new attempt: an order cancelled without one refuses it", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { orderId } = await placeTransfer(s, p);
    const a = await attemptOf(orderId);
    // Remove the attempt the way only a superuser can (rows are append-only evidence), then cancel: the order has none and is terminal.
    await admin.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      for (const t of ["payment_attempt_event", "payment_attempt"]) await tx.execute(sql.raw(`delete from ${t}`));
      await tx.execute(sql`delete from job where kind = 'payment.instruction'`);
    });
    await transitionOrder(s.owner, orderId, "cancel", { reason: "Pembeli berubah pikiran" });
    await expect(createOrderPaymentAttempt({ exec: db, storeId: s.storeId }, { orderId, requestKey: a.requestKey, channelCode: "VABCA", customer: a.customer, amountIdr: a.amountIdr, adminFeeIdr: a.adminFeeIdr })).rejects.toMatchObject({ code: "terminal_order" });
    expect(await platform.select().from(paymentAttempt)).toHaveLength(0);
  });

  it("the demo reset function removes payment rows of demo stores only", async () => {
    const s = await makeStore("toko-a"); // not a demo store
    const p = new FakeAutoLaris();
    await openPayment(s, p);
    expect(Number((await admin.execute<{ n: string }>(sql`select reset_demo_payments(array[${s.storeId}]::bigint[]) as n`))[0]!.n)).toBe(0);
    expect(await platform.select().from(paymentAttempt)).toHaveLength(1);
    await admin.execute(sql`update store set slug = 'demo-toko-a' where id = ${s.storeId}`);
    expect(Number((await admin.execute<{ n: string }>(sql`select reset_demo_payments(array[${s.storeId}]::bigint[]) as n`))[0]!.n)).toBeGreaterThan(0);
    expect(await platform.select().from(paymentAttempt)).toHaveLength(0);
    // The marker is transaction-local: evidence is protected again right after the call.
    await openPayment(s, p);
    expect(await pgCode(admin.execute(sql`delete from payment_attempt_event`))).toBe("42501");
  });

  it("wave 2 review P1: the platform login cannot erase payment evidence, not even after renaming a store to demo-*", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    await openPayment(s, p);
    expect(await pgCode(platform.execute(sql`select reset_demo_payments(array[${s.storeId}]::bigint[])`))).toBe("42501");
    await platform.execute(sql`update store set slug = 'demo-toko-a' where id = ${s.storeId}`); // the platform role can write the slug...
    expect(await pgCode(platform.execute(sql`select reset_demo_payments(array[${s.storeId}]::bigint[])`))).toBe("42501"); // ...and still cannot call the erase
    expect(await pgCode(db.execute(sql`select reset_demo_payments(array[${s.storeId}]::bigint[])`))).toBe("42501");
    expect(await platform.select().from(paymentAttempt)).toHaveLength(1);
  });

  it("wave 2 review P3: the app login cannot start an attempt in a settled state, with a COD order or another total, nor write later events", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { orderId, a } = await openPayment(s, p);
    const insertAttempt = (over: string, total = a.amountIdr) =>
      withStore(db, s.storeId, (tx) =>
        tx.execute(sql.raw(`insert into payment_attempt (store_id, order_id, owner_kind, owner_id, request_key, reff_id, channel_code, customer, amount_idr, admin_fee_idr, total_idr, expires_at, next_advice_at${over ? ", " + over.split("=")[0] : ""})
          values (${s.storeId}, ${orderId}, 'order', '${orderId}', 'forged', '999999999999999999999999999', 'VABCA', '{}'::jsonb, ${total}, 0, ${total}, now() + interval '1 day', now()${over ? ", " + over.split("=")[1] : ""})`)),
      );
    // The order already has an attempt (unique), so remove it as the owner to isolate what the guard itself refuses.
    await admin.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`); // owner fixture only: skip the append-only triggers
      for (const t of ["payment_attempt_event", "payment_attempt"]) await tx.execute(sql.raw(`delete from ${t}`));
    });
    expect(await pgCode(insertAttempt("status='paid'"))).toBe("23514");
    expect(await pgCode(insertAttempt("instruction='{\"url\":\"https://evil.example\"}'::jsonb"))).toBe("23514");
    expect(await pgCode(insertAttempt("", a.amountIdr + 1))).toBe("23514"); // not the order total
    await admin.execute(sql`update "order" set payment_method = 'cod' where id = ${orderId}`);
    expect(await pgCode(insertAttempt(""))).toBe("23514"); // COD never has a payment attempt
    await admin.execute(sql`update "order" set payment_method = 'manual_transfer' where id = ${orderId}`);
    expect(await pgCode(insertAttempt(""))).toBe("allowed");
    const [row] = await platform.select({ id: paymentAttempt.id }).from(paymentAttempt);
    expect(await pgCode(withStore(db, s.storeId, (tx) => tx.insert(paymentAttemptEvent).values({ storeId: s.storeId, attemptId: row!.id, revision: 2, kind: "accepted" })))).toBe("42501");
  });

  it("wave 2 review P3: the app login cannot read a callback's raw body", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { a } = await openPayment(s, p);
    await acceptPaymentCallback(db, callback(a));
    expect(await pgCode(withStore(db, s.storeId, (tx) => tx.execute(sql`select raw_body from payment_callback`)))).toBe("42501");
    expect(await pgCode(withStore(db, s.storeId, (tx) => tx.execute(sql`select id, body_sha256, body_shape from payment_callback`)))).toBe("allowed");
  });

  it("wave 2 review P3: callbacks per attempt are capped, so a leaked signed URL cannot trigger unbounded provider inquiries", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { a } = await openPayment(s, p);
    for (let i = 0; i < CALLBACK_MAX_PER_ATTEMPT + 5; i++) await acceptPaymentCallback(db, callback(a, { nonce: `n${i}` }));
    expect(await platform.select().from(paymentCallback)).toHaveLength(CALLBACK_MAX_PER_ATTEMPT);
    expect(await jobsOf(PAYMENT_VERIFY)).toHaveLength(CALLBACK_MAX_PER_ATTEMPT);
  });

  it("the seller sees status and totals of the payment, never provider ids, fees or callbacks", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { orderId, a } = await openPayment(s, p);
    const seen = (await getOrder(s.owner, orderId))!;
    expect(seen.payment).toMatchObject({ channelCode: "VABCA", requestState: "accepted", status: "pending", totalIdr: a.totalIdr });
    expect(seen.payment).not.toHaveProperty("transactionId");
    expect(seen.payment).not.toHaveProperty("providerFeeIdr");
    expect(JSON.stringify(seen)).not.toMatch(/transactionId|providerFee|callback/i);
    expect(seen).not.toHaveProperty("paymentReference");
  });
});

describe("callback body retention (period OPEN: off by default, digest stays)", () => {
  it("redaction is off until the owner records a period; then it blanks the raw body only, keeps the digest, and only the owner-side function can do it", async () => {
    const s = await makeStore("toko-a");
    const p = new FakeAutoLaris();
    const { a } = await openPayment(s, p);
    await acceptPaymentCallback(db, callback(a));
    await withoutGuard("payment_callback", "payment_callback_guard", () => admin.execute(sql`update payment_callback set created_at = now() - interval '40 days'`));
    const [before] = await platform.select().from(paymentCallback);
    expect(await redactPaymentCallbacks(platform)).toBe(0); // no period: nothing is redacted, nothing is hard-coded
    expect((await platform.select().from(paymentCallback))[0]!.rawBody).toBe(before!.rawBody);

    const noCap = await makeOperator([]);
    const op = await makeOperator(["ops.jobs.manage"]);
    await expect(setCallbackRetention(noCap, { days: 30, reason: "no grant" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await redactPaymentCallbacks(platform)).toBe(0);
    await setCallbackRetention(op, { days: 30, reason: "privacy owner decision" });
    expect(await redactPaymentCallbacks(platform)).toBe(1);
    const [after] = await platform.select().from(paymentCallback);
    expect(after).toMatchObject({ rawBody: null, redactedAt: expect.any(Date), bodySha256: before!.bodySha256, bodyShape: before!.bodyShape, createdAt: before!.createdAt });
    expect(await redactPaymentCallbacks(platform)).toBe(0); // idempotent
    // A fresh callback is inside the period and stays.
    await acceptPaymentCallback(db, callback(a, { retry: 1 }));
    expect(await redactPaymentCallbacks(platform)).toBe(0);
    // Evidence is never deleted or rewritten, not even by the owner role.
    expect(await pgCode(admin.execute(sql`update payment_callback set body_sha256 = ${"0".repeat(64)}`))).toBe("23514");
    expect(await pgCode(admin.execute(sql`delete from payment_callback`))).toBe("42501");
    await setCallbackRetention(op, { days: null, reason: "pause" });
  });
});
