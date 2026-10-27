import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq, getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it } from "vitest";
import { placeOrder } from "../src/seller/commerce/checkout.ts";
import { runOnce } from "../src/ops/jobs/jobs.ts";
import { transitionOrder } from "../src/seller/commerce/orders.ts";
import {
  BUYER_DATA_INVENTORY,
  exportBuyerData,
  findBuyerOrders,
  normalizeBuyerKey,
  PII_COLUMN_RE,
  REDACTED,
  redactOrders,
  redactStaleOrders,
  RETENTION_ACTOR,
  retentionDays,
} from "../src/seller/commerce/privacy.ts";
import * as schema from "../src/schema.ts";
import { auditLog, mailOutbox, membership, order, orderLine, orderNotification, orderRedaction, orderSignalContext, signalEvent } from "../src/schema.ts";
import { saveDestination } from "../src/storefront/signals.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { buyer, db, makeStore, makeUser, platform, seller } from "./helpers.ts";

// Buyer data export and redaction (T-43, SEC-19, PRIV-4). Every service call here runs as
// bukalaris_app inside the store's RLS context; `platform` only inspects rows across stores.

process.env.INTEGRATION_TOKEN_KEY ??= Buffer.alloc(32, 9).toString("base64");
// The shared truncate (helpers.ts) leaves the store-less dev outbox alone; order ids restart per
// test, so stale mails about "#1" from an earlier test would be matched here. Start empty.
beforeEach(() => platform.delete(mailOutbox));

type Store = Awaited<ReturnType<typeof makeStore>>;
const PHONE = "081234567890";
const EMAIL = "budi@example.com";
/** Click/IP context of a buyer request, as apps/web passes it from the checkout action. */
const request = { cookies: { _fbp: "fb.1.1700000000000.42" }, clientIp: "203.0.113.7", userAgent: "Mozilla/5.0 privacy-test" };

async function placed(s: Store, over: Record<string, unknown> = {}, withContext = false) {
  const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 2 }, "add");
  const { orderId } = await placeOrder(db, cartId, buyer({ buyerPhone: PHONE, ...over }), undefined, withContext ? { clientIp: request.clientIp, signal: request } : {});
  return orderId;
}
/** COD lifecycle to `completed` through the real transitions (history rows, notifications, Purchase signal). */
async function completed(s: Store, over: Record<string, unknown> = {}, withContext = false) {
  const id = await placed(s, over, withContext);
  for (const [action, input] of [["confirm", {}], ["process", {}], ["ship", { trackingNumber: "RESI-PRIV-1" }], ["complete", {}]] as const) await transitionOrder(s.owner, id, action, input);
  return id;
}
const orderRow = async (id: number) => (await platform.select().from(order).where(eq(order.id, id)))[0]!;
const audits = (storeId: number, action: string) =>
  platform
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.storeId, storeId), eq(auditLog.action, action)))
    .orderBy(auditLog.id);
const mailsFor = (id: number) =>
  platform
    .select({ to: mailOutbox.toEmail, subject: mailOutbox.subject, text: mailOutbox.textBody, html: mailOutbox.htmlBody })
    .from(mailOutbox)
    .where(sql`${mailOutbox.subject} ~ ${`#${id}([^0-9]|$)`}`)
    .orderBy(mailOutbox.id);

describe("inventory (PRIV-1)", () => {
  const doc = readFileSync(fileURLToPath(new URL("../../../docs/13-COMPLIANCE-PRIVACY.md", import.meta.url)), "utf8");
  const columns = (Object.values(schema) as unknown[])
    .filter((t): t is PgTable => is(t, PgTable))
    .flatMap((t) => Object.values(getTableColumns(t)).map((c) => `${getTableName(t)}.${c.name}`));

  it("every column named like buyer personal data is handled in BUYER_DATA_INVENTORY (a new phone/email/address/ip column fails here until it is)", () => {
    const handled = new Set(BUYER_DATA_INVENTORY.map((e) => `${e.table}.${e.column}`));
    const unhandled = columns.filter((c) => PII_COLUMN_RE.test(c.split(".")[1]!) && !handled.has(c));
    expect(unhandled, "add each to BUYER_DATA_INVENTORY and to docs/13-COMPLIANCE-PRIVACY.md").toEqual([]);
    expect(columns.length).toBeGreaterThan(100);
  });
  it("every inventory entry names a real column and is documented in 13-COMPLIANCE-PRIVACY.md", () => {
    const set = new Set(columns);
    for (const e of BUYER_DATA_INVENTORY) {
      expect(set.has(`${e.table}.${e.column}`), `${e.table}.${e.column} is not in the schema`).toBe(true);
      expect(doc, `${e.table}.${e.column} missing from the inventory table`).toContain(`\`${e.table}.${e.column}\``);
    }
    expect(new Set(BUYER_DATA_INVENTORY.map((e) => `${e.table}.${e.column}`)).size).toBe(BUYER_DATA_INVENTORY.length);
  });
});

describe("lookup key", () => {
  it("normalizes phone spellings to 0… digits and e-mails to lower case; rejects anything else", () => {
    for (const p of ["081234567890", "+62 812-3456-7890", "6281234567890", "(0812) 3456 7890"]) expect(normalizeBuyerKey(p), p).toEqual({ kind: "phone", value: "081234567890" });
    expect(normalizeBuyerKey("  Budi@Example.COM ")).toEqual({ kind: "email", value: "budi@example.com" });
    for (const bad of ["", "12", "budi", "budi@", "a@b", "0812abc"]) expect(() => normalizeBuyerKey(bad), bad).toThrow(/HP|email/);
  });
});

describe("export (PRIV-4 locate + hand over)", () => {
  it("returns every record of the buyer in this store only, by phone in any spelling or by e-mail; audited without the raw key", async () => {
    const a = await makeStore("priv-a");
    const b = await makeStore("priv-b");
    const withMail = await completed(a, { buyerEmail: EMAIL }, true);
    const plain = await placed(a, { buyerName: "Budi Kedua" });
    const other = await placed(a, { buyerPhone: "089900001111", buyerName: "Orang Lain" });
    const foreign = await placed(b, {});
    await runOnce(platform, { workerId: "W" }); // notifications → mail_outbox + order_notification

    const out = await exportBuyerData(a.owner, "+62 812 3456 7890");
    expect(out.store).toEqual({ id: a.storeId, slug: "priv-a", name: "Toko priv-a" });
    expect(out.query).toEqual({ kind: "phone", value: PHONE });
    expect(out.orders.map((o) => o.id)).toEqual([withMail, plain]);
    expect(out.orders.map((o) => o.id)).not.toContain(other);
    expect(out.orders.map((o) => o.id)).not.toContain(foreign);
    const first = out.orders[0]!;
    expect(first).toMatchObject({ buyerName: "Budi Santoso", buyerPhone: PHONE, buyerEmail: EMAIL, status: "completed", total: 200_000 + first.shippingFee });
    expect(first).not.toHaveProperty("requestHash");
    expect(first).not.toHaveProperty("idempotencyKey");
    expect(first).not.toHaveProperty("shippingMargin"); // seller-internal
    expect(first).not.toHaveProperty("shippingProviderCost");
    expect(first.lines).toEqual([expect.objectContaining({ quantity: 2, unitPrice: 100_000, lineTotal: 200_000 })]);
    expect(first.history.map((h) => h.toStatus)).toEqual(["placed", "processing", "shipped", "completed"]);
    expect(first.signalContext).toMatchObject({ fbp: "fb.1.1700000000000.42", clientIp: "203.0.113.7", userAgent: request.userAgent });
    expect(first.notifications.filter((n) => n.recipient === "buyer").map((n) => n.toEmail)).toEqual([EMAIL, EMAIL, EMAIL]); // created, confirmed, shipped
    expect(first.mails.length).toBe(3);
    expect(first.mails.every((m) => m.toEmail === EMAIL && m.textBody.includes(`#${withMail}`))).toBe(true);
    expect(out.orders[1]!.signalContext).toBeNull();
    expect(out.orders[1]!.mails).toEqual([]);

    const byMail = await exportBuyerData(a.owner, "Budi@Example.com");
    expect(byMail.orders.map((o) => o.id)).toEqual([withMail]);
    expect((await exportBuyerData(b.owner, PHONE)).orders.map((o) => o.id)).toEqual([foreign]);

    const log = await audits(a.storeId, "privacy.export");
    expect(log.length).toBe(2);
    expect(log[0]!.reason).toMatch(/^phone:[0-9a-f]{16} orders:/);
    expect(log[0]!.reason).toContain(String(withMail));
    expect(JSON.stringify(log)).not.toContain(PHONE);
    expect(JSON.stringify(log)).not.toContain(EMAIL);

    const found = await findBuyerOrders(a.owner, PHONE);
    expect(found.orders.map((o) => o.id)).toEqual([plain, withMail]);
    await expect(exportBuyerData(await seller(await staffOf(a), a.storeId), PHONE)).rejects.toThrow("Akses ditolak.");
  });
});

/** A staff member of the store (privacy.manage is owner-only). */
async function staffOf(s: Store) {
  const id = await makeUser("staff");
  await platform.insert(membership).values({ storeId: s.storeId, userId: id, role: "staff" });
  return id;
}

describe("redaction (SEC-19)", () => {
  it("replaces contact fields with the placeholder, deletes context, strips signal user blocks and mail bodies; amounts, lines, status and history stay", async () => {
    const s = await makeStore("priv-r");
    await saveDestination(s.owner, "meta", { pixelId: "123456789012345", token: "EAAB-fake-never-sent", enabled: true });
    const id = await completed(s, { buyerEmail: EMAIL }, true);
    const keep = await completed(s, { buyerPhone: "089900001111", buyerEmail: "lain@example.com" });
    await runOnce(platform, { workerId: "W" });
    const before = await orderRow(id);
    expect((await mailsFor(id)).length).toBeGreaterThanOrEqual(4); // 3 buyer mails + seller "created"
    const [ev] = await platform.select().from(signalEvent).where(eq(signalEvent.orderId, id));
    expect(ev!.payload).toHaveProperty("user");

    const counts = await redactOrders(s.owner, { orderIds: [String(id)] });
    expect(counts).toEqual({ orders: 1, signalContexts: 1, signalEvents: 1, notifications: 3, mails: 4, skipped: 0 });

    const after = await orderRow(id);
    expect(after).toMatchObject({ buyerName: REDACTED, buyerPhone: REDACTED, buyerEmail: null, shippingAddress: REDACTED });
    const money = (o: typeof before) => [o.status, o.subtotal, o.shippingFee, o.shippingProviderCost, o.shippingMargin, o.total, o.trackingNumber, o.courier, o.destinationAreaLabel, o.paymentMethod];
    expect(money(after)).toEqual(money(before));
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect((await platform.select().from(orderLine).where(eq(orderLine.orderId, id))).map((l) => l.lineTotal)).toEqual([200_000]);
    expect((await platform.select().from(orderSignalContext).where(eq(orderSignalContext.orderId, id))).length).toBe(0);
    const [evAfter] = await platform.select().from(signalEvent).where(eq(signalEvent.orderId, id));
    expect(evAfter!.payload).not.toHaveProperty("user");
    expect(evAfter!.payload).toMatchObject({ value: 200_000, orderId: String(id) });
    const mails = await mailsFor(id);
    expect(mails.every((m) => m.text === REDACTED && m.html === null)).toBe(true);
    expect(mails.filter((m) => m.to === REDACTED).length).toBe(3);
    expect(mails.filter((m) => m.to !== REDACTED).length).toBe(1); // the seller copy keeps the owner's address
    const notes = await platform.select().from(orderNotification).where(eq(orderNotification.orderId, id));
    expect(notes.filter((n) => n.recipient === "buyer").every((n) => n.toEmail === REDACTED)).toBe(true);
    expect(notes.find((n) => n.recipient === "seller")!.toEmail).not.toBe(REDACTED);
    expect(JSON.stringify(await platform.execute(sql`select * from "order" o join order_notification n on n.order_id = o.id where o.id = ${id}`))).not.toContain(EMAIL);

    // The other buyer's order is untouched.
    expect((await orderRow(keep)).buyerEmail).toBe("lain@example.com");
    expect((await mailsFor(keep)).every((m) => m.text !== REDACTED)).toBe(true);

    // Per-order record + batch audit with counts.
    expect(await platform.select().from(orderRedaction).where(eq(orderRedaction.orderId, id))).toEqual([
      expect.objectContaining({ storeId: s.storeId, actorUserId: s.ownerId, source: "seller", override: false, reason: null }),
    ]);
    const [log] = await audits(s.storeId, "privacy.redact");
    expect(JSON.parse(log!.reason!)).toEqual({ source: "seller", orderIds: [id], counts: { orders: 1, signalContexts: 1, signalEvents: 1, notifications: 3, mails: 4 }, override: false, reason: null });
    expect(log!.actorUserId).toBe(s.ownerId);
    expect((await findBuyerOrders(s.owner, PHONE)).orders).toEqual([]); // the phone is gone
  });

  it("is idempotent: a second run changes nothing and writes no audit row", async () => {
    const s = await makeStore("priv-i");
    const id = await completed(s);
    expect((await redactOrders(s.owner, { orderIds: [id] })).orders).toBe(1);
    const snapshot = await orderRow(id);
    expect(await redactOrders(s.owner, { orderIds: [id] })).toEqual({ orders: 0, signalContexts: 0, signalEvents: 0, notifications: 0, mails: 0, skipped: 1 });
    expect(await orderRow(id)).toEqual(snapshot);
    expect((await audits(s.storeId, "privacy.redact")).length).toBe(1);
    expect((await platform.select().from(orderRedaction).where(eq(orderRedaction.orderId, id))).length).toBe(1);
  });

  it("refuses orders that are not completed/cancelled unless the owner overrides with a reason; the override is recorded", async () => {
    const s = await makeStore("priv-o");
    const open = await placed(s);
    await transitionOrder(s.owner, open, "confirm");
    await expect(redactOrders(s.owner, { orderIds: [open] })).rejects.toMatchObject({ code: "order_open" });
    await expect(redactOrders(s.owner, { orderIds: [open], override: true })).rejects.toThrow("Isi alasan");
    await expect(redactOrders(s.owner, { orderIds: [open], override: true, reason: "abc" })).rejects.toThrow("Alasan minimal 5 karakter.");
    expect((await orderRow(open)).buyerName).toBe("Budi Santoso");
    expect((await redactOrders(s.owner, { orderIds: [open], override: true, reason: "Permintaan pembeli lewat WhatsApp" })).orders).toBe(1);
    expect((await orderRow(open)).status).toBe("placed"); // status untouched, only the contact fields
    expect(await platform.select().from(orderRedaction).where(eq(orderRedaction.orderId, open))).toEqual([
      expect.objectContaining({ override: true, reason: "Permintaan pembeli lewat WhatsApp", source: "seller" }),
    ]);
    // A cancelled order needs no override.
    const rejected = await placed(s, { buyerPhone: "089900001111" });
    await transitionOrder(s.owner, rejected, "reject", { reason: "uji penolakan" });
    expect((await redactOrders(s.owner, { orderIds: [rejected] })).orders).toBe(1);
  });

  it("stays inside the store and the owner role: another store's order is not found, staff is forbidden, bad ids are rejected", async () => {
    const a = await makeStore("priv-x");
    const b = await makeStore("priv-y");
    const id = await completed(b);
    await expect(redactOrders(a.owner, { orderIds: [id] })).rejects.toMatchObject({ code: "not_found" });
    await expect(redactOrders(await seller(await staffOf(b), b.storeId), { orderIds: [id] })).rejects.toThrow("Akses ditolak.");
    await expect(redactOrders(b.owner, { orderIds: [] })).rejects.toThrow("Pilih minimal satu pesanan.");
    await expect(redactOrders(b.owner, { orderIds: ["x"] })).rejects.toThrow();
    expect((await orderRow(id)).buyerName).toBe("Budi Santoso");
  });
});

describe("retention job (Q-11, disabled by default)", () => {
  it("BUYER_DATA_RETENTION_DAYS: unset or empty disables the job; a positive integer enables it; junk fails loudly", () => {
    expect(retentionDays({})).toBeNull();
    expect(retentionDays({ BUYER_DATA_RETENTION_DAYS: "" })).toBeNull();
    expect(retentionDays({ BUYER_DATA_RETENTION_DAYS: " 30 " })).toBe(30);
    for (const bad of ["0", "-1", "abc", "1.5"]) expect(() => retentionDays({ BUYER_DATA_RETENTION_DAYS: bad }), bad).toThrow(/integer >= 1/);
    expect(retentionDays({ ...process.env, BUYER_DATA_RETENTION_DAYS: undefined })).toBeNull();
  });

  it("redacts only closed orders older than the window, across stores, with the retention actor; runs again as a no-op", async () => {
    const a = await makeStore("priv-ra");
    const b = await makeStore("priv-rb");
    const oldClosed = await completed(a, { buyerEmail: EMAIL }, true);
    const oldOpen = await placed(a, { buyerPhone: "089900001111" });
    const recentClosed = await completed(a, { buyerPhone: "089900002222" });
    const oldForeign = await completed(b);
    const age = (id: number, days: number) => platform.update(order).set({ updatedAt: sql`now() - ${days} * interval '1 day'`, createdAt: sql`now() - ${days} * interval '1 day'` }).where(eq(order.id, id));
    await age(oldClosed, 40);
    await age(oldOpen, 40);
    await age(oldForeign, 31);
    await age(recentClosed, 29);

    const result = await redactStaleOrders(platform, { days: 30 });
    expect(result).toEqual({ stores: 2, orders: 2, counts: { orders: 2, signalContexts: 1, signalEvents: 0, notifications: 0, mails: 0 } });
    expect((await orderRow(oldClosed)).buyerName).toBe(REDACTED);
    expect((await orderRow(oldForeign)).buyerName).toBe(REDACTED);
    expect((await orderRow(oldOpen)).buyerName).toBe("Budi Santoso");
    expect((await orderRow(recentClosed)).buyerName).toBe("Budi Santoso");
    expect((await platform.select().from(orderRedaction).where(eq(orderRedaction.orderId, oldClosed)))[0]).toMatchObject({ actorUserId: RETENTION_ACTOR, source: "retention", override: false });
    const [logA] = await audits(a.storeId, "privacy.redact");
    expect(logA!.actorUserId).toBe(RETENTION_ACTOR);
    expect(JSON.parse(logA!.reason!)).toMatchObject({ source: "retention", orderIds: [oldClosed] });
    expect((await audits(b.storeId, "privacy.redact")).length).toBe(1);

    expect(await redactStaleOrders(platform, { days: 30 })).toEqual({ stores: 0, orders: 0, counts: { orders: 0, signalContexts: 0, signalEvents: 0, notifications: 0, mails: 0 } });
    await expect(redactStaleOrders(platform, { days: 0 })).rejects.toThrow(">= 1");
  });
});
