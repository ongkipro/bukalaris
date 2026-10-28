import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { recordSessionMfa } from "../src/ops/capabilities-approvals.ts";
import { runOnce } from "../src/ops/jobs/jobs.ts";
import { recordPaymentInquiry } from "../src/payments/attempts.ts";
import { FakeAutoLaris } from "../src/payments/fake.ts";
import { setPaymentAdapter } from "../src/payments/jobs.ts";
import { fakeProviders } from "../src/payments/providers.ts";
import { paymentAttempt } from "../src/payments/schema-payments.ts";
import { eq } from "drizzle-orm";
import { releaseStore } from "../src/ledger/release.ts";
import { issueSellerStepUp } from "../src/ledger/stepup.ts";
import { requestPayout, setPayoutDestination } from "../src/ledger/payouts.ts";
import { ledgerBalance } from "../src/ledger/ledger.ts";
import { placeOrder } from "../src/seller/commerce/checkout.ts";
import { transitionOrder } from "../src/seller/commerce/orders.ts";
import { session } from "../src/schema.ts";
import { bindSession, type OperatorScope } from "../src/platform/scoped.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { admin, buyer, db, makeStore, platform } from "./helpers.ts";
import { deliver } from "./deliver.ts";

// Shared fixtures of the T-37 tests. Everything runs against the FAKE adapters; the courier is the fake JNE (a COD-capable fixture, ledger/fixtures.ts).

export type S = Awaited<ReturnType<typeof makeStore>>;
export const fake = new FakeAutoLaris();
const providers = { ...fakeProviders, payment: fake };

let phone = 0;
const nextPhone = () => `0813${String(++phone).padStart(8, "0")}`; // distinct buyers: the per-phone checkout limit is not under test

export async function place(s: S, over: Record<string, unknown> = {}, qty = 1): Promise<number> {
  const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: qty }, "add");
  const { orderId } = await placeOrder(db, cartId, buyer({ buyerPhone: nextPhone(), ...over }), providers);
  return orderId;
}

/** A prepaid order whose payment was VERIFIED by the (fake) provider inquiry: the order is `placed` and its sale is booked pending. */
export async function paidPrepaid(s: S, qty = 1, over: Record<string, unknown> = {}) {
  setPaymentAdapter(fake);
  const orderId = await place(s, { paymentMethod: "manual_transfer", paymentChannel: "VABCA", ...over }, qty);
  await runOnce(platform, { workerId: "t37", providers });
  const [attempt] = await platform.select().from(paymentAttempt).where(eq(paymentAttempt.orderId, orderId));
  await recordPaymentInquiry({ exec: platform, storeId: s.storeId }, attempt!.id, { rc: "00", ket: "Sukses", data: { status: "PAID", amount: attempt!.totalIdr } }, { source: "reconcile", mode: "fake" });
  return { orderId, attempt: attempt! };
}

export async function toShipped(s: S, orderId: number, confirm = false) {
  if (confirm) await transitionOrder(s.owner, orderId, "confirm");
  await transitionOrder(s.owner, orderId, "process");
  await transitionOrder(s.owner, orderId, "ship", { trackingNumber: `T37-${orderId}` });
}

export async function deliveredPrepaid(s: S, qty = 1) {
  const r = await paidPrepaid(s, qty);
  await toShipped(s, r.orderId);
  await deliver(s.storeId, r.orderId);
  return r;
}

export async function deliveredCod(s: S, qty = 1) {
  const orderId = await place(s, { paymentMethod: "cod" }, qty);
  await toShipped(s, orderId, true);
  await deliver(s.storeId, orderId);
  return orderId;
}

export const balance = (storeId: number) => ledgerBalance(platform, storeId);
/** A store whose available balance holds `qty` delivered prepaid sales (released by the job). */
export async function fund(s: S, qty = 1) {
  const r = await deliveredPrepaid(s, qty);
  await releaseStore(platform, s.storeId);
  return r;
}

export async function sessionOf(userId: string, mfa = true) {
  const id = randomUUID();
  await admin.insert(session).values({ id, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
  if (mfa) await recordSessionMfa(platform, { sessionId: id, userId, method: "totp" });
  return id;
}
export const operatorSession = (op: OperatorScope, mfa = true) => sessionOf(op.userId, mfa);

/** Lift one guard trigger for one fixture statement (superuser time travel on immutable columns); the guard itself is under test elsewhere. */
export async function withoutGuard(table: string, trigger: string, fn: () => Promise<unknown>) {
  await admin.execute(sql.raw(`alter table ${table} disable trigger ${trigger}`));
  try {
    await fn();
  } finally {
    await admin.execute(sql.raw(`alter table ${table} enable trigger ${trigger}`));
  }
}

/** A proof for the store owner, issued on a scope BOUND to a server-side session (the session never comes from the call's input). `scope` is the owner scope to use with it. */
export async function ownerProof(s: S, action: "payout.destination" | "payout.request", subjectId: string, sessionId?: string) {
  const sid = sessionId ?? (await sessionOf(s.ownerId));
  const scope = bindSession(s.owner, sid);
  return { sessionId: sid, scope, proofId: await issueSellerStepUp(scope, { action, subjectId }) };
}

/** An ACTIVE destination: created through the real service, then its hold moved into the past (time travel). The holder equals the owner's registered name. */
export async function activateDestination(s: S, over: Partial<{ bankCode: string; accountNumber: string; accountHolderName: string }> = {}) {
  const { scope, proofId } = await ownerProof(s, "payout.destination", String(s.storeId));
  const r = await setPayoutDestination(scope, { proofId, bankCode: "BCA", accountNumber: "1234567890", accountHolderName: `${s.sf.storeSlug}-owner`, ...over });
  await withoutGuard("payout_destination", "payout_destination_guard", () => admin.execute(sql`update payout_destination set hold_until = now() - interval '1 minute' where id = ${r.destinationId}`));
  return r;
}

export async function requestPayoutOf(s: S, amountIdr: number, key: string = randomUUID()) {
  const { scope, proofId } = await ownerProof(s, "payout.request", key);
  return requestPayout(scope, { proofId, requestKey: key, amountIdr });
}

/** A PNG-looking receipt, unique per call (the bytes are what the SHA-256 and the magic bytes see). */
export const receipt = (tag: string = randomUUID()) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(tag)]);
