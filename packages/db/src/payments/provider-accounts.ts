import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor, Tx } from "../client.ts";
import { consumeSellerStepUp } from "../ledger/stepup.ts";
import { cutoverError } from "../ledger/boundary.ts";
import { dbMailer } from "../platform/accounts.ts";
import { surfaceOriginsAreLoopback } from "../platform/mail-transport.ts";
import { DomainError, requireCap, type SellerScope, type StorefrontScope } from "../platform/scoped.ts";
import { inStore, withStore } from "../platform/tenant.ts";
import { auditLog, membership, storePickupArea, user } from "../schema.ts";
import { enforceLimits } from "../seller/commerce/checkout.ts";
import { keyFingerprint, keyHint, sealCredential, unsealCredential, type CredentialPurpose } from "../shipping/credentials.ts";
import { PROVIDER_ENVIRONMENTS, storeShippingAccount, type ProviderEnvironment } from "../shipping/schema-accounts.ts";
import { storeShippingSync } from "../shipping/schema-fulfillment.ts";
import { fakeAutoLaris } from "./fake.ts";
import { FAKE_AREAS, fakeMengantar } from "./providers.ts";
import { paymentProductionSwitch, storePaymentAccount } from "./schema-payments.ts";

// T-104 — the store's own provider accounts (ADR-0013 sections 1 to 3, D-27): the seller's Mengantar key (`store_shipping_account`, kind
// `seller_owned`, keyring `shipping_credentials`) and AutoLaris key (`store_payment_account`, keyring `payment_credentials`).
//
// Invariants, each with a named test in test/t104-provider-accounts.test.ts:
// - A key is never part of a returned value, an error, a log line, an audit row or a mail: views are explicit allow-lists of non-secret
//   columns (the application role holds no SELECT on the sealed columns at all), audit rows and mails carry the fingerprint and the
//   environment only, and every provider error is mapped to a code without reading its message.
// - Connect, replace and remove need `integrations.manage` (store owner) AND a step-up proof of this session consumed in the writing
//   transaction; `provider_account_guard` refuses a key or environment change by the application role without such a proof.
// - The sealed envelope is read only through `provider_key_envelope(store, provider)`, which refuses any store but `app_store_id()`, and its
//   additional data binds purpose, store, account row and kind.
// - A failed connection check stores nothing new: the previous key stays sealed and in use. Check and save share RL-PROVIDER-CHECK.
// - There is no provider URL anywhere: `environment` maps to a fixed origin read from server configuration (`providerOrigin`).

export const PROVIDERS = ["mengantar", "autolaris"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const PROVIDER_NAME: Record<Provider, string> = { mengantar: "Mengantar", autolaris: "AutoLaris" };
const PURPOSE: Record<Provider, CredentialPurpose> = { mengantar: "shipping_credentials", autolaris: "payment_credentials" };
/** The account kind sealed into the envelope's additional data. */
const SEAL_KIND: Record<Provider, string> = { mengantar: "seller_owned", autolaris: "autolaris" };
/** Step-up action of every key or environment change; the subject is the provider. */
export const PROVIDER_KEY_ACTION = "integrations.provider_key" as const;
/** RL-PROVIDER-CHECK (doc 16, D-33): a save or a check-now, 5 per 10 minutes per store. */
export const PROVIDER_CHECK_LIMIT = { limit: 5, windowSec: 600 } as const;
/** Printable ASCII without spaces; long enough to be a key, short enough to bound the envelope. */
const KEY_RE = /^[\x21-\x7e]{8,512}$/;

export type CheckCode = "AUTH_FAILED" | "PROVIDER_UNAVAILABLE" | "INVALID_RESPONSE";
export type ProviderCheckResult = { ok: true } | { ok: false; code: CheckCode };
export type ProviderCheckInput = { provider: Provider; environment: ProviderEnvironment; origin: string | null; apiKey: string; pickupAreaId: string | null; exec?: Executor };
/** One call that proves a key works (ADR-0013 decision 8): Mengantar a rate estimate from the pickup area, AutoLaris the channel list. */
export interface ProviderCheckTransport {
  readonly mode: "fake" | "live";
  check(input: ProviderCheckInput): Promise<ProviderCheckResult>;
}

/**
 * Local and CI transport (decision 33): no network. A key containing "INVALID" is refused, one containing "DOWN" finds the provider unreachable;
 * otherwise the existing fake adapters answer the decision-8 call (a rate estimate from the pickup area, the channel list).
 */
export class FakeProviderCheck implements ProviderCheckTransport {
  readonly mode = "fake" as const;
  /** What a call looked like, without the key. */
  calls: { provider: Provider; environment: ProviderEnvironment; origin: string | null }[] = [];
  /** One-shot override for tests: a result or a thrown error. */
  next: ProviderCheckResult | Error | null = null;
  async check(input: ProviderCheckInput): Promise<ProviderCheckResult> {
    if (this.calls.length >= 100) this.calls.shift(); // bounded: the module-level instance lives as long as the server
    this.calls.push({ provider: input.provider, environment: input.environment, origin: input.origin });
    const next = this.next;
    this.next = null;
    if (next instanceof Error) throw next;
    if (next) return next;
    if (/INVALID/i.test(input.apiKey)) return { ok: false, code: "AUTH_FAILED" };
    if (/DOWN/i.test(input.apiKey)) return { ok: false, code: "PROVIDER_UNAVAILABLE" };
    const answered = input.provider === "mengantar"
      ? (await fakeMengantar.estimate({ originAreaId: input.pickupAreaId ?? FAKE_AREAS[0]!.id, destinationAreaId: FAKE_AREAS[2]!.id, weightKg: 1, codAmount: 0 })).length > 0
      : (await fakeAutoLaris.listChannels()).length > 0;
    return answered ? { ok: true } : { ok: false, code: "INVALID_RESPONSE" };
  }
}
const fakeCheck = new FakeProviderCheck();
let checkOverride: ProviderCheckTransport | null = null;
/** Test seam. There is no live transport in this build; the production switch per provider is T-105 / T-106. */
export function setProviderCheckTransport(t: ProviderCheckTransport | null) { checkOverride = t; }
/**
 * The fake runs only outside production (the rule of `shipping/accounts.ts`), or in the e2e production build that sets the explicit
 * `PROVIDER_CHECK_FAKE=1` with every surface origin on loopback (so the flag alone, set by mistake on a real deployment, does
 * nothing: the rule of local mail), and never for a provider whose origin is configured. Anything else is refused and nothing is stored, so a
 * production server cannot record a passed check (and readiness) for a key no provider has seen.
 * lazy: the live transport and the audited per-provider production switch (decision 34) arrive with T-105 / T-106.
 */
export function fakeCheckAllowed(origin: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  return origin === null && (env.NODE_ENV !== "production" || (env.PROVIDER_CHECK_FAKE === "1" && surfaceOriginsAreLoopback(env)));
}
/** T-105 / T-106: the live check of each provider, used only for a configured origin (loaded on use: the provider modules import this one). */
const LIVE_CHECK: Partial<Record<Provider, () => Promise<ProviderCheckTransport>>> = {
  mengantar: async () => (await import("../shipping/seller.ts")).mengantarLiveCheck,
};
async function checkTransport(origin: string | null, provider: Provider): Promise<ProviderCheckTransport> {
  if (checkOverride) return checkOverride;
  const live = origin === null ? undefined : LIVE_CHECK[provider];
  if (live) return live();
  if (!fakeCheckAllowed(origin)) throw new DomainError("provider_unavailable", "Pengecekan koneksi penyedia belum tersedia di server ini. Tidak ada yang diubah.");
  return fakeCheck;
}

const ORIGIN_ENV: Record<Provider, Record<ProviderEnvironment, string>> = {
  mengantar: { sandbox: "MENGANTAR_SANDBOX_ORIGIN", production: "MENGANTAR_PRODUCTION_ORIGIN" },
  autolaris: { sandbox: "AUTOLARIS_SANDBOX_ORIGIN", production: "AUTOLARIS_PRODUCTION_ORIGIN" },
};
/**
 * The provider origin of an account (decision 10): chosen by the environment value only, from server configuration, never from stored or
 * submitted text. Null while the origin is not configured (locally, and until T-105 / T-106 read the documented origins). An https origin
 * without path, query or credentials, or the configuration is refused.
 */
export function providerOrigin(provider: Provider, environment: ProviderEnvironment, env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[ORIGIN_ENV[provider][environment]];
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("provider_origin_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || `${url.origin}` !== raw.replace(/\/$/, "")) throw new Error("provider_origin_invalid");
  return url.origin;
}

/** Runs the check; a thrown transport error becomes a code without its message being read (the Mengantar key travels in the URL path). */
async function runCheck(scope: Pick<SellerScope, "exec" | "storeId">, provider: Provider, environment: ProviderEnvironment, apiKey: string): Promise<ProviderCheckResult> {
  const origin = providerOrigin(provider, environment);
  const transport = await checkTransport(origin, provider);
  const [pickup] = provider === "mengantar" ? await inStore(scope, ({ exec }) => exec.select({ areaId: storePickupArea.areaId }).from(storePickupArea).where(eq(storePickupArea.storeId, scope.storeId))) : [];
  try {
    const r = await transport.check({ provider, environment, origin, apiKey, pickupAreaId: pickup?.areaId ?? null, exec: scope.exec });
    return r.ok ? { ok: true } : { ok: false, code: (["AUTH_FAILED", "PROVIDER_UNAVAILABLE", "INVALID_RESPONSE"] as const).includes(r.code) ? r.code : "INVALID_RESPONSE" };
  } catch {
    return { ok: false, code: "PROVIDER_UNAVAILABLE" };
  }
}

const CHECK_MESSAGE: Record<CheckCode, string> = {
  AUTH_FAILED: "Kunci ditolak penyedia.",
  PROVIDER_UNAVAILABLE: "Penyedia tidak bisa dihubungi saat ini.",
  INVALID_RESPONSE: "Jawaban penyedia tidak bisa dibaca.",
};

// ── Views: explicit allow-lists of non-secret columns ─────────────────────────────────────────────────────────────
const SHIP = storeShippingAccount;
const PAY = storePaymentAccount;
const SHIP_COLUMNS = { id: SHIP.id, environment: SHIP.environment, status: SHIP.status, keyHint: SHIP.keyHint, keyFingerprint: SHIP.keyFingerprint, lastCheckedAt: SHIP.lastCheckedAt, lastResult: SHIP.lastResult, revision: SHIP.revision, pickupRegisteredAt: SHIP.pickupRegisteredAt };
const PAY_COLUMNS = { id: PAY.id, environment: PAY.environment, status: PAY.status, keyHint: PAY.keyHint, keyFingerprint: PAY.keyFingerprint, lastCheckedAt: PAY.lastCheckedAt, lastResult: PAY.lastResult, revision: PAY.revision, originAreaId: PAY.originAreaId, destinationAreaId: PAY.destinationAreaId, shipperEmail: PAY.shipperEmail, senderAddress: PAY.senderAddress, paymentOnlyConfirmedAt: PAY.paymentOnlyConfirmedAt };
type AccountRow = { id: number; environment: ProviderEnvironment | null; status: string; keyHint: string | null; keyFingerprint: string | null; lastCheckedAt: Date | null; lastResult: string | null; revision: number; pickupRegisteredAt?: Date | null; originAreaId?: string | null; destinationAreaId?: string | null; shipperEmail?: string | null; senderAddress?: string | null; paymentOnlyConfirmedAt?: Date | null };

async function readAccount(exec: Executor, storeId: number, provider: Provider, lock = false): Promise<AccountRow | undefined> {
  if (provider === "mengantar") {
    const q = exec.select(SHIP_COLUMNS).from(SHIP).where(and(eq(SHIP.storeId, storeId), eq(SHIP.kind, "seller_owned")));
    return (await (lock ? q.for("update") : q))[0];
  }
  const q = exec.select(PAY_COLUMNS).from(PAY).where(eq(PAY.storeId, storeId));
  return (await (lock ? q.for("update") : q))[0];
}

export type ProviderAccountView = {
  provider: Provider;
  connected: boolean;
  environment: ProviderEnvironment | null;
  /** Masked: first and last four characters of a key of 24 characters or more, otherwise fully masked. */
  keyHint: string | null;
  lastCheckedAt: Date | null;
  lastResult: "ready" | CheckCode | null;
  revision: number;
};
export type PaymentAccountDetails = { originAreaId: string | null; destinationAreaId: string | null; shipperEmail: string | null; senderAddress: string | null; paymentOnlyConfirmedAt: Date | null };

const view = (provider: Provider, r: AccountRow | undefined): ProviderAccountView => ({
  provider,
  connected: r?.status === "active",
  environment: r?.environment ?? null,
  keyHint: r?.status === "active" ? r.keyHint : null,
  lastCheckedAt: r?.status === "active" ? r.lastCheckedAt : null,
  lastResult: r?.status === "active" ? (r.lastResult as ProviderAccountView["lastResult"]) : null,
  revision: r?.revision ?? 0,
});

// ── Readiness (ADR-0013 decisions 12 to 14) ─────────────────────────────────────────────────────────────────────
export type ReadinessGap = "key" | "check" | "dedicated" | "pickup_area" | "pickup_registered" | "order_fields" | "sender_address" | "payment_only" | "production_off";
export type Readiness = { ready: boolean; missing: ReadinessGap[] };
type ReadScope = Pick<SellerScope | StorefrontScope, "exec" | "storeId">;
const readiness = (missing: (ReadinessGap | false)[]): Readiness => {
  const gaps = missing.filter((g): g is ReadinessGap => g !== false);
  return { ready: gaps.length === 0, missing: gaps };
};
function shippingGaps(a: AccountRow | undefined, pickupArea: boolean, dedicated: DedicatedRow | undefined): Readiness {
  const keyed = a?.status === "active";
  // T-115 (decision 41): the seller confirmed THIS key's account as new and dedicated, after its order list was checked.
  const isDedicated = !!dedicated?.confirmedAt && dedicated.fingerprint === a?.keyFingerprint && dedicated.environment === a?.environment;
  return readiness([!keyed && "key", keyed && a!.lastResult !== "ready" && "check", keyed && !isDedicated && "dedicated", !pickupArea && "pickup_area", !a?.pickupRegisteredAt && "pickup_registered"]);
}
type DedicatedRow = { confirmedAt: Date | null; fingerprint: string | null; environment: string | null };
const readDedicated = async (exec: Executor, storeId: number): Promise<DedicatedRow | undefined> =>
  (await exec.select({ confirmedAt: storeShippingSync.dedicatedConfirmedAt, fingerprint: storeShippingSync.dedicatedFingerprint, environment: storeShippingSync.dedicatedEnvironment }).from(storeShippingSync).where(eq(storeShippingSync.storeId, storeId)))[0];
function paymentGaps(a: AccountRow | undefined, productionOn: boolean): Readiness {
  const keyed = a?.status === "active";
  return readiness([
    !keyed && "key",
    keyed && a!.lastResult !== "ready" && "check",
    !(a?.originAreaId && a.destinationAreaId && a.shipperEmail) && "order_fields",
    !a?.senderAddress && "sender_address",
    !a?.paymentOnlyConfirmedAt && "payment_only",
    // T-106 (decision 34): a production account waits for the Owner console switch, turned on only after the recorded sandbox pass.
    a?.environment === "production" && !productionOn && "production_off",
  ]);
}
/** Decision 34 (T-106): production calls on seller AutoLaris keys are on only after the Owner console switched them on. */
export async function autolarisProductionOn(exec: Executor): Promise<boolean> {
  const [row] = await exec.select({ enabled: paymentProductionSwitch.enabled }).from(paymentProductionSwitch).where(eq(paymentProductionSwitch.provider, "autolaris"));
  return row?.enabled === true;
}
/** Shipping is ready (decision 12): a sealed Mengantar key whose last check passed, a pickup area and a pickup address registered with that account. */
export async function shippingReadiness(scope: ReadScope): Promise<Readiness> {
  return inStore(scope, async ({ exec }) => {
    const [a, [pickup], dedicated] = await Promise.all([readAccount(exec, scope.storeId, "mengantar"), exec.select({ storeId: storePickupArea.storeId }).from(storePickupArea).where(eq(storePickupArea.storeId, scope.storeId)), readDedicated(exec, scope.storeId)]);
    return shippingGaps(a, !!pickup, dedicated);
  });
}
/** QRIS/VA is ready (decision 13): a sealed AutoLaris key whose last check passed, the order fields, a sender address and the recorded payment-only profile. */
export async function paymentReadiness(scope: ReadScope): Promise<Readiness> {
  return inStore(scope, async ({ exec }) => paymentGaps(await readAccount(exec, scope.storeId, "autolaris"), await autolarisProductionOn(exec)));
}
/**
 * Decision 14: a store opens with one ready payment method; a physical product is activated only while shipping is ready. COD counts as a
 * method once shipping is ready (its store switch arrives with T-105), bank transfer arrives with T-113. Callers (store opening, product
 * activation, the checkout method list) are wired by T-93, T-105 and T-106.
 */
export async function storeReadiness(scope: ReadScope) {
  const [shipping, qrisVa, bankTransfer] = await Promise.all([shippingReadiness(scope), paymentReadiness(scope), import("./bank-transfer.ts").then((m) => m.bankTransferReady(scope.exec, scope.storeId))]);
  // T-113 (decision 36): bank transfer with one listed account counts as a ready prepaid method.
  return { shipping, qrisVa, bankTransfer, canOpen: qrisVa.ready || bankTransfer || shipping.ready, physicalProducts: shipping.ready };
}

/** The seller screen (owner only): both accounts, the AutoLaris readiness inputs and readiness. Never a key, an envelope or a fingerprint. */
export async function sellerProviderAccounts(scope: SellerScope) {
  requireCap(scope, "integrations.manage");
  return inStore(scope, async ({ exec }) => {
    const [ship, pay, [pickup], dedicated] = await Promise.all([readAccount(exec, scope.storeId, "mengantar"), readAccount(exec, scope.storeId, "autolaris"), exec.select({ storeId: storePickupArea.storeId }).from(storePickupArea).where(eq(storePickupArea.storeId, scope.storeId)), readDedicated(exec, scope.storeId)]);
    const details: PaymentAccountDetails | null = pay ? { originAreaId: pay.originAreaId ?? null, destinationAreaId: pay.destinationAreaId ?? null, shipperEmail: pay.shipperEmail ?? null, senderAddress: pay.senderAddress ?? null, paymentOnlyConfirmedAt: pay.paymentOnlyConfirmedAt ?? null } : null;
    const shipping = shippingGaps(ship, !!pickup, dedicated), qrisVa = paymentGaps(pay, await autolarisProductionOn(exec));
    const bankTransfer = (await (await import("./bank-transfer.ts")).bankTransferState(exec, scope.storeId)).ready; // T-113 (decision 36)
    return { mengantar: view("mengantar", ship), autolaris: view("autolaris", pay), details, readiness: { shipping, qrisVa, bankTransfer, canOpen: qrisVa.ready || bankTransfer || shipping.ready, physicalProducts: shipping.ready } };
  });
}

// ── Opening a key: the server-side provider client only ──────────────────────────────────────────────────────────
/**
 * Opens this store's sealed key for a provider call. Not exported by the package entry point. The envelope comes from the definer function
 * that refuses any store but the transaction's `app_store_id()`; the additional data binds it to this store, row and kind.
 */
export async function openProviderKey(scope: Pick<SellerScope, "exec" | "storeId">, provider: Provider): Promise<string> {
  const rows = (await inStore(scope, ({ exec }) => exec.execute(sql`select account_id, key_id, sealed_key from public.provider_key_envelope(${scope.storeId}::bigint, ${provider})`))) as unknown as { account_id: string; key_id: string; sealed_key: string }[];
  const r = rows[0];
  if (!r) throw new DomainError("not_connected", `Belum ada kunci ${PROVIDER_NAME[provider]} tersimpan.`);
  return unsealCredential(PURPOSE[provider], r.sealed_key, r.key_id, scope.storeId, Number(r.account_id), SEAL_KIND[provider]);
}

// ── Changes ─────────────────────────────────────────────────────────────────────────────────────────────────────
const providerSchema = z.enum(PROVIDERS, { error: "Penyedia tidak dikenal." });
const saveInput = z.strictObject({
  provider: providerSchema,
  environment: z.enum(PROVIDER_ENVIRONMENTS, { error: "Pilih lingkungan: sandbox atau produksi." }),
  apiKey: z.string().max(2000, "Kunci API terlalu panjang."),
  proofId: z.string(),
});
const removeInput = z.strictObject({ provider: providerSchema, proofId: z.string() });

const limitCheck = (scope: SellerScope) => enforceLimits(scope.exec, [{ key: `provider-check:store:${scope.storeId}`, rule: PROVIDER_CHECK_LIMIT }]);
const ENV_LABEL: Record<ProviderEnvironment, string> = { sandbox: "sandbox", production: "produksi" };

/** Insert the store's (empty) account row when it does not exist yet, then lock it. The key is written by the caller in the same transaction. */
async function lockedAccount(tx: Tx, storeId: number, provider: Provider, environment: ProviderEnvironment): Promise<AccountRow> {
  // Explicit column lists: the application role holds INSERT on exactly these columns (migration 0018).
  if (provider === "mengantar") await tx.execute(sql`insert into public.store_shipping_account (store_id, kind, status, external_user_id, environment) values (${storeId}, 'seller_owned', 'needs_key', ${`store:${storeId}`}, ${environment}) on conflict (store_id, kind) do nothing`);
  else await tx.execute(sql`insert into public.store_payment_account (store_id, environment, status) values (${storeId}, ${environment}, 'needs_key') on conflict (store_id) do nothing`);
  return (await readAccount(tx, storeId, provider, true))!;
}

async function auditAndNotify(tx: Tx, scope: SellerScope, provider: Provider, change: "connect" | "replace" | "environment" | "remove", environment: ProviderEnvironment, fingerprint: string) {
  await tx.insert(auditLog).values({ storeId: scope.storeId, actorUserId: scope.userId, actorCapability: "integrations.manage", action: `provider.key.${change}`, subjectKind: "provider_account", subjectId: provider, accessLevel: "write", outcome: "allowed", reason: `environment=${environment}; fingerprint=${fingerprint}` });
  const [me] = await tx.select({ email: user.email }).from(user).where(eq(user.id, scope.userId));
  const owners = await tx.select({ email: user.email }).from(membership).innerJoin(user, eq(user.id, membership.userId)).where(and(eq(membership.storeId, scope.storeId), eq(membership.role, "owner")));
  const what = { connect: "dihubungkan", replace: "diganti", environment: `dipindah ke lingkungan ${ENV_LABEL[environment]}`, remove: "dihapus" }[change];
  for (const to of new Set(owners.map((o) => o.email))) {
    await dbMailer(tx).send({
      to,
      subject: `Kunci ${PROVIDER_NAME[provider]} toko ${scope.storeName} ${change === "remove" ? "dihapus" : "diubah"}`,
      text: `Kunci API ${PROVIDER_NAME[provider]} toko ${scope.storeName} ${what} oleh ${me?.email ?? "pemilik toko"} (lingkungan: ${ENV_LABEL[environment]}). Kunci tidak pernah ditampilkan atau dikirim lewat e-mail. Jika bukan Anda, segera amankan akun Anda dan periksa Akun penyedia di Seller Admin.`,
    });
  }
}

/**
 * Connect or replace a key, or move a connected key to the other environment (an empty key field keeps the stored key). The connection
 * check runs BEFORE anything is written and outside the transaction; a failed check changes nothing. The step-up proof is consumed in the
 * writing transaction, so a failed write leaves it unconsumed until it expires.
 */
export async function saveProviderKey(scope: SellerScope, raw: unknown): Promise<ProviderAccountView> {
  requireCap(scope, "integrations.manage");
  const input = saveInput.parse(raw);
  const { provider, environment } = input;
  const apiKey = input.apiKey.trim();
  if (apiKey && !KEY_RE.test(apiKey)) throw new DomainError("invalid_key", "Kunci API harus 8 sampai 512 karakter tanpa spasi.");
  const current = await inStore(scope, ({ exec }) => readAccount(exec, scope.storeId, provider));
  const connected = current?.status === "active";
  if (!apiKey && !connected) throw new DomainError("invalid_key", `Isi kunci API ${PROVIDER_NAME[provider]}.`);
  if (!apiKey && current!.environment === environment) throw new DomainError("no_change", "Tidak ada perubahan. Kolom kunci yang kosong mempertahankan kunci tersimpan; isi kunci baru atau pilih lingkungan lain.");
  await limitCheck(scope);
  const value = apiKey || (await openProviderKey(scope, provider));
  const result = await runCheck(scope, provider, environment, value);
  if (!result.ok) throw new DomainError("check_failed", `${CHECK_MESSAGE[result.code]} Tidak ada yang diubah; kunci sebelumnya tetap dipakai.`);
  const fingerprint = keyFingerprint(PURPOSE[provider], value);
  // T-115 (ADR-0013 decision 41): another Mengantar account (a new key or environment) must hold no order Bukalaris did not create for this store.
  if (provider === "mengantar" && !(connected && current!.keyFingerprint === fingerprint && current!.environment === environment)) {
    await (await import("../shipping/sync.ts")).assertDedicatedAccount(scope, environment, value);
  }
  // T-107 (review M2): the first own account of a store is refused while platform money of it is in flight (`money_cutover_guard`); the seller sees why.
  return withStore(scope.exec, scope.storeId, async (tx) => {
    await consumeSellerStepUp(tx, scope, input.proofId, { action: PROVIDER_KEY_ACTION, subjectId: provider });
    const row = await lockedAccount(tx, scope.storeId, provider, environment);
    // The account must still be the one read (and, for an empty key field, opened) before the check: a change saved meanwhile wins.
    if (row.revision !== (current?.revision ?? 0) || row.keyFingerprint !== (current?.keyFingerprint ?? null)) throw new DomainError("conflict", "Akun ini baru saja diubah di sesi lain. Muat ulang halaman lalu coba lagi; tidak ada yang diubah.");
    const change = row.status !== "active" ? "connect" : apiKey ? "replace" : "environment";
    // The pickup address is registered with one Mengantar account: another key or environment needs a new registration (T-105).
    const sameAccount = row.status === "active" && row.keyFingerprint === fingerprint && row.environment === environment;
    const set = { ...sealCredential(PURPOSE[provider], value, scope.storeId, row.id, SEAL_KIND[provider]), environment, status: "active" as const, keyFingerprint: fingerprint, keyHint: keyHint(value), lastCheckedAt: sql`now()` as unknown as Date, lastResult: "ready", stepUpRef: input.proofId, revision: sql`revision + 1` as unknown as number, updatedAt: sql`now()` as unknown as Date };
    const [saved] = provider === "mengantar"
      ? await tx.update(SHIP).set({ ...set, ...(sameAccount ? {} : { pickupRegisteredAt: null }) }).where(and(eq(SHIP.storeId, scope.storeId), eq(SHIP.id, row.id))).returning(SHIP_COLUMNS)
      : await tx.update(PAY).set(set).where(and(eq(PAY.storeId, scope.storeId), eq(PAY.id, row.id))).returning(PAY_COLUMNS);
    await auditAndNotify(tx, scope, provider, change, environment, fingerprint);
    return view(provider, saved);
  }).catch((err: unknown) => {
    throw cutoverError(err);
  });
}

/** Remove the key (an explicit action, never an empty field): step-up consumed, audited, every owner told. The row stays for history. */
export async function removeProviderKey(scope: SellerScope, raw: unknown): Promise<ProviderAccountView> {
  requireCap(scope, "integrations.manage");
  const { provider, proofId } = removeInput.parse(raw);
  return withStore(scope.exec, scope.storeId, async (tx) => {
    await consumeSellerStepUp(tx, scope, proofId, { action: PROVIDER_KEY_ACTION, subjectId: provider });
    const row = await readAccount(tx, scope.storeId, provider, true);
    if (row?.status !== "active") throw new DomainError("not_connected", `Belum ada kunci ${PROVIDER_NAME[provider]} tersimpan.`);
    const set = { sealedKey: null, keyId: null, sealedAt: null, keyFingerprint: null, keyHint: null, status: "needs_key" as const, lastCheckedAt: null, lastResult: null, stepUpRef: proofId, revision: sql`revision + 1` as unknown as number, updatedAt: sql`now()` as unknown as Date };
    const [saved] = provider === "mengantar"
      ? await tx.update(SHIP).set({ ...set, pickupRegisteredAt: null }).where(and(eq(SHIP.storeId, scope.storeId), eq(SHIP.id, row.id))).returning(SHIP_COLUMNS)
      : await tx.update(PAY).set(set).where(and(eq(PAY.storeId, scope.storeId), eq(PAY.id, row.id))).returning(PAY_COLUMNS);
    await auditAndNotify(tx, scope, provider, "remove", row.environment!, row.keyFingerprint!);
    return view(provider, saved);
  });
}

/** "Check now" on the stored key: records the time and result only. A failed check keeps the key (and the store is not ready until it passes). */
export async function checkProviderNow(scope: SellerScope, rawProvider: unknown): Promise<ProviderCheckResult> {
  requireCap(scope, "integrations.manage");
  const provider = providerSchema.parse(rawProvider);
  const current = await inStore(scope, ({ exec }) => readAccount(exec, scope.storeId, provider));
  if (current?.status !== "active") throw new DomainError("not_connected", `Belum ada kunci ${PROVIDER_NAME[provider]} tersimpan.`);
  await limitCheck(scope);
  const value = await openProviderKey(scope, provider);
  const result = await runCheck(scope, provider, current.environment!, value);
  const lastResult = result.ok ? "ready" : result.code;
  await inStore(scope, async ({ exec }) => {
    // Only the key that was checked: a replacement saved meanwhile keeps its own result.
    if (provider === "mengantar") await exec.update(SHIP).set({ lastCheckedAt: sql`now()` as unknown as Date, lastResult }).where(and(eq(SHIP.storeId, scope.storeId), eq(SHIP.id, current.id), eq(SHIP.keyFingerprint, current.keyFingerprint!)));
    else await exec.update(PAY).set({ lastCheckedAt: sql`now()` as unknown as Date, lastResult }).where(and(eq(PAY.storeId, scope.storeId), eq(PAY.id, current.id), eq(PAY.keyFingerprint, current.keyFingerprint!)));
  });
  return result;
}

const areaId = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "ID area hanya huruf, angka, garis bawah atau tanda hubung (maksimal 64).");
const detailsInput = z.strictObject({
  originAreaId: areaId,
  destinationAreaId: areaId,
  shipperEmail: z.string().trim().max(254).pipe(z.email("E-mail pengirim tidak valid.")),
  senderAddress: z.string().trim().min(10, "Alamat pengirim minimal 10 karakter.").max(500),
  paymentOnlyConfirmed: z.boolean(),
});
/** The AutoLaris readiness inputs of decision 13. Owner only, audited; not a key change, so no step-up. Needs a connected account row. */
export async function setPaymentAccountDetails(scope: SellerScope, raw: unknown): Promise<PaymentAccountDetails> {
  requireCap(scope, "integrations.manage");
  const input = detailsInput.parse(raw);
  return withStore(scope.exec, scope.storeId, async (tx) => {
    const row = await readAccount(tx, scope.storeId, "autolaris", true);
    if (!row) throw new DomainError("not_connected", "Hubungkan kunci AutoLaris terlebih dahulu.");
    const confirmed = input.paymentOnlyConfirmed ? (row.paymentOnlyConfirmedAt ? {} : { paymentOnlyConfirmedAt: sql`now()` as unknown as Date, paymentOnlyConfirmedBy: scope.userId }) : { paymentOnlyConfirmedAt: null, paymentOnlyConfirmedBy: null };
    const [saved] = await tx.update(PAY).set({ originAreaId: input.originAreaId, destinationAreaId: input.destinationAreaId, shipperEmail: input.shipperEmail, senderAddress: input.senderAddress, ...confirmed, revision: sql`revision + 1` as unknown as number, updatedAt: sql`now()` as unknown as Date }).where(and(eq(PAY.storeId, scope.storeId), eq(PAY.id, row.id))).returning(PAY_COLUMNS);
    await tx.insert(auditLog).values({ storeId: scope.storeId, actorUserId: scope.userId, actorCapability: "integrations.manage", action: "provider.details.update", subjectKind: "provider_account", subjectId: "autolaris", accessLevel: "write", outcome: "allowed", reason: `payment_only=${input.paymentOnlyConfirmed}` });
    return { originAreaId: saved!.originAreaId, destinationAreaId: saved!.destinationAreaId, shipperEmail: saved!.shipperEmail, senderAddress: saved!.senderAddress, paymentOnlyConfirmedAt: saved!.paymentOnlyConfirmedAt };
  });
}
