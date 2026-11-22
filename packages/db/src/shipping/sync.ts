import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Executor, Tx } from "../client.ts";
import { enqueue, registerHandler } from "../ops/jobs/jobs.ts";
import { dbMailer } from "../platform/accounts.ts";
import { surfaceOriginsFromEnv } from "../platform/host.ts";
import { hit, type LimitRule } from "../platform/rate-limit.ts";
import { DomainError, requireCap, type SellerScope } from "../platform/scoped.ts";
import { inStore, withStore } from "../platform/tenant.ts";
import { auditLog, membership, order, shipment, user } from "../schema.ts";
import { keyFingerprint, sealCredential, unsealCredential } from "./credentials.ts";
import { SHIPMENT_TRACK, TERMINAL } from "./fulfillment.ts";
import { storeShippingAccount, type ProviderEnvironment } from "./schema-accounts.ts";
import { shipmentStatusEvent, shippingForeignParcel, shippingWebhookEvent, storeShippingSync, type MirroredInvoice } from "./schema-fulfillment.ts";
import { storableCategory } from "./parcel-state.ts";
import { openSellerKeyAsWorker, sellerMengantar, type AccountOrder, type SellerMengantar } from "./seller.ts";

// T-115 — Mengantar account lock, dedicated-account check and parcel sync (ADR-0013 section 11, decisions 40 to 45; decisions 30, 31).
//
// Invariants, each with a named test in test/t115-mengantar-lock.test.ts:
// - Mengantar is the only shipping provider (decision 40): every shipping account kind is a Mengantar account and no seller or operator path
//   names another (`SHIPPING_PROVIDER`).
// - The account is dedicated (decision 41): connecting a key reads the account's order list (archive included) and refuses an account holding
//   any order Bukalaris did not create for this store; the seller's confirmation is recorded for that key and environment only. A parcel found
//   later that Bukalaris did not create is listed as foreign, never imported, and marks the store's sync as not exact until resolved.
// - Two paths, one writer (decision 43): a webhook is verified (HMAC-SHA256 of `{x-timestamp}.{raw body}` with the store's sealed Webhook
//   Secret, constant time; stale timestamps refused; a sandbox delivery refused for a production account), stored once (a replay is a
//   duplicate), and ONLY enqueues a tracking read on the store's key. The read (`fulfillment.ts` SHIPMENT_TRACK) is the single writer of parcel
//   state; a scheduled sweep reads every non-final parcel with a fair order across stores, so a paused webhook costs only time.
// - The Webhook Secret is sealed like the API key (section 2): step-up, audit and owner notice with a fingerprint only; never in an error, a
//   log line, an audit row, a job payload or a mail.
// - Mengantar's money figures (decision 45) are a read-only mirror with their read time: the balance and newest invoices of the account.

/** Decision 40: the one shipping aggregator. There is no provider setting anywhere; every `store_shipping_account` kind is a Mengantar account. */
export const SHIPPING_PROVIDER = "mengantar" as const;

/** The AAD kind of a sealed Webhook Secret: an envelope of the API key never opens as a secret and the reverse. */
const WEBHOOK_SEAL_KIND = "seller_owned_webhook";
/** The step-up subject of a Webhook Secret change (action `integrations.provider_key`, as a key change). */
export const WEBHOOK_SECRET_SUBJECT = "mengantar_webhook";
/** A signed delivery older or newer than this is refused (the documented examples use five minutes). */
export const WEBHOOK_MAX_SKEW_MS = 5 * 60_000;
export const WEBHOOK_BODY_MAX_BYTES = 4096;
/** RL-MENGANTAR-WH (doc 16, D-33): after the signature, per store. */
export const MENGANTAR_WEBHOOK_LIMIT: LimitRule = { limit: 600, windowSec: 600 };
/** The scheduled read (decision 43): a parcel not read for this long is read again; at most `PARCEL_SWEEP_BATCH` reads per minute. */
export const PARCEL_SWEEP_STALE_MS = 30 * 60_000;
export const PARCEL_SWEEP_BATCH = 100;
/** The account scan (decisions 41, 45): every store at most every six hours; a seller's own request at most every ten minutes. */
export const ACCOUNT_SCAN_EVERY_MS = 6 * 3_600_000;
export const ACCOUNT_SCAN_REQUEST_MS = 10 * 60_000;
export const ACCOUNT_SCAN_BATCH = 50;
/** Orders read per scan (newest first) and how many invoices are mirrored. An order younger than the grace period is left for the next scan. */
export const SCAN_PAGES = 3;
export const SCAN_PAGE_SIZE = 100;
export const SCAN_GRACE_MS = 10 * 60_000;
export const MIRRORED_INVOICES = 20;

export const SHIPPING_PARCEL_SWEEP = "shipping.parcel_sweep";
export const SHIPPING_ACCOUNT_SCAN_SWEEP = "shipping.account_scan_sweep";
export const SHIPPING_ACCOUNT_SCAN = "shipping.account_scan";

const SECRET_RE = /^[\x21-\x7e]{8,256}$/;
const HOOK_RE = /^[a-f0-9]{32}$/;
const SIGNATURE_RE = /^[a-f0-9]{64}$/;

const limit = async (exec: Executor, key: string, rule: LimitRule) => {
  const r = await hit(exec, key, rule);
  if (r.count > rule.limit) throw new DomainError("rate_limited", `Terlalu banyak permintaan. Coba lagi dalam ${r.retryAfterSec} detik.`);
};
const providerAccounts = () => import("../payments/provider-accounts.ts"); // loaded on use, as in seller.ts and rules.ts

// ── Webhook signature (decision 43) ──────────────────────────────────────────────────────────────────────────

/** HMAC-SHA256 hex of `{x-timestamp}.{raw body}` keyed with the Webhook Secret (documented; the documented test vector is in the test file). */
export const mengantarWebhookSignature = (secret: string, timestamp: string, rawBody: string) => createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");

/** Constant-time comparison of a received signature with the expected one; anything malformed is false. */
export function verifyMengantarSignature(secret: string, timestamp: string, rawBody: string, received: string): boolean {
  if (!SIGNATURE_RE.test(received)) return false;
  const expected = Buffer.from(mengantarWebhookSignature(secret, timestamp, rawBody), "utf8");
  const got = Buffer.from(received, "utf8");
  return expected.length === got.length && timingSafeEqual(expected, got);
}

// ── The store's link row ─────────────────────────────────────────────────────────────────────────────────────

/** The store's own Mengantar account as the app role may read it (no sealed column). */
async function ownAccount(exec: Executor, storeId: number) {
  const [a] = await exec
    .select({ id: storeShippingAccount.id, status: storeShippingAccount.status, environment: storeShippingAccount.environment, keyFingerprint: storeShippingAccount.keyFingerprint })
    .from(storeShippingAccount)
    .where(and(eq(storeShippingAccount.storeId, storeId), eq(storeShippingAccount.kind, "seller_owned")));
  return a?.status === "active" && a.environment && a.keyFingerprint ? { id: a.id, environment: a.environment, keyFingerprint: a.keyFingerprint } : null;
}
const NOT_CONNECTED = "Hubungkan dulu kunci akun kurir milik toko di Akun penyedia.";

/** The link row of a store, created with a fresh random webhook id the first time it is needed. */
async function ensureSyncRow(tx: Executor, storeId: number): Promise<void> {
  // Explicit columns: the application role holds INSERT on exactly these two (migration 0020).
  await tx.execute(sql`insert into public.store_shipping_sync (store_id, hook_id) values (${storeId}, ${randomBytes(16).toString("hex")}) on conflict do nothing`);
}

/** Which of `ids` are provider orders Bukalaris created for this store (a shipment holds it now, or its status history ever did). */
async function knownProviderOrders(exec: Executor, storeId: number, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const [a, b] = await Promise.all([
    exec.select({ id: shipment.providerOrderId }).from(shipment).where(and(eq(shipment.storeId, storeId), inArray(shipment.providerOrderId, ids))),
    exec.select({ id: shipmentStatusEvent.providerOrderId }).from(shipmentStatusEvent).where(and(eq(shipmentStatusEvent.storeId, storeId), inArray(shipmentStatusEvent.providerOrderId, ids))),
  ]);
  return new Set([...a, ...b].flatMap((r) => (r.id ? [r.id] : [])));
}

// ── Decision 41: a new account, used only by this store ─────────────────────────────────────────────────────────

/**
 * The dedicated-account check of a key: one page (the newest 100 orders, archive included) of the account's order list on that key. Any order
 * Bukalaris did not create for this store refuses the account; nothing is written. Called by the connection check of a new key or environment
 * and again by the seller's confirmation. lazy: one page only; a store that rotates the key of an account with more than 100 of its own
 * parcels has its older orders checked by the account scan instead (docs/DECISIONS.md D-35).
 */
export async function assertDedicatedAccount(scope: Pick<SellerScope, "exec" | "storeId">, environment: ProviderEnvironment, key: string): Promise<void> {
  let orders: AccountOrder[], unreadable: number;
  try {
    ({ orders, unreadable } = await (await sellerMengantar(scope.exec, key, environment)).accountOrders({ size: SCAN_PAGE_SIZE, archive: true }));
  } catch (err) {
    if (err instanceof DomainError) throw err;
    const e = new DomainError("account_check_failed", "Daftar pesanan akun kurir tidak bisa dibaca, jadi akun belum bisa dipastikan khusus untuk toko ini. Tidak ada yang disimpan; coba lagi sebentar lagi.");
    e.cause = err;
    throw e;
  }
  const known = await inStore(scope, ({ exec }) => knownProviderOrders(exec, scope.storeId, orders.map((o) => o.providerOrderId)));
  if (unreadable > 0 || orders.some((o) => !known.has(o.providerOrderId))) {
    throw new DomainError("account_not_empty", "Akun kurir ini sudah berisi pesanan yang tidak dibuat Bukalaris untuk toko ini. Buat akun baru yang hanya dipakai toko ini, lalu hubungkan kuncinya. Tidak ada yang disimpan.");
  }
}

/**
 * The seller's confirmation that the connected account is new and used only by this store (decision 41). The account is checked again first
 * (the check of decision 41 also covers keys connected before this task). Recorded for this key and environment only; owner only, audited.
 */
export async function confirmDedicatedAccount(scope: SellerScope, raw: unknown): Promise<void> {
  requireCap(scope, "integrations.manage");
  z.strictObject({ confirmed: z.literal(true, { error: "Centang pernyataan bahwa akun ini baru dan hanya dipakai toko ini." }) }).parse(raw);
  const acct = await inStore(scope, ({ exec }) => ownAccount(exec, scope.storeId));
  if (!acct) throw new DomainError("not_connected", NOT_CONNECTED);
  const { openProviderKey, PROVIDER_CHECK_LIMIT } = await providerAccounts();
  await limit(scope.exec, `provider-check:store:${scope.storeId}`, PROVIDER_CHECK_LIMIT); // shares RL-PROVIDER-CHECK: one provider read
  await assertDedicatedAccount(scope, acct.environment, await openProviderKey(scope, "mengantar"));
  await withStore(scope.exec, scope.storeId, async (tx) => {
    const now = await ownAccount(tx, scope.storeId);
    if (now?.keyFingerprint !== acct.keyFingerprint || now.environment !== acct.environment) throw new DomainError("conflict", "Kunci akun kurir baru saja diganti. Muat ulang halaman lalu konfirmasi lagi.");
    await ensureSyncRow(tx, scope.storeId);
    await tx
      .update(storeShippingSync)
      .set({ dedicatedConfirmedAt: sql`now()` as unknown as Date, dedicatedConfirmedBy: scope.userId, dedicatedFingerprint: acct.keyFingerprint, dedicatedEnvironment: acct.environment, revision: sql`${storeShippingSync.revision} + 1` as unknown as number, updatedAt: new Date() })
      .where(eq(storeShippingSync.storeId, scope.storeId));
    await tx.insert(auditLog).values({ storeId: scope.storeId, actorUserId: scope.userId, actorCapability: "integrations.manage", action: "shipping.account.dedicated_confirmed", subjectKind: "provider_account", subjectId: SHIPPING_PROVIDER, accessLevel: "write", outcome: "allowed", reason: `environment=${acct.environment}; fingerprint=${acct.keyFingerprint}` });
  });
}

// ── Decision 43: the Webhook Secret, sealed like the API key ─────────────────────────────────────────────────

async function notifyOwners(tx: Tx, scope: SellerScope, subject: string, text: string) {
  const owners = await tx.select({ email: user.email }).from(membership).innerJoin(user, eq(user.id, membership.userId)).where(and(eq(membership.storeId, scope.storeId), eq(membership.role, "owner")));
  for (const to of new Set(owners.map((o) => o.email))) await dbMailer(tx).send({ to, subject, text });
}

const secretInput = z.strictObject({ secret: z.string().max(2000), proofId: z.string() });
/** Enter or replace the Webhook Secret (owner, fresh step-up, audited with its fingerprint, every owner told). Bound to the connected key. */
export async function setWebhookSecret(scope: SellerScope, raw: unknown): Promise<void> {
  requireCap(scope, "integrations.manage");
  const input = secretInput.parse(raw);
  const secret = input.secret.trim();
  if (!SECRET_RE.test(secret)) throw new DomainError("invalid_secret", "Webhook Secret harus 8 sampai 256 karakter tanpa spasi.");
  const { consumeSellerStepUp } = await import("../ledger/stepup.ts");
  await withStore(scope.exec, scope.storeId, async (tx) => {
    await consumeSellerStepUp(tx, scope, input.proofId, { action: "integrations.provider_key", subjectId: WEBHOOK_SECRET_SUBJECT });
    const acct = await ownAccount(tx, scope.storeId);
    if (!acct) throw new DomainError("not_connected", NOT_CONNECTED);
    await ensureSyncRow(tx, scope.storeId);
    const sealed = sealCredential("shipping_credentials", secret, scope.storeId, acct.id, WEBHOOK_SEAL_KIND);
    await tx
      .update(storeShippingSync)
      .set({ sealedWebhookSecret: sealed.sealedKey, webhookKeyId: sealed.keyId, webhookSealedAt: sealed.sealedAt, webhookFingerprint: acct.keyFingerprint, webhookEnvironment: acct.environment, stepUpRef: input.proofId, revision: sql`${storeShippingSync.revision} + 1` as unknown as number, updatedAt: new Date() })
      .where(eq(storeShippingSync.storeId, scope.storeId));
    await tx.insert(auditLog).values({ storeId: scope.storeId, actorUserId: scope.userId, actorCapability: "integrations.manage", action: "provider.webhook_secret.set", subjectKind: "provider_account", subjectId: WEBHOOK_SECRET_SUBJECT, accessLevel: "write", outcome: "allowed", reason: `environment=${acct.environment}; fingerprint=${keyFingerprint("shipping_credentials", secret)}` });
    await notifyOwners(tx, scope, `Webhook Secret kurir toko ${scope.storeName} diubah`, `Webhook Secret akun kurir toko ${scope.storeName} disimpan oleh pemilik toko. Secret tidak pernah ditampilkan atau dikirim lewat e-mail. Jika bukan Anda, segera amankan akun Anda dan periksa Pengiriman di Seller Admin.`);
  });
}

/** Remove the Webhook Secret (explicit action, step-up). Webhooks are then refused; the scheduled read keeps every parcel correct, only slower. */
export async function removeWebhookSecret(scope: SellerScope, raw: unknown): Promise<void> {
  requireCap(scope, "integrations.manage");
  const { proofId } = z.strictObject({ proofId: z.string() }).parse(raw);
  const { consumeSellerStepUp } = await import("../ledger/stepup.ts");
  await withStore(scope.exec, scope.storeId, async (tx) => {
    await consumeSellerStepUp(tx, scope, proofId, { action: "integrations.provider_key", subjectId: WEBHOOK_SECRET_SUBJECT });
    const rows = await tx
      .update(storeShippingSync)
      .set({ sealedWebhookSecret: null, webhookKeyId: null, webhookSealedAt: null, webhookFingerprint: null, webhookEnvironment: null, stepUpRef: proofId, revision: sql`${storeShippingSync.revision} + 1` as unknown as number, updatedAt: new Date() })
      .where(and(eq(storeShippingSync.storeId, scope.storeId), sql`${storeShippingSync.webhookSealedAt} is not null`))
      .returning({ storeId: storeShippingSync.storeId });
    if (rows.length === 0) throw new DomainError("not_set", "Belum ada Webhook Secret tersimpan.");
    await tx.insert(auditLog).values({ storeId: scope.storeId, actorUserId: scope.userId, actorCapability: "integrations.manage", action: "provider.webhook_secret.remove", subjectKind: "provider_account", subjectId: WEBHOOK_SECRET_SUBJECT, accessLevel: "write", outcome: "allowed" });
    await notifyOwners(tx, scope, `Webhook Secret kurir toko ${scope.storeName} dihapus`, `Webhook Secret akun kurir toko ${scope.storeName} dihapus oleh pemilik toko. Status paket tetap diperbarui otomatis secara berkala.`);
  });
}

// ── Decision 43: the webhook route (app pool; the store comes from the webhook id through a definer resolver) ──

export type WebhookInput = { hookId: string | null; rawBody: string; timestamp: string | null; signature: string | null; environment: string | null };
export type WebhookOutcome =
  | { status: 200; outcome: "read_enqueued" | "no_parcel" | "parcel_final" | "duplicate" }
  | { status: 400; outcome: "malformed" }
  | { status: 401; outcome: "unauthorized" | "stale" }
  | { status: 403; outcome: "sandbox_refused" }
  | { status: 429; outcome: "rate_limited" };

const webhookBody = z.looseObject({
  cnote_no: z.string().max(64).nullish(),
  order_id: z.string().max(64).nullish(),
  courier: z.string().max(40).nullish(),
  status_category: z.string().max(60).nullish(),
});
const opt = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

/**
 * One Mengantar delivery. Verified before anything is stored: the store's Webhook Secret (bound to the connected key), the signature over the
 * raw body in constant time, a fresh timestamp, and no sandbox marker for a production account. A verified delivery is stored once (the
 * signature is unique per store: a replay is a duplicate) and at most enqueues a tracking read of that store's parcel: it never writes a
 * shipment or an order. Another store's parcel is out of reach: the lookup runs in this store's context only.
 */
export async function receiveMengantarWebhook(exec: Executor, input: WebhookInput, now = Date.now()): Promise<WebhookOutcome> {
  const unauthorized = { status: 401, outcome: "unauthorized" } as const;
  if (!input.hookId || !HOOK_RE.test(input.hookId) || !input.signature || !SIGNATURE_RE.test(input.signature) || !input.timestamp || !/^\d{10,16}$/.test(input.timestamp)) return unauthorized;
  const [row] = (await exec.execute(sql`select resolve_mengantar_webhook_store(${input.hookId}) as store_id`)) as unknown as { store_id: string | null }[];
  const storeId = row?.store_id ? Number(row.store_id) : null;
  if (!storeId) return unauthorized;
  return withStore(exec, storeId, async (tx): Promise<WebhookOutcome> => {
    const [env] = (await tx.execute(sql`select account_id, key_id, sealed_key from public.provider_key_envelope(${storeId}::bigint, ${WEBHOOK_SECRET_SUBJECT})`)) as unknown as { account_id: string; key_id: string; sealed_key: string }[];
    if (!env) return unauthorized;
    let secret: string;
    try {
      secret = unsealCredential("shipping_credentials", env.sealed_key, env.key_id, storeId, Number(env.account_id), WEBHOOK_SEAL_KIND);
    } catch {
      return unauthorized;
    }
    if (!verifyMengantarSignature(secret, input.timestamp!, input.rawBody, input.signature!)) return unauthorized;
    const sentAt = Number(input.timestamp);
    if (Math.abs(now - sentAt) > WEBHOOK_MAX_SKEW_MS) return { status: 401, outcome: "stale" };
    const acct = await ownAccount(tx, storeId);
    if (!acct) return unauthorized;
    if (acct.environment === "production" && input.environment?.trim().toLowerCase() === "sandbox") return { status: 403, outcome: "sandbox_refused" };
    let body: z.infer<typeof webhookBody>;
    try {
      body = webhookBody.parse(JSON.parse(input.rawBody));
    } catch {
      return { status: 400, outcome: "malformed" };
    }
    const r = await hit(tx, `mengantar-wh:store:${storeId}`, MENGANTAR_WEBHOOK_LIMIT);
    if (r.count > MENGANTAR_WEBHOOK_LIMIT.limit) return { status: 429, outcome: "rate_limited" };
    const providerOrderId = opt(body.order_id), trackingNumber = opt(body.cnote_no);
    const [parcel] = providerOrderId || trackingNumber
      ? await tx
          .select({ orderId: shipment.orderId, status: shipment.status })
          .from(shipment)
          .where(and(eq(shipment.storeId, storeId), providerOrderId ? eq(shipment.providerOrderId, providerOrderId) : eq(shipment.trackingNumber, trackingNumber!)))
      : [];
    const outcome = !parcel ? "no_parcel" : TERMINAL.includes(parcel.status) ? "parcel_final" : "read_enqueued";
    const stored = await tx
      .insert(shippingWebhookEvent)
      .values({ storeId, signature: input.signature!, sentAt: new Date(sentAt), providerOrderId, trackingNumber, courier: opt(body.courier), statusCategory: storableCategory(body.status_category), outcome })
      .onConflictDoNothing({ target: [shippingWebhookEvent.storeId, shippingWebhookEvent.signature] })
      .returning({ id: shippingWebhookEvent.id });
    if (stored.length === 0) return { status: 200, outcome: "duplicate" };
    if (parcel && outcome === "read_enqueued") {
      // One read per parcel and minute, however many deliveries arrive: the read, not the delivery, decides the state (out-of-order safe).
      await enqueue(tx, { kind: SHIPMENT_TRACK, storeId, key: `track:${parcel.orderId}:wh:${Math.floor(now / 60_000)}`, payload: { orderId: parcel.orderId } });
    }
    await tx.update(storeShippingSync).set({ lastWebhookAt: new Date(now) }).where(eq(storeShippingSync.storeId, storeId));
    return { status: 200, outcome };
  });
}

// ── Decision 43: the scheduled read of every non-final parcel, fair across stores ──────────────────────────────────

/**
 * Enqueue a tracking read for parcels on stores' own accounts that are not final and were not read for `PARCEL_SWEEP_STALE_MS`. Fair order:
 * the stalest parcel of EACH store first (rank within the store), so one store with many parcels cannot starve the others. Idempotent per
 * parcel and staleness window (the job key), so overlapping sweeps enqueue nothing twice.
 */
export async function sweepParcels(db: Db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PARCEL_SWEEP_STALE_MS);
  const rows = (await db.execute(sql`
    select store_id, order_id from (
      select s.store_id, s.order_id, s.last_tracked_at, row_number() over (partition by s.store_id order by s.last_tracked_at asc nulls first, s.id) as rn
      from public.shipment s join public."order" o on o.store_id = s.store_id and o.id = s.order_id
      where o.shipping_account_kind = 'seller_owned' and s.provider_order_id is not null
        and s.status not in ('delivered', 'returned', 'cancelled', 'failed')
        and (s.last_tracked_at is null or s.last_tracked_at < ${cutoff.toISOString()}::timestamptz)
    ) x order by rn, last_tracked_at asc nulls first, store_id limit ${PARCEL_SWEEP_BATCH}`)) as unknown as { store_id: string; order_id: string }[];
  const bucket = Math.floor(now.getTime() / PARCEL_SWEEP_STALE_MS);
  let n = 0;
  for (const r of rows) {
    const orderId = Number(r.order_id);
    const { created } = await enqueue(db, { kind: SHIPMENT_TRACK, storeId: Number(r.store_id), key: `track:${orderId}:sweep:${bucket}`, payload: { orderId } });
    if (created) n++;
  }
  return n;
}

// ── Decisions 41 and 45: the account scan (foreign parcels, balance, invoices) ───────────────────────────────────

/** Every store on its own account whose last scan is older than `ACCOUNT_SCAN_EVERY_MS`, least recently scanned first. */
export async function sweepAccountScans(db: Db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ACCOUNT_SCAN_EVERY_MS);
  const rows = (await db.execute(sql`
    select a.store_id from public.store_shipping_account a left join public.store_shipping_sync s on s.store_id = a.store_id
    where a.kind = 'seller_owned' and a.status = 'active' and (s.last_scan_at is null or s.last_scan_at < ${cutoff.toISOString()}::timestamptz)
    order by s.last_scan_at asc nulls first, a.store_id limit ${ACCOUNT_SCAN_BATCH}`)) as unknown as { store_id: string }[];
  const bucket = Math.floor(now.getTime() / ACCOUNT_SCAN_EVERY_MS);
  let n = 0;
  for (const r of rows) if ((await enqueue(db, { kind: SHIPPING_ACCOUNT_SCAN, storeId: Number(r.store_id), key: `scan:${r.store_id}:${bucket}` })).created) n++;
  return n;
}

/** "Periksa akun sekarang": one scan job per store and ten minutes (the job key is the limit). Returns false when one is already queued. */
export async function requestAccountScan(scope: SellerScope, now = Date.now()): Promise<boolean> {
  requireCap(scope, "shipping.manage");
  return inStore(scope, async ({ exec }) => {
    if (!(await ownAccount(exec, scope.storeId))) throw new DomainError("not_connected", NOT_CONNECTED);
    return (await enqueue(exec, { kind: SHIPPING_ACCOUNT_SCAN, storeId: scope.storeId, key: `scan:${scope.storeId}:m:${Math.floor(now / ACCOUNT_SCAN_REQUEST_MS)}` })).created;
  });
}

/** The marker id of orders in the account whose id could not be read (review minor 7). */
export const UNREADABLE_ORDER_ID = "TIDAK-TERBACA";
const SCAN_UNAVAILABLE = "Akun kurir toko tidak bisa dibaca saat ini; pemeriksaan diulang otomatis.";

/**
 * The account scan, on the store's own key (worker, platform pool): the newest orders (at most `SCAN_PAGES` pages, stopping once a page
 * reaches what the last scan already covered) compared with the parcels Bukalaris created for this store; an unknown one is recorded as a
 * foreign parcel (never an order or a shipment). Then the balance and the newest invoices are mirrored with the read time. A provider
 * failure is recorded on the store's sync row and left to the next scan.
 */
export async function scanAccount(db: Db, storeId: number, now = new Date()): Promise<{ foreign: number; read: number } | null> {
  const [acct] = await db.select({ id: storeShippingAccount.id, status: storeShippingAccount.status }).from(storeShippingAccount).where(and(eq(storeShippingAccount.storeId, storeId), eq(storeShippingAccount.kind, "seller_owned")));
  if (acct?.status !== "active") return null;
  const record = (patch: Partial<typeof storeShippingSync.$inferInsert>) =>
    withStore(db, storeId, async (tx) => {
      await ensureSyncRow(tx, storeId);
      await tx.update(storeShippingSync).set({ ...patch, updatedAt: new Date() }).where(eq(storeShippingSync.storeId, storeId));
    });
  let client: SellerMengantar;
  try {
    const { key, account } = await openSellerKeyAsWorker(db, storeId, acct.id);
    client = await sellerMengantar(db, key, account.environment);
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    await record({ lastScanAt: now, scanError: err.message.slice(0, 300) });
    return null;
  }
  const [state] = await db.select({ lastScanAt: storeShippingSync.lastScanAt }).from(storeShippingSync).where(eq(storeShippingSync.storeId, storeId));
  const covered = state?.lastScanAt ? state.lastScanAt.getTime() - 86_400_000 : null;
  const seen: AccountOrder[] = [];
  let unreadable = 0;
  let money;
  try {
    let cursor: string | undefined;
    for (let page = 0; page < SCAN_PAGES; page++) {
      const r = await client.accountOrders({ size: SCAN_PAGE_SIZE, cursor });
      seen.push(...r.orders);
      unreadable += r.unreadable;
      const oldest = Math.min(...r.orders.map((o) => (o.createdAt ? Date.parse(o.createdAt) : Infinity)));
      if (!r.nextCursor || (covered !== null && oldest < covered)) break;
      cursor = r.nextCursor;
    }
    money = await client.accountMoney(MIRRORED_INVOICES);
  } catch (err) {
    // A refusal (the production switch closed meanwhile) or a provider failure: recorded on the store's sync row, left to the next scan.
    await record({ lastScanAt: now, scanError: err instanceof DomainError ? err.message.slice(0, 300) : SCAN_UNAVAILABLE });
    return null;
  }
  // A booking may be on its way back from the provider: an order younger than the grace period waits for the next scan.
  const settled = seen.filter((o) => !o.createdAt || Date.parse(o.createdAt) < now.getTime() - SCAN_GRACE_MS);
  return withStore(db, storeId, async (tx) => {
    await ensureSyncRow(tx, storeId);
    const known = await knownProviderOrders(tx, storeId, settled.map((o) => o.providerOrderId));
    const foreign: AccountOrder[] = settled.filter((o) => !known.has(o.providerOrderId));
    // Review minor 7: orders whose id could not be read are foreign too (one marker row; the seller checks the account and resolves it).
    if (unreadable > 0) foreign.push({ providerOrderId: UNREADABLE_ORDER_ID, trackingNumber: null, status: null, createdAt: null });
    if (foreign.length > 0) {
      await tx
        .insert(shippingForeignParcel)
        .values(foreign.map((o) => ({ storeId, providerOrderId: o.providerOrderId, trackingNumber: o.trackingNumber, providerStatus: storableCategory(o.status), providerCreatedAt: o.createdAt && !Number.isNaN(Date.parse(o.createdAt)) ? new Date(o.createdAt) : null })))
        .onConflictDoNothing({ target: [shippingForeignParcel.storeId, shippingForeignParcel.providerOrderId] });
    }
    await tx
      .update(storeShippingSync)
      .set({ lastScanAt: now, scanError: null, accountReadAt: now, balanceIdr: money.balanceIdr, invoices: money.invoices, updatedAt: new Date() })
      .where(eq(storeShippingSync.storeId, storeId));
    return { foreign: foreign.length, read: seen.length };
  });
}

/** HTTP-26 for one store: the platform origin from configuration (DOM-5), the store's opaque webhook id as `h`. */
export const webhookUrl = (hookId: string, env: NodeJS.ProcessEnv = process.env) => `${surfaceOriginsFromEnv(env).platformOrigin}/api/shipping/mengantar/webhook?h=${hookId}`;

// ── Seller views and actions ─────────────────────────────────────────────────────────────────────────────────

export type ForeignParcelView = { id: number; providerOrderId: string; trackingNumber: string | null; providerStatus: string | null; providerCreatedAt: Date | null; firstSeenAt: Date };
export type ShippingSyncView = {
  connected: boolean;
  environment: ProviderEnvironment | null;
  /** The address the seller sets in Mengantar (platform origin, never a request host); null until the link row exists. */
  webhookUrl: string | null;
  dedicated: { confirmedAt: Date | null };
  webhook: { secretSet: boolean; sealedAt: Date | null; lastWebhookAt: Date | null };
  /** False while an unresolved foreign parcel exists (decision 41). */
  exact: boolean;
  foreign: ForeignParcelView[];
  lastScanAt: Date | null;
  scanError: string | null;
  mirror: { readAt: Date | null; balanceIdr: number | null; invoices: MirroredInvoice[] };
};

/** Unresolved foreign parcels of a store, minus any that a link or a later booking proved to be Bukalaris's own. */
async function openForeignParcels(exec: Executor, storeId: number): Promise<ForeignParcelView[]> {
  const rows = await exec
    .select({ id: shippingForeignParcel.id, providerOrderId: shippingForeignParcel.providerOrderId, trackingNumber: shippingForeignParcel.trackingNumber, providerStatus: shippingForeignParcel.providerStatus, providerCreatedAt: shippingForeignParcel.providerCreatedAt, firstSeenAt: shippingForeignParcel.firstSeenAt })
    .from(shippingForeignParcel)
    .where(and(eq(shippingForeignParcel.storeId, storeId), isNull(shippingForeignParcel.resolvedAt)))
    .orderBy(desc(shippingForeignParcel.firstSeenAt), asc(shippingForeignParcel.id))
    .limit(200);
  const known = await knownProviderOrders(exec, storeId, rows.map((r) => r.providerOrderId));
  return rows.filter((r) => !known.has(r.providerOrderId));
}

/** SC-34 "Akun Mengantar": the link with the store's own account. No secret, no envelope, no fingerprint leaves this function. */
export async function shippingSync(scope: SellerScope): Promise<ShippingSyncView> {
  requireCap(scope, "shipping.manage");
  return inStore(scope, async ({ exec }) => {
    const acct = await ownAccount(exec, scope.storeId);
    const [s] = await exec
      .select({
        hookId: storeShippingSync.hookId,
        dedicatedConfirmedAt: storeShippingSync.dedicatedConfirmedAt,
        dedicatedFingerprint: storeShippingSync.dedicatedFingerprint,
        dedicatedEnvironment: storeShippingSync.dedicatedEnvironment,
        webhookSealedAt: storeShippingSync.webhookSealedAt,
        webhookFingerprint: storeShippingSync.webhookFingerprint,
        webhookEnvironment: storeShippingSync.webhookEnvironment,
        lastWebhookAt: storeShippingSync.lastWebhookAt,
        accountReadAt: storeShippingSync.accountReadAt,
        balanceIdr: storeShippingSync.balanceIdr,
        invoices: storeShippingSync.invoices,
        lastScanAt: storeShippingSync.lastScanAt,
        scanError: storeShippingSync.scanError,
      })
      .from(storeShippingSync)
      .where(eq(storeShippingSync.storeId, scope.storeId));
    const bound = (fp: string | null | undefined, env: string | null | undefined) => !!acct && fp === acct.keyFingerprint && env === acct.environment;
    const foreign = await openForeignParcels(exec, scope.storeId);
    return {
      connected: !!acct,
      environment: acct?.environment ?? null,
      webhookUrl: s?.hookId ? webhookUrl(s.hookId) : null,
      dedicated: { confirmedAt: s?.dedicatedConfirmedAt && bound(s.dedicatedFingerprint, s.dedicatedEnvironment) ? s.dedicatedConfirmedAt : null },
      webhook: { secretSet: !!s?.webhookSealedAt && bound(s.webhookFingerprint, s.webhookEnvironment), sealedAt: s?.webhookSealedAt ?? null, lastWebhookAt: s?.lastWebhookAt ?? null },
      exact: foreign.length === 0,
      foreign,
      lastScanAt: s?.lastScanAt ?? null,
      scanError: s?.scanError ?? null,
      mirror: { readAt: s?.accountReadAt ?? null, balanceIdr: s?.balanceIdr ?? null, invoices: s?.invoices ?? [] },
    };
  });
}

const resolveInput = z.strictObject({ note: z.string().trim().min(5, "Tulis catatan minimal 5 karakter (apa paket ini dan apa yang sudah Anda lakukan).").max(300) });
/** The seller resolved a foreign parcel (it stays in the record, never imported). Audited. */
export async function resolveForeignParcel(scope: SellerScope, id: number, raw: unknown): Promise<void> {
  requireCap(scope, "shipping.manage");
  const { note } = resolveInput.parse(raw);
  await inStore(scope, async ({ exec }) => {
    // Review minor 6: while a booking's outcome is unknown, a parcel that appeared after it started may be exactly its order. Marking it handled
    // and then releasing the booking could leave two live provider orders: link its id on that order instead.
    const [candidate] = await exec
      .select({ orderId: shipment.orderId })
      .from(shippingForeignParcel)
      .innerJoin(shipment, and(eq(shipment.storeId, shippingForeignParcel.storeId), eq(shipment.status, "unknown")))
      .where(and(eq(shippingForeignParcel.storeId, scope.storeId), eq(shippingForeignParcel.id, id), or(isNull(shippingForeignParcel.providerCreatedAt), gte(shippingForeignParcel.providerCreatedAt, shipment.createdAt))))
      .limit(1);
    if (candidate) throw new DomainError("booking_unknown_open", `Pesanan #${candidate.orderId} punya booking dengan hasil tidak pasti, dan paket ini muncul setelah booking itu dimulai. Bila ini order dari booking tersebut, tautkan ID order-nya di pesanan #${candidate.orderId}; paket ini tidak bisa ditandai selesai selama booking itu belum dilepas atau ditautkan.`);
    const rows = await exec
      .update(shippingForeignParcel)
      .set({ resolvedAt: new Date(), resolvedBy: scope.userId, resolutionNote: note })
      .where(and(eq(shippingForeignParcel.storeId, scope.storeId), eq(shippingForeignParcel.id, id), isNull(shippingForeignParcel.resolvedAt)))
      .returning({ providerOrderId: shippingForeignParcel.providerOrderId });
    if (rows.length === 0) throw new DomainError("not_found", "Paket asing tidak ditemukan atau sudah ditandai selesai.");
    await exec.insert(auditLog).values({ storeId: scope.storeId, actorUserId: scope.userId, actorCapability: "shipping.manage", action: "shipping.foreign_parcel.resolve", subjectKind: "shipping_foreign_parcel", subjectId: String(id), accessLevel: "write", outcome: "allowed", reason: `provider_order=${rows[0]!.providerOrderId}; ${note}`.slice(0, 500) });
  });
}

/** Mengantar's status categories of one parcel, oldest first (decision 42). */
export async function shipmentStatusHistory(scope: SellerScope, orderId: number) {
  requireCap(scope, "orders.read");
  return inStore(scope, ({ exec }) =>
    exec
      .select({ category: shipmentStatusEvent.category, parcelState: shipmentStatusEvent.parcelState, source: shipmentStatusEvent.source, providerChangedAt: shipmentStatusEvent.providerChangedAt, observedAt: shipmentStatusEvent.observedAt })
      .from(shipmentStatusEvent)
      .innerJoin(shipment, and(eq(shipment.storeId, shipmentStatusEvent.storeId), eq(shipment.id, shipmentStatusEvent.shipmentId)))
      .innerJoin(order, and(eq(order.storeId, shipment.storeId), eq(order.id, shipment.orderId)))
      .where(and(eq(shipmentStatusEvent.storeId, scope.storeId), eq(shipment.orderId, orderId)))
      .orderBy(asc(shipmentStatusEvent.id))
      .limit(200),
  );
}

// ── Worker registrations (handlers here; the two schedules in `jobs.ts`, imported by the worker only) ──────────────

registerHandler(SHIPPING_ACCOUNT_SCAN, async ({ db }, j) => { await scanAccount(db, j.storeId); }, { replaySafe: true });
