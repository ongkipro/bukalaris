import { and, asc, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../../client.ts";
import { hit, type LimitRule } from "../../platform/rate-limit.ts";
import { DomainError, requireCap, type SellerScope } from "../../platform/scoped.ts";
import { inStore, withStore } from "../../platform/tenant.ts";
import { auditLog, digitalGrant, order, orderLine, product, productAccessItem, productAccessNote, store, variant } from "../../schema.ts";
import { ACCESS_ITEM_TYPES, DIGITAL_GRANT_STATES, RESERVED_ACCESS_ITEM_TYPES, type AccessItemType, type DigitalGrantState } from "./schema-digital.ts";

export { ACCESS_ITEM_TYPES, DIGITAL_GRANT_STATES, RESERVED_ACCESS_ITEM_TYPES, type AccessItemType, type DigitalGrantState } from "./schema-digital.ts";

// T-112 (PR-2, ADR-0016 section 4, section 7 and decisions 18, 20, 23, 24; C-G1..C-G3):
// Seller-hosted access links & plain-text access note for digital products, per-line grants issued
// strictly inside the settlement transaction, one single reader (`resolveOrderDigitalGrants`) that
// enforces active/non-expired/non-revoked/non-suspended store and RL-ACCESS-OPEN, plus audited seller
// extend/revoke and automatic revocation on cancel, refund and order redaction.
// The server NEVER makes an outbound HTTP request to any access link.

export const ACCESS_LINKS_MAX = 10;
export const ACCESS_URL_MAX = 2000;
export const ACCESS_NOTE_MAX = 5000;

/** RL-ACCESS-OPEN (docs/16-OBSERVABILITY-RATE-LIMITING.md, D-33): 60 / 10 min per order; 120 / 10 min per IP. */
export const ACCESS_OPEN_LIMITS = {
  order: { limit: 60, windowSec: 600 },
  ip: { limit: 120, windowSec: 600 },
} as const satisfies Record<string, LimitRule>;

/** Validate and normalize a seller-supplied access link: https only, no credentials, no control chars/backslash, max 2,000 chars, never fetched. */
export function validateAccessUrl(raw: string): { url: string; host: string } {
  const trimmed = raw.trim();
  if (/[\s\x00-\x1f\x7f\\]/.test(trimmed)) {
    throw new DomainError("invalid_access_url", "Tautan akses tidak boleh mengandung spasi atau karakter kontrol.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new DomainError("invalid_access_url", "Format tautan akses tidak valid.");
  }
  if (parsed.protocol !== "https:") {
    throw new DomainError("invalid_access_url", "Tautan akses wajib menggunakan protokol https://.");
  }
  if (parsed.username !== "" || parsed.password !== "" || /^https:\/\/[^/]*@/i.test(trimmed)) {
    throw new DomainError("invalid_access_url", "Tautan akses tidak boleh memuat kredensial (user:password@).");
  }
  if (!parsed.hostname || !parsed.hostname.includes(".")) {
    throw new DomainError("invalid_access_url", "Host tujuan tautan akses tidak valid.");
  }
  const normalized = parsed.href;
  if (normalized.length < 10 || normalized.length > ACCESS_URL_MAX) {
    throw new DomainError("invalid_access_url", `Tautan akses harus antara 10 dan ${ACCESS_URL_MAX} karakter.`);
  }
  return { url: normalized, host: parsed.hostname.toLowerCase() };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const addLinkInput = z.strictObject({
  itemType: z.string().default("link"),
  label: z.string().trim().min(1, "Label tautan wajib diisi.").max(120, "Label maksimal 120 karakter."),
  url: z.string().trim().min(1, "Tautan akses wajib diisi.").max(ACCESS_URL_MAX, `Tautan maksimal ${ACCESS_URL_MAX} karakter.`),
});

const noteInput = z.strictObject({
  note: z.string().max(ACCESS_NOTE_MAX, `Catatan akses maksimal ${ACCESS_NOTE_MAX} karakter.`),
});

/** True when a digital product has at least one access link or a non-empty access note (ADR-0016 decision 3). */
export async function hasDigitalDeliveryContent(tx: Executor, storeId: number, productId: number): Promise<boolean> {
  const [{ n }] = (await tx
    .select({ n: count() })
    .from(productAccessItem)
    .where(and(eq(productAccessItem.storeId, storeId), eq(productAccessItem.productId, productId)))) as [{ n: number }];
  if (n > 0) return true;
  const [noteRow] = await tx
    .select({ note: productAccessNote.note })
    .from(productAccessNote)
    .where(and(eq(productAccessNote.storeId, storeId), eq(productAccessNote.productId, productId)));
  return Boolean(noteRow && noteRow.note.trim().length > 0);
}

/** Seller Admin (SC-03): read a digital product's configured access links and note. Never called by storefront/API/feeds. */
export async function getProductAccessContent(scope: SellerScope, productId: number) {
  requireCap(scope, "catalog.read");
  return inStore(scope, async ({ exec: tx }) => {
    const [p] = await tx
      .select({ id: product.id, kind: product.kind })
      .from(product)
      .where(and(eq(product.storeId, scope.storeId), eq(product.id, productId)));
    if (!p || p.kind !== "digital") return null;
    const items = await tx
      .select({ id: productAccessItem.id, itemType: productAccessItem.itemType, label: productAccessItem.label, url: productAccessItem.url, position: productAccessItem.position })
      .from(productAccessItem)
      .where(and(eq(productAccessItem.storeId, scope.storeId), eq(productAccessItem.productId, productId)))
      .orderBy(asc(productAccessItem.position), asc(productAccessItem.id));
    const [noteRow] = await tx
      .select({ note: productAccessNote.note })
      .from(productAccessNote)
      .where(and(eq(productAccessNote.storeId, scope.storeId), eq(productAccessNote.productId, productId)));
    return {
      items: items.map((i) => ({ ...i, host: hostOf(i.url) })),
      note: noteRow?.note ?? "",
    };
  });
}

/** Seller Admin (SC-03): add one https access link to a digital product (cap 10, reserved types refused, audited without URL). */
export async function addAccessLink(scope: SellerScope, productId: number, raw: unknown): Promise<{ id: number }> {
  requireCap(scope, "catalog.write");
  const input = addLinkInput.parse(raw);
  if (input.itemType !== "link") {
    throw new DomainError("reserved_access_type", "Jenis item akses ini belum tersedia; hanya tautan (link) yang didukung.");
  }
  const { url, host } = validateAccessUrl(input.url);
  return inStore(scope, async ({ exec: tx }) => {
    const [p] = await tx
      .select({ id: product.id, kind: product.kind })
      .from(product)
      .where(and(eq(product.storeId, scope.storeId), eq(product.id, productId)))
      .for("update");
    if (!p) throw new DomainError("not_found", "Produk tidak ditemukan.");
    if (p.kind !== "digital") throw new DomainError("not_digital", "Tautan akses hanya untuk produk digital.");
    const existing = await tx
      .select({ id: productAccessItem.id, position: productAccessItem.position })
      .from(productAccessItem)
      .where(and(eq(productAccessItem.storeId, scope.storeId), eq(productAccessItem.productId, productId)))
      .orderBy(asc(productAccessItem.position), asc(productAccessItem.id));
    if (existing.length >= ACCESS_LINKS_MAX) {
      throw new DomainError("access_link_limit", `Maksimal ${ACCESS_LINKS_MAX} tautan akses per produk.`);
    }
    const nextPos = existing.length === 0 ? 0 : existing[existing.length - 1]!.position + 1;
    const [row] = await tx
      .insert(productAccessItem)
      .values({ storeId: scope.storeId, productId, itemType: "link", label: input.label, url, position: nextPos })
      .returning({ id: productAccessItem.id });
    // Audit stores host only, NEVER the access URL or query string.
    await tx.insert(auditLog).values({
      storeId: scope.storeId,
      actorUserId: scope.userId,
      actorCapability: "catalog.write",
      action: "digital.access_link.add",
      subjectKind: "product",
      subjectId: String(productId),
      accessLevel: "write",
      outcome: "allowed",
      reason: `item=${row!.id}; host=${host}`.slice(0, 500),
    });
    return { id: row!.id };
  });
}

/** Seller Admin (SC-03): reorder access links (up/down) deterministically, audited. */
export async function reorderAccessLink(scope: SellerScope, productId: number, itemId: number, direction: "up" | "down"): Promise<void> {
  requireCap(scope, "catalog.write");
  await inStore(scope, async ({ exec: tx }) => {
    const [p] = await tx
      .select({ id: product.id })
      .from(product)
      .where(and(eq(product.storeId, scope.storeId), eq(product.id, productId)))
      .for("update");
    if (!p) throw new DomainError("not_found", "Produk tidak ditemukan.");
    const items = await tx
      .select({ id: productAccessItem.id, position: productAccessItem.position })
      .from(productAccessItem)
      .where(and(eq(productAccessItem.storeId, scope.storeId), eq(productAccessItem.productId, productId)))
      .orderBy(asc(productAccessItem.position), asc(productAccessItem.id));
    const idx = items.findIndex((i) => i.id === itemId);
    if (idx < 0) throw new DomainError("not_found", "Tautan akses tidak ditemukan.");
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= items.length) return;
    const reordered = [...items];
    const [moved] = reordered.splice(idx, 1);
    reordered.splice(swapIdx, 0, moved!);
    for (let i = 0; i < reordered.length; i++) {
      await tx
        .update(productAccessItem)
        .set({ position: i, updatedAt: new Date() })
        .where(and(eq(productAccessItem.storeId, scope.storeId), eq(productAccessItem.id, reordered[i]!.id)));
    }
    await tx.insert(auditLog).values({
      storeId: scope.storeId,
      actorUserId: scope.userId,
      actorCapability: "catalog.write",
      action: "digital.access_link.reorder",
      subjectKind: "product",
      subjectId: String(productId),
      accessLevel: "write",
      outcome: "allowed",
      reason: `item=${itemId}; dir=${direction}`,
    });
  });
}

/** Seller Admin (SC-03): remove an access link (audited; keeps at least one delivery item/note while product is active). */
export async function removeAccessLink(scope: SellerScope, productId: number, itemId: number): Promise<void> {
  requireCap(scope, "catalog.write");
  await inStore(scope, async ({ exec: tx }) => {
    const [p] = await tx
      .select({ id: product.id, status: product.status })
      .from(product)
      .where(and(eq(product.storeId, scope.storeId), eq(product.id, productId)))
      .for("update");
    if (!p) throw new DomainError("not_found", "Produk tidak ditemukan.");
    const deleted = await tx
      .delete(productAccessItem)
      .where(and(eq(productAccessItem.storeId, scope.storeId), eq(productAccessItem.productId, productId), eq(productAccessItem.id, itemId)))
      .returning({ id: productAccessItem.id });
    if (deleted.length === 0) throw new DomainError("not_found", "Tautan akses tidak ditemukan.");
    if (p.status === "active" && !(await hasDigitalDeliveryContent(tx, scope.storeId, productId))) {
      throw new DomainError("delivery_content_required", "Produk digital aktif harus memiliki minimal satu tautan atau catatan akses. Ubah ke Draf dulu bila ingin menghapus semuanya.");
    }
    await tx.insert(auditLog).values({
      storeId: scope.storeId,
      actorUserId: scope.userId,
      actorCapability: "catalog.write",
      action: "digital.access_link.remove",
      subjectKind: "product",
      subjectId: String(productId),
      accessLevel: "write",
      outcome: "allowed",
      reason: `item=${itemId}`,
    });
  });
}

/** Seller Admin (SC-03): save or clear the plain-text access note (never rendered as HTML; audited without body). */
export async function saveAccessNote(scope: SellerScope, productId: number, raw: unknown): Promise<void> {
  requireCap(scope, "catalog.write");
  const { note } = noteInput.parse(raw);
  const trimmed = note.trim();
  await inStore(scope, async ({ exec: tx }) => {
    const [p] = await tx
      .select({ id: product.id, kind: product.kind, status: product.status })
      .from(product)
      .where(and(eq(product.storeId, scope.storeId), eq(product.id, productId)))
      .for("update");
    if (!p) throw new DomainError("not_found", "Produk tidak ditemukan.");
    if (p.kind !== "digital") throw new DomainError("not_digital", "Catatan akses hanya untuk produk digital.");
    if (trimmed.length === 0) {
      await tx.delete(productAccessNote).where(and(eq(productAccessNote.storeId, scope.storeId), eq(productAccessNote.productId, productId)));
      if (p.status === "active" && !(await hasDigitalDeliveryContent(tx, scope.storeId, productId))) {
        throw new DomainError("delivery_content_required", "Produk digital aktif harus memiliki minimal satu tautan atau catatan akses.");
      }
    } else {
      await tx
        .insert(productAccessNote)
        .values({ storeId: scope.storeId, productId, note: trimmed, updatedAt: new Date() })
        .onConflictDoUpdate({ target: [productAccessNote.storeId, productAccessNote.productId], set: { note: trimmed, updatedAt: new Date() } });
    }
    await tx.insert(auditLog).values({
      storeId: scope.storeId,
      actorUserId: scope.userId,
      actorCapability: "catalog.write",
      action: "digital.access_note.save",
      subjectKind: "product",
      subjectId: String(productId),
      accessLevel: "write",
      outcome: "allowed",
      reason: `len=${trimmed.length}`,
    });
  });
}

// ── Grant issuance & revocation (in-transaction hooks) ─────────────────────────────────────

/**
 * Issue one `digital_grant` per digital `order_line` STRICTLY inside the transaction that settles the order
 * (status check or seller manual confirmation). Idempotent under concurrent or replayed settlement
 * (`onConflictDoNothing` on `(store_id, order_id, variant_id)`). Also starts the affiliate hold window
 * for digital-only orders (ADR-0016 decision 20).
 */
export async function grantDigitalAccessInTx(tx: Executor, storeId: number, orderId: number): Promise<number> {
  const [o] = await tx
    .select({ id: order.id, status: order.status, paidAt: order.paidAt, testOrder: order.testOrder, hasDigital: order.hasDigital })
    .from(order)
    .where(and(eq(order.storeId, storeId), eq(order.id, orderId)));
  if (!o || !o.paidAt || !o.hasDigital || o.status === "cancelled" || o.status === "returned") return 0;
  const [st] = await tx.select({ expiryDays: store.digitalGrantExpiryDays }).from(store).where(eq(store.id, storeId));
  const expiresAt = st?.expiryDays ? new Date(o.paidAt.getTime() + st.expiryDays * 86_400_000) : null;
  const lines = await tx
    .select({ variantId: orderLine.variantId, productId: variant.productId })
    .from(orderLine)
    .innerJoin(variant, and(eq(variant.storeId, orderLine.storeId), eq(variant.id, orderLine.variantId)))
    .where(and(eq(orderLine.storeId, storeId), eq(orderLine.orderId, orderId), eq(orderLine.productKind, "digital")))
    .orderBy(asc(orderLine.variantId));
  if (lines.length === 0) return 0;
  const inserted = await tx
    .insert(digitalGrant)
    .values(lines.map((l) => ({ storeId, orderId, variantId: l.variantId, productId: l.productId, state: "active" as const, expiresAt, isTest: o.testOrder })))
    .onConflictDoNothing()
    .returning({ id: digitalGrant.id });
  return inserted.length;
}

/** Revoke all active digital grants of one order (called inside cancel, seller refund, or order redaction C-G3). */
export async function revokeOrderDigitalGrantsInTx(tx: Executor, storeId: number, orderId: number, actorUserId: string, reason: string): Promise<number> {
  const safeReason = reason.trim().length >= 3 ? reason.trim().slice(0, 500) : "Akses dicabut oleh sistem";
  const safeActor = actorUserId.trim() || "system:digital";
  const revoked = await tx
    .update(digitalGrant)
    .set({ state: "revoked", revokedAt: new Date(), revokedBy: safeActor, revokedReason: safeReason, updatedAt: new Date() })
    .where(and(eq(digitalGrant.storeId, storeId), eq(digitalGrant.orderId, orderId), eq(digitalGrant.state, "active")))
    .returning({ id: digitalGrant.id });
  return revoked.length;
}

// ── Single reader for buyer digital content (ADR-0016 item 26) ─────────────────────────────

export type ResolvedAccessLink = { id: number; label: string; host: string; url: string };
export type ResolvedDigitalGrant = {
  id: number;
  productTitle: string;
  variantTitle: string;
  state: DigitalGrantState;
  expired: boolean;
  active: boolean;
  isTest: boolean;
  expiresAt: Date | null;
  grantedAt: Date;
  /** Non-empty ONLY when `active` (state='active', not expired, store active); empty otherwise. */
  links: ResolvedAccessLink[];
  /** Plain text ONLY when `active`; null otherwise. Always render as text, never HTML. */
  note: string | null;
};

/**
 * The ONE function that resolves a buyer's digital grants to their delivery content (ADR-0016 item 26).
 * Enforces RL-ACCESS-OPEN when requested by the buyer, hides all access links while the store is suspended (C-G1),
 * and returns nothing (empty links, null note) for expired or revoked grants.
 */
export async function resolveOrderDigitalGrants(
  exec: Executor,
  ref: { storeId: number; orderId: number },
  opts: { clientIp?: string | undefined; countRateLimit?: boolean | undefined; now?: Date | undefined } = {},
): Promise<{ storeSuspended: boolean; rateLimited: boolean; retryAfterSec?: number | undefined; grants: ResolvedDigitalGrant[] }> {
  // RL-ACCESS-OPEN is fail-closed by default (countRateLimit defaults to true); both order and IP counters are evaluated together.
  if (opts.countRateLimit !== false) {
    const hits = [hit(exec, `access-open:order:${ref.orderId}`, ACCESS_OPEN_LIMITS.order)];
    if (opts.clientIp) hits.push(hit(exec, `access-open:ip:${opts.clientIp}`, ACCESS_OPEN_LIMITS.ip));
    const [rOrder, rIp] = await Promise.all(hits);
    const overOrder = rOrder!.count > ACCESS_OPEN_LIMITS.order.limit;
    const overIp = rIp !== undefined && rIp.count > ACCESS_OPEN_LIMITS.ip.limit;
    if (overOrder || overIp) {
      const wait = Math.max(overOrder ? rOrder!.retryAfterSec : 0, overIp ? rIp!.retryAfterSec : 0);
      return { storeSuspended: false, rateLimited: true, retryAfterSec: wait, grants: [] };
    }
  }
  const now = opts.now ?? new Date();
  return withStore(exec, ref.storeId, async (tx) => {
    const [st] = await tx.select({ status: store.status }).from(store).where(eq(store.id, ref.storeId));
    // C-G1: while a store is suspended its access links are not shown.
    if (!st || st.status !== "active") {
      return { storeSuspended: true, rateLimited: false, grants: [] };
    }
    const rows = await tx
      .select({
        id: digitalGrant.id,
        productId: digitalGrant.productId,
        productTitle: orderLine.productTitle,
        variantTitle: orderLine.variantTitle,
        state: digitalGrant.state,
        expiresAt: digitalGrant.expiresAt,
        isTest: digitalGrant.isTest,
        grantedAt: digitalGrant.grantedAt,
      })
      .from(digitalGrant)
      .innerJoin(orderLine, and(eq(orderLine.storeId, digitalGrant.storeId), eq(orderLine.orderId, digitalGrant.orderId), eq(orderLine.variantId, digitalGrant.variantId)))
      .where(and(eq(digitalGrant.storeId, ref.storeId), eq(digitalGrant.orderId, ref.orderId)))
      .orderBy(asc(digitalGrant.id));
    if (rows.length === 0) return { storeSuspended: false, rateLimited: false, grants: [] };

    const activeProductIds = [
      ...new Set(rows.filter((r) => r.state === "active" && (r.expiresAt === null || r.expiresAt > now)).map((r) => r.productId)),
    ];
    const itemsByProduct = new Map<number, ResolvedAccessLink[]>();
    const noteByProduct = new Map<number, string>();
    if (activeProductIds.length > 0) {
      const items = await tx
        .select({ id: productAccessItem.id, productId: productAccessItem.productId, label: productAccessItem.label, url: productAccessItem.url })
        .from(productAccessItem)
        .where(and(eq(productAccessItem.storeId, ref.storeId), inArray(productAccessItem.productId, activeProductIds)))
        .orderBy(asc(productAccessItem.position), asc(productAccessItem.id));
      for (const it of items) {
        const list = itemsByProduct.get(it.productId) ?? [];
        list.push({ id: it.id, label: it.label, host: hostOf(it.url), url: it.url });
        itemsByProduct.set(it.productId, list);
      }
      const notes = await tx
        .select({ productId: productAccessNote.productId, note: productAccessNote.note })
        .from(productAccessNote)
        .where(and(eq(productAccessNote.storeId, ref.storeId), inArray(productAccessNote.productId, activeProductIds)));
      for (const n of notes) noteByProduct.set(n.productId, n.note);
    }

    const grants: ResolvedDigitalGrant[] = rows.map((r) => {
      const expired = r.expiresAt !== null && r.expiresAt <= now;
      const active = r.state === "active" && !expired;
      return {
        id: r.id,
        productTitle: r.productTitle,
        variantTitle: r.variantTitle,
        state: r.state,
        expired,
        active,
        isTest: r.isTest,
        expiresAt: r.expiresAt,
        grantedAt: r.grantedAt,
        links: active ? (itemsByProduct.get(r.productId) ?? []) : [],
        note: active ? (noteByProduct.get(r.productId) ?? null) : null,
      };
    });
    return { storeSuspended: false, rateLimited: false, grants };
  });
}

// ── Seller Admin grant management (SC-13) ──────────────────────────────────────────────────

/** Seller Admin (SC-13): list digital grants of one order (metadata only; never returns links to unauthorized callers). */
export async function sellerOrderDigitalGrants(scope: SellerScope, orderId: number) {
  requireCap(scope, "orders.read");
  return inStore(scope, async ({ exec: tx }) =>
    tx
      .select({
        id: digitalGrant.id,
        productTitle: orderLine.productTitle,
        variantTitle: orderLine.variantTitle,
        state: digitalGrant.state,
        expiresAt: digitalGrant.expiresAt,
        isTest: digitalGrant.isTest,
        grantedAt: digitalGrant.grantedAt,
        revokedAt: digitalGrant.revokedAt,
        revokedReason: digitalGrant.revokedReason,
      })
      .from(digitalGrant)
      .innerJoin(orderLine, and(eq(orderLine.storeId, digitalGrant.storeId), eq(orderLine.orderId, digitalGrant.orderId), eq(orderLine.variantId, digitalGrant.variantId)))
      .where(and(eq(digitalGrant.storeId, scope.storeId), eq(digitalGrant.orderId, orderId)))
      .orderBy(asc(digitalGrant.id)),
  );
}

const extendGrantInput = z.strictObject({
  /** Positive days from now (or null to clear expiry / make permanent). Rejects booleans explicitly. */
  days: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : typeof v === "boolean" ? Number.NaN : v),
    z.coerce.number().int().min(1, "Minimal 1 hari.").max(3650, "Maksimal 3650 hari.").nullable(),
  ),
  reason: z.string().trim().min(5, "Alasan minimal 5 karakter.").max(500),
});

/** Seller Admin (SC-13): extend or clear the expiry of an active grant, audited. */
export async function extendDigitalGrant(scope: SellerScope, grantId: number, raw: unknown): Promise<{ expiresAt: Date | null }> {
  requireCap(scope, "orders.fulfill");
  const input = extendGrantInput.parse(raw);
  return inStore(scope, async ({ exec: tx }) => {
    const [g] = await tx
      .select({ id: digitalGrant.id, orderId: digitalGrant.orderId, state: digitalGrant.state, expiresAt: digitalGrant.expiresAt })
      .from(digitalGrant)
      .where(and(eq(digitalGrant.storeId, scope.storeId), eq(digitalGrant.id, grantId)))
      .for("update");
    if (!g) throw new DomainError("not_found", "Akses digital tidak ditemukan.");
    if (g.state !== "active") throw new DomainError("grant_revoked", "Akses yang sudah dicabut tidak dapat diperpanjang.");
    const base = g.expiresAt && g.expiresAt > new Date() ? g.expiresAt : new Date();
    const nextExpiry = input.days === null ? null : new Date(base.getTime() + input.days * 86_400_000);
    await tx.update(digitalGrant).set({ expiresAt: nextExpiry, updatedAt: new Date() }).where(and(eq(digitalGrant.storeId, scope.storeId), eq(digitalGrant.id, grantId)));
    await tx.insert(auditLog).values({
      storeId: scope.storeId,
      actorUserId: scope.userId,
      actorCapability: "orders.fulfill",
      action: "digital.grant.extend",
      subjectKind: "order",
      subjectId: String(g.orderId),
      accessLevel: "write",
      outcome: "allowed",
      reason: `grant=${grantId}; days=${input.days ?? "none"}; ${input.reason}`.slice(0, 500),
    });
    return { expiresAt: nextExpiry };
  });
}

const revokeGrantInput = z.strictObject({
  reason: z.string().trim().min(5, "Alasan pencabutan minimal 5 karakter.").max(500),
});

/** Seller Admin (SC-13): revoke one digital grant with a reason, audited. */
export async function revokeDigitalGrant(scope: SellerScope, grantId: number, raw: unknown): Promise<void> {
  requireCap(scope, "orders.fulfill");
  const input = revokeGrantInput.parse(raw);
  await inStore(scope, async ({ exec: tx }) => {
    const [g] = await tx
      .select({ id: digitalGrant.id, orderId: digitalGrant.orderId, state: digitalGrant.state })
      .from(digitalGrant)
      .where(and(eq(digitalGrant.storeId, scope.storeId), eq(digitalGrant.id, grantId)))
      .for("update");
    if (!g) throw new DomainError("not_found", "Akses digital tidak ditemukan.");
    if (g.state === "revoked") return;
    await tx
      .update(digitalGrant)
      .set({ state: "revoked", revokedAt: new Date(), revokedBy: scope.userId, revokedReason: input.reason, updatedAt: new Date() })
      .where(and(eq(digitalGrant.storeId, scope.storeId), eq(digitalGrant.id, grantId)));
    await tx.insert(auditLog).values({
      storeId: scope.storeId,
      actorUserId: scope.userId,
      actorCapability: "orders.fulfill",
      action: "digital.grant.revoke",
      subjectKind: "order",
      subjectId: String(g.orderId),
      accessLevel: "write",
      outcome: "allowed",
      reason: `grant=${grantId}; ${input.reason}`.slice(0, 500),
    });
  });
}
