import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueSellerStepUp } from "../src/ledger/stepup.ts";
import { runOnce } from "../src/ops/jobs/jobs.ts";
import { renderMail } from "../src/ops/jobs/notify.ts";
import { addBankAccount, BANK_ACCOUNT_STEP_UP, confirmBankTransfer } from "../src/payments/bank-transfer.ts";
import { FakeProviderCheck, saveProviderKey, setProviderCheckTransport } from "../src/payments/provider-accounts.ts";
import { fakeProviders } from "../src/payments/providers.ts";
import { bindSession, type SellerScope } from "../src/platform/scoped.ts";
import { acceptSellerTerms } from "../src/platform/terms.ts";
import { savePromoHub } from "../src/promotions/manage.ts";
import { mailOutbox, media, order, product, variant } from "../src/schema.ts";
import { addVariant, createProduct, getProduct, updateProduct, updateVariant } from "../src/seller/commerce/catalog.ts";
import { addAccessLink } from "../src/seller/commerce/digital.ts";
import { checkoutPromotionPreview, checkoutSummary, placeOrder, searchDestinationAreas } from "../src/seller/commerce/checkout.ts";
import { applyProviderTransition, getOrder, transitionOrder } from "../src/seller/commerce/orders.ts";
import { redactOrders } from "../src/seller/commerce/privacy.ts";
import { bookShipment } from "../src/shipping/fulfillment.ts";
import { formatShippingQuote, saveCourierRules } from "../src/shipping/rules.ts";
import { parcelWeightKg, setPickupAddress, shippingOptions } from "../src/shipping/shipping.ts";
import { confirmDedicatedAccount } from "../src/shipping/sync.ts";
import { feedItems, feedSettings } from "../src/storefront/feeds.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { admin, db, DESTINATION, makeStore, platform } from "./helpers.ts";
import { sessionOf } from "./t37-fixtures.ts";

// T-111 (PR-4, ADR-0016 sections 1-3, 5 and decisions 19-22):
// Product kind (`physical` | `digital`), digital variant weight/stock rules, activation readiness (decision 21),
// digital-only / mixed / physical-only checkout, COD refusal & e-mail requirement, physical-only shipping weight
// and free-shipping threshold, order lifecycle (digital completes on pay; mixed follows parcel), feed exclusion,
// e-mail/redaction without shipping block.

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code ?? String(e));
const pgCode = (p: Promise<unknown>) => p.then(() => "allowed", (e: { cause?: { code?: string }; code?: string }) => e.cause?.code ?? e.code);

beforeEach(() => setProviderCheckTransport(new FakeProviderCheck()));
afterEach(() => setProviderCheckTransport(null));

type Own = Awaited<ReturnType<typeof makeStore>> & { me: SellerScope };

async function digitalReadyStore(slug: string, opts: { withShipping?: boolean } = {}): Promise<Own> {
  const s = await makeStore(slug, { pickupArea: opts.withShipping !== false });
  const me = bindSession(s.owner, await sessionOf(s.ownerId));
  await acceptSellerTerms(me, { version: 1, agreed: true });
  await addBankAccount(me, { bankCode: "BCA", accountNumber: "1234567890", holderName: "Pemilik Digital", proofId: await issueSellerStepUp(me, BANK_ACCOUNT_STEP_UP) });
  if (opts.withShipping) {
    await saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: `CANARY-T111-${slug}-0123456789abcdef`, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar" }) });
    await confirmDedicatedAccount(me, { confirmed: true });
    await setPickupAddress(me, { addressText: "Jl. Braga No. 10, Bandung", contactName: "Budi Pemilik", contactPhone: "081234567890" });
    await saveCourierRules(me, { couriers: [{ courierCode: "JNE", enabled: true, codEnabled: true }] });
    await searchDestinationAreas("menteng", undefined, s.sf);
  }
  return { ...s, me };
}

const variantOf = async (productId: number) => (await admin.select().from(variant).where(eq(variant.productId, productId)))[0]!;
const orderOf = async (orderId: number) => (await admin.select().from(order).where(eq(order.id, orderId)))[0]!;
/** T-112 (ADR-0016 decision 3): create a digital product as draft, attach one access link, then activate. */
async function createActiveDigital(me: SellerScope, title: string, variantSpec: { title: string; price: number; stock: number; trackStock?: boolean }) {
  const id = await createProduct(me, { title, kind: "digital", status: "draft", variant: variantSpec });
  await addAccessLink(me, id, { label: "Unduh file", url: "https://drive.google.com/file/d/t111-fixture/view" });
  await updateProduct(me, id, { title, description: "", kind: "digital", status: "active", slug: null });
  return id;
}

describe("T-111 product kind, variant rules and activation readiness (ADR-0016 decisions 1, 2, 21)", () => {
  it("digital variants have no weight and unlimited stock by default; physical variants require weight and tracked stock in service and database", async () => {
    const s = await digitalReadyStore("t111-kind");
    const digId = await createActiveDigital(s.me, "E-Book Panduan", { title: "PDF", price: 50_000, stock: 0 });
    const dv = await variantOf(digId);
    expect(dv.weightGrams).toBeNull();
    expect(dv.trackStock).toBe(false);
    // Optional limited edition digital variant turns stock tracking on while keeping weight NULL.
    const limitedId = await addVariant(s.me, digId, { title: "Edisi Terbatas", price: 99_000, stock: 5, trackStock: true });
    const [lv] = await admin.select().from(variant).where(eq(variant.id, limitedId));
    expect(lv).toMatchObject({ weightGrams: null, trackStock: true, stock: 5 });

    // Physical product without weight is refused by service AND by database trigger.
    await expect(createProduct(s.me, { title: "Buku Cetak", kind: "physical", status: "draft", variant: { title: "Softcover", price: 80_000, stock: 3 } })).rejects.toMatchObject({ name: "ZodError" });
    expect(await pgCode(admin.execute(sql`update variant set weight_grams = null where id = ${s.variantId}`))).toBe("23514");
    expect(await pgCode(admin.execute(sql`update variant set track_stock = false where id = ${s.variantId}`))).toBe("23514");
    expect(await pgCode(admin.execute(sql`update variant set weight_grams = 500 where id = ${dv.id}`))).toBe("23514");

    // Unsold product can switch kind (physical -> digital clears weight & trackStock; digital -> physical requires defaultWeightGrams).
    const draftId = await createProduct(s.me, { title: "Template", kind: "physical", status: "draft", variant: { title: "A", price: 25_000, stock: 1, weightGrams: 200 } });
    await updateProduct(s.me, draftId, { title: "Template", description: "", kind: "digital", status: "draft", slug: null });
    expect(await variantOf(draftId)).toMatchObject({ weightGrams: null, trackStock: false });
    expect(await code(updateProduct(s.me, draftId, { title: "Template", description: "", kind: "physical", status: "draft", slug: null }))).toBe("weight_required");
    await updateProduct(s.me, draftId, { title: "Template", description: "", kind: "physical", status: "draft", slug: null, defaultWeightGrams: 300 });
    expect(await variantOf(draftId)).toMatchObject({ weightGrams: 300, trackStock: true });
  });

  it("activation follows ADR-0016 decision 21: digital needs a ready prepaid method, physical on a seller-owned store needs ready shipping", async () => {
    const bare = await makeStore("t111-bare", { pickupArea: false });
    const bareMe = bindSession(bare.owner, await sessionOf(bare.ownerId));
    // Digital product cannot be activated without a ready prepaid method (AutoLaris or bank transfer).
    expect(await code(createProduct(bareMe, { title: "Kursus PDF", kind: "digital", status: "active", variant: { title: "Akses", price: 50_000, stock: 0 } }))).toBe("prepaid_not_ready");
    const draftDig = await createProduct(bareMe, { title: "Kursus PDF", kind: "digital", status: "draft", variant: { title: "Akses", price: 50_000, stock: 0 } });
    expect(await code(updateProduct(bareMe, draftDig, { title: "Kursus PDF", description: "", kind: "digital", status: "active", slug: null }))).toBe("prepaid_not_ready");

    // Adding a bank account makes the store seller_owned with prepaid ready, NO shipping yet -> digital activates (once delivery content is added), physical is blocked!
    await acceptSellerTerms(bareMe, { version: 1, agreed: true });
    await addBankAccount(bareMe, { bankCode: "BCA", accountNumber: "5555666677", holderName: "Toko Digital", proofId: await issueSellerStepUp(bareMe, BANK_ACCOUNT_STEP_UP) });
    await addAccessLink(bareMe, draftDig, { label: "Unduh PDF", url: "https://drive.google.com/file/d/t111-bare/view" });
    await updateProduct(bareMe, draftDig, { title: "Kursus PDF", description: "", kind: "digital", status: "active", slug: null });
    expect(await code(createProduct(bareMe, { title: "Kaos Fisik", kind: "physical", status: "active", variant: { title: "M", price: 100_000, stock: 5, weightGrams: 250 } }))).toBe("shipping_not_ready");
  });

  it("kind change is refused after a sale (service and database)", async () => {
    const s = await digitalReadyStore("t111-lock");
    const digId = await createActiveDigital(s.me, "Preset Foto", { title: "Pack", price: 40_000, stock: 0 });
    const dv = await variantOf(digId);
    const cartId = await setCartLine(s.sf, undefined, { variantId: dv.id, quantity: 1 }, "add");
    await placeOrder(db, cartId, {
      idempotencyKey: randomUUID(),
      buyerName: "Pembeli Digital",
      buyerPhone: "081211112222",
      buyerEmail: "pembeli@example.com",
      paymentMethod: "bank_transfer",
    }, fakeProviders);
    expect((await getProduct(s.me, digId))?.kindLocked).toBe(true);
    // Review fix (Part 1 #1): editing a sold digital product without resending `kind` keeps it digital and succeeds.
    await updateProduct(s.me, digId, { title: "Preset Foto v2", description: "Update", status: "active", slug: null });
    expect((await getProduct(s.me, digId))?.kind).toBe("digital");
    expect(await code(updateProduct(s.me, digId, { title: "Preset Foto", description: "", kind: "physical", status: "active", slug: null, defaultWeightGrams: 100 }))).toBe("product_kind_locked");
    expect(await pgCode(admin.execute(sql`update product set kind = 'physical' where id = ${digId}`))).toBe("23514");
    // Review fix (Part 2 #1 & #2): DB guards refuse moving a digital-only order to `placed` (both bank-transfer guard and order_status_guard) and refuse re-parenting a physical variant under a digital product.
    const [digOrder] = await admin.select({ id: order.id }).from(order).where(eq(order.storeId, s.storeId));
    expect(await pgCode(admin.execute(sql`update "order" set status = 'placed' where id = ${digOrder!.id}`))).toBe("42501");
    await admin.execute(sql`insert into bank_transfer_confirmation (store_id, order_id, confirmed_by, reason) values (${s.storeId}, ${digOrder!.id}, ${s.ownerId}, 'uji guard status')`);
    expect(await pgCode(admin.execute(sql`update "order" set status = 'placed' where id = ${digOrder!.id}`))).toBe("23514");
    expect(await pgCode(admin.execute(sql`update variant set product_id = ${digId} where id = ${s.variantId}`))).toBe("23514");
    // Review fix (Part 1 #5): INSERT of a digital order with NULL email is refused even if buyer_name = '[dihapus]'.
    expect(await pgCode(admin.execute(sql`insert into "order" (store_id, cart_id, idempotency_key, request_hash, status, payment_method, buyer_name, buyer_phone, buyer_email, has_physical, has_digital, subtotal, total) values (${s.storeId}, gen_random_uuid(), ${randomUUID()}, 'h', 'awaiting_payment', 'bank_transfer', '[dihapus]', '081200000000', null, false, true, 10000, 10000)`))).toBe("23514");
  });
});

describe("T-111 checkout rules, lifecycle and feeds for digital-only and mixed orders", () => {
  it("digital-only order skips shipping, requires email, refuses COD, handles unlimited/counted stock, completes on payment, omits shipping from email and redacts cleanly", async () => {
    const s = await digitalReadyStore("t111-digonly", { withShipping: false });
    const digId = await createActiveDigital(s.me, "E-Book Bisnis", { title: "PDF", price: 75_000, stock: 0 });
    const dv = await variantOf(digId);
    const cartId = await setCartLine(s.sf, undefined, { variantId: dv.id, quantity: 2 }, "add");
    const summary = await checkoutSummary(db, cartId);
    expect(summary).toMatchObject({ hasPhysical: false, hasDigital: true, canShip: true, subtotal: 150_000 });

    // Refused without email and refused with COD (direct submit).
    expect(await code(placeOrder(db, cartId, { idempotencyKey: randomUUID(), buyerName: "Ani", buyerPhone: "081233334444", paymentMethod: "bank_transfer" }, fakeProviders))).toBe("email_required");
    expect(await code(placeOrder(db, cartId, { idempotencyKey: randomUUID(), buyerName: "Ani", buyerPhone: "081233334444", buyerEmail: "ani@example.com", paymentMethod: "cod" }, fakeProviders))).toBe("cod_unavailable_digital");

    // Valid digital-only order via bank transfer: no address/area/courier/shipping fee; stock stays 0 (unlimited).
    const { orderId } = await placeOrder(db, cartId, {
      idempotencyKey: randomUUID(),
      buyerName: "Ani Digital",
      buyerPhone: "081233334444",
      buyerEmail: "ani@example.com",
      paymentMethod: "bank_transfer",
    }, fakeProviders);
    const created = await orderOf(orderId);
    expect(created).toMatchObject({
      status: "awaiting_payment",
      hasPhysical: false,
      hasDigital: true,
      shippingAddress: null,
      courier: null,
      courierCode: null,
      originAreaId: null,
      destinationAreaId: null,
      weightKg: null,
      shippingFee: 0,
      subtotal: 150_000,
      total: 150_000,
    });
    expect((await variantOf(digId)).stock).toBe(0);
    // Cannot book a shipment or process/ship a digital-only order.
    expect(await code(bookShipment(s.me, orderId))).toBe("no_shipment");
    expect(await code(transitionOrder(s.me, orderId, "process"))).toBe("invalid_transition");

    // Paying (seller bank-transfer confirmation) moves digital-only order directly to `completed` (ADR-0016 section 5).
    await confirmBankTransfer(s.me, { orderId, reason: "Dana masuk di mutasi BCA" });
    const paid = await orderOf(orderId);
    expect(paid.status).toBe("completed");
    expect(paid.paidAt).not.toBeNull();
    expect(paid.trackingNumber).toBeNull();

    // Notifications omit shipping block ("Pengiriman:" and "Ongkir") for orders without a parcel.
    for (let i = 0; i < 4; i++) if ((await runOnce(platform, { workerId: "t111" })).length === 0) break;
    const mails = await admin.select({ text: mailOutbox.textBody, html: mailOutbox.htmlBody }).from(mailOutbox).where(eq(mailOutbox.toEmail, "ani@example.com"));
    expect(mails.length).toBeGreaterThan(0);
    for (const m of mails) {
      expect(m.text).not.toContain("Pengiriman:");
      expect(m.text).not.toContain("Ongkir ");
      expect(m.html).not.toContain("Pengiriman:");
    }
    // Redacting a closed digital-only order keeps shipping_address NULL and succeeds under DB CHECKs.
    expect((await redactOrders(s.me, { orderIds: [orderId] })).orders).toBe(1);
    const redacted = await orderOf(orderId);
    expect(redacted.shippingAddress).toBeNull();
    expect(redacted.buyerEmail).toBeNull();

    // Counted digital stock decrements at submit and restocks once on cancel.
    const limId = await addVariant(s.me, digId, { title: "VIP Seat", price: 100_000, stock: 3, trackStock: true });
    const c2 = await setCartLine(s.sf, undefined, { variantId: limId, quantity: 2 }, "add");
    const { orderId: o2 } = await placeOrder(db, c2, { idempotencyKey: randomUUID(), buyerName: "Budi", buyerPhone: "081255556666", buyerEmail: "budi@example.com", paymentMethod: "bank_transfer" }, fakeProviders);
    expect((await admin.select({ s: variant.stock }).from(variant).where(eq(variant.id, limId)))[0]!.s).toBe(1);
    await transitionOrder(s.me, o2, "cancel", { reason: "Pembeli membatalkan pesanan" });
    expect((await admin.select({ s: variant.stock }).from(variant).where(eq(variant.id, limId)))[0]!.s).toBe(3);
  });

  it("mixed order quotes shipping from physical lines only, refuses COD, ignores digital lines for free-shipping threshold, and follows the parcel to completed", async () => {
    const s = await digitalReadyStore("t111-mixed", { withShipping: true });
    // Physical product: 600 g, Rp 80.000; digital product: no weight, Rp 200.000.
    await updateVariant(s.me, s.variantId, { title: "Fisik 600g", price: 80_000, weightGrams: 600 });
    const digId = await createActiveDigital(s.me, "Bonus E-Book", { title: "PDF", price: 200_000, stock: 0 });
    const dv = await variantOf(digId);
    // Free-shipping threshold at Rp 150.000: physical subtotal (80k) is BELOW threshold even though combined subtotal is 280k!
    await savePromoHub(s.me, { enabled: true, title: "Promo", subtitle: "", bannerMediaId: null, bannerCtaLabel: "", bannerCtaHref: "", freeShipEnabled: true, freeShipThresholdIdr: 150_000, percentRounding: "floor", featuredCollectionIds: [] });

    // parcelWeightKg ignores digital lines even if a caller passes a bogus weight on a digital line.
    expect(parcelWeightKg([{ quantity: 1, weightGrams: 600, productKind: "physical" }, { quantity: 5, weightGrams: 2000, productKind: "digital" }])).toBe(1);

    let cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    cartId = await setCartLine(s.sf, cartId, { variantId: dv.id, quantity: 1 }, "add");
    const summary = await checkoutSummary(db, cartId);
    expect(summary).toMatchObject({ hasPhysical: true, hasDigital: true, subtotal: 280_000 });
    const quote = await shippingOptions(s.sf, DESTINATION.destinationAreaId, { lines: summary!.lines.filter((l) => l.productKind === "physical"), subtotal: summary!.subtotal });
    expect(quote.weightKg).toBe(1);

    // Direct COD submit with a digital line is refused (ADR-0016 decision 7).
    expect(await code(placeOrder(db, cartId, {
      idempotencyKey: randomUUID(),
      buyerName: "Citra",
      buyerPhone: "081277778888",
      buyerEmail: "citra@example.com",
      shippingAddress: "Jl. Menteng Raya No. 5, Jakarta",
      destinationAreaId: DESTINATION.destinationAreaId,
      destinationAreaLabel: DESTINATION.destinationAreaLabel,
      courier: "JNE",
      paymentMethod: "cod",
      shippingQuote: formatShippingQuote(quote.options),
    }, fakeProviders))).toBe("cod_unavailable_digital");

    // Promotion preview and submit: free-shipping threshold does NOT trigger (physical = 80k < 150k).
    const preview = await checkoutPromotionPreview(db, cartId, { buyerPhone: "081277778888", voucherCode: "", destinationAreaId: DESTINATION.destinationAreaId, courier: "JNE", paymentMethod: "bank_transfer" });
    expect(preview.shippingDiscount).toBe(0);

    const { orderId } = await placeOrder(db, cartId, {
      idempotencyKey: randomUUID(),
      buyerName: "Citra Campuran",
      buyerPhone: "081277778888",
      buyerEmail: "citra@example.com",
      shippingAddress: "Jl. Menteng Raya No. 5, Jakarta",
      destinationAreaId: DESTINATION.destinationAreaId,
      destinationAreaLabel: DESTINATION.destinationAreaLabel,
      courier: "JNE",
      paymentMethod: "bank_transfer",
      shippingQuote: formatShippingQuote(quote.options),
    }, fakeProviders);
    const o = await orderOf(orderId);
    expect(o).toMatchObject({ hasPhysical: true, hasDigital: true, weightKg: 1, shippingDiscount: 0, status: "awaiting_payment" });
    expect(o.shippingFee).toBeGreaterThan(0);

    // Paying a mixed order moves it to `placed` (NOT `completed`!), and it follows the parcel to `completed`.
    await confirmBankTransfer(s.me, { orderId, reason: "Dana masuk" });
    expect((await orderOf(orderId)).status).toBe("placed");
    const detail = await getOrder(s.me, orderId);
    expect(detail?.actions).toContain("process");
    await transitionOrder(s.me, orderId, "process");
    await transitionOrder(s.me, orderId, "ship", { trackingNumber: "JNE-MIX-001" });
    expect((await orderOf(orderId)).status).toBe("shipped");
    await applyProviderTransition(platform, s.storeId, orderId, "completed", { source: "provider", note: "Terkirim" });
    expect((await orderOf(orderId)).status).toBe("completed");

    // When physical lines alone reach the threshold (2 × 80k = 160k >= 150k), free shipping DOES trigger.
    let c2 = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 2 }, "add");
    c2 = await setCartLine(s.sf, c2, { variantId: dv.id, quantity: 1 }, "add");
    const p2 = await checkoutPromotionPreview(db, c2, { buyerPhone: "081277779999", voucherCode: "", destinationAreaId: DESTINATION.destinationAreaId, courier: "JNE", paymentMethod: "bank_transfer" });
    expect(p2.shippingDiscount).toBeGreaterThan(0);
    // And mail helper renders shipping route for mixed order.
    const mail = renderMail("created", "buyer", {
      id: orderId, storeName: "Toko", storeSlug: s.sf.storeSlug, status: "placed", paymentMethod: "bank_transfer",
      hasPhysical: true, hasDigital: true, buyerName: "Citra", buyerEmail: "citra@example.com",
      courier: "JNE", trackingNumber: null, destinationAreaLabel: DESTINATION.destinationAreaLabel,
      subtotal: 280_000, shippingFee: o.shippingFee, goodsDiscount: 0, shippingDiscount: 0, total: o.total,
      lines: [{ productTitle: "Fisik", variantTitle: "M", quantity: 1, lineTotal: 80_000 }],
      bank: { accounts: [], expiresAt: new Date() },
    }, "citra@example.com");
    expect(mail.text).toContain("Pengiriman: JNE");
  });

  it("catalog feeds exclude digital products (ADR-0016 decision 22)", async () => {
    const s = await digitalReadyStore("t111-feeds", { withShipping: true });
    const digId = await createActiveDigital(s.me, "E-Book Rahasia", { title: "PDF", price: 50_000, stock: 0 });
    // Give both physical and digital products cover images.
    await admin.insert(media).values([
      { storeId: s.storeId, productId: s.productId, mime: "image/png", bytes: 100, width: 100, height: 100, alt: "fisik", position: 0 },
      { storeId: s.storeId, productId: digId, mime: "image/png", bytes: 100, width: 100, height: 100, alt: "digital", position: 0 },
    ]);
    const items = await feedItems(s.sf);
    expect(items.items.map((i) => i.title)).toEqual([expect.stringContaining("Kaos")]);
    expect(items.items.some((i) => i.title.includes("E-Book"))).toBe(false);
    const settings = await feedSettings(s.me);
    expect(settings.activeProducts).toBe(1);
    expect(settings.withoutImage).toBe(0);
  });
});
