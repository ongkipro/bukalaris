import "./mail.ts"; // registers the durable delivery handler used by each rendered notification
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { dbMailer, type Mail, type Mailer } from "../../platform/accounts.ts";
import { storeLinks, surfaceOriginsFromEnv } from "../../platform/host.ts";
import type { Executor } from "../../client.ts";
import { resolveOrderStore } from "../../platform/resolvers.ts";
import { enqueue, registerHandler } from "./jobs.ts";
import type { OrderAction } from "../../seller/commerce/orders.ts";
import { withStore } from "../../platform/tenant.ts";
import { membership, NOTIFY_EVENTS, NOTIFY_RECIPIENTS, order, orderBankTransfer, orderLine, orderNotification, store, user, type NotifyEvent, type NotifyRecipient, type OrderStatus } from "../../schema.ts";

// Order e-mail notifications (T-36, PR-21, Q-16: e-mail only). The business write
// enqueues intent in its own transaction (`enqueueOrderNotifications`); the outbox
// worker renders Indonesian text + simple HTML and hands it to the Mailer (dev outbox
// until a provider is chosen). `(kind, key)` on the job plus `order_notification`'s
// unique key give at most one mail per order, event and address, also when a job is
// re-run after a lost lease. Buyers reach a read-only status page through a signed,
// expiring link; sellers (owners) get a link into Seller Admin.

export const ORDER_NOTIFY = "order.notify";

// ── Enqueue (inside the caller's transaction) ──────────────────────────────

const EVENT_OF_ACTION: Partial<Record<OrderAction, NotifyEvent>> = { confirm: "confirmed", ship: "shipped", cancel: "cancelled", reject: "cancelled" };
/** Who is told about each event; `buyer` only when the order carries an e-mail. */
const RECIPIENTS: Record<NotifyEvent, readonly NotifyRecipient[]> = {
  created: ["buyer", "seller"],
  confirmed: ["buyer"],
  shipped: ["buyer"],
  cancelled: ["buyer", "seller"],
};

/**
 * Enqueue the notifications for an order event in the same transaction as the business
 * write. `trigger` is `"created"` (checkout) or the seller action; actions without a
 * notification (`pay`, `process`, `hold`, `complete`) are a no-op. Idempotency key
 * `notify:<orderId>:<event>:<recipient>`.
 */
export async function enqueueOrderNotifications(tx: Executor, storeId: number, orderId: number, trigger: "created" | OrderAction): Promise<void> {
  const event = trigger === "created" ? "created" : EVENT_OF_ACTION[trigger];
  if (!event) return;
  const [o] = await tx.select({ email: order.buyerEmail }).from(order).where(and(eq(order.storeId, storeId), eq(order.id, orderId)));
  for (const recipient of RECIPIENTS[event]) {
    if (recipient === "buyer" && !o?.email) continue;
    await enqueue(tx, { kind: ORDER_NOTIFY, storeId, key: `notify:${orderId}:${event}:${recipient}`, payload: { orderId, event, recipient } });
  }
}

// ── Signed buyer link: /o/<orderId>.<expiry>.<hmac> ─────────────────────────

/** Links stay valid long enough to cover a slow COD cycle; every later mail carries a fresh one. */
export const ORDER_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_RE = /^([0-9]{1,15})\.([0-9]{1,12})\.([A-Za-z0-9_-]{43})$/;

/** No fallback to another purpose's secret (SEC-22); the worker calls this before claiming anything. */
export function requireOrderLinkSecret(): string {
  const s = process.env.ORDER_LINK_SECRET;
  if (!s) throw new Error("ORDER_LINK_SECRET is not set");
  return s;
}
const signature = (orderId: number, expiresAtSec: number) => createHmac("sha256", requireOrderLinkSecret()).update(`order-link:${orderId}.${expiresAtSec}`).digest("base64url");

/** Token for the buyer status page of `orderId`, valid for `ORDER_LINK_TTL_MS` from `now`. */
export function signOrderLink(orderId: number, now = Date.now()): string {
  const exp = Math.floor((now + ORDER_LINK_TTL_MS) / 1000);
  return `${orderId}.${exp}.${signature(orderId, exp)}`;
}

/** The order id a well-formed, unexpired, untampered token grants; null otherwise (constant-time compare). */
export function verifyOrderLink(token: string, now = Date.now()): number | null {
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const orderId = Number(m[1]);
  const exp = Number(m[2]);
  if (exp * 1000 <= now) return null;
  const given = Buffer.from(m[3]!);
  const expected = Buffer.from(signature(orderId, exp));
  return given.length === expected.length && timingSafeEqual(given, expected) ? orderId : null;
}

/** Status page data for a valid token: that order only, no address beyond the area label, no phone. */
export async function getOrderForLink(exec: Executor, token: string, now = Date.now()) {
  const orderId = verifyOrderLink(token, now);
  if (!orderId) return null;
  // Cross-store resolver (ADR-0005 §4): the signed order id → its store, nothing else; then the store context.
  const storeId = await resolveOrderStore(exec, orderId);
  if (storeId === null) return null;
  return withStore(exec, storeId, async (tx) => {
    const [o] = await tx
      .select({
        id: order.id,
        storeId: order.storeId,
        storeName: store.name,
        // Public (it names the storefront): a store host serves only its own store's link (T-103).
        storeSlug: store.slug,
        status: order.status,
        paymentMethod: order.paymentMethod,
        courier: order.courier,
        trackingNumber: order.trackingNumber,
        destinationAreaLabel: order.destinationAreaLabel,
        subtotal: order.subtotal,
        shippingFee: order.shippingFee,
        goodsDiscount: order.goodsDiscount,
        shippingDiscount: order.shippingDiscount,
        total: order.total,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      })
      .from(order)
      .innerJoin(store, eq(store.id, order.storeId))
      .where(eq(order.id, orderId));
    if (!o) return null;
    const lines = await tx
      .select({ variantId: orderLine.variantId, productTitle: orderLine.productTitle, variantTitle: orderLine.variantTitle, quantity: orderLine.quantity, lineTotal: orderLine.lineTotal })
      .from(orderLine)
      .where(and(eq(orderLine.storeId, o.storeId), eq(orderLine.orderId, o.id)))
      .orderBy(asc(orderLine.variantId));
    const { storeId: _storeId, ...safe } = o;
    return { ...safe, lines };
  });
}

/** Buyer-facing status wording (a held COD order is still "waiting for the seller" to the buyer). */
export const BUYER_STATUS_LABEL: Record<OrderStatus, string> = {
  awaiting_confirmation: "Menunggu konfirmasi penjual",
  on_hold: "Menunggu konfirmasi penjual",
  awaiting_payment: "Menunggu pembayaran",
  placed: "Dikonfirmasi",
  processing: "Sedang disiapkan",
  shipped: "Dikirim",
  completed: "Selesai",
  cancelled: "Dibatalkan",
  returned: "Dikembalikan ke penjual",
};

// ── Templates ──────────────────────────────────────────────────────────────

const idr = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
export const rupiah = (n: number) => idr.format(n);
/** HTML-escape every interpolated value (titles, names, labels, tracking numbers come from users). */
export const escapeHtml = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const origins = () => surfaceOriginsFromEnv(process.env);

type OrderForMail = NonNullable<Awaited<ReturnType<typeof loadOrder>>>;
async function loadOrder(exec: Executor, storeId: number, orderId: number) {
  const [o] = await exec
    .select({
      id: order.id,
      storeName: store.name,
      storeSlug: store.slug,
      status: order.status,
      paymentMethod: order.paymentMethod,
      buyerName: order.buyerName,
      buyerEmail: order.buyerEmail,
      courier: order.courier,
      trackingNumber: order.trackingNumber,
      destinationAreaLabel: order.destinationAreaLabel,
      subtotal: order.subtotal,
      shippingFee: order.shippingFee,
      goodsDiscount: order.goodsDiscount,
      shippingDiscount: order.shippingDiscount,
      total: order.total,
    })
    .from(order)
    .innerJoin(store, eq(store.id, order.storeId))
    .where(and(eq(order.storeId, storeId), eq(order.id, orderId)));
  if (!o) return null;
  const lines = await exec
    .select({ productTitle: orderLine.productTitle, variantTitle: orderLine.variantTitle, quantity: orderLine.quantity, lineTotal: orderLine.lineTotal })
    .from(orderLine)
    .where(and(eq(orderLine.storeId, storeId), eq(orderLine.orderId, orderId)))
    .orderBy(asc(orderLine.variantId));
  // T-113 (decision 37): a bank-transfer order carries the destination accounts it froze at submit; the mail shows them with the exact total.
  const [bank] = o.paymentMethod === "bank_transfer" ? await exec.select({ accounts: orderBankTransfer.accounts, expiresAt: orderBankTransfer.expiresAt }).from(orderBankTransfer).where(and(eq(orderBankTransfer.storeId, storeId), eq(orderBankTransfer.orderId, orderId))) : [];
  return { ...o, lines, bank: bank ?? null };
}
const wib = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" });
/** The transfer instruction of a bank-transfer order: the exact total (no unique code) and every frozen destination account. */
function bankLines(o: OrderForMail): string[] {
  if (!o.bank) return [];
  return [
    `Transfer tepat ${rupiah(o.total)} ke salah satu rekening ${o.storeName} berikut sebelum ${wib.format(o.bank.expiresAt)} WIB:`,
    ...o.bank.accounts.map((a) => `- ${a.bankCode} ${a.accountNumber} a.n. ${a.holderName}`),
    "Setelah transfer, kirim foto bukti transfer di halaman status pesanan. Pesanan diproses setelah penjual mengonfirmasi dana masuk.",
  ];
}

/** Subject + lead paragraph per event and recipient; the order summary and link are appended by `renderMail`. */
function copy(event: NotifyEvent, recipient: NotifyRecipient, o: OrderForMail): { subject: string; lead: string[] } {
  const n = `#${o.id}`;
  if (recipient === "buyer") {
    switch (event) {
      case "created":
        return {
          subject: `Pesanan ${n} di ${o.storeName} diterima`,
          lead: [
            `Halo ${o.buyerName}, pesanan Anda di ${o.storeName} sudah kami terima.`,
            ...(o.paymentMethod === "cod"
              ? ["Bayar di tempat (COD) saat barang tiba. Penjual akan menghubungi nomor HP Anda untuk konfirmasi sebelum pesanan dikirim."]
              : o.bank
                ? bankLines(o)
                : ["Selesaikan pembayaran transfer sesuai instruksi di halaman konfirmasi; pesanan diproses setelah pembayaran dikonfirmasi penjual."]),
          ],
        };
      case "confirmed":
        return { subject: `Pesanan ${n} dikonfirmasi oleh ${o.storeName}`, lead: [`Halo ${o.buyerName}, pesanan Anda sudah dikonfirmasi penjual dan akan segera disiapkan.`] };
      case "shipped":
        return {
          subject: `Pesanan ${n} dikirim · resi ${o.trackingNumber ?? "-"}`,
          lead: [`Halo ${o.buyerName}, pesanan Anda sudah dikirim dengan ${o.courier}.`, `Nomor resi: ${o.trackingNumber ?? "-"}`],
        };
      case "cancelled":
        return { subject: `Pesanan ${n} dibatalkan`, lead: [`Halo ${o.buyerName}, pesanan Anda di ${o.storeName} dibatalkan. Hubungi penjual bila ada pertanyaan.`] };
    }
  }
  switch (event) {
    case "created":
      return o.paymentMethod === "cod"
        ? {
            subject: `[${o.storeName}] Pesanan COD ${n} menunggu konfirmasi`,
            lead: [`Pesanan COD baru dari ${o.buyerName}.`, "Hubungi pembeli untuk konfirmasi, lalu tandai pesanan sebagai dikonfirmasi di Seller Admin sebelum diproses."],
          }
        : o.bank
          ? { subject: `[${o.storeName}] Pesanan transfer bank ${n} menunggu pembayaran`, lead: [`Pesanan transfer bank baru dari ${o.buyerName}, total ${rupiah(o.total)}.`, "Cek mutasi rekening Anda; setelah dana masuk, konfirmasi transfer pada pesanan di Seller Admin (dengan alasan). Bukti dari pembeli saja tidak mengubah status pesanan."] }
          : { subject: `[${o.storeName}] Pesanan baru ${n} menunggu pembayaran`, lead: [`Pesanan transfer baru dari ${o.buyerName}.`, "Tandai sudah dibayar di Seller Admin setelah pembayaran masuk."] };
    case "cancelled":
      return { subject: `[${o.storeName}] Pesanan ${n} dibatalkan`, lead: [`Pesanan ${n} dari ${o.buyerName} dibatalkan; stok sudah dikembalikan.`] };
    default:
      return { subject: `[${o.storeName}] Pesanan ${n}: ${BUYER_STATUS_LABEL[o.status]}`, lead: [`Status pesanan ${n} dari ${o.buyerName} sekarang: ${BUYER_STATUS_LABEL[o.status]}.`] };
  }
}

/** Plain text + simple inline-styled HTML (no external assets); every value is escaped in the HTML. */
export function renderMail(event: NotifyEvent, recipient: NotifyRecipient, o: OrderForMail, to: string): Mail {
  const { subject, lead } = copy(event, recipient, o);
  // The buyer's signed status page lives on the store's own host (ADR-0014 decisions 5 and 7, T-103); the seller's link on Seller Admin.
  const link = recipient === "buyer" ? `${storeLinks(o.storeSlug).origin}/o/${signOrderLink(o.id)}` : `${origins().appOrigin}/seller/orders/${o.id}`;
  const linkLabel = recipient === "buyer" ? "Lihat status pesanan" : "Buka pesanan di Seller Admin";
  const route = `${o.courier} ke ${o.destinationAreaLabel}`;
  const text = [
    ...lead,
    "",
    `Pesanan #${o.id} · ${o.storeName}`,
    ...o.lines.map((l) => `- ${l.productTitle} · ${l.variantTitle} × ${l.quantity} = ${rupiah(l.lineTotal)}`),
    `Subtotal ${rupiah(o.subtotal)}`,
    ...(o.goodsDiscount > 0 ? [`Diskon barang -${rupiah(o.goodsDiscount)}`] : []),
    `Ongkir ${rupiah(o.shippingFee)}${o.shippingDiscount > 0 ? ` (sudah dipotong diskon ongkir ${rupiah(o.shippingDiscount)})` : ""}`,
    `Total ${rupiah(o.total)}`,
    `Pengiriman: ${route}${o.trackingNumber ? ` · resi ${o.trackingNumber}` : ""}`,
    "",
    `${linkLabel}: ${link}`,
    "",
    "Email ini dikirim otomatis oleh Bukalaris. Jangan membalas email ini.",
  ].join("\n");
  const html = [
    '<!doctype html><html lang="id"><body style="margin:0;padding:16px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;background:#fff">',
    '<div style="max-width:560px;margin:0 auto">',
    ...lead.map((p) => `<p style="margin:0 0 12px">${escapeHtml(p)}</p>`),
    `<h2 style="font-size:16px;margin:20px 0 8px">Pesanan #${escapeHtml(o.id)} · ${escapeHtml(o.storeName)}</h2>`,
    '<table style="width:100%;border-collapse:collapse;font-size:14px">',
    ...o.lines.map(
      (l) =>
        `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${escapeHtml(l.productTitle)} · ${escapeHtml(l.variantTitle)} × ${escapeHtml(l.quantity)}</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">${escapeHtml(rupiah(l.lineTotal))}</td></tr>`,
    ),
    `<tr><td style="padding:6px 0">Subtotal</td><td style="padding:6px 0;text-align:right">${escapeHtml(rupiah(o.subtotal))}</td></tr>`,
    ...(o.goodsDiscount > 0 ? [`<tr><td style="padding:6px 0">Diskon barang</td><td style="padding:6px 0;text-align:right">-${escapeHtml(rupiah(o.goodsDiscount))}</td></tr>`] : []),
    `<tr><td style="padding:6px 0">Ongkir${o.shippingDiscount > 0 ? ` (diskon ongkir ${escapeHtml(rupiah(o.shippingDiscount))})` : ""}</td><td style="padding:6px 0;text-align:right">${escapeHtml(rupiah(o.shippingFee))}</td></tr>`,
    `<tr><td style="padding:6px 0;font-weight:600">Total</td><td style="padding:6px 0;text-align:right;font-weight:600">${escapeHtml(rupiah(o.total))}</td></tr>`,
    "</table>",
    `<p style="margin:12px 0;font-size:14px">Pengiriman: ${escapeHtml(route)}${o.trackingNumber ? ` · resi <strong>${escapeHtml(o.trackingNumber)}</strong>` : ""}</p>`,
    `<p style="margin:20px 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px">${linkLabel}</a></p>`,
    `<p style="margin:0;font-size:12px;color:#666">Email ini dikirim otomatis oleh Bukalaris. Jangan membalas email ini.</p>`,
    "</div></body></html>",
  ].join("");
  return { to, subject, text, html, order: { id: o.id, recipient } };
}

// ── Job handler ────────────────────────────────────────────────────────────

const notifyPayload = z.object({ orderId: z.number().int().positive(), event: z.enum(NOTIFY_EVENTS), recipient: z.enum(NOTIFY_RECIPIENTS) });

/** Intent and order_notification commit together; the mail.deliver worker performs external I/O after commit. */
let mailerFor: (exec: Executor) => Mailer = dbMailer;
export function setNotifyMailer(factory: (exec: Executor) => Mailer): void {
  mailerFor = factory;
}

/** Owners of the store receive seller mail (seller notification preferences are out of scope, T-36). */
async function ownerEmails(exec: Executor, storeId: number): Promise<string[]> {
  const rows = await exec
    .select({ email: user.email })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(and(eq(membership.storeId, storeId), eq(membership.role, "owner")))
    .orderBy(asc(user.email));
  return rows.map((r) => r.email.toLowerCase());
}

registerHandler(ORDER_NOTIFY, async ({ db }, j) => {
  const { orderId, event, recipient } = notifyPayload.parse(j.payload);
  const o = await loadOrder(db, j.storeId, orderId);
  if (!o) return;
  const addresses = recipient === "buyer" ? (o.buyerEmail ? [o.buyerEmail] : []) : await ownerEmails(db, j.storeId);
  await db.transaction(async (tx) => {
    const mailer = mailerFor(tx);
    for (const to of addresses) {
      const [fresh] = await tx
        .insert(orderNotification)
        .values({ storeId: j.storeId, orderId, event, recipient, toEmail: to })
        .onConflictDoNothing()
        .returning({ id: orderNotification.id });
      if (!fresh) continue; // already notified (re-run after a lost lease)
      // Durable mail intent commits with the unique notification. No external I/O in this transaction.
      await mailer.send(renderMail(event, recipient, o, to));
    }
  });
});
