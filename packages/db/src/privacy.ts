import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "./client.ts";
import { normalizePhone } from "./orders.ts";
import {
  auditLog,
  mailOutbox,
  order,
  orderLine,
  orderNotification,
  orderRedaction,
  orderSignalContext,
  orderStatusHistory,
  signalEvent,
  type OrderStatus,
  type RedactionSource,
} from "./schema.ts";
import { DomainError, requireCap, type SellerScope } from "./scoped.ts";
import { inStore, withStore } from "./tenant.ts";

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
  | "not_personal"; // name matched the scan but the column holds no personal data

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
  { table: "order_notification", column: "to_email", handling: "redact" },
  { table: "mail_outbox", column: "to_email", handling: "redact" },
  { table: "mail_outbox", column: "text_body", handling: "redact" },
  { table: "mail_outbox", column: "html_body", handling: "redact" },
  { table: "rate_limit", column: "key", handling: "expires" },
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
];

// ── Lookup key ─────────────────────────────────────────────────────────────────────────

export type BuyerKey = { kind: "phone" | "email"; value: string };

/** Phone (`+62…`/`62…`/`0…`, spaces and dashes ignored) or lower-cased e-mail; anything else is rejected. */
export function normalizeBuyerKey(raw: unknown): BuyerKey {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s.includes("@")) {
    const value = s.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254) throw new DomainError("invalid_query", "Alamat email tidak valid.");
    return { kind: "email", value };
  }
  const digits = normalizePhone(s.replace(/[\s().-]/g, ""));
  if (!/^[0-9]{8,15}$/.test(digits)) throw new DomainError("invalid_query", "Masukkan nomor HP (8–15 digit) atau alamat email pembeli.");
  return { kind: "phone", value: digits };
}

/** Same normalization as `normalizeBuyerKey` applied to the stored phone, so `+62`, `62` and `0` spellings match. */
const phoneSql = sql`regexp_replace(regexp_replace(regexp_replace(${order.buyerPhone}, '[^0-9+]', '', 'g'), '^\\+', ''), '^62', '0')`;
const matchesKey = (key: BuyerKey) => (key.kind === "phone" ? sql`${phoneSql} = ${key.value}` : sql`lower(${order.buyerEmail}) = ${key.value}`);
/** Audit rows never carry the raw key: a short SHA-256 prefix is enough to correlate requests. */
const keyDigest = (key: BuyerKey) => `${key.kind}:${createHash("sha256").update(key.value).digest("hex").slice(0, 16)}`;

/** Orders of this buyer in the store, newest first. A redacted order no longer matches: its contact fields are gone. */
export async function findBuyerOrders(scope: SellerScope, rawKey: unknown) {
  requireCap(scope, "privacy.manage");
  const key = normalizeBuyerKey(rawKey);
  const orders = await inStore(scope, (scope) =>
    scope.exec
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
      .limit(200),
  );
  return { key, orders };
}

// ── Export ─────────────────────────────────────────────────────────────────────────────

const mailSubjectFor = (orderId: number) => `(^|[^0-9])#${orderId}([^0-9]|$)`;

/**
 * Everything this store holds about one buyer, as one JSON document: orders (contact,
 * shipping, payment, amounts), lines, status history, attribution context, signal events'
 * user blocks, notification records and the mails the dev outbox sent to the buyer. Only the
 * caller's store (RLS); the lookup is audited (`privacy.export`) with a hashed key.
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
    const [lines, history, contexts, events, notifications, redactions] = ids.length
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
        ])
      : [[], [], [], [], [], []];
    // Dev outbox mails addressed to the buyer: store-less table, so the match is the buyer's
    // own address plus the order number in the subject (order ids are platform-wide).
    const buyerEmails = [...new Set(rows.map((o) => o.buyerEmail).filter((e): e is string => !!e && e !== REDACTED))];
    const mails = buyerEmails.length
      ? await tx
          .select({ toEmail: mailOutbox.toEmail, subject: mailOutbox.subject, textBody: mailOutbox.textBody, createdAt: mailOutbox.createdAt })
          .from(mailOutbox)
          .where(and(inArray(mailOutbox.toEmail, buyerEmails), sql`${mailOutbox.subject} ~ ${`#(${ids.join("|")})([^0-9]|$)`}`))
          .orderBy(asc(mailOutbox.id))
      : [];
    await tx.insert(auditLog).values({ actorUserId: scope.userId, storeId: scope.storeId, action: "privacy.export", reason: `${keyDigest(key)} orders:${ids.join(",") || "-"}` });
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
        mails: mails.filter((m) => new RegExp(mailSubjectFor(o.id)).test(m.subject)),
      })),
    };
  });
}
export type BuyerExport = Awaited<ReturnType<typeof exportBuyerData>>;

// ── Redaction ──────────────────────────────────────────────────────────────────────────

export type RedactionCounts = { orders: number; signalContexts: number; signalEvents: number; notifications: number; mails: number };
const zero = (): RedactionCounts => ({ orders: 0, signalContexts: 0, signalEvents: 0, notifications: 0, mails: 0 });

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

  // Mails: the dev outbox has no order id, so match the recipient recorded for the order
  // plus the order number in the subject. Buyer copies lose the address too; seller copies
  // (owner addresses) keep theirs and lose only the body that named the buyer.
  const sent = await tx
    .select({ orderId: orderNotification.orderId, recipient: orderNotification.recipient, toEmail: orderNotification.toEmail })
    .from(orderNotification)
    .where(and(eq(orderNotification.storeId, storeId), inArray(orderNotification.orderId, ids), ne(orderNotification.toEmail, REDACTED)));
  for (const n of sent) {
    counts.mails += (
      await tx
        .update(mailOutbox)
        .set({ textBody: REDACTED, htmlBody: null, ...(n.recipient === "buyer" ? { toEmail: REDACTED } : {}) })
        .where(and(eq(mailOutbox.toEmail, n.toEmail), sql`${mailOutbox.subject} ~ ${mailSubjectFor(n.orderId)}`, ne(mailOutbox.textBody, REDACTED)))
        .returning({ id: mailOutbox.id })
    ).length;
  }
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
