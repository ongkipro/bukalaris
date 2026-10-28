import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DEMO_STORES } from "../src/demo/data.ts";
import { seedDemo } from "../src/demo/seed-demo.ts";
import { placeOrder } from "../src/seller/commerce/checkout.ts";
import { runOnce } from "../src/ops/jobs/jobs.ts";
import { transitionOrder } from "../src/seller/commerce/orders.ts";
import { BUYER_DATA_INVENTORY, exportBuyerData, REDACTED, redactOrders, redactStaleOrders } from "../src/seller/commerce/privacy.ts";
import { bookShipment, refreshTracking, setBookingAdapter, type BookingAdapter, type TrackingEvent, type TrackingResult } from "../src/shipping/fulfillment.ts";
import { order, orderRedaction, shipment } from "../src/schema.ts";
import { withStore } from "../src/platform/tenant.ts";
import { purchasePayload } from "../src/storefront/signals.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { deliver } from "./deliver.ts";
import { admin, buyer, db, makeStore, platform } from "./helpers.ts";

// T-47 (PR-4, SEC-19, PRIV-1, PRIV-4, TEN-1, TEN-3): shipment privacy (inventory, export, redaction), the signal redaction guard and the wave-4 demo seed.
// Services run as bukalaris_app in the store's RLS context; provider calls go to a scripted adapter, nothing reaches a network.

type Store = Awaited<ReturnType<typeof makeStore>>;
const PHONE = "081234567890";
afterEach(() => setBookingAdapter(null));

const DESC_1 = "Paket diterima oleh BUDI SANTOSO, Jl. Merdeka No. 1 Bandung";
const DESC_2 = "Kurir menghubungi 081234567890 (Budi)";
const trackAt = ["07-10-2026 10:00", "07-10-2026 15:30"];
function scripted(history: TrackingEvent[], providerStatus = "ON DELIVERY"): BookingAdapter {
  return {
    async createOrder(input) {
      return { providerOrderId: `MGT-${input.orderId}`, providerBatchId: `B-${input.orderId}`, trackingNumber: `RESI-${input.orderId}`, paid: true, providerStatus: "PENDING PICKUP" };
    },
    async payUnpaid() {},
    async track(): Promise<TrackingResult> {
      return { trackingNumber: null, providerStatus, paid: null, history };
    },
  };
}
const history = (): TrackingEvent[] => [
  { at: trackAt[0]!, desc: DESC_1 },
  { at: trackAt[1]!, desc: DESC_2 },
];

/** An order with a booked, tracked shipment (transfer order paid by the seller, booked and read through the worker). */
async function shippedOrder(s: Store, over: Record<string, unknown> = {}, adapter: BookingAdapter = scripted(history())) {
  setBookingAdapter(adapter);
  const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 2 }, "add");
  const { orderId } = await placeOrder(db, cartId, buyer({ paymentMethod: "manual_transfer", buyerEmail: "budi@example.com", buyerPhone: PHONE, ...over }));
  await runOnce(platform, { workerId: "setup" });
  await transitionOrder(s.owner, orderId, "pay");
  await bookShipment(s.owner, orderId);
  await runOnce(platform, { workerId: "book" });
  await refreshTracking(s.owner, orderId);
  await runOnce(platform, { workerId: "track" });
  return orderId;
}
const shipmentOf = async (orderId: number) => (await platform.select().from(shipment).where(eq(shipment.orderId, orderId)))[0]!;
const setError = (orderId: number, message: string) => admin.execute(sql`update shipment set last_error = ${message} where order_id = ${orderId}`);

// The columns of `shipment` that are structural (ids, codes, amounts, state), never provider free text. Anything else of type text or jsonb must be in the inventory.
const STRUCTURAL_SHIPMENT_COLUMNS: Record<string, true> = { requested_by: true, status: true, courier_code: true, origin_area_id: true, destination_area_id: true, provider_order_id: true, provider_batch_id: true, tracking_number: true };
function missingFreeTextShipmentColumns(inventory: readonly { table: string; column: string }[]) {
  const listed = new Set(inventory.filter((e) => e.table === "shipment").map((e) => e.column));
  return Object.values(getTableColumns(shipment))
    .filter((c) => (c.dataType === "string" || c.dataType === "json") && !(c.name in STRUCTURAL_SHIPMENT_COLUMNS))
    .map((c) => c.name)
    .filter((name) => !listed.has(name));
}

describe("inventory (PRIV-1): shipment free text", () => {
  it("every free-text shipment column is in BUYER_DATA_INVENTORY with a redaction handling, and the check fails when one is missing", () => {
    expect(missingFreeTextShipmentColumns(BUYER_DATA_INVENTORY)).toEqual([]);
    expect(BUYER_DATA_INVENTORY.filter((e) => e.table === "shipment").map((e) => [e.column, e.handling])).toEqual([
      ["tracking_history", "strip"],
      ["provider_status", "strip"],
      ["last_error", "redact"],
    ]);
    // the guard itself: drop each entry and it must report exactly that column
    for (const column of ["tracking_history", "provider_status", "last_error"]) {
      expect(missingFreeTextShipmentColumns(BUYER_DATA_INVENTORY.filter((e) => !(e.table === "shipment" && e.column === column)))).toEqual([column]);
    }
    expect(missingFreeTextShipmentColumns([])).toEqual(["provider_status", "tracking_history", "last_error"]);
  });
  it("the inventory documents each shipment column in 13-COMPLIANCE-PRIVACY.md", () => {
    const doc = readFileSync(fileURLToPath(new URL("../../../docs/13-COMPLIANCE-PRIVACY.md", import.meta.url)), "utf8");
    for (const c of ["tracking_history", "provider_status", "last_error"]) expect(doc).toContain(`\`shipment.${c}\``);
  });
});

describe("buyer export includes the shipment (T-47)", () => {
  it("carries status, resi, amounts, provider status, tracking history and last_error, and no provider internals", async () => {
    const s = await makeStore("t47-exp");
    const id = await shippedOrder(s);
    await setError(id, "Kurir: alamat Jl. Merdeka tidak ditemukan");
    const out = await exportBuyerData(s.owner, PHONE);
    const ship = out.orders.find((o) => o.id === id)!.shipment!;
    expect(ship).toMatchObject({
      status: "in_transit",
      courierCode: "JNE",
      trackingNumber: `RESI-${id}`,
      codAmount: 0,
      providerStatus: "ON DELIVERY",
      trackingHistory: history(),
      lastError: "Kurir: alamat Jl. Merdeka tidak ditemukan",
      paid: true,
    });
    expect(ship.bookedAt).toBeInstanceOf(Date);
    expect(ship).not.toHaveProperty("providerOrderId");
    expect(ship).not.toHaveProperty("providerBatchId");
    expect(ship).not.toHaveProperty("requestedBy");
    // an order without a shipment says so explicitly
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const plain = await placeOrder(db, cartId, buyer({ buyerPhone: PHONE }));
    const again = await exportBuyerData(s.owner, PHONE);
    expect(again.orders.find((o) => o.id === plain.orderId)!.shipment).toBeNull();
  });
});

describe("redaction strips provider free text and keeps codes, timestamps, resi and amounts (T-47)", () => {
  it("strips descriptions and last_error, keeps status codes, `at`, resi, courier and amounts; a second run changes nothing", async () => {
    const s = await makeStore("t47-red");
    const id = await shippedOrder(s);
    await setError(id, `Booking gagal untuk ${PHONE}: Budi Santoso`);
    await deliver(s.storeId, id); // the courier writer completes the order: no override needed
    const before = await shipmentOf(id);
    const orderBefore = (await platform.select().from(order).where(eq(order.id, id)))[0]!;
    const counts = await redactOrders(s.owner, { orderIds: [id] });
    expect(counts.shipments).toBe(1);
    const after = await shipmentOf(id);

    expect(after.trackingHistory).toEqual([
      { at: trackAt[0], desc: REDACTED },
      { at: trackAt[1], desc: REDACTED },
    ]);
    expect(after.lastError).toBe(REDACTED);
    const kept = (x: typeof before) => [x.status, x.providerStatus, x.trackingNumber, x.courierCode, x.codAmount, x.weightKg, x.paid, x.bookedAt, x.deliveredAt, x.lastTrackedAt, x.createdAt, x.originAreaId, x.destinationAreaId, x.providerOrderId, x.bookingAttempts, x.manualPolls];
    expect(kept(after)).toEqual(kept(before));
    expect(after.trackingHistory.map((h) => h.at)).toEqual(before.trackingHistory.map((h) => h.at));
    const orderAfter = (await platform.select().from(order).where(eq(order.id, id)))[0]!;
    expect([orderAfter.subtotal, orderAfter.shippingFee, orderAfter.total, orderAfter.trackingNumber, orderAfter.status]).toEqual([orderBefore.subtotal, orderBefore.shippingFee, orderBefore.total, orderBefore.trackingNumber, orderBefore.status]);
    expect(JSON.stringify(await platform.select().from(shipment).where(eq(shipment.orderId, id)))).not.toMatch(/BUDI|Budi|Merdeka|081234567890/);
    // idempotent
    expect(await redactOrders(s.owner, { orderIds: [id] })).toMatchObject({ orders: 0, shipments: 0, skipped: 1 });
    expect(await shipmentOf(id)).toEqual(after);
  });

  it("provider_status stays while it is an upper-case status code and is replaced when it is free text", async () => {
    const s = await makeStore("t47-code");
    const a = await shippedOrder(s);
    const b = await shippedOrder(s, { buyerPhone: "089900001111" }, scripted(history(), "Diterima oleh Budi Santoso"));
    expect([(await shipmentOf(a)).providerStatus, (await shipmentOf(b)).providerStatus]).toEqual(["ON DELIVERY", "Diterima oleh Budi Santoso"]);
    for (const id of [a, b]) await deliver(s.storeId, id);
    await redactOrders(s.owner, { orderIds: [a, b] });
    expect([(await shipmentOf(a)).providerStatus, (await shipmentOf(b)).providerStatus]).toEqual(["ON DELIVERY", REDACTED]);
  });

  it("an order redacted with an override and polled again stores its new provider text already stripped", async () => {
    const s = await makeStore("t47-poll");
    const id = await shippedOrder(s);
    expect((await orderOf(id)).status).toBe("shipped");
    await redactOrders(s.owner, { orderIds: [id], override: true, reason: "Permintaan pembeli lewat WhatsApp" });
    expect((await shipmentOf(id)).trackingHistory.every((h) => h.desc === REDACTED)).toBe(true);
    // Wave 5 review: the provider's STATUS text can carry a name too ("Diterima oleh Budi"): it is replaced on a redacted order, not only the timeline.
    setBookingAdapter(scripted([...history(), { at: "08-10-2026 09:00", desc: "Paket dibawa kurir Agus ke rumah Budi" }], "Diterima oleh Budi Santoso"));
    await refreshTracking(s.owner, id);
    await runOnce(platform, { workerId: "track-2" });
    const polled = await shipmentOf(id);
    expect(polled.providerStatus).toBe(REDACTED);
    expect(polled.trackingHistory.map((h) => h.at)).toEqual([...trackAt, "08-10-2026 09:00"]); // the new line and its timestamp arrive
    expect(polled.trackingHistory.every((h) => h.desc === REDACTED)).toBe(true);
  });

  it("the retention job strips shipments with the same function", async () => {
    const s = await makeStore("t47-ret");
    const id = await shippedOrder(s);
    await deliver(s.storeId, id);
    await admin.execute(sql`update "order" set updated_at = now() - interval '40 days' where id = ${id}`);
    const out = await redactStaleOrders(platform, { days: 30 });
    expect(out.counts.shipments).toBe(1);
    expect((await shipmentOf(id)).trackingHistory.every((h) => h.desc === REDACTED)).toBe(true);
    expect(await platform.select().from(orderRedaction).where(eq(orderRedaction.orderId, id))).toHaveLength(1);
  });
});

const orderOf = async (id: number) => (await platform.select().from(order).where(eq(order.id, id)))[0]!;

describe("store A cannot export or redact store B's shipment rows under the RLS role (TEN-1, TEN-3)", () => {
  it("export by A never returns B's shipment, redaction of B's order is not found, and SQL under A's context sees and changes no B shipment row", async () => {
    const a = await makeStore("t47-a");
    const b = await makeStore("t47-b");
    const idA = await shippedOrder(a);
    const idB = await shippedOrder(b);
    const exported = await exportBuyerData(a.owner, PHONE);
    expect(exported.orders.map((o) => o.id)).toEqual([idA]); // the same phone is B's buyer too: only A's order and shipment appear
    expect(JSON.stringify(exported)).not.toContain(`RESI-${idB}`);
    await expect(redactOrders(a.owner, { orderIds: [idB] })).rejects.toMatchObject({ code: "not_found" });
    await withStore(db, a.storeId, async (tx) => {
      expect((await tx.select().from(shipment).where(eq(shipment.orderId, idB))).length).toBe(0);
      expect(await tx.update(shipment).set({ lastError: REDACTED }).where(eq(shipment.orderId, idB)).returning({ id: shipment.id })).toEqual([]);
    });
    expect((await shipmentOf(idB)).trackingHistory.map((h) => h.desc)).toEqual([DESC_1, DESC_2]);
    expect((await exportBuyerData(b.owner, PHONE)).orders.map((o) => o.id)).toEqual([idB]);
    // outside any store context the app role sees no shipment at all
    expect(await db.select().from(shipment)).toEqual([]);
    expect(await db.select().from(shipment).where(and(eq(shipment.storeId, a.storeId)))).toEqual([]);
  });
});

describe("purchasePayload skips the redaction placeholder (T-47)", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const GOLDEN = {
    fn: "24263bfaefb124c488c2f5e63d1d30b418f51d0d6f5b380aa1956ec40ea57278", // sha256("budi")
    ln: "884ace7632428d815f546c2b854dbfdc0d89f5a0d348444d6237e2dc404892f8", // sha256("santoso")
    ph62: "dd752605096029a73495a91862983963e1947a834a4300808074185af10bb725", // sha256("6281234567890")
    phE164: "62397bbd6a8c9ae53bc914a6017300eb6b13af5be20e4cc9ad2dc3d61ecb24cd", // sha256("+6281234567890")
  };
  const payloadOf = (storeId: number, id: number) => withStore(platform, storeId, (tx) => purchasePayload(tx, storeId, id));
  async function open(s: Store, over: Record<string, unknown> = {}) {
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    return (await placeOrder(db, cartId, buyer({ buyerPhone: PHONE, ...over }))).orderId;
  }

  it("an unredacted order keeps its golden hashed fields; the same order redacted with an override has no hashed field at all, and no hash of the placeholder", async () => {
    const s = await makeStore("t47-sig");
    const id = await open(s);
    const before = (await payloadOf(s.storeId, id))!;
    expect(before.user).toMatchObject(GOLDEN);
    expect(sha("budi")).toBe(GOLDEN.fn);
    await redactOrders(s.owner, { orderIds: [id], override: true, reason: "Permintaan pembeli lewat WhatsApp" });
    const after = (await payloadOf(s.storeId, id))!;
    expect(after.user).toEqual({}); // no click context either: redaction deleted it
    for (const k of ["fn", "ln", "ph62", "phE164", "em"]) expect(after.user).not.toHaveProperty(k);
    expect(JSON.stringify(after)).not.toContain(sha("dihapus"));
    expect(JSON.stringify(after)).not.toContain(sha("62dihapus"));
    // money and contents of the event are untouched
    expect(after).toMatchObject({ value: before.value, orderId: before.orderId, contents: before.contents, numItems: before.numItems });
  });

  it("only the placeholder is skipped: a real name with a redacted phone keeps its name hashes, and vice versa; a different order of the same store is unaffected", async () => {
    const s = await makeStore("t47-sig2");
    const half = await open(s, { buyerPhone: "089900001111" });
    const other = await open(s);
    await admin.execute(sql`update "order" set buyer_phone = ${REDACTED} where id = ${half}`);
    const p = (await payloadOf(s.storeId, half))!;
    expect(p.user).toMatchObject({ fn: GOLDEN.fn, ln: GOLDEN.ln });
    expect(p.user).not.toHaveProperty("ph62");
    expect(p.user).not.toHaveProperty("phE164");
    await admin.execute(sql`update "order" set buyer_phone = ${PHONE}, buyer_name = ${REDACTED} where id = ${half}`);
    const q = (await payloadOf(s.storeId, half))!;
    expect(q.user).toMatchObject({ ph62: GOLDEN.ph62, phE164: GOLDEN.phE164 });
    expect(q.user).not.toHaveProperty("fn");
    expect(q.user).not.toHaveProperty("ln");
    expect((await payloadOf(s.storeId, other))!.user).toMatchObject(GOLDEN);
  });
});

describe(".env.example documents the shipping and retention variables (T-47)", () => {
  const text = readFileSync(fileURLToPath(new URL("../../../.env.example", import.meta.url)), "utf8");
  it.each(["MENGANTAR_PICKUP_ADDRESS_ID", "MENGANTAR_PICKUP_TIME_ID", "ALLOW_COD_BOOKING", "BUYER_DATA_RETENTION_DAYS", "KEYRING_CHECKOUT_RESUME"])("%s is listed (a commented placeholder or a dev value)", (name) => {
    expect(text).toMatch(new RegExp(`^(# )?${name}=`, "m"));
  });
  it("lists no real secret: the only uncommented new value is the dev placeholder ring", () => {
    const live = text.split("\n").filter((l) => /^(MENGANTAR_PICKUP|ALLOW_COD|BUYER_DATA_RETENTION)/.test(l));
    expect(live).toEqual([]); // each of the four is commented out: unset locally means the fake courier and no retention
    expect(text).toMatch(/^KEYRING_CHECKOUT_RESUME=r1:[A-Za-z0-9+/]{43}=$/m);
  });
});

describe("demo seed (T-47)", () => {
  const stores = DEMO_STORES.slice(0, 2);
  let mediaDir: string | undefined;
  afterAll(async () => {
    if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
  });
  it("gives every demo store one published landing page, one booked fake shipment with tracking and one active feed token; a re-run is idempotent", async () => {
    mediaDir = await mkdtemp(join(tmpdir(), "bukalaris-t47-"));
    const first = await seedDemo(platform, { mediaDir, imageSize: 32, stores });
    expect(first.skipped).toBe(false);
    expect(first.counts).toMatchObject({ stores: 2, landingPages: 2, shipments: 2, feedTokens: 2, jobsFailed: 0 });
    for (const s of stores) {
      const q = async (table: string, extra = "") =>
        (await platform.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table} where store_id = (select id from store where slug = '${s.slug}') ${extra}`)))[0]!.n;
      expect(await q("landing_page", "and status = 'published' and published_revision_id is not null")).toBe(1);
      expect(await q("shipment", "and tracking_number is not null and booked_at is not null and status in ('booked', 'in_transit') and jsonb_array_length(tracking_history) >= 1")).toBe(1);
      expect(await q("feed_token", "and status = 'active'")).toBe(1);
    }
    const second = await seedDemo(platform, { mediaDir, imageSize: 32, stores });
    expect(second.skipped).toBe(true);
    expect(second.counts).toMatchObject({ landingPages: 2, shipments: 2, feedTokens: 2 });
    // --reset rebuilds with the same shape (the owner-side reset functions remove the evidence; the platform role is never given a delete)
    const third = await seedDemo(platform, { mediaDir, imageSize: 32, stores, reset: true, ownerDb: admin });
    expect(third.counts).toMatchObject({ stores: 2, landingPages: 2, shipments: 2, feedTokens: 2, jobsFailed: 0 });
  }, 240_000);
});
