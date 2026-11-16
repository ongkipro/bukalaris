import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, max, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Executor } from "../client.ts";
import { enqueue } from "../ops/jobs/jobs.ts";
import { verifyOrderLink } from "../ops/jobs/notify.ts";
import { consoleMutation } from "../ops/console.ts";
import { consumeApproval, payloadHash, requestApproval } from "../ops/capabilities-approvals.ts";
import { requirePlatformCap } from "../ops/capabilities.ts";
import { hit, type LimitRule } from "../platform/rate-limit.ts";
import { resolveCartStore, resolveOrderStore } from "../platform/resolvers.ts";
import { DomainError, requireCap, type OperatorScope, type SellerScope } from "../platform/scoped.ts";
import { withStore } from "../platform/tenant.ts";
import { auditLog, order, store } from "../schema.ts";
import { credentialKeyring, keyFingerprint, sealCredential, unsealCredential } from "../shipping/credentials.ts";
import type { ProviderEnvironment } from "../shipping/schema-accounts.ts";
import { applySellerSettlement, PAYMENT_INSTRUCTION, PAYMENT_VERIFY, type Attempt } from "./attempts.ts";
import { COD_FEE_CODE, isPricedChannel, paymentFee, PaymentContractError, type FeeSchedule, type PaymentChannel, type SubmitProfile } from "./contract.ts";
import { FakeAutoLaris } from "./fake.ts";
import { autolarisProductionOn, fakeCheckAllowed, openProviderKey, paymentReadiness, providerOrigin } from "./provider-accounts.ts";
import type { PaymentAdapter } from "./providers.ts";
import { orderPaymentView, type OrderPaymentView } from "./view.ts";
import { paymentAnomaly, paymentAttempt, paymentAttemptEvent, paymentChannelLock, paymentFeeRate, paymentManualConfirmation, paymentProductionSwitch, storePaymentAccount } from "./schema-payments.ts";
import { ADVICE_INTERVAL_MS, PAY_RECHECK_LIMITS, PAYMENT_INSTRUCTION_LIFETIME_MS, STATUS_CHECK_LOOKBACK_MS } from "./settings.ts";

// T-106 — AutoLaris on the seller's own key (ADR-0013 sections 3 to 6, decision 34, D-21, D-27, D-33).
//
// A store that has a `store_payment_account` row is on its own AutoLaris account: its buyer orders are created, checked and settled on that
// store's key only, never on the platform account (T-49), which keeps serving subscription invoices (T-50) and stores without a row.
// Invariants, each with a named test in test/t106-autolaris-seller-key.test.ts:
// - The callback is evidence only (D-21): it enqueues a pull; the pull settles only on the paid code plus an allow-listed status word.
// - A store's attempts are created and checked with THAT store's key (`attemptAdapter`); no code path falls back to the platform adapter.
// - The method list and the order submit use one function (`storePaymentMethods`): master switch, readiness, production switch, platform
//   lock, seller exclusion and the fee schedule. The fee decision (bearer, rate version, amounts) is frozen on the attempt.
// - A key is opened only server-side and never placed in a value, error, log line, job row or observation.

/** Codes of our own errors that are safe to log; anything else is logged as `error` (a message is never logged: it could carry provider text). */
const SAFE_ERROR_CODES = new Set(["payment_key_unavailable", "payment_envelope_invalid", "payment_key_purpose_reused", "provider_origin_invalid"]);
export function errorCode(err: unknown): string {
  if (err instanceof DomainError || err instanceof PaymentContractError) return err.code;
  return err instanceof Error && SAFE_ERROR_CODES.has(err.message) ? err.message : "error";
}
/** One structured line with a code only (the worker's log convention, like `shipping.partner.skipped`). */
export function logCode(event: string, storeId: number | null, err: unknown): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "warn", event, storeId, code: errorCode(err) }));
}

// ── Server-side transport for the seller's key ─────────────────────────────────────────────────────────────────────
export type OpenedAutoLaris = { apiKey: string; environment: ProviderEnvironment; origin: string | null };
/** Builds the provider adapter for one opened key. There is no live transport in this build (lazy: decision 33 keeps local and CI on fakes). */
export interface SellerPaymentTransport {
  readonly mode: "fake" | "live";
  adapterFor(key: OpenedAutoLaris): PaymentAdapter;
}

/** One fake AutoLaris account per key (a bill exists only in the account it was created in). Never touches a network. */
export class FakeAutoLarisAccounts implements SellerPaymentTransport {
  readonly mode = "fake" as const;
  private readonly accounts = new Map<string, FakeAutoLaris>();
  /** Which account (a hash of the key, never the key) served which call. Bounded: the module-level instance lives as long as the server. */
  calls: { account: string; environment: ProviderEnvironment; op: "list" | "submit" | "advice" | "recover"; ref: string | null }[] = [];
  static accountOf(apiKey: string): string {
    return createHash("sha256").update(`fake-autolaris-account:${apiKey}`).digest("hex").slice(0, 16);
  }
  /** Test seam: the fake account behind a key (the same instance every time). */
  account(apiKey: string): FakeAutoLaris {
    const id = FakeAutoLarisAccounts.accountOf(apiKey);
    let a = this.accounts.get(id);
    if (!a) this.accounts.set(id, (a = new FakeAutoLaris()));
    return a;
  }
  private record(entry: FakeAutoLarisAccounts["calls"][number]) {
    if (this.calls.length >= 200) this.calls.shift();
    this.calls.push(entry);
  }
  adapterFor(key: OpenedAutoLaris): PaymentAdapter {
    const a = this.account(key.apiKey), account = FakeAutoLarisAccounts.accountOf(key.apiKey), environment = key.environment;
    return {
      mode: "fake",
      listChannels: () => (this.record({ account, environment, op: "list", ref: null }), a.listChannels()),
      submit: (input) => (this.record({ account, environment, op: "submit", ref: input.reffId }), a.submit(input)),
      advice: (input) => (this.record({ account, environment, op: "advice", ref: input.transactionId }), a.advice(input)),
      recoverCreate: (input) => (this.record({ account, environment, op: "recover", ref: input.reffId }), a.recoverCreate(input)),
    };
  }
}
const fakeAccounts = new FakeAutoLarisAccounts();
let transportOverride: SellerPaymentTransport | null = null;
/** Test seam (and the place a live transport would be installed after the recorded sandbox pass). */
export const setSellerPaymentTransport = (t: SellerPaymentTransport | null): void => {
  transportOverride = t;
};
/**
 * The transport for an account's environment: the fake only where the T-104 rule allows it (outside production, or the e2e build on loopback,
 * and never for a configured origin). Anything else is refused: no live transport exists in this build, so nothing can reach AutoLaris.
 */
function sellerTransport(environment: ProviderEnvironment): SellerPaymentTransport {
  if (transportOverride) return transportOverride;
  if (fakeCheckAllowed(providerOrigin("autolaris", environment))) return fakeAccounts;
  throw new DomainError("provider_unavailable", "Koneksi ke AutoLaris belum tersedia di server ini.");
}

type AccountRow = {
  id: number; environment: ProviderEnvironment; status: string; lastResult: string | null; enabled: boolean; excludedChannels: string[]; feeBearer: "buyer" | "seller";
  originAreaId: string | null; destinationAreaId: string | null; shipperEmail: string | null; senderAddress: string | null;
};
const ACCOUNT_COLUMNS = {
  id: storePaymentAccount.id, environment: storePaymentAccount.environment, status: storePaymentAccount.status, lastResult: storePaymentAccount.lastResult,
  enabled: storePaymentAccount.enabled, excludedChannels: storePaymentAccount.excludedChannels, feeBearer: storePaymentAccount.feeBearer,
  originAreaId: storePaymentAccount.originAreaId, destinationAreaId: storePaymentAccount.destinationAreaId, shipperEmail: storePaymentAccount.shipperEmail, senderAddress: storePaymentAccount.senderAddress,
};
/** The store's own AutoLaris account row (non-secret columns only), or undefined when the store is on the platform account. Caller carries the store context. */
async function accountRow(tx: Executor, storeId: number): Promise<AccountRow | undefined> {
  return (await tx.select(ACCOUNT_COLUMNS).from(storePaymentAccount).where(eq(storePaymentAccount.storeId, storeId)))[0];
}

export type StoreAutoLaris = { accountId: number; environment: ProviderEnvironment; adapter: PaymentAdapter; profile: SubmitProfile };
/**
 * The provider adapter bound to THIS store's key, for the web app (app pool) and the worker (platform pool) alike. The key is opened through
 * `provider_key_envelope` (bound to `app_store_id()`), never returned. Refused while the account has no key, while a production account waits
 * for the decision-34 switch, and where no transport exists.
 */
export async function storeAutoLaris(exec: Executor, storeId: number): Promise<StoreAutoLaris> {
  const { a, name, productionOn } = await withStore(exec, storeId, async (tx) => {
    const [s] = await tx.select({ name: store.name }).from(store).where(eq(store.id, storeId));
    return { a: await accountRow(tx, storeId), name: s?.name ?? "Toko", productionOn: await autolarisProductionOn(tx) };
  });
  if (a?.status !== "active") throw new DomainError("not_connected", "Akun AutoLaris toko belum terhubung.");
  if (a.environment === "production" && !productionOn) throw new DomainError("production_off", "Pembayaran produksi AutoLaris belum diaktifkan oleh Bukalaris.");
  const transport = sellerTransport(a.environment);
  const apiKey = await openProviderKey({ exec, storeId }, "autolaris");
  return {
    accountId: a.id, environment: a.environment,
    adapter: transport.adapterFor({ apiKey, environment: a.environment, origin: providerOrigin("autolaris", a.environment) }),
    profile: { shipperName: name, originAreaId: a.originAreaId ?? "", destinationAreaId: a.destinationAreaId ?? "", shipperEmail: a.shipperEmail ?? "", senderAddress: a.senderAddress ?? "" },
  };
}

/** Refusals of `storeAutoLaris`/`attemptAdapter` that do not heal by retrying the same job: no key, production switched off, account moved. */
export const PERMANENT_ACCOUNT_CODES: ReadonlySet<string> = new Set(["not_connected", "production_off", "account_changed"]);

/** The adapter an attempt is created and checked with: its own store's key for an attempt on the store's account, the platform adapter otherwise. */
export async function attemptAdapter(db: Executor, a: Pick<Attempt, "storeId" | "paymentAccountId" | "environment">, platform: PaymentAdapter): Promise<{ adapter: PaymentAdapter; profile?: SubmitProfile }> {
  if (a.paymentAccountId === null) return { adapter: platform };
  const s = await storeAutoLaris(db, a.storeId);
  // Review finding 3: the row keeps its id when the account moves sandbox <-> production; an attempt is only ever created or checked in its own environment.
  // lazy: a key replaced within one environment is not detected (no stable per-key id survives a ring rotation); its status check then finds no bill and never settles.
  if (s.accountId !== a.paymentAccountId || s.environment !== a.environment) throw new DomainError("account_changed", "Akun AutoLaris toko berubah.");
  return { adapter: s.adapter, profile: s.profile };
}

// ── Platform settings read by checkout ─────────────────────────────────────────────────────────────────────────────
/** The fee schedule in force: the highest version (decision 19). */
export async function currentFeeSchedule(exec: Executor): Promise<FeeSchedule> {
  const rows = await exec.select().from(paymentFeeRate).where(eq(paymentFeeRate.version, sql`(select max(version) from ${paymentFeeRate})`));
  if (rows.length === 0) throw new DomainError("fee_schedule", "Tarif biaya pembayaran belum tersedia.");
  return { version: rows[0]!.version, rates: Object.fromEntries(rows.map((r) => [r.channelCode, { base: r.base, rateBps: r.rateBps, fixedIdr: r.fixedIdr }])) };
}
const lockedChannels = async (exec: Executor) => new Set((await exec.select({ c: paymentChannelLock.channelCode }).from(paymentChannelLock)).map((r) => r.c));

// ── One method function for the list and the submit (ADR-0013 section 4) ─────────────────────────────────────────────
export type StorePaymentMethods = {
  channels: PaymentChannel[];
  schedule: FeeSchedule;
  /** The store's own account the order will be created under; null = the platform account (T-49). */
  account: { id: number; environment: ProviderEnvironment; feeBearer: "buyer" | "seller" } | null;
};
/**
 * The QRIS/VA channels a buyer of this store may use, used by the checkout page AND again at order submit: the provider's own list (on the
 * store's key when the store has its account), narrowed to channels the fee schedule prices, minus the platform locks and the seller's
 * exclusions; empty when the seller switched AutoLaris off, the account is not ready or production is not switched on.
 */
export async function storePaymentMethods(exec: Executor, storeId: number, platform: PaymentAdapter): Promise<StorePaymentMethods> {
  const { schedule, locks, a, ready } = await withStore(exec, storeId, async (tx) => {
    const a = await accountRow(tx, storeId);
    return { schedule: await currentFeeSchedule(tx), locks: await lockedChannels(tx), a, ready: a ? (await paymentReadiness({ exec: tx, storeId })).ready : false };
  });
  if (a && (!a.enabled || !ready)) return { channels: [], schedule, account: { id: a.id, environment: a.environment, feeBearer: a.feeBearer } };
  let listed: PaymentChannel[];
  try {
    listed = await (a ? (await storeAutoLaris(exec, storeId)).adapter : platform).listChannels();
  } catch (err) {
    const e = new DomainError("provider", "Metode pembayaran sedang tidak tersedia. Coba lagi sebentar.");
    e.cause = err;
    throw e;
  }
  const excluded = new Set(a?.excludedChannels ?? []);
  return {
    channels: listed.filter((c) => c.code !== COD_FEE_CODE && isPricedChannel(schedule, c.code) && !locks.has(c.code) && !excluded.has(c.code)),
    schedule,
    account: a ? { id: a.id, environment: a.environment, feeBearer: a.feeBearer } : null,
  };
}
/** Submit-time check: the channel must be one the same function offers now; a hidden, excluded, locked or switched-off channel is refused. */
export async function pickStorePaymentChannel(exec: Executor, storeId: number, platform: PaymentAdapter, code: string | undefined) {
  const methods = await storePaymentMethods(exec, storeId, platform);
  const channel = methods.channels.find((c) => c.code === code);
  if (!channel) throw new DomainError("payment_channel", "Metode pembayaran tidak tersedia. Pilih metode lain.");
  return { channel, methods };
}

/**
 * The cheap half of the submit check again inside the order transaction (no provider call): the switch, the exclusion and the lock read at
 * submit are still the same when the order is written, so a change saved meanwhile cannot slip an order through.
 */
export async function assertChannelStillOffered(tx: Executor, storeId: number, channelCode: string, accountId: number | null): Promise<void> {
  const a = await accountRow(tx, storeId);
  const [locked] = await tx.select({ c: paymentChannelLock.channelCode }).from(paymentChannelLock).where(eq(paymentChannelLock.channelCode, channelCode));
  if ((a?.id ?? null) !== accountId || locked || (a && (!a.enabled || a.excludedChannels.includes(channelCode)))) throw new DomainError("payment_channel", "Metode pembayaran tidak tersedia. Pilih metode lain.");
}

export type PaymentPlan = { amountIdr: number; adminFeeIdr: number; expectedFeeIdr: number; feeBearer: "buyer" | "seller"; feeRateVersion: number; paymentAccountId: number | null; environment: ProviderEnvironment | null };
/**
 * Decision 18: with `buyer` the bill is the order total plus the fee (the seller nets the order total); with `seller` the bill equals the
 * order total and the seller bears the fee. Both the bearer and the amounts are frozen on the attempt (and the fee in `order_financials`).
 */
export function paymentPlan(methods: StorePaymentMethods, channelCode: string, goodsOmset: number, payable: number): PaymentPlan {
  const fee = paymentFee(methods.schedule, channelCode, goodsOmset, payable);
  const feeBearer = methods.account?.feeBearer ?? "buyer";
  return { amountIdr: payable, adminFeeIdr: feeBearer === "buyer" ? fee : 0, expectedFeeIdr: fee, feeBearer, feeRateVersion: methods.schedule.version, paymentAccountId: methods.account?.id ?? null, environment: methods.account?.environment ?? null };
}

// ── Buyer: retry and "check now" (decisions 21 and 25, RL-PAY-RECHECK) ─────────────────────────────────────────────────
export type BuyerOrderRef = { storeId: number; orderId: number };
const buyerAuth = z.union([z.strictObject({ token: z.string().max(200) }), z.strictObject({ orderId: z.number().int().positive(), cartId: z.uuid() })]);
/** The order a buyer may act on: from the signed order-status link, or from the checkout cookie of the cart the order came from. Null otherwise. */
export async function resolveBuyerOrder(exec: Executor, raw: unknown): Promise<BuyerOrderRef | null> {
  const parsed = buyerAuth.safeParse(raw);
  if (!parsed.success) return null;
  const auth = parsed.data;
  if ("token" in auth) {
    const orderId = verifyOrderLink(auth.token);
    const storeId = orderId === null ? null : await resolveOrderStore(exec, orderId);
    return orderId !== null && storeId !== null ? { storeId, orderId } : null;
  }
  const storeId = await resolveCartStore(exec, auth.cartId);
  if (storeId === null) return null;
  const [o] = await withStore(exec, storeId, (tx) => tx.select({ id: order.id }).from(order).where(and(eq(order.storeId, storeId), eq(order.id, auth.orderId), eq(order.cartId, auth.cartId))));
  return o ? { storeId, orderId: o.id } : null;
}

/** What the buyer's pages show of the payment: the order status and the latest attempt (no provider id, fee or callback). */
export async function buyerOrderPayment(exec: Executor, ref: BuyerOrderRef): Promise<{ orderStatus: string; payment: OrderPaymentView | null } | null> {
  return withStore(exec, ref.storeId, async (tx) => {
    const [o] = await tx.select({ status: order.status }).from(order).where(and(eq(order.storeId, ref.storeId), eq(order.id, ref.orderId)));
    return o ? { orderStatus: o.status, payment: await orderPaymentView(tx, ref.storeId, ref.orderId) } : null;
  });
}

async function limitRecheck(exec: Executor, orderId: number, clientIp: string | undefined) {
  const hits: { key: string; rule: LimitRule }[] = [{ key: `pay-recheck:order:${orderId}`, rule: PAY_RECHECK_LIMITS.order }, ...(clientIp ? [{ key: `pay-recheck:ip:${clientIp}`, rule: PAY_RECHECK_LIMITS.ip }] : [])];
  const results = await Promise.all(hits.map((h) => hit(exec, h.key, h.rule)));
  const over = results.filter((r, i) => r.count > hits[i]!.rule.limit);
  if (over.length) throw new DomainError("rate_limited", `Terlalu sering. Status terakhir tetap ditampilkan; coba lagi dalam ${Math.max(...over.map((r) => r.retryAfterSec))} detik.`);
}

/** Attempts of an order the status check still covers: accepted, unpaid, with a provider id, not expired more than 24 hours ago. */
const checkableOf = (tx: Executor, storeId: number, orderId: number) =>
  tx.select({ id: paymentAttempt.id }).from(paymentAttempt).where(and(eq(paymentAttempt.storeId, storeId), eq(paymentAttempt.orderId, orderId), eq(paymentAttempt.requestState, "accepted"),
    ne(paymentAttempt.status, "paid"), isNotNull(paymentAttempt.transactionId), sql`${paymentAttempt.expiresAt} > now() - ${STATUS_CHECK_LOOKBACK_MS} * interval '1 millisecond'`));

/**
 * "Check now" (RL-PAY-RECHECK: 6/min per order, 30/10 min per IP): enqueues the verify-by-pull job for each attempt the status check still
 * covers. The web request never calls the provider and never changes a payment; the worker pulls with the owning store's key.
 */
export async function requestPaymentCheck(exec: Executor, ref: BuyerOrderRef, ctx: { clientIp?: string | undefined } = {}): Promise<number> {
  await limitRecheck(exec, ref.orderId, ctx.clientIp);
  const bucket = Math.floor(Date.now() / 60_000);
  return withStore(exec, ref.storeId, async (tx) => {
    const due = await checkableOf(tx, ref.storeId, ref.orderId);
    for (const a of due) await enqueue(tx, { kind: PAYMENT_VERIFY, storeId: ref.storeId, key: `recheck:${a.id}:${bucket}`, payload: { attemptId: a.id, source: "recheck" } });
    return due.length;
  });
}

/**
 * Decision 21/25: a buyer whose instruction failed or expired asks for a new one. The old attempt is kept (a late payment of it still settles
 * the order); the new attempt has the next number, the same channel and the same frozen amounts, and is checked against the same method
 * function as at submit (switched off, excluded, locked or not ready = refused). Only on the store's own account (T-49 keeps one attempt).
 */
export async function retryOrderPayment(exec: Executor, ref: BuyerOrderRef, platform: PaymentAdapter, ctx: { clientIp?: string | undefined } = {}): Promise<Attempt> {
  await limitRecheck(exec, ref.orderId, ctx.clientIp);
  const latest = await withStore(exec, ref.storeId, async (tx) => (await tx.select().from(paymentAttempt).where(and(eq(paymentAttempt.storeId, ref.storeId), eq(paymentAttempt.orderId, ref.orderId))).orderBy(desc(paymentAttempt.attemptNo)).limit(1))[0]);
  if (!latest || latest.paymentAccountId === null) throw new DomainError("not_retryable", "Tagihan pesanan ini tidak bisa dibuat ulang. Hubungi penjual.");
  const methods = await storePaymentMethods(exec, ref.storeId, platform);
  if (!methods.account || !methods.channels.some((c) => c.code === latest.channelCode)) throw new DomainError("payment_channel", "Metode pembayaran pesanan ini sedang tidak tersedia. Hubungi penjual.");
  const account = methods.account;
  return withStore(exec, ref.storeId, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`payment.order:${ref.storeId}:${ref.orderId}`}, 0))`);
    const [o] = await tx.select({ status: order.status }).from(order).where(and(eq(order.storeId, ref.storeId), eq(order.id, ref.orderId))).for("update");
    const attempts = await tx.select().from(paymentAttempt).where(and(eq(paymentAttempt.storeId, ref.storeId), eq(paymentAttempt.orderId, ref.orderId))).orderBy(desc(paymentAttempt.attemptNo));
    const prev = attempts[0]!;
    if (o?.status !== "awaiting_payment" || attempts.some((a) => a.status === "paid")) throw new DomainError("not_retryable", "Pesanan ini tidak menunggu pembayaran lagi.");
    const now = new Date();
    if (!(prev.requestState === "failed" || (prev.requestState === "accepted" && prev.expiresAt <= now))) throw new DomainError("not_retryable", "Tagihan terakhir masih berlaku atau sedang diperiksa. Selesaikan tagihan itu atau tunggu sebentar.");
    const [created] = await tx
      .insert(paymentAttempt)
      .values({
        storeId: ref.storeId, orderId: ref.orderId, ownerId: String(ref.orderId), attemptNo: prev.attemptNo + 1, requestKey: `retry:${ref.orderId}:${prev.attemptNo + 1}`,
        reffId: BigInt(`0x${randomBytes(12).toString("hex")}`).toString().padStart(29, "0"),
        channelCode: prev.channelCode, customer: prev.customer, amountIdr: prev.amountIdr, adminFeeIdr: prev.adminFeeIdr, totalIdr: prev.totalIdr,
        paymentAccountId: account.id, environment: account.environment, feeBearer: prev.feeBearer, feeRateVersion: prev.feeRateVersion, expectedFeeIdr: prev.expectedFeeIdr,
        expiresAt: new Date(now.getTime() + PAYMENT_INSTRUCTION_LIFETIME_MS), nextAdviceAt: new Date(now.getTime() + ADVICE_INTERVAL_MS),
      })
      .returning();
    await tx.insert(paymentAttemptEvent).values({ storeId: ref.storeId, attemptId: created!.id, revision: 1, kind: "created" });
    await enqueue(tx, { kind: PAYMENT_INSTRUCTION, storeId: ref.storeId, key: `attempt:${created!.id}`, payload: { orderId: ref.orderId, attemptId: created!.id } });
    return created!;
  });
}

// ── Seller: settings, transactions, manual confirmation (decisions 18, 24, C-P5, C-P6) ─────────────────────────────────
const channelCode = z.string().regex(/^[A-Z0-9_-]{1,40}$/, "Kode channel tidak valid.");
const preferencesInput = z.strictObject({ enabled: z.boolean(), excludedChannels: z.array(channelCode).max(40), feeBearer: z.enum(["buyer", "seller"], { error: "Pilih siapa yang menanggung biaya." }) });
export type PaymentPreferences = z.infer<typeof preferencesInput>;
/** The seller's AutoLaris preferences and the channels they can choose from (priced by the schedule, not locked by the platform). */
export async function sellerPaymentPreferences(scope: SellerScope) {
  requireCap(scope, "integrations.manage");
  return withStore(scope.exec, scope.storeId, async (tx) => {
    const a = await accountRow(tx, scope.storeId);
    const [schedule, locks] = await Promise.all([currentFeeSchedule(tx), lockedChannels(tx)]);
    return {
      preferences: a ? { enabled: a.enabled, excludedChannels: a.excludedChannels, feeBearer: a.feeBearer } : null,
      channels: Object.keys(schedule.rates).filter((code) => code !== COD_FEE_CODE).sort().map((code) => ({ code, locked: locks.has(code) })), // T-107: the COD fee row is no channel
    };
  });
}
/** Owner only (`integrations.manage`, C-P6), audited; not a key change, so no step-up. Needs the store's account row. */
export async function setPaymentPreferences(scope: SellerScope, raw: unknown): Promise<PaymentPreferences> {
  requireCap(scope, "integrations.manage");
  const input = preferencesInput.parse(raw);
  const excluded = [...new Set(input.excludedChannels)].sort();
  return withStore(scope.exec, scope.storeId, async (tx) => {
    const [row] = await tx.update(storePaymentAccount).set({ enabled: input.enabled, excludedChannels: excluded, feeBearer: input.feeBearer, revision: sql`revision + 1` as unknown as number, updatedAt: sql`now()` as unknown as Date })
      .where(eq(storePaymentAccount.storeId, scope.storeId)).returning({ enabled: storePaymentAccount.enabled, excludedChannels: storePaymentAccount.excludedChannels, feeBearer: storePaymentAccount.feeBearer });
    if (!row) throw new DomainError("not_connected", "Hubungkan kunci AutoLaris terlebih dahulu.");
    await tx.insert(auditLog).values({ storeId: scope.storeId, actorUserId: scope.userId, actorCapability: "integrations.manage", action: "payment.preferences.update", subjectKind: "provider_account", subjectId: "autolaris", accessLevel: "write", outcome: "allowed", reason: `enabled=${row.enabled}; excluded=${row.excludedChannels.join(",") || "-"}; fee_bearer=${row.feeBearer}` });
    return row;
  });
}

export type SellerAttemptView = {
  id: string; orderId: number; attemptNo: number; channelCode: string; environment: ProviderEnvironment | null; feeBearer: "buyer" | "seller";
  amountIdr: number; adminFeeIdr: number; totalIdr: number; expectedFeeIdr: number | null; requestState: Attempt["requestState"]; status: Attempt["status"];
  expiresAt: Date; paidAt: Date | null; createdAt: Date; manual: { reason: string; evidence: string; at: Date } | null; anomalies: ("second_settled" | "paid_after_close")[];
};
/** The store's recent attempts on its own account (newest first) with their manual confirmation and anomalies. Never a provider id or a callback. */
export async function sellerPaymentAttempts(scope: SellerScope, limit = 50): Promise<SellerAttemptView[]> {
  requireCap(scope, "finance.confirm_payment");
  return withStore(scope.exec, scope.storeId, async (tx) => {
    const rows = await tx.select({
      id: paymentAttempt.id, orderId: paymentAttempt.orderId, attemptNo: paymentAttempt.attemptNo, channelCode: paymentAttempt.channelCode, environment: paymentAttempt.environment, feeBearer: paymentAttempt.feeBearer,
      amountIdr: paymentAttempt.amountIdr, adminFeeIdr: paymentAttempt.adminFeeIdr, totalIdr: paymentAttempt.totalIdr, expectedFeeIdr: paymentAttempt.expectedFeeIdr,
      requestState: paymentAttempt.requestState, status: paymentAttempt.status, expiresAt: paymentAttempt.expiresAt, paidAt: paymentAttempt.paidAt, createdAt: paymentAttempt.createdAt,
    }).from(paymentAttempt).where(and(eq(paymentAttempt.storeId, scope.storeId), isNotNull(paymentAttempt.paymentAccountId))).orderBy(desc(paymentAttempt.createdAt), desc(paymentAttempt.attemptNo)).limit(Math.min(Math.max(limit, 1), 200));
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [manual, anomalies] = await Promise.all([
      tx.select().from(paymentManualConfirmation).where(and(eq(paymentManualConfirmation.storeId, scope.storeId), inArray(paymentManualConfirmation.attemptId, ids))),
      tx.select().from(paymentAnomaly).where(and(eq(paymentAnomaly.storeId, scope.storeId), inArray(paymentAnomaly.attemptId, ids))).orderBy(asc(paymentAnomaly.id)),
    ]);
    return rows.map((r) => {
      const m = manual.find((x) => x.attemptId === r.id);
      return { ...r, manual: m ? { reason: m.reason, evidence: m.evidence, at: m.createdAt } : null, anomalies: anomalies.filter((x) => x.attemptId === r.id).map((x) => x.kind) };
    });
  });
}

/** A seller "check now" for one order (same limit and the same pull as the buyer's). */
export async function sellerRequestPaymentCheck(scope: SellerScope, rawOrderId: unknown, ctx: { clientIp?: string | undefined } = {}): Promise<number> {
  requireCap(scope, "finance.confirm_payment");
  const orderId = z.coerce.number().int().positive().parse(rawOrderId);
  return requestPaymentCheck(scope.exec, { storeId: scope.storeId, orderId }, ctx);
}

const manualInput = z.strictObject({
  attemptId: z.uuid({ error: "Transaksi tidak dikenal." }),
  reason: z.string().trim().min(5, "Alasan minimal 5 karakter.").max(500),
  evidence: z.string().trim().min(3, "Bukti minimal 3 karakter (misalnya nomor referensi mutasi).").max(500),
});
/**
 * Decision 24 / C-P5: the store owner confirms a payment by hand (`finance.confirm_payment`), with a reason and evidence; one append-only
 * record per attempt. The order is paid when it still awaits payment; a second settled attempt or a paid closed order raises the anomaly.
 */
export async function confirmPaymentByHand(scope: SellerScope, raw: unknown) {
  requireCap(scope, "finance.confirm_payment");
  const input = manualInput.parse(raw);
  return withStore(scope.exec, scope.storeId, async (tx) => {
    const [a0] = await tx.select({ orderId: paymentAttempt.orderId }).from(paymentAttempt).where(and(eq(paymentAttempt.storeId, scope.storeId), eq(paymentAttempt.id, input.attemptId)));
    if (!a0) throw new DomainError("not_found", "Transaksi tidak ditemukan.");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`payment.order:${scope.storeId}:${a0.orderId}`}, 0))`);
    const [o] = await tx.select({ status: order.status }).from(order).where(and(eq(order.storeId, scope.storeId), eq(order.id, a0.orderId))).for("update");
    const [a] = await tx.select().from(paymentAttempt).where(and(eq(paymentAttempt.storeId, scope.storeId), eq(paymentAttempt.id, input.attemptId)));
    if (!o || !a) throw new DomainError("not_found", "Transaksi tidak ditemukan.");
    if (a.paymentAccountId === null) throw new DomainError("not_found", "Transaksi ini tidak memakai akun AutoLaris toko.");
    if (a.status === "paid") throw new DomainError("already_paid", "Pembayaran ini sudah terverifikasi oleh AutoLaris.");
    const [record] = await tx.insert(paymentManualConfirmation).values({ storeId: scope.storeId, attemptId: a.id, orderId: a.orderId, confirmedBy: scope.userId, reason: input.reason, evidence: input.evidence })
      .onConflictDoNothing().returning({ id: paymentManualConfirmation.id });
    if (!record) throw new DomainError("already_confirmed", "Transaksi ini sudah dikonfirmasi manual. Catatan konfirmasi tidak bisa diubah.");
    const outcome = await applySellerSettlement(tx, a, o.status, `Pembayaran dikonfirmasi manual oleh penjual: ${input.reason}`, scope.userId);
    await tx.insert(auditLog).values({ storeId: scope.storeId, actorUserId: scope.userId, actorCapability: "finance.confirm_payment", action: "payment.manual_confirm", subjectKind: "payment_attempt", subjectId: a.id, accessLevel: "write", outcome: "allowed", reason: `order=${a.orderId}; outcome=${outcome}` });
    return { outcome };
  });
}

// ── Owner console (decision 4 "locked", decision 19, decision 34) ────────────────────────────────────────────────────
export async function paymentPlatformSettings(op: OperatorScope) {
  await requirePlatformCap(op, "providers.read");
  const [locks, schedule, [sw], versions] = await Promise.all([
    op.exec.select().from(paymentChannelLock).orderBy(asc(paymentChannelLock.channelCode)),
    currentFeeSchedule(op.exec),
    op.exec.select().from(paymentProductionSwitch).where(eq(paymentProductionSwitch.provider, "autolaris")),
    op.exec.select({ version: paymentFeeRate.version, createdBy: max(paymentFeeRate.createdBy), reason: max(paymentFeeRate.reason), createdAt: max(paymentFeeRate.createdAt) }).from(paymentFeeRate).groupBy(paymentFeeRate.version).orderBy(desc(paymentFeeRate.version)).limit(20),
  ]);
  return { locks, schedule, versions, production: sw ?? null };
}
const reason = z.string().trim().min(3, "Alasan wajib diisi.").max(500);
const lockInput = z.strictObject({ channelCode, locked: z.boolean(), reason });
/** Lock (never offered, cannot be enabled by a seller) or unlock a channel. Audited (`providers.manage`). */
export async function setPaymentChannelLock(op: OperatorScope, raw: unknown) {
  const input = lockInput.parse(raw);
  return consoleMutation(op, { capability: "providers.manage", action: input.locked ? "payment.channel.lock" : "payment.channel.unlock", targetKind: "payment_channel", targetId: input.channelCode, reason: input.reason, reasonCode: "payment_channel" }, async (tx) => {
    if (input.locked) await tx.insert(paymentChannelLock).values({ channelCode: input.channelCode, reason: input.reason, lockedBy: op.userId }).onConflictDoNothing();
    else await tx.delete(paymentChannelLock).where(eq(paymentChannelLock.channelCode, input.channelCode));
  });
}
const rateInput = z.strictObject({ channelCode, base: z.enum(["goods_omset", "payable", "flat"]), rateBps: z.number().int().min(0).max(10_000), fixedIdr: z.number().int().min(0).max(1_000_000) })
  .refine((r) => r.base !== "flat" || r.rateBps === 0, "Tarif tetap tidak memakai persen.");
const feeInput = z.strictObject({ rates: z.array(rateInput).min(1).max(40), reason });
/**
 * Publish a new fee-rate version (append-only; the previous versions stay, attempts keep the version they were priced with). Audited. A channel
 * the input does not name is copied forward from the current version (review nit: an omission must not silently drop a channel from
 * checkout); a channel is withdrawn by locking it, not by leaving it out.
 */
export async function publishPaymentFeeRates(op: OperatorScope, raw: unknown): Promise<number> {
  const input = feeInput.parse(raw);
  if (new Set(input.rates.map((r) => r.channelCode)).size !== input.rates.length) throw new DomainError("duplicate_channel", "Satu channel hanya boleh satu tarif per versi.");
  let version = 0;
  await consoleMutation(op, { capability: "providers.manage", action: "payment.fee_rates.publish", targetKind: "payment_fee_rate", targetId: "autolaris", reason: input.reason, reasonCode: "fee_rates" }, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('payment.fee_rate.publish', 0))`);
    const [{ v }] = (await tx.select({ v: max(paymentFeeRate.version) }).from(paymentFeeRate)) as [{ v: number | null }];
    version = (v ?? 0) + 1;
    const named = new Set(input.rates.map((r) => r.channelCode));
    const carried = v === null ? [] : Object.entries((await currentFeeSchedule(tx)).rates).filter(([c]) => !named.has(c)).map(([channelCode, r]) => ({ channelCode, ...r }));
    await tx.insert(paymentFeeRate).values([...input.rates, ...carried].map((r) => ({ version, channelCode: r.channelCode, base: r.base, rateBps: r.rateBps, fixedIdr: r.fixedIdr, createdBy: op.userId, reason: input.reason })));
  });
  return version;
}
const passInput = z.strictObject({ evidence: z.string().trim().min(3, "Bukti uji sandbox wajib diisi.").max(500), reason });
/**
 * Record the sandbox pass of decision 34 (evidence reference, e.g. the track report of the opt-in sandbox run). Audited. A later pass replaces
 * the stored one in place; every recording keeps its own audit row (the history).
 */
export async function recordAutoLarisSandboxPass(op: OperatorScope, raw: unknown) {
  const input = passInput.parse(raw);
  return consoleMutation(op, { capability: "providers.manage", action: "payment.production.sandbox_pass", targetKind: "payment_production_switch", targetId: "autolaris", reason: input.reason, reasonCode: "sandbox_pass" }, async (tx) => {
    await tx.update(paymentProductionSwitch).set({ sandboxPassAt: sql`now()` as unknown as Date, sandboxPassEvidence: input.evidence, updatedBy: op.userId, updatedAt: sql`now()` as unknown as Date, revision: sql`revision + 1` as unknown as number }).where(eq(paymentProductionSwitch.provider, "autolaris"));
  });
}
/** Four-eyes action of switching production ON (AGENTS.md: sensitive actions). Shared key for both providers; the target id names the provider. */
export const PRODUCTION_ON_ACTION = "providers.production_on" as const;
/**
 * The approved payload names the recorded sandbox pass and the switch revision: a pass recorded (or the switch changed) after the approval
 * makes the hash differ, so the approval can no longer be consumed (confirmation review item 5).
 */
const productionOnPayload = (row: { sandboxPassAt: Date | null; revision: number }) => ({ provider: "autolaris", enabled: true, sandboxPassAt: row.sandboxPassAt?.toISOString() ?? null, revision: row.revision });
const switchInput = z.strictObject({ enabled: z.boolean(), reason, approvalId: z.number().int().positive().optional() });
/**
 * Decision 34, step 1 of switching production ON: a second operator must approve. Refused until a sandbox pass is recorded. Returns the
 * approval request id; another operator with `providers.manage` decides it (`decideApproval`).
 */
export async function requestAutoLarisProduction(op: OperatorScope, raw: unknown): Promise<{ approvalId: number }> {
  await requirePlatformCap(op, "providers.manage");
  const { reason: why } = z.strictObject({ reason }).parse(raw);
  const [row] = await op.exec.select().from(paymentProductionSwitch).where(eq(paymentProductionSwitch.provider, "autolaris"));
  if (!row?.sandboxPassAt) throw new DomainError("sandbox_pass_required", "Produksi hanya bisa diaktifkan setelah uji sandbox AutoLaris tercatat.");
  const r = await requestApproval(op, { actionKey: PRODUCTION_ON_ACTION, targetKind: "provider_production_switch", targetId: "autolaris", payload: productionOnPayload(row), reason: why });
  return { approvalId: r.id };
}
/**
 * Decision 34: switch production calls on seller AutoLaris keys on (only with a sandbox pass recorded AND an approval of another operator,
 * consumed here) or off (one operator: the safe direction). Audited; the CHECK refuses ON without a pass too.
 */
export async function setAutoLarisProduction(op: OperatorScope, raw: unknown) {
  const input = switchInput.parse(raw);
  return consoleMutation(op, { capability: "providers.manage", action: input.enabled ? "payment.production.on" : "payment.production.off", targetKind: "payment_production_switch", targetId: "autolaris", reason: input.reason, reasonCode: "production_switch" }, async (tx) => {
    const [row] = await tx.select().from(paymentProductionSwitch).where(eq(paymentProductionSwitch.provider, "autolaris")).for("update");
    if (input.enabled && !row?.sandboxPassAt) throw new DomainError("sandbox_pass_required", "Produksi hanya bisa diaktifkan setelah uji sandbox AutoLaris tercatat.");
    if (input.enabled) {
      if (!input.approvalId) throw new DomainError("approval_invalid", "Mengaktifkan produksi memerlukan persetujuan operator kedua.");
      await consumeApproval(tx, op, { approvalId: input.approvalId, actionKey: PRODUCTION_ON_ACTION, targetKind: "provider_production_switch", targetId: "autolaris", payloadSha256: payloadHash(productionOnPayload(row!)) });
    }
    await tx.update(paymentProductionSwitch).set({ enabled: input.enabled, updatedBy: op.userId, updatedAt: sql`now()` as unknown as Date, revision: sql`revision + 1` as unknown as number }).where(eq(paymentProductionSwitch.provider, "autolaris"));
  });
}

// ── Payment keyring rotation (JOB-23 for `payment_credentials`; the T-104 open point) ─────────────────────────────────
/**
 * One envelope per committed transaction under the leading ring key; the store/row/kind additional data is kept; the fingerprint moves with
 * it. A row that does not open is skipped (code logged, never the message) and the sweep continues past it (review finding 1).
 */
export async function resealPaymentCredentials(db: Db, limit = 100): Promise<{ changed: number; failed: number }> {
  const current = credentialKeyring("payment_credentials")[0]!;
  let changed = 0, failed = 0, after = 0;
  for (let i = 0; i < limit; i++) {
    const step = await db.transaction(async (tx) => {
      const [a] = await tx.select({ id: storePaymentAccount.id, storeId: storePaymentAccount.storeId, sealedKey: storePaymentAccount.sealedKey, keyId: storePaymentAccount.keyId })
        .from(storePaymentAccount).where(sql`${storePaymentAccount.sealedKey} is not null and ${storePaymentAccount.keyId} <> ${current.keyId} and ${storePaymentAccount.id} > ${after}`)
        .orderBy(asc(storePaymentAccount.id)).limit(1).for("update", { skipLocked: true });
      if (!a) return null;
      try {
        const value = unsealCredential("payment_credentials", a.sealedKey!, a.keyId!, a.storeId, a.id, "autolaris");
        await tx.update(storePaymentAccount).set({ ...sealCredential("payment_credentials", value, a.storeId, a.id, "autolaris"), keyFingerprint: keyFingerprint("payment_credentials", value) }).where(eq(storePaymentAccount.id, a.id));
        return { id: a.id, ok: true };
      } catch (err) {
        logCode("payment.credentials.reseal_skipped", a.storeId, err);
        return { id: a.id, ok: false };
      }
    });
    if (!step) break;
    after = step.id;
    if (step.ok) changed++;
    else failed++;
  }
  return { changed, failed };
}
