import { randomBytes } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Executor } from "../client.ts";
import { DomainError, requireCap, type OperatorScope, type SellerScope, type StorefrontScope } from "../platform/scoped.ts";
import { inStore, withStore } from "../platform/tenant.ts";
import { requirePlatformCap } from "../ops/capabilities.ts";
import { consoleMutation } from "../ops/console.ts";
import { enqueue } from "../ops/jobs/jobs.ts";
import { shippingControl, storeShippingAccount, type ShippingAccountKind } from "./schema-accounts.ts";
import { courierServicePolicy, order } from "../schema.ts";
import { sealShippingKey, shippingKeyring, unsealShippingKey } from "./credentials.ts";
import { FakePartnerTransport, PartnerClient, PartnerError, PARTNER_CONFLICT_ROUNDS_MAX, PARTNER_EMAIL_ATTEMPTS, PARTNER_MAX_PAGES, PARTNER_PROVISION_LEASE_MS, partnerRetryDelayMs, PARTNER_SWEEP_BATCH, type PartnerCredentials } from "./mengantar/partner.ts";
import { mengantarRotationRecorded } from "./mengantar/gate.ts";

export const SHIPPING_ACCOUNT_PROVISION = "shipping.account.provision";
export const SHIPPING_ACCOUNT_SYNC = "shipping.account.sync";
export const SHIPPING_ACCOUNT_SWEEP = "shipping.account.sweep";
export const SHIPPING_CREDENTIAL_RESEAL = "shipping.credentials.reseal";
// One allowlist used by seller, checkout and console. Sealed columns and registration e-mail cannot accidentally enter a DTO.
export const SHIPPING_ACCOUNT_VIEW = {
  id: storeShippingAccount.id, storeId: storeShippingAccount.storeId, kind: storeShippingAccount.kind,
  status: storeShippingAccount.status, lastCheckedAt: storeShippingAccount.lastCheckedAt,
  lastResult: storeShippingAccount.lastResult, revision: storeShippingAccount.revision,
};
/** Operator-only: the allowlist plus the failed-round counter (never part of a seller or checkout DTO). */
const SHIPPING_ACCOUNT_OPERATOR_VIEW = { ...SHIPPING_ACCOUNT_VIEW, registrationAttempts: storeShippingAccount.registrationAttempts };
export type ShippingAccountView = { id: number; storeId: number; kind: ShippingAccountKind; status: "pending" | "active" | "needs_key" | "disabled"; lastCheckedAt: Date | null; lastResult: string | null; revision: number };
const fakePartner = new FakePartnerTransport();
let partnerOverride: FakePartnerTransport | null = null;
/** Test seam is fake-only; a live transport is not built (production base URL, egress IP and the rotation gate are owner steps). */
export function setPartnerTransport(transport: FakePartnerTransport | null) { partnerOverride = transport; }
/** The fake runs only outside production: a production worker without a live adapter refuses instead of minting fake accounts and keys. */
function defaultPartnerClient(db: Db): PartnerClient {
  if (!partnerClientAvailable()) throw new PartnerError("PROVIDER_UNAVAILABLE");
  return new PartnerClient(db, partnerOverride ?? fakePartner);
}
/** False in production while no live adapter is installed (there is none yet): the worker schedules then do nothing instead of failing every minute into dead jobs. */
export function partnerClientAvailable(): boolean {
  return !!partnerOverride || process.env.NODE_ENV !== "production";
}
/** Stores whose 409 retries are exhausted: no automatic provisioning until the owner recovers the account (which resets the counter). */
const conflictRoundsExhausted = sql`(${storeShippingAccount.registrationAttempts} >= ${PARTNER_CONFLICT_ROUNDS_MAX} and ${storeShippingAccount.lastResult} = 'EMAIL_ALREADY_REGISTERED')`;

export async function selectShippingAccount(scope: Pick<SellerScope | StorefrontScope, "exec" | "storeId">): Promise<ShippingAccountView> {
  return inStore(scope, async ({ exec }) => {
    const accounts = await exec.select(SHIPPING_ACCOUNT_VIEW).from(storeShippingAccount).where(eq(storeShippingAccount.storeId, scope.storeId));
    const [control] = await exec.select({ preferPartner: shippingControl.preferPartner }).from(shippingControl).where(eq(shippingControl.key, "default"));
    const chosen = (control?.preferPartner ? accounts.find((a) => a.kind === "partner_managed" && a.status === "active") : undefined)
      ?? accounts.find((a) => a.kind === "platform_master" && a.status === "active");
    if (!chosen) throw new DomainError("awaiting_account", "Akun Bukalaris Kirim belum siap; tunggu pemulihan oleh Bukalaris.");
    return chosen;
  });
}
export async function sellerShippingAccounts(scope: SellerScope) {
  requireCap(scope, "shipping.read");
  const accounts = await inStore(scope, ({ exec }) => exec.select(SHIPPING_ACCOUNT_VIEW).from(storeShippingAccount).where(eq(storeShippingAccount.storeId, scope.storeId)).orderBy(asc(storeShippingAccount.id)));
  let selected: ShippingAccountView | null = null;
  try { selected = await selectShippingAccount(scope); } catch (e) { if (!(e instanceof DomainError) || e.code !== "awaiting_account") throw e; }
  const services = await scope.exec.select({ courierCode: courierServicePolicy.courierCode, serviceCode: courierServicePolicy.serviceCode, codAllowed: courierServicePolicy.codAllowed, returnFree: courierServicePolicy.returnFree }).from(courierServicePolicy).where(eq(courierServicePolicy.status, "active"));
  return { accounts, selected, services, cashback: "off" as const };
}

/** Every use after checkout resolves THIS frozen account, never the current routing default. */
export async function orderShippingAccount(exec: Executor, storeId: number, orderId: number): Promise<ShippingAccountView> {
  const account = await withStore(exec, storeId, async (tx) => {
    const [a] = await tx.select(SHIPPING_ACCOUNT_VIEW).from(storeShippingAccount).innerJoin(order, and(eq(order.storeId, storeShippingAccount.storeId), eq(order.shippingAccountId, storeShippingAccount.id), eq(order.shippingAccountKind, storeShippingAccount.kind))).where(and(eq(order.storeId, storeId), eq(order.id, orderId)));
    return a;
  });
  if (!account || account.status !== "active") throw new DomainError("awaiting_account", "Akun pengiriman pesanan ini perlu dipulihkan. Pesanan tidak dialihkan ke akun lain.");
  return account;
}

/** Worker entry; one durable claim, no provider I/O in the claim/save transaction. A concurrent invocation returns the SAME binding. */
export async function provisionShippingAccount(db: Db, storeId: number, client: PartnerClient = defaultPartnerClient(db)) {
  shippingKeyring(); // validate BEFORE the provider creates anything
  const account = await db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string; store_id: string; status: string; external_user_id: string; mengantar_seller_id: string | null; registered_email: string | null; registration_attempts: number }>(sql`
      update public.store_shipping_account set provisioning_until = now() + ${PARTNER_PROVISION_LEASE_MS} * interval '1 millisecond', updated_at = now()
      where store_id = ${storeId} and kind = 'partner_managed' and status in ('pending', 'needs_key')
        and (provisioning_until is null or provisioning_until <= now()) and (next_retry_at is null or next_retry_at <= now())
        and not (registration_attempts >= ${PARTNER_CONFLICT_ROUNDS_MAX} and last_result = 'EMAIL_ALREADY_REGISTERED')
      returning id, store_id, status, external_user_id, mengantar_seller_id, registered_email, registration_attempts`);
    return rows[0];
  });
  if (!account) {
    const [existing] = await db.select(SHIPPING_ACCOUNT_VIEW).from(storeShippingAccount).where(and(eq(storeShippingAccount.storeId, storeId), eq(storeShippingAccount.kind, "partner_managed")));
    if (!existing) throw new DomainError("not_found", "Akun pengiriman tidak ditemukan.");
    return { accountId: existing.id, outcome: existing.status === "active" ? "active" as const : existing.status === "disabled" ? "disabled" as const : "busy" as const };
  }
  const id = Number(account.id);
  try {
    let value: PartnerCredentials | undefined;
    if (account.status === "needs_key" && account.mengantar_seller_id) value = await client.currentKey(account.mengantar_seller_id);
    else {
      for (let attempt = 0; attempt < PARTNER_EMAIL_ATTEMPTS; attempt++) {
        const domain = process.env.MENGANTAR_ROUTING_EMAIL_DOMAIN ?? "shipping.bukalaris.invalid";
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new PartnerError("INVALID_RESPONSE");
        const email = attempt === 0 && !account.registered_email ? `store-${storeId}@${domain}` : `store-${storeId}-${randomBytes(8).toString("hex")}@${domain}`;
        await db.update(storeShippingAccount).set({ registeredEmail: email }).where(and(eq(storeShippingAccount.id, id), eq(storeShippingAccount.storeId, storeId)));
        try { value = await client.register(account.external_user_id, email); break; }
        catch (err) { if (!(err instanceof PartnerError) || err.code !== "EMAIL_ALREADY_REGISTERED" || attempt + 1 === PARTNER_EMAIL_ATTEMPTS) throw err; }
      }
    }
    if (!value) throw new PartnerError("INVALID_RESPONSE");
    const sealed = sealShippingKey(value.apiKey, storeId, id);
    await db.update(storeShippingAccount).set({ ...sealed, mengantarSellerId: value.sellerId, status: "active", lastResult: "ready", lastCheckedAt: new Date(), provisioningUntil: null, nextRetryAt: null, registrationAttempts: 0, revision: sql`${storeShippingAccount.revision} + 1`, updatedAt: new Date() }).where(and(eq(storeShippingAccount.id, id), eq(storeShippingAccount.storeId, storeId), sql`${storeShippingAccount.status} <> 'disabled'`));
    return { accountId: id, outcome: "active" as const };
  } catch (err) {
    const e = err instanceof PartnerError ? err : new PartnerError("PROVIDER_UNAVAILABLE");
    const disabled = e.code === "SELLER_DEACTIVATED" || e.code === "API_KEY_DISABLED";
    // A rate limit is the shared budget speaking, not this store failing: it never counts against the store. Every other failure lengthens the back-off (15 min, 30, 60 ... 6 h).
    const failed = e.code === "RATE_LIMITED" ? 0 : 1;
    await db.update(storeShippingAccount).set({ ...(disabled ? { status: "disabled" as const } : {}), lastResult: e.code, lastCheckedAt: new Date(), provisioningUntil: null, registrationAttempts: sql`${storeShippingAccount.registrationAttempts} + ${failed}`, nextRetryAt: sql`now() + ${e.retryAfterSec ? e.retryAfterSec * 1000 : partnerRetryDelayMs(account.registration_attempts + failed)} * interval '1 millisecond'` }).where(and(eq(storeShippingAccount.id, id), eq(storeShippingAccount.storeId, storeId)));
    if (disabled) return { accountId: id, outcome: "disabled" as const };
    throw e;
  }
}

export async function queueShippingAccountRecovery(op: OperatorScope, raw: unknown) {
  const input = z.strictObject({ accountId: z.coerce.number().int().positive(), revision: z.coerce.number().int().nonnegative(), reason: z.string().trim().min(5).max(300) }).parse(raw);
  return consoleMutation(op, { capability: "shipping.manage", action: "shipping.account.recover", targetKind: "shipping_account", targetId: String(input.accountId), reason: input.reason, reasonCode: "key_recovery" }, async (tx) => {
    const [a] = await tx.select(SHIPPING_ACCOUNT_VIEW).from(storeShippingAccount).where(eq(storeShippingAccount.id, input.accountId)).for("update");
    if (!a || a.kind !== "partner_managed") throw new DomainError("not_found", "Akun tidak ditemukan.");
    if (a.status === "disabled") throw new DomainError("account_disabled", "Akun dinonaktifkan penyedia; pemulihan otomatis dihentikan.");
    if (a.revision !== input.revision) throw new DomainError("conflict", "Akun berubah; muat ulang sebelum mencoba lagi.");
    const revision = a.revision + 1;
    await tx.update(storeShippingAccount).set({ status: a.status === "active" ? "needs_key" : a.status, revision, provisioningUntil: null, nextRetryAt: null, registrationAttempts: 0 }).where(eq(storeShippingAccount.id, a.id));
    await enqueue(tx, { storeId: a.storeId, kind: SHIPPING_ACCOUNT_PROVISION, key: `shipping-account:${a.id}:${revision}`, payload: { accountId: a.id } });
  });
}

export async function shippingAccountHealth(op: OperatorScope, after = 0) {
  await requirePlatformCap(op, "shipping.manage");
  const accounts = await op.exec.select({ ...SHIPPING_ACCOUNT_OPERATOR_VIEW, autoRetryStopped: conflictRoundsExhausted.mapWith(Boolean) }).from(storeShippingAccount).where(sql`${storeShippingAccount.id} > ${after}`).orderBy(asc(storeShippingAccount.id)).limit(100);
  return { accounts, rotationRecorded: mengantarRotationRecorded(), providerCalls: "disabled" as const, mode: "fake" as const };
}

/** JOB-08: bounded list reconciliation. A foreign or mismatched remote seller can never disable another store's binding. */
export async function syncShippingAccounts(db: Db, client: PartnerClient = defaultPartnerClient(db)) {
  let checked = 0;
  for (let page = 1; page <= PARTNER_MAX_PAGES; page++) {
    const response = await client.list(page);
    for (const seller of response.sellers) {
      const updated = await db.update(storeShippingAccount).set({ ...(seller.active ? {} : { status: "disabled" as const }), lastResult: seller.active ? "ready" : "SELLER_DEACTIVATED", lastCheckedAt: new Date() }).where(and(eq(storeShippingAccount.kind, "partner_managed"), eq(storeShippingAccount.externalUserId, seller.externalUserId), eq(storeShippingAccount.mengantarSellerId, seller.sellerId))).returning({ id: storeShippingAccount.id });
      checked += updated.length;
    }
    if (!response.hasMore) break;
  }
  return { checked };
}

/** JOB-23: one envelope per committed transaction, original store/account/kind AAD retained; old keys stay until all rows have moved. */
export async function resealShippingCredentials(db: Db, limit = 100) {
  const current = shippingKeyring()[0]!;
  let changed = 0;
  for (let i = 0; i < limit; i++) {
    const resealed = await db.transaction(async (tx) => {
      const [a] = await tx.select().from(storeShippingAccount).where(sql`${storeShippingAccount.sealedKey} is not null and ${storeShippingAccount.keyId} <> ${current.keyId}`).orderBy(asc(storeShippingAccount.id)).limit(1).for("update", { skipLocked: true });
      if (!a) return false;
      const sealed = sealShippingKey(unsealShippingKey(a.sealedKey!, a.keyId!, a.storeId, a.id), a.storeId, a.id);
      await tx.update(storeShippingAccount).set(sealed).where(eq(storeShippingAccount.id, a.id));
      return true;
    });
    if (!resealed) break;
    changed++;
  }
  return { changed };
}

/** The automatic part of "every store gets a Bukalaris-generated account": a bounded sweep over pending bindings whose retry time has come. One failure never stops the batch. */
export async function sweepPendingAccounts(db: Db, client: PartnerClient = defaultPartnerClient(db)) {
  const due = await db.select({ storeId: storeShippingAccount.storeId }).from(storeShippingAccount).where(sql`${storeShippingAccount.kind} = 'partner_managed' and ${storeShippingAccount.status} = 'pending' and (${storeShippingAccount.nextRetryAt} is null or ${storeShippingAccount.nextRetryAt} <= now()) and (${storeShippingAccount.provisioningUntil} is null or ${storeShippingAccount.provisioningUntil} <= now()) and not ${conflictRoundsExhausted}`).orderBy(asc(storeShippingAccount.id)).limit(PARTNER_SWEEP_BATCH);
  const outcomes: { storeId: number; outcome: string }[] = [];
  for (const { storeId } of due) {
    try { outcomes.push({ storeId, outcome: (await provisionShippingAccount(db, storeId, client)).outcome }); }
    catch (err) { outcomes.push({ storeId, outcome: err instanceof PartnerError ? err.code : "ERROR" }); if (err instanceof PartnerError && err.code === "RATE_LIMITED") break; }
  }
  return outcomes;
}
