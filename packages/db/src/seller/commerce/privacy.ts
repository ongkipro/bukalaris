import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../../client.ts";
import { normalizeEmail, phoneLookupKey } from "../../buyer/normalize.ts";
import { phoneKeyEquals } from "../../buyer/normalize-sql.ts";
import {
  auditLog,
  checkoutSession,
  order,
  orderLine,
  orderNotification,
  orderRedaction,
  orderSignalContext,
  orderStatusHistory,
  shipment,
  signalEvent,
  type OrderStatus,
  type RedactionSource,
} from "../../schema.ts";
import { DomainError, requireCap, type SellerScope } from "../../platform/scoped.ts";
import { inStore, withStore } from "../../platform/tenant.ts";

// Buyer data export and redaction (T-43, SEC-19, PRIV-4). Engineering mechanism only: it
// gives the store owner a way to locate, hand over and irreversibly remove one buyer's
// personal data inside their store; whether and when to use it is the privacy owner's
// decision (docs/13-COMPLIANCE-PRIVACY.md). Redaction replaces contact fields with a fixed
// placeholder and removes attribution context and mail bodies; amounts, lines, statuses and
// catalog snapshots stay (financial record). Everything runs in the store's RLS context.

/** Value written over every redacted text field. */
export const REDACTED = "[dihapus]";
/** Statuses an order must have before it is redacted without an explicit override. */
export const CLOSED_STATUSES: readonly OrderStatus[] = ["completed", "cancelled"];
export const RETENTION_ACTOR = "system:retention";

// ── Inventory ──────────────────────────────────────────────────────────────────────────

export type Handling =
  | "redact" // overwritten with REDACTED (or NULL) by redaction
  | "delete" // the row is deleted by redaction
  | "strip" // the personal part of a JSON payload is removed by redaction
  | "expires" // short-lived by an existing sweep; redaction does not touch it
  | "kept" // free text that must not carry buyer data; not touched (documented)
  | "seller" // seller/operator account data, not buyer data (out of scope here)
  | "not_personal" // name matched the scan but the column holds no personal data
  | "global"; // platform-owned global buyer identity (T-57, ADR-0010): never touched by a seller redaction or export, which stay per store

/**
 * Every column whose name looks like buyer personal data, with how redaction treats it.
 * `privacy.test.ts` scans the schema with `PII_COLUMN_RE` and fails when a matching column
 * is missing here or here but missing from docs/13-COMPLIANCE-PRIVACY.md.
 */
export const PII_COLUMN_RE = /(^|_)(phone|email|address|ip|user_agent|fbp|fbc|ttclid|ttp|gclid|gbraid|wbraid|whatsapp|buyer_name)($|_)/;
export const BUYER_DATA_INVENTORY: readonly { table: string; column: string; handling: Handling }[] = [
  { table: "order", column: "buyer_name", handling: "redact" },
  { table: "order", column: "buyer_phone", handling: "redact" },
  { table: "order", column: "buyer_email", handling: "redact" },
  { table: "order", column: "shipping_address", handling: "redact" },
  { table: "order_signal_context", column: "fbp", handling: "delete" },
  { table: "order_signal_context", column: "fbc", handling: "delete" },
  { table: "order_signal_context", column: "ttclid", handling: "delete" },
  { table: "order_signal_context", column: "ttp", handling: "delete" },
  { table: "order_signal_context", column: "gclid", handling: "delete" },
  { table: "order_signal_context", column: "gbraid", handling: "delete" },
  { table: "order_signal_context", column: "wbraid", handling: "delete" },
  { table: "order_signal_context", column: "utm", handling: "delete" },
  { table: "order_signal_context", column: "client_ip", handling: "delete" },
  { table: "order_signal_context", column: "user_agent", handling: "delete" },
  { table: "signal_event", column: "payload", handling: "strip" },
  // T-47: the provider's tracking text (receiver names and address fragments can appear in it). Redaction keeps the status codes, the timestamps and the resi.
  { table: "shipment", column: "tracking_history", handling: "strip" }, // each line's `desc` is replaced by REDACTED; `at` and any other key stay
  { table: "shipment", column: "provider_status", handling: "strip" }, // kept while it is a known provider status code, otherwise replaced by REDACTED
  { table: "shipment", column: "last_error", handling: "redact" }, // sanitized provider/booking message; REDACTED when present
  // T-45: what the buyer typed into hosted checkout before ordering (PR-25). Captured only from fields the buyer typed; purged 30 days after creation by cleanup.ts.
  { table: "checkout_session", column: "buyer_name", handling: "redact" },
  { table: "checkout_session", column: "buyer_phone", handling: "redact" },
  { table: "checkout_session", column: "buyer_email", handling: "redact" },
  { table: "checkout_session", column: "shipping_address", handling: "redact" },
  { table: "order_notification", column: "to_email", handling: "redact" },
  { table: "mail_outbox", column: "to_email", handling: "redact" },
  { table: "mail_outbox", column: "text_body", handling: "redact" },
  { table: "mail_outbox", column: "html_body", handling: "redact" },
  { table: "rate_limit", column: "key", handling: "expires" },
  { table: "discount_buyer_usage", column: "phone_fingerprint", handling: "not_personal" }, // T-46: keyed HMAC of the canonical phone (purpose promotion.buyer_usage); never the number
  { table: "order_status_history", column: "note", handling: "kept" },
  { table: "stock_adjustment", column: "reason", handling: "kept" },
  { table: "audit_log", column: "reason", handling: "kept" },
  { table: "user", column: "email", handling: "seller" },
  { table: "user", column: "email_verified", handling: "not_personal" },
  { table: "session", column: "ip_address", handling: "seller" },
  { table: "session", column: "user_agent", handling: "seller" },
  { table: "store", column: "whatsapp", handling: "seller" },
  { table: "store_invitation", column: "email", handling: "seller" },
  { table: "store_pickup_area", column: "address_text", handling: "seller" },
  // T-57 global buyer identity (ADR-0010, PRIV-8). Platform data: a store owner redacts only the store-owned order snapshot above, and no store lookup reads these tables.
  { table: "buyer", column: "display_name", handling: "global" },
  { table: "buyer", column: "primary_phone_identifier_id", handling: "not_personal" }, // a reference to buyer_identifier, no value
  { table: "buyer_identifier", column: "canonical_value", handling: "global" },
  { table: "buyer_address", column: "recipient_name", handling: "global" },
  { table: "buyer_address", column: "phone_canonical", handling: "global" },
  { table: "buyer_address", column: "address_text", handling: "global" },
];

// ── Lookup key ─────────────────────────────────────────────────────────────────────────

export type BuyerKey = { kind: "phone" | "email"; value: string };

/** Phone (`+62…`/`62…`/`0…`/`0062…`, separators ignored) or e-mail, both through the shared normalization of `buyer/normalize.ts` (T-57); anything else is rejected. */
export function normalizeBuyerKey(raw: unknown): BuyerKey {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s.includes("@")) {
    const value = normalizeEmail(s);
    if (value === null) throw new DomainError("invalid_query", "Alamat email tidak valid.");
    return { kind: "email", value };
  }
  const value = phoneLookupKey(s);
  if (value === null) throw new DomainError("invalid_query", "Masukkan nomor HP (8–15 digit) atau alamat email pembeli.");
  return { kind: "phone", value };
}

/** The stored snapshot is compared through the SQL port of the same normalization, so every spelling of one number matches and a redacted one (`[dihapus]`) never does. */
const matchesKey = (key: BuyerKey) => (key.kind === "phone" ? phoneKeyEquals(order.buyerPhone, key.value) : sql`lower(${order.buyerEmail}) = ${key.value}`);
/** The same comparison on the checkout-session snapshot (T-45): what the buyer typed, matched through the same SQL port. */
const sessionMatchesKey = (key: BuyerKey) => (key.kind === "phone" ? phoneKeyEquals(checkoutSession.buyerPhone, key.value) : sql`lower(${checkoutSession.buyerEmail}) = ${key.value}`);
/** Audit rows never carry the raw key: a short SHA-256 prefix is enough to correlate requests. */
const keyDigest = (key: BuyerKey) => `${key.kind}:${createHash("sha256").update(key.value).digest("hex").slice(0, 16)}`;

/** Orders of this buyer in the store, newest first, and the number of checkout sessions (T-45) that still hold this buyer's typed contact. A redacted order or session no longer matches: its contact fields are gone. */
export async function findBuyerOrders(scope: SellerScope, rawKey: unknown) {
  requireCap(scope, "privacy.manage");
  const key = normalizeBuyerKey(rawKey);
  return inStore(scope, async (scope) => {
    const orders = await scope.exec
      .select({
        id: order.id,
        status: order.status,
        paymentMethod: order.paymentMethod,
        buyerName: order.buyerName,
        total: order.total,
        createdAt: order.createdAt,
      })
      .from(order)
      .where(and(eq(order.storeId, scope.storeId), matchesKey(key)))
      .orderBy(desc(order.id))
      .limit(200);
    const [sessions] = await scope.exec
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(checkoutSession)
      .where(and(eq(checkoutSession.storeId, scope.storeId), sessionMatchesKey(key)));
    return { key, orders, sessions: sessions?.n ?? 0 };
  });
}

// ── Export ─────────────────────────────────────────────────────────────────────────────


/**
 * Everything this store holds about one buyer, as one JSON document: orders (contact,
 * shipping, payment, amounts), lines, status history, attribution context, signal events'
 * user blocks, notification records, the shipment (status, resi, provider status and tracking lines, T-47), the mails the dev outbox sent to the buyer and the checkout
 * sessions (what the buyer typed before ordering, T-45). Only the caller's store (RLS); the lookup is audited (`privacy.export`) with a hashed key.
 */
export async function exportBuyerData(scope: SellerScope, rawKey: unknown) {
  requireCap(scope, "privacy.manage");
  const key = normalizeBuyerKey(rawKey);
  return inStore(scope, async ({ exec: tx }) => {
    const rows = await tx
      .select()
      .from(order)
      .where(and(eq(order.storeId, scope.storeId), matchesKey(key)))
      .orderBy(asc(order.id));
    const ids = rows.map((o) => o.id);
    const [lines, history, contexts, events, notifications, redactions, shipments] = ids.length
      ? await Promise.all([
          tx.select().from(orderLine).where(and(eq(orderLine.storeId, scope.storeId), inArray(orderLine.orderId, ids))).orderBy(asc(orderLine.orderId), asc(orderLine.variantId)),
          tx
            .select({ orderId: orderStatusHistory.orderId, fromStatus: orderStatusHistory.fromStatus, toStatus: orderStatusHistory.toStatus, note: orderStatusHistory.note, createdAt: orderStatusHistory.createdAt })
            .from(orderStatusHistory)
            .where(and(eq(orderStatusHistory.storeId, scope.storeId), inArray(orderStatusHistory.orderId, ids)))
            .orderBy(asc(orderStatusHistory.id)),
          tx.select().from(orderSignalContext).where(and(eq(orderSignalContext.storeId, scope.storeId), inArray(orderSignalContext.orderId, ids))),
          tx
            .select({ orderId: signalEvent.orderId, provider: signalEvent.provider, eventName: signalEvent.eventName, eventId: signalEvent.eventId, status: signalEvent.status, user: sql<unknown>`${signalEvent.payload} -> 'user'`, createdAt: signalEvent.createdAt })
            .from(signalEvent)
            .where(and(eq(signalEvent.storeId, scope.storeId), inArray(signalEvent.orderId, ids)))
            .orderBy(asc(signalEvent.id)),
          tx
            .select({ orderId: orderNotification.orderId, event: orderNotification.event, recipient: orderNotification.recipient, toEmail: orderNotification.toEmail, createdAt: orderNotification.createdAt })
            .from(orderNotification)
            .where(and(eq(orderNotification.storeId, scope.storeId), inArray(orderNotification.orderId, ids)))
            .orderBy(asc(orderNotification.id)),
          tx.select().from(orderRedaction).where(and(eq(orderRedaction.storeId, scope.storeId), inArray(orderRedaction.orderId, ids))),
          // The provider's own references (provider order and batch ids) are Bukalaris/provider internals, not the buyer's data.
          tx
            .select({
              orderId: shipment.orderId,
              status: shipment.status,
              courierCode: shipment.courierCode,
              trackingNumber: shipment.trackingNumber,
              codAmount: shipment.codAmount,
              weightKg: shipment.weightKg,
              providerStatus: shipment.providerStatus,
              trackingHistory: shipment.trackingHistory,
              lastError: shipment.lastError,
              paid: shipment.paid,
              bookedAt: shipment.bookedAt,
              deliveredAt: shipment.deliveredAt,
              lastTrackedAt: shipment.lastTrackedAt,
            })
            .from(shipment)
            .where(and(eq(shipment.storeId, scope.storeId), inArray(shipment.orderId, ids))),
        ])
      : [[], [], [], [], [], [], []];
    // Only order-linked buyer copies can leave the definer; credential mail is never selectable by app.
    const mails = await tx.execute<{ orderId: number; toEmail: string; subject: string; textBody: string; createdAt: Date }>(
      sql`select order_id::int as "orderId", to_email as "toEmail", subject, text_body as "textBody", created_at as "createdAt" from public.mail_privacy_export(${`{${ids.join(",")}}`}::bigint[])`,
    );
    // T-45: sessions are matched by the typed contact itself (an abandoned checkout may never have become an order). The resume handle and the cart id stay out.
    const sessions = await tx
      .select({
        status: checkoutSession.status,
        buyerName: checkoutSession.buyerName,
        buyerPhone: checkoutSession.buyerPhone,
        buyerEmail: checkoutSession.buyerEmail,
        shippingAddress: checkoutSession.shippingAddress,
        subtotalIdr: checkoutSession.subtotalIdr,
        abandonedAt: checkoutSession.abandonedAt,
        recoveredAt: checkoutSession.recoveredAt,
        waOpenedAt: checkoutSession.waOpenedAt,
        createdAt: checkoutSession.createdAt,
        updatedAt: checkoutSession.updatedAt,
      })
      .from(checkoutSession)
      .where(and(eq(checkoutSession.storeId, scope.storeId), sessionMatchesKey(key)))
      .orderBy(asc(checkoutSession.id));
    await tx.insert(auditLog).values({ actorUserId: scope.userId, storeId: scope.storeId, action: "privacy.export", reason: `${keyDigest(key)} orders:${ids.join(",") || "-"} sessions:${sessions.length}` });
    return {
      format: "bukalaris.buyer-export/1",
      exportedAt: new Date().toISOString(),
      store: { id: scope.storeId, slug: scope.storeSlug, name: scope.storeName },
      query: key,
      // Internal keys and the seller's courier cost/margin are not the buyer's data.
      orders: rows.map(({ requestHash: _h, idempotencyKey: _k, cartId: _c, shippingProviderCost: _pc, shippingMargin: _m, ...o }) => ({
        ...o,
        redaction: redactions.find((r) => r.orderId === o.id) ?? null,
        lines: lines.filter((l) => l.orderId === o.id).map(({ orderId: _o, storeId: _s, ...l }) => l),
        history: history.filter((h) => h.orderId === o.id).map(({ orderId: _o, ...h }) => h),
        signalContext: contexts.find((c) => c.orderId === o.id) ?? null,
        signalEvents: events.filter((e) => e.orderId === o.id).map(({ orderId: _o, ...e }) => e),
        notifications: notifications.filter((n) => n.orderId === o.id).map(({ orderId: _o, ...n }) => n),
        mails: mails.filter((m) => m.orderId === o.id).map(({ orderId: _o, ...m }) => m),
        shipment: shipments.filter((s) => s.orderId === o.id).map(({ orderId: _o, ...s }) => s)[0] ?? null,
      })),
      checkoutSessions: sessions,
    };
  });
}
export type BuyerExport = Awaited<ReturnType<typeof exportBuyerData>>;

// ── Redaction ──────────────────────────────────────────────────────────────────────────

export type RedactionCounts = { orders: number; signalContexts: number; signalEvents: number; notifications: number; mails: number; shipments: number; checkoutSessions: number };
const zero = (): RedactionCounts => ({ orders: 0, signalContexts: 0, signalEvents: 0, notifications: 0, mails: 0, shipments: 0, checkoutSessions: 0 });

/** A provider status category is an upper-case code such as `ON DELIVERY` or `ACTIVE/WAITING NEXT PROCESS`; anything else may be free text and is not kept (T-47). */
export const PROVIDER_CODE_RE_SOURCE = "^[A-Z]+([ /_-][A-Z]+)*$";

/**
 * Strip the provider's free text from the shipments of these orders (T-47): every tracking line keeps its timestamp (`at`) and any other key but its
 * `desc` becomes REDACTED; `last_error` becomes REDACTED when present; `provider_status` stays while it is a status code. Status, resi, courier, amounts and
 * every timestamp are untouched. A row that is already stripped is not selected, so a second run changes nothing.
 */
async function redactShipments(tx: Executor, storeId: number, ids: number[]): Promise<number> {
  const stripped = sql`coalesce((select jsonb_agg(case when jsonb_typeof(e) = 'object' then e || jsonb_build_object('desc', ${REDACTED}::text) else e end order by n) from jsonb_array_elements(${shipment.trackingHistory}) with ordinality as t(e, n)), '[]'::jsonb)`;
  const rows = await tx
    .update(shipment)
    .set({
      trackingHistory: stripped,
      lastError: sql`case when ${shipment.lastError} is null then null else ${REDACTED}::text end`,
      providerStatus: sql`case when ${shipment.providerStatus} is null or (char_length(${shipment.providerStatus}) <= 40 and ${shipment.providerStatus} ~ ${PROVIDER_CODE_RE_SOURCE}) then ${shipment.providerStatus} else ${REDACTED}::text end`,
    })
    .where(
      and(
        eq(shipment.storeId, storeId),
        inArray(shipment.orderId, ids),
        sql`(exists (select 1 from jsonb_array_elements(${shipment.trackingHistory}) e where e ->> 'desc' is distinct from ${REDACTED}::text)
          or (${shipment.lastError} is not null and ${shipment.lastError} <> ${REDACTED}::text)
          or (${shipment.providerStatus} is not null and ${shipment.providerStatus} <> ${REDACTED}::text and not (char_length(${shipment.providerStatus}) <= 40 and ${shipment.providerStatus} ~ ${PROVIDER_CODE_RE_SOURCE})))`,
      ),
    )
    .returning({ id: shipment.id });
  return rows.length;
}

/** Overwrite the typed contact of checkout sessions that match `where` (T-45): REDACTED for name, phone and address, NULL for e-mail, like the order snapshot. Already-redacted rows are skipped. */
async function redactSessions(tx: Executor, storeId: number, matching: SQL | undefined): Promise<number> {
  if (!matching) return 0;
  const rows = await tx
    .update(checkoutSession)
    .set({
      buyerName: sql`case when ${checkoutSession.buyerName} is null then null else ${REDACTED}::text end`,
      buyerPhone: sql`case when ${checkoutSession.buyerPhone} is null then null else ${REDACTED}::text end`,
      buyerEmail: null,
      shippingAddress: sql`case when ${checkoutSession.shippingAddress} is null then null else ${REDACTED}::text end`,
    })
    .where(
      and(
        eq(checkoutSession.storeId, storeId),
        matching,
        or(
          sql`${checkoutSession.buyerName} is distinct from ${REDACTED}::text and ${checkoutSession.buyerName} is not null`,
          sql`${checkoutSession.buyerPhone} is distinct from ${REDACTED}::text and ${checkoutSession.buyerPhone} is not null`,
          sql`${checkoutSession.shippingAddress} is distinct from ${REDACTED}::text and ${checkoutSession.shippingAddress} is not null`,
          isNotNull(checkoutSession.buyerEmail),
        ),
      ),
    )
    .returning({ id: checkoutSession.id });
  return rows.length;
}

/**
 * The redaction itself, for orders already verified to belong to `storeId`, to be locked
 * and not yet redacted. Runs inside a store-context transaction; writes the per-order
 * `order_redaction` rows and one `privacy.redact` audit row with the counts.
 */
async function redactRows(
  tx: Executor,
  storeId: number,
  ids: number[],
  meta: { actorUserId: string; source: RedactionSource; override: boolean; reason: string | null },
): Promise<RedactionCounts> {
  const counts = zero();
  if (ids.length === 0) return counts;
  // T-45: the sessions of this buyer are found by the order's own contact and cart BEFORE the order snapshot is overwritten.
  const contacts = await tx.select({ cartId: order.cartId, phone: order.buyerPhone, email: order.buyerEmail }).from(order).where(and(eq(order.storeId, storeId), inArray(order.id, ids)));
  const sessionMatch = or(
    ...contacts.map((c) => (c.cartId ? eq(checkoutSession.cartId, c.cartId) : undefined)),
    ...[...new Set(contacts.map((c) => phoneLookupKey(c.phone)))].map((k) => (k ? phoneKeyEquals(checkoutSession.buyerPhone, k) : undefined)),
    ...[...new Set(contacts.map((c) => normalizeEmail(c.email)))].map((e) => (e ? sql`lower(${checkoutSession.buyerEmail}) = ${e}` : undefined)),
  );
  counts.checkoutSessions = await redactSessions(tx, storeId, sessionMatch);
  counts.shipments = await redactShipments(tx, storeId, ids);
  counts.orders = (
    await tx
      .update(order)
      .set({ buyerName: REDACTED, buyerPhone: REDACTED, buyerEmail: null, shippingAddress: REDACTED, updatedAt: new Date() })
      .where(and(eq(order.storeId, storeId), inArray(order.id, ids)))
      .returning({ id: order.id })
  ).length;
  counts.signalContexts = (
    await tx.delete(orderSignalContext).where(and(eq(orderSignalContext.storeId, storeId), inArray(orderSignalContext.orderId, ids))).returning({ id: orderSignalContext.orderId })
  ).length;
  counts.signalEvents = (
    await tx
      .update(signalEvent)
      .set({ payload: sql`${signalEvent.payload} - 'user'` })
      .where(and(eq(signalEvent.storeId, storeId), inArray(signalEvent.orderId, ids), sql`${signalEvent.payload} ? 'user'`))
      .returning({ id: signalEvent.id })
  ).length;

  // Owner-side function binds order ids to app_store_id() and strips every buyer and seller copy.
  const [mailCounts] = await tx.execute<{ n: number }>(sql`select public.mail_privacy_redact(${`{${ids.join(",")}}`}::bigint[])::int as n`);
  counts.mails = mailCounts?.n ?? 0;
  counts.notifications = (
    await tx
      .update(orderNotification)
      .set({ toEmail: REDACTED })
      .where(and(eq(orderNotification.storeId, storeId), inArray(orderNotification.orderId, ids), eq(orderNotification.recipient, "buyer"), ne(orderNotification.toEmail, REDACTED)))
      .returning({ id: orderNotification.id })
  ).length;

  await tx.insert(orderRedaction).values(ids.map((orderId) => ({ storeId, orderId, actorUserId: meta.actorUserId, source: meta.source, override: meta.override, reason: meta.reason })));
  await tx.insert(auditLog).values({
    actorUserId: meta.actorUserId,
    storeId,
    action: "privacy.redact",
    reason: JSON.stringify({ source: meta.source, orderIds: ids, counts, override: meta.override, reason: meta.reason }),
  });
  return counts;
}

const redactInput = z
  .strictObject({
    orderIds: z.array(z.coerce.number().int().positive()).min(1, "Pilih minimal satu pesanan.").max(100, "Maksimal 100 pesanan sekali proses."),
    override: z.boolean().default(false),
    reason: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().min(5, "Alasan minimal 5 karakter.").max(500).optional()),
  })
  .refine((v) => !v.override || v.reason, { message: "Isi alasan untuk menghapus data pesanan yang masih berjalan.", path: ["reason"] });

/**
 * Owner redacts selected orders. Orders already redacted are skipped (idempotent: a second
 * call changes nothing and writes no audit row). Orders that are not completed/cancelled are
 * refused unless `override` is set with a reason; that choice is recorded on each row.
 */
export async function redactOrders(scope: SellerScope, raw: unknown): Promise<RedactionCounts & { skipped: number }> {
  requireCap(scope, "privacy.manage");
  const input = redactInput.parse(raw);
  const ids = [...new Set(input.orderIds)].sort((a, b) => a - b);
  return inStore(scope, async ({ exec: tx }) => {
    const rows = await tx
      .select({ id: order.id, status: order.status })
      .from(order)
      .where(and(eq(order.storeId, scope.storeId), inArray(order.id, ids)))
      .orderBy(asc(order.id))
      .for("update");
    if (rows.length !== ids.length) throw new DomainError("not_found", "Pesanan tidak ditemukan.");
    const done = new Set((await tx.select({ id: orderRedaction.orderId }).from(orderRedaction).where(and(eq(orderRedaction.storeId, scope.storeId), inArray(orderRedaction.orderId, ids)))).map((r) => r.id));
    const todo = rows.filter((r) => !done.has(r.id));
    const open = todo.filter((r) => !CLOSED_STATUSES.includes(r.status));
    if (open.length > 0 && !input.override) {
      throw new DomainError("order_open", `Pesanan #${open.map((o) => o.id).join(", #")} belum selesai/dibatalkan. Centang "tetap hapus" dan isi alasan untuk melanjutkan.`);
    }
    const counts = await redactRows(
      tx,
      scope.storeId,
      todo.map((r) => r.id),
      { actorUserId: scope.userId, source: "seller", override: open.length > 0, reason: input.reason ?? null },
    );
    return { ...counts, skipped: done.size };
  });
}

/**
 * Owner redacts the checkout sessions that still hold one buyer's typed contact (T-45), for a buyer who abandoned checkout and never ordered (no order id to
 * select on the page above). Same overwrite as the order redaction; idempotent; audited as `privacy.redact_sessions` with the count and a hashed key.
 */
export async function redactCheckoutSessions(scope: SellerScope, rawKey: unknown): Promise<{ checkoutSessions: number }> {
  requireCap(scope, "privacy.manage");
  const key = normalizeBuyerKey(rawKey);
  return inStore(scope, async ({ exec: tx }) => {
    const n = await redactSessions(tx, scope.storeId, sessionMatchesKey(key));
    if (n > 0) await tx.insert(auditLog).values({ actorUserId: scope.userId, storeId: scope.storeId, action: "privacy.redact_sessions", reason: `${keyDigest(key)} sessions:${n}` });
    return { checkoutSessions: n };
  });
}

// ── Retention job (cleanup.ts) ─────────────────────────────────────────────────────────

/** `BUYER_DATA_RETENTION_DAYS`: unset/empty → null (job disabled, the default); otherwise an integer >= 1. */
export function retentionDays(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.BUYER_DATA_RETENTION_DAYS?.trim();
  if (!raw) return null;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) throw new Error(`BUYER_DATA_RETENTION_DAYS must be an integer >= 1 (got "${raw}")`);
  return days;
}

/**
 * Redact every completed/cancelled order whose last change is older than `days`, across
 * stores (platform pool), one store-context transaction per store so the same `redactRows`
 * path and audit apply. Open orders are never touched by retention. Returns per-store counts.
 */
export async function redactStaleOrders(exec: Executor, opts: { days: number; limit?: number }): Promise<{ stores: number; orders: number; counts: RedactionCounts }> {
  if (!Number.isInteger(opts.days) || opts.days < 1) throw new DomainError("days", "days must be an integer >= 1");
  const stale = await exec
    .select({ storeId: order.storeId, id: order.id })
    .from(order)
    .leftJoin(orderRedaction, and(eq(orderRedaction.storeId, order.storeId), eq(orderRedaction.orderId, order.id)))
    .where(and(inArray(order.status, [...CLOSED_STATUSES]), lt(order.updatedAt, sql`now() - ${opts.days} * interval '1 day'`), isNull(orderRedaction.orderId)))
    .orderBy(asc(order.storeId), asc(order.id))
    .limit(opts.limit ?? 1000);
  const byStore = new Map<number, number[]>();
  for (const r of stale) byStore.set(r.storeId, [...(byStore.get(r.storeId) ?? []), r.id]);
  const total = zero();
  for (const [storeId, ids] of byStore) {
    const c = await withStore(exec, storeId, (tx) => redactRows(tx, storeId, ids, { actorUserId: RETENTION_ACTOR, source: "retention", override: false, reason: null }));
    for (const k of Object.keys(total) as (keyof RedactionCounts)[]) total[k] += c[k];
  }
  return { stores: byStore.size, orders: stale.length, counts: total };
}
