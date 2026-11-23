import { inspect } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueSellerStepUp } from "../src/ledger/stepup.ts";
import { FakeProviderCheck, saveProviderKey, setPaymentAccountDetails, setProviderCheckTransport, shippingReadiness } from "../src/payments/provider-accounts.ts";
import { paymentAttempt, storePaymentAccount } from "../src/payments/schema-payments.ts";
import { confirmPaymentByHand } from "../src/payments/seller.ts";
import { FAKE_NO_COD_AREA } from "../src/payments/providers.ts";
import { bindSession, type SellerScope } from "../src/platform/scoped.ts";
import { acceptSellerTerms, recordSellerTermsReview } from "../src/platform/terms.ts";
import { withStore } from "../src/platform/tenant.ts";
import { runOnce } from "../src/ops/jobs/jobs.ts";
import { auditLog, job, mailOutbox, order, shipment, shipmentCost, user } from "../src/schema.ts";
import { placeOrder, searchDestinationAreas } from "../src/seller/commerce/checkout.ts";
import { transitionOrder } from "../src/seller/commerce/orders.ts";
import { bookShipment, COD_REFUSED_MESSAGE, linkUnknownBooking, releaseUnknownBooking, setBookingAdapter, SHIPMENT_BOOK, SHIPMENT_TRACK, OWN_UNCERTAIN_MESSAGE, PAY_UNCERTAIN_MESSAGE, UNCERTAIN_MESSAGE, type BookingAdapter, type BookingInput } from "../src/shipping/fulfillment.ts";
import { recordMengantarSandboxPass, requestMengantarProductionOn, setMengantarProductionCalls } from "../src/shipping/live-setting.ts";
import { decideApproval } from "../src/ops/capabilities-approvals.ts";
import { MengantarClient, MengantarError } from "../src/shipping/mengantar/client.ts";
import { areaProvince, chosenShippingFee, formatShippingQuote, rememberAreas, saveCourierRules, saveShippingSettings, SELLER_PROVIDER_LIMITS, sellerMethods, sellerShippingRules, type MethodContext } from "../src/shipping/rules.ts";
import { storeShippingAccount } from "../src/shipping/schema-accounts.ts";
import { providerLiveSetting, storeCourierRule, storeShippingSetting } from "../src/shipping/schema-shipping.ts";
import { fakeSellerMengantar, SellerMengantar, sellerTransport, setSellerMengantarFetch } from "../src/shipping/seller.ts";
import { confirmDedicatedAccount } from "../src/shipping/sync.ts";
import { searchPickupAreas, setPickupAddress, setPickupArea, shippingOptions } from "../src/shipping/shipping.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { admin, buyer, db, DEFAULT_OPERATOR_CAPABILITIES, DESTINATION, makeOperator, makeStore, PICKUP_AREA, platform } from "./helpers.ts";
import { sessionOf } from "./t37-fixtures.ts";

// T-105 (ADR-0013 sections 4, 5, 7 and 9): Mengantar on the store's OWN key. Everything runs on the deterministic seller fake (no origin
// configured) or on the real client over a STUBBED fetch (an origin of example.test): no request leaves the process. The key is a canary.

const KEY = "CANARY-T105-seller/key+0123456789?abc=def#ghi";
const KEY_FORMS = [KEY, encodeURIComponent(KEY), JSON.stringify(KEY).slice(1, -1), Buffer.from(KEY).toString("base64")];
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code ?? String(e));
const MENTENG = DESTINATION.destinationAreaId; // DKI Jakarta in the fake areas
const GUBENG = "c1c1c1c1c1c1c1c1c1c1c1c1"; // Jawa Timur
const RULES = [
  { courierCode: "JNE", enabled: true, codEnabled: true },
  { courierCode: "SiCepat", enabled: true, codEnabled: true },
  { courierCode: "lion", enabled: true, codEnabled: true },
  { courierCode: "pos", enabled: true, codEnabled: true },
];

type Own = Awaited<ReturnType<typeof makeStore>> & { me: SellerScope };
/** A store on its own Mengantar account, ready to ship: key connected (fake check), pickup address registered, courier rules saved. */
async function ownStore(slug: string, opts: { environment?: "sandbox" | "production"; rules?: typeof RULES; key?: string } = {}): Promise<Own> {
  const s = await makeStore(slug);
  const me = bindSession(s.owner, await sessionOf(s.ownerId));
  await acceptSellerTerms(me, { version: 1, agreed: true }); // T-116: owner must accept seller terms before saving provider keys
  await saveProviderKey(me, { provider: "mengantar", environment: opts.environment ?? "sandbox", apiKey: opts.key ?? KEY, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar" }) });
  await confirmDedicatedAccount(me, { confirmed: true }); // T-115: shipping is ready only on a confirmed dedicated account
  await setPickupAddress(me, { addressText: "Jl. Braga No. 10, Bandung", contactName: "Budi Pemilik", contactPhone: "081234567890" });
  await saveCourierRules(me, { couriers: opts.rules ?? RULES });
  return { ...s, me };
}
const cart = (s: Own, quantity = 1) => setCartLine(s.sf, undefined, { variantId: s.variantId, quantity }, "add");
const quote = (s: Own, destination = MENTENG) => shippingOptions(s.sf, destination, { lines: [{ quantity: 1, weightGrams: 1000 }], subtotal: 100_000 });
const run = (workerId = "W", batch?: number) => runOnce(platform, { workerId, batch });
const shipmentOf = async (orderId: number) => (await platform.select().from(shipment).where(eq(shipment.orderId, orderId)))[0] ?? null;
const orderOf = async (orderId: number) => (await platform.select().from(order).where(eq(order.id, orderId)))[0]!;
/** A buyer submit with the fee list the buyer was shown (required for a store on its own account, review minor 2). */
async function submit(s: Own, over: Record<string, unknown>) {
  const shippingQuote = formatShippingQuote((await quote(s, (over.destinationAreaId as string | undefined) ?? MENTENG)).options);
  return placeOrder(db, await cart(s), buyer({ shippingQuote, ...over }));
}
/**
 * T-107 (ADR-0013 section 8, Ceiling T-106-1 closed for it): a store on its own Mengantar account takes QRIS/VA only on its OWN AutoLaris account,
 * so a prepaid order here first connects one (fake, sandbox) and is confirmed by the owner by hand (decision 24) instead of the bare "pay".
 */
async function ownAutoLaris(s: Own) {
  if ((await admin.select({ id: storePaymentAccount.id }).from(storePaymentAccount).where(eq(storePaymentAccount.storeId, s.storeId))).length > 0) return;
  await saveProviderKey(s.me, { provider: "autolaris", environment: "sandbox", apiKey: `CANARY-T105-AUTOLARIS-${s.storeId}-0123456789abcdef`, proofId: await issueSellerStepUp(s.me, { action: "integrations.provider_key", subjectId: "autolaris" }) });
  await setPaymentAccountDetails(s.me, { originAreaId: "3517100", destinationAreaId: "3518010", shipperEmail: `store-${s.storeId}@example.invalid`, senderAddress: "Jl. Braga No. 1, Bandung 40111", paymentOnlyConfirmed: true });
}
async function paidOrder(s: Own, over: Record<string, unknown> = {}) {
  const cod = over.paymentMethod === "cod";
  if (!cod) await ownAutoLaris(s);
  const { orderId } = await submit(s, { paymentMethod: "manual_transfer", ...over });
  await run("setup");
  if (cod) await transitionOrder(s.owner, orderId, "confirm");
  else {
    const [a] = await admin.select({ id: paymentAttempt.id }).from(paymentAttempt).where(eq(paymentAttempt.orderId, orderId));
    await confirmPaymentByHand(s.me, { attemptId: a!.id, reason: "uang masuk di mutasi", evidence: `MUT-${orderId}` });
  }
  return orderId;
}
type Scripted = BookingAdapter & { inputs: BookingInput[]; active: number; maxActive: number };
function scripted(createOrder?: (input: BookingInput) => Promise<void>): Scripted {
  const a: Scripted = {
    inputs: [],
    active: 0,
    maxActive: 0,
    async createOrder(input) {
      a.inputs.push(input);
      a.active++;
      a.maxActive = Math.max(a.maxActive, a.active);
      try {
        await createOrder?.(input);
      } finally {
        a.active--;
      }
      return { providerOrderId: `ORD-${input.orderId}`, providerBatchId: `B-${input.orderId}`, trackingNumber: `RESI-${input.orderId}`, paid: true, providerStatus: "PENDING PICKUP" };
    },
    async payUnpaid() {},
    async track() {
      return { trackingNumber: null, providerStatus: "ON DELIVERY", paid: true, history: [] };
    },
  };
  return a;
}

/** A stubbed provider on a configured sandbox origin: the real client runs, every request is recorded, nothing leaves the process. */
function stubProvider(prices: Record<string, number>) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: init?.body as string | undefined });
    const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
    if (url.includes("/address/search")) return json([{ _id: MENTENG, SUBDISTRICT_NAME: "MENTENG", DISTRICT_NAME: "MENTENG", CITY_NAME: "JAKARTA PUSAT", PROVINCE_NAME: "DKI JAKARTA", ZIP_CODE: "10310" }]);
    if (url.includes("/order/estimate")) return json(Object.fromEntries(Object.entries(prices).map(([k, price]) => [k, { price, discount: 1_000, codFee: 0, estimatedPrice: price, estimatedSpecialPrice: price - 1_000, unsupported: false, unsupported_cod: false }])));
    if (url.endsWith("/address") && init?.method === "POST") return json({ _id: "pickupaddr0001" });
    if (url.endsWith("/address")) return json([]); // the account's pickup-address list (the key check before any pickup area)
    if (new URL(url).pathname.endsWith("/order") && (init?.method ?? "GET") === "GET" && url.includes("size=")) return new Response(JSON.stringify({ success: true, data: [], nextCursor: "" }), { status: 200 }); // T-115: an empty (dedicated) account
    if (url.endsWith("/order") && init?.method === "POST") return new Response(JSON.stringify({ success: true, batch_id: "B-STUB-1", data: [{ ORDER_ID: "ORD-STUB-1", cnote_no: "RESI-STUB-1", isPaid: true, statusCategory: "PENDING PICKUP" }] }), { status: 200 });
    return new Response(JSON.stringify({ success: false, message: "not found" }), { status: 404 });
  }) as typeof fetch;
  setSellerMengantarFetch(f);
  return calls;
}


let check: FakeProviderCheck;
beforeEach(async () => {
  check = new FakeProviderCheck();
  setProviderCheckTransport(check);
  await admin.execute(sql`truncate shipping_area, provider_live_setting`);
  fakeSellerMengantar.failRegistration = false;
});
afterEach(() => {
  setProviderCheckTransport(null);
  setBookingAdapter(null);
  setSellerMengantarFetch(null);
  vi.restoreAllMocks();
});

describe("T-105 the filters of ADR-0013 section 4: one eligibility function", () => {
  it("the full filter table of section 4 through the one eligibility function", () => {
    const rate = (price: number | undefined, extra: Record<string, unknown> = {}) => ({ price, unsupported: false, unsupported_cod: false, ...extra });
    const rates = {
      JNE: rate(12_000),
      NORULE: rate(9_000),
      OFF: rate(9_000),
      NOROUTE: rate(9_000, { unsupported: true }),
      SPXORIGIN: rate(9_000, { unsupportedOriginSpx: true }),
      JNECargo: rate(40_000),
      ZERO: rate(0),
      MISSING: rate(undefined),
      ROUTENOCOD: rate(10_000, { unsupported_cod: true }),
      COURIERNOCOD: rate(11_000),
      CEILING: rate(13_000),
    };
    const on = { enabled: true, codEnabled: true };
    const ctx: MethodContext = {
      rules: new Map(Object.entries({ JNE: on, OFF: { enabled: false, codEnabled: true }, NOROUTE: on, SPXORIGIN: on, JNECargo: on, ZERO: on, MISSING: on, ROUTENOCOD: on, COURIERNOCOD: { enabled: true, codEnabled: false }, CEILING: on })),
      settings: { codEnabled: true, codBlockedProvinces: ["papua"] },
      codCeiling: (c) => c !== "CEILING",
      province: "dki-jakarta",
    };
    const r = sellerMethods(rates, ctx);
    expect(Object.fromEntries(r.dropped.map((d) => [d.courier, d.reason]))).toEqual({ NORULE: "no_rule", OFF: "courier_off", NOROUTE: "unsupported", SPXORIGIN: "unsupported", JNECargo: "cargo", ZERO: "no_price", MISSING: "no_price" });
    expect(r.methods.map((m) => [m.courier, m.fee, m.cod, m.codRefusal])).toEqual([
      ["ROUTENOCOD", 10_000, false, "route_no_cod"],
      ["COURIERNOCOD", 11_000, false, "courier_cod_off"],
      ["JNE", 12_000, true, null],
      ["CEILING", 13_000, false, "platform_ceiling"],
    ]);
    // Province rows: blocked, and unresolved (null) refuses COD; the store switch turns every COD off.
    expect(sellerMethods({ JNE: rate(12_000) }, { ...ctx, province: "papua" }).methods[0]).toMatchObject({ cod: false, codRefusal: "province_blocked" });
    expect(sellerMethods({ JNE: rate(12_000) }, { ...ctx, province: null }).methods[0]).toMatchObject({ cod: false, codRefusal: "province_unresolved" });
    expect(sellerMethods({ JNE: rate(12_000) }, { ...ctx, settings: { ...ctx.settings, codEnabled: false } }).methods[0]).toMatchObject({ cod: false, codRefusal: "store_cod_off" });
    // Public rate: `price`, never the discounted account price; without `price` the undiscounted estimate minus any COD fee.
    expect(sellerMethods({ JNE: { estimatedPrice: 15_000, codFee: 3_000, estimatedSpecialPrice: 9_000, unsupported: false } }, ctx).methods[0]!.fee).toBe(12_000);
  });

  it("a courier without a rule row is closed: not offered, and refused on a direct submit", async () => {
    const s = await ownStore("t105-norule", { rules: [{ courierCode: "JNE", enabled: true, codEnabled: false }] });
    await searchDestinationAreas("menteng", undefined, s.sf);
    const q = await quote(s);
    // The fake account answers JNE, SiCepat, anteraja, a cargo service, a zero price and an unsupported route: only the ruled JNE is offered.
    expect(q.options.map((o) => o.courier)).toEqual(["JNE"]);
    expect(await code(submit(s, { courier: "anteraja", paymentMethod: "manual_transfer" }))).toBe("courier");
    expect(await code(submit(s, { courier: "SiCepat", paymentMethod: "manual_transfer" }))).toBe("courier");
    // Switched off by the seller: closed too; cargo, zero price and unsupported routes are never offered even with a rule.
    await saveCourierRules(s.me, { couriers: [{ courierCode: "JNE", enabled: false, codEnabled: false }, ...RULES.slice(1)] });
    expect((await quote(s)).options.map((o) => o.courier)).toEqual(["SiCepat"]);
    for (const courier of ["JNE", "lion", "pos", "JNECargo"]) expect(await code(submit(s, { courier, paymentMethod: "manual_transfer" })), courier).toBe("courier");
  });

  it("COD is checked again at submit: a direct COD submit to a blocked or unresolved province, with the store or courier COD off, is refused", async () => {
    const s = await ownStore("t105-cod");
    // Unresolved: the destination was never answered by a provider area search (no province on record).
    let q = await quote(s);
    expect(q.options.find((o) => o.courier === "JNE")).toMatchObject({ prepaid: { buyerFee: 12_000 }, cod: null });
    expect(await code(submit(s, { courier: "JNE", paymentMethod: "cod" }))).toBe("courier_cod");
    // Resolved through the store's own search: COD offered on JNE (COD on), never on SiCepat (the route refuses COD).
    await searchDestinationAreas("menteng", undefined, s.sf);
    q = await quote(s);
    expect(q.options.map((o) => [o.courier, o.cod?.buyerFee ?? null])).toEqual([["SiCepat", null], ["JNE", 12_000]]);
    expect(await code(submit(s, { courier: "SiCepat", paymentMethod: "cod" }))).toBe("courier_cod");
    // Blocked province (DKI Jakarta): refused at submit; the prepaid order on the same courier still passes.
    await saveShippingSettings(s.me, { codEnabled: true, codFeeBearer: "seller", codBlockedProvinces: ["dki-jakarta"], revision: 0 });
    expect(await code(submit(s, { courier: "JNE", paymentMethod: "cod" }))).toBe("courier_cod");
    await ownAutoLaris(s); // T-107: prepaid on a store with its own Mengantar account runs on its own AutoLaris account
    expect(await code(submit(s, { courier: "JNE", paymentMethod: "manual_transfer" }))).toBe("ok");
    // Another province is allowed; then the store switch and the courier switch each refuse it at submit.
    await searchDestinationAreas("gubeng", undefined, s.sf);
    const gubeng = { destinationAreaId: GUBENG, destinationAreaLabel: "Gubeng, Gubeng, Surabaya, Jawa Timur 60281" };
    expect(await code(submit(s, { courier: "JNE", paymentMethod: "cod", ...gubeng }))).toBe("ok");
    await saveShippingSettings(s.me, { codEnabled: false, codFeeBearer: "seller", codBlockedProvinces: ["dki-jakarta"], revision: 1 });
    expect(await code(submit(s, { courier: "JNE", paymentMethod: "cod", ...gubeng }))).toBe("courier_cod");
    await saveShippingSettings(s.me, { codEnabled: true, codFeeBearer: "seller", codBlockedProvinces: [], revision: 2 });
    await saveCourierRules(s.me, { couriers: [{ courierCode: "JNE", enabled: true, codEnabled: false }] });
    expect(await code(submit(s, { courier: "JNE", paymentMethod: "cod", ...gubeng }))).toBe("courier_cod");
    // The route that refuses COD on every courier (provider flag) never offers it.
    expect((await quote(s, FAKE_NO_COD_AREA)).options.every((o) => o.cod === null)).toBe(true);
    // The settings are the store's: stale revision refused, and the DB accepts only known province codes.
    expect(await code(saveShippingSettings(s.me, { codEnabled: true, codFeeBearer: "buyer", codBlockedProvinces: [], revision: 0 }))).toBe("conflict");
    expect(await code(saveShippingSettings(s.me, { codEnabled: true, codFeeBearer: "buyer", codBlockedProvinces: ["atlantis"], revision: 3 }))).not.toBe("ok");
    expect(await code(withStore(db, s.storeId, (tx) => tx.execute(sql`update store_shipping_setting set cod_blocked_provinces = '{atlantis}'`)))).toBe("23514");
  });

  it("store B cannot read or change store A's courier rules and COD settings under the application role", async () => {
    const a = await ownStore("t105-iso-a");
    const b = await makeStore("t105-iso-b");
    await saveShippingSettings(a.me, { codEnabled: false, codFeeBearer: "seller", codBlockedProvinces: ["aceh"], revision: 0 });
    expect(await withStore(db, b.storeId, (tx) => tx.select().from(storeCourierRule))).toEqual([]);
    expect(await withStore(db, b.storeId, (tx) => tx.select().from(storeShippingSetting))).toEqual([]);
    expect(await code(withStore(db, b.storeId, (tx) => tx.insert(storeCourierRule).values({ storeId: a.storeId, courierCode: "JNE", enabled: true, codEnabled: true, updatedBy: b.ownerId })))).toBe("42501");
    await withStore(db, b.storeId, (tx) => tx.update(storeShippingSetting).set({ codEnabled: true }).where(eq(storeShippingSetting.storeId, a.storeId)));
    expect((await platform.select().from(storeShippingSetting).where(eq(storeShippingSetting.storeId, a.storeId)))[0]).toMatchObject({ codEnabled: false });
    expect((await sellerShippingRules(b.owner)).ownAccount).toBe(false);
    expect(await code(saveCourierRules({ ...a.owner, role: "staff" }, { couriers: [] }))).toBe("forbidden");
  });
});

describe("T-105 prices on the seller's key: public rate, no provider COD fee, stale price refused", () => {
  it("the buyer is charged the public rate with no margin; checkout quotes never request the provider COD fee; submit re-quotes and refuses a stale price", async () => {
    vi.stubEnv("MENGANTAR_SANDBOX_ORIGIN", "https://sandbox.example.test");
    let prices: Record<string, number> = { JNE: 13_000, SiCepat: 9_500 };
    const calls = stubProvider(prices);
    const s = await ownStore("t105-price");
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/address"))).toHaveLength(1); // the pickup registration went to the store's account
    await searchDestinationAreas("menteng", undefined, s.sf);
    const q = await quote(s);
    expect(q).toMatchObject({ shippingAccountKind: "seller_owned", environment: "sandbox" });
    expect(q.options.find((o) => o.courier === "JNE")).toEqual({ courier: "JNE", label: "JNE Express", etd: undefined, prepaid: { providerCost: 13_000, margin: 0, buyerFee: 13_000, platformDiscount: 0 }, cod: { providerCost: 13_000, margin: 0, buyerFee: 13_000, platformDiscount: 0 } });
    // Every request carried the key only in the (encoded) path, on the configured origin, and no estimate ever carried a COD amount.
    const estimates = calls.filter((c) => c.url.includes("/order/estimate"));
    expect(estimates.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.url.startsWith(`https://sandbox.example.test/api/public/${encodeURIComponent(KEY)}/`)).toBe(true);
    for (const c of estimates) expect(new URL(c.url).searchParams.has("COD_AMOUNT")).toBe(false);
    // The order freezes the public rate with no margin and is a test order (sandbox account).
    const seen = formatShippingQuote(q.options);
    const { orderId } = await placeOrder(db, await cart(s), buyer({ courier: "JNE", paymentMethod: "cod", shippingQuote: seen }));
    expect(await orderOf(orderId)).toMatchObject({ shippingAccountKind: "seller_owned", shippingProviderCost: 13_000, shippingMargin: 0, shippingFee: 13_000, total: 113_000, testOrder: true });
    // The provider raises the price after the buyer saw the list: submit refuses, nothing is created at the stale price.
    prices = { JNE: 14_000, SiCepat: 9_500 };
    stubProvider(prices);
    const before = (await platform.select({ id: order.id }).from(order).where(eq(order.storeId, s.storeId))).length;
    expect(await code(placeOrder(db, await cart(s), buyer({ courier: "JNE", paymentMethod: "cod", shippingQuote: seen })))).toBe("quote_changed");
    expect(await code(placeOrder(db, await cart(s), buyer({ courier: "SiCepat", paymentMethod: "manual_transfer", shippingQuote: "JNE:13000:13000" })))).toBe("quote_changed"); // a courier the buyer was not shown
    // A store on its own account always compares: a submit without the shown list is refused too (review minor 2).
    expect(await code(placeOrder(db, await cart(s), buyer({ courier: "JNE", paymentMethod: "cod" })))).toBe("quote_changed");
    expect((await platform.select({ id: order.id }).from(order).where(eq(order.storeId, s.storeId))).length).toBe(before);
    expect(await code(placeOrder(db, await cart(s), buyer({ courier: "JNE", paymentMethod: "cod", shippingQuote: formatShippingQuote((await quote(s)).options) })))).toBe("ok");
    // The marker is set once: no role moves it afterwards.
    expect(await code(withStore(db, s.storeId, (tx) => tx.update(order).set({ testOrder: false }).where(eq(order.id, orderId))))).toBe("42501");
    expect(await code(platform.update(order).set({ testOrder: false }).where(eq(order.id, orderId)))).toBe("42501");
    expect(() => chosenShippingFee(q.options, "JNE", "cod", "JNE:13000:-")).toThrow(/berubah/); // COD was not shown for it: stale
  });
});

describe("T-105 pickup registration and the readiness columns", () => {
  it("the pickup address is registered with the store's account first; a refusal changes nothing; another area or key drops it; the database bounds the readiness columns", async () => {
    const s = await ownStore("t105-pickup");
    expect(await shippingReadiness(s.me)).toEqual({ ready: true, missing: [] });
    const row = async () => (await platform.select().from(storeShippingAccount).where(and(eq(storeShippingAccount.storeId, s.storeId), eq(storeShippingAccount.kind, "seller_owned"))))[0]!;
    const registered = await row();
    expect(registered.pickupAddressId).toMatch(/^fakepickup/);
    // A provider refusal: the local address text and the registration stay as they were.
    fakeSellerMengantar.failRegistration = true;
    expect(await code(setPickupAddress(s.me, { addressText: "Jl. Asia Afrika No. 99, Bandung", contactName: "Budi", contactPhone: "081234567890" }))).toBe("pickup_registration_failed");
    expect((await platform.execute(sql`select address_text from store_pickup_area where store_id = ${s.storeId}`))[0]).toEqual({ address_text: "Jl. Braga No. 10, Bandung" });
    expect((await row()).pickupRegisteredAt).toEqual(registered.pickupRegisteredAt);
    // The contact is required for a store on its own account.
    expect(await code(setPickupAddress(s.me, { addressText: "Jl. Asia Afrika No. 99, Bandung" }))).not.toBe("ok");
    // Another pickup area drops the registration (not ready until the address is saved again).
    await setPickupArea(s.me, { areaId: "a2a2a2a2a2a2a2a2a2a2a2a2", areaLabel: "Cihapit, Bandung Wetan, Bandung, Jawa Barat 40114" });
    expect(await row()).toMatchObject({ pickupRegisteredAt: null, pickupAddressId: null });
    expect(await shippingReadiness(s.me)).toEqual({ ready: false, missing: ["pickup_registered"] });
    expect(await code(quote(s))).toBe("shipping_not_ready");
    await setPickupAddress(s.me, { addressText: "Jl. Cihapit No. 3, Bandung", contactName: "Budi", contactPhone: "081234567890" });
    expect((await row()).pickupAddressId).not.toBeNull();
    // A key replaced with another account drops it too (the guard clears both columns on a key or environment change).
    await saveProviderKey(s.me, { provider: "mengantar", environment: "sandbox", apiKey: `${KEY}-OTHER`, proofId: await issueSellerStepUp(s.me, { action: "integrations.provider_key", subjectId: "mengantar" }) });
    expect(await row()).toMatchObject({ pickupRegisteredAt: null, pickupAddressId: null });
    await setPickupAddress(s.me, { addressText: "Jl. Cihapit No. 3, Bandung", contactName: "Budi", contactPhone: "081234567890" });
    // Below the service (T-104 known gap): the application role can no longer forge readiness. A check time or a registration is the
    // statement's own time, a passed check carries its check time, and a registration needs an address id and a connected key that passed.
    const asApp = (q: ReturnType<typeof sql>) => code(withStore(db, s.storeId, (tx) => tx.execute(q)));
    const id = (await row()).id;
    expect(await asApp(sql`update store_shipping_account set last_checked_at = now() - interval '1 day' where id = ${id}`)).toBe("42501");
    expect(await asApp(sql`update store_shipping_account set last_result = 'AUTH_FAILED', last_checked_at = now() where id = ${id}`)).toBe("ok");
    expect(await asApp(sql`update store_shipping_account set last_result = 'ready' where id = ${id}`)).toBe("42501");
    expect(await asApp(sql`update store_shipping_account set pickup_registered_at = now(), pickup_address_id = 'forged1' where id = ${id}`)).toBe("42501"); // the last check failed
    expect(await asApp(sql`update store_shipping_account set last_result = 'ready', last_checked_at = now() where id = ${id}`)).toBe("ok");
    expect(await asApp(sql`update store_shipping_account set pickup_registered_at = now() - interval '1 hour', pickup_address_id = 'forged2' where id = ${id}`)).toBe("42501");
    expect(await asApp(sql`update store_shipping_account set pickup_registered_at = now(), pickup_address_id = null where id = ${id}`)).toBe("23514");
  });
});

describe("T-105 booking on the seller's key", () => {
  it("booking runs on the store's own key one at a time per store; parallel requests of one order produce one shipment; no platform COD gate and no platform reservation", async () => {
    const s = await ownStore("t105-book");
    await searchDestinationAreas("menteng", undefined, s.sf);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const adapter = scripted((input) => (input.orderId === first ? gate : Promise.resolve()));
    setBookingAdapter(adapter);
    const first = await paidOrder(s);
    const second = await paidOrder(s, { paymentMethod: "cod", courier: "JNE" }); // COD on the seller's own account: no ALLOW_COD_BOOKING needed
    await run("drain"); // only the booking jobs below are due from here
    const outcomes = await Promise.all([bookShipment(s.me, first, { pickupType: "drop_off" }), bookShipment(s.me, first, { pickupType: "drop_off" }), bookShipment(s.me, first, { pickupType: "drop_off" })]);
    expect(outcomes.filter((o) => o.created)).toHaveLength(1);
    expect(new Set(outcomes.map((o) => o.shipmentId)).size).toBe(1);
    await bookShipment(s.me, second);
    // Worker A takes the first booking and holds the store's dispatch lease; worker B finds the store busy and retries later.
    const a = run("A", 1);
    await vi.waitFor(() => expect(adapter.inputs).toHaveLength(1));
    expect(await run("B", 1)).toMatchObject([{ kind: SHIPMENT_BOOK, status: "pending" }]); // 409 from the store's lease: nothing was sent, retried with backoff
    expect((await shipmentOf(second))!.status).toBe("queued");
    release();
    await a;
    await platform.update(job).set({ nextAttemptAt: sql`now() - interval '1 second'` }).where(eq(job.kind, SHIPMENT_BOOK));
    await run("C");
    expect(adapter.maxActive).toBe(1);
    expect(adapter.inputs.map((i) => [i.orderId, i.pickupType, i.shippingAccountKind, i.idempotencyKey])).toEqual([
      [first, "drop_off", "seller_owned", `bk-${s.storeId}-${first}-0`],
      [second, "scheduled_pickup", "seller_owned", `bk-${s.storeId}-${second}-0`],
    ]);
    expect(await shipmentOf(first)).toMatchObject({ status: "booked", trackingNumber: `RESI-${first}`, pickupType: "drop_off" });
    expect(await shipmentOf(second)).toMatchObject({ status: "booked", codAmount: 112_000 + 3_360 }); // T-107: total plus the COD fee the buyer bears (default bearer `buyer`, 3% UNVERIFIED rate)
    expect((await orderOf(first)).status).toBe("shipped");
    // The platform reserves nothing for a store on its own account (the seller pays the courier: ADR-0013 C-P7).
    expect(await platform.select().from(shipmentCost).where(eq(shipmentCost.storeId, s.storeId))).toEqual([]);
  });

  it("an unknown outcome blocks every further booking until a person releases it or links the shipment the provider accepted", async () => {
    const s = await ownStore("t105-unknown");
    let fail: Error | null = new MengantarError("timeout", "Mengantar timed out after 8000 ms");
    const adapter = scripted(async () => {
      if (fail) throw fail;
    });
    setBookingAdapter(adapter);
    const orderId = await paidOrder(s);
    await bookShipment(s.me, orderId);
    await run();
    expect(await shipmentOf(orderId)).toMatchObject({ status: "unknown", providerOrderId: null, lastError: expect.stringContaining(OWN_UNCERTAIN_MESSAGE) });
    // Blocked: no second booking (seller), and the stale job never books again.
    expect(await code(bookShipment(s.me, orderId))).toBe("booking_unknown");
    expect(await code(bookShipment(s.me, orderId, { pickupType: "drop_off" }))).toBe("booking_unknown");
    await platform.update(job).set({ status: "pending", nextAttemptAt: sql`now() - interval '1 second'` }).where(eq(job.kind, SHIPMENT_BOOK));
    await run("again");
    expect(adapter.inputs).toHaveLength(1);
    // Recovery 1: released after checking the account (reason required, audited); the next booking is a new attempt with a new key.
    expect(await code(releaseUnknownBooking(s.me, orderId, { reason: "x" }))).not.toBe("ok");
    await releaseUnknownBooking(s.me, orderId, { reason: "Daftar order akun kurir sudah dicek: kosong" });
    expect((await shipmentOf(orderId))!.status).toBe("failed");
    fail = null;
    await bookShipment(s.me, orderId);
    await run();
    expect(adapter.inputs.map((i) => i.idempotencyKey)).toEqual([`bk-${s.storeId}-${orderId}-0`, `bk-${s.storeId}-${orderId}-1`]);
    expect(await shipmentOf(orderId)).toMatchObject({ status: "booked", bookingAttempts: 1 });
    // Recovery 2 on another order: a lost worker (and an HTTP 502) is unknown too; the seller links the order the provider did create.
    const other = await paidOrder(s);
    await bookShipment(s.me, other);
    await platform.update(shipment).set({ status: "booking" }).where(eq(shipment.orderId, other));
    await run();
    expect((await shipmentOf(other))!.status).toBe("unknown");
    expect(await code(linkUnknownBooking(s.me, other, { providerOrderId: "bad id!" }))).not.toBe("ok");
    // The provider is asked first, on the store's own key: an id it does not know (a typo) is refused and the shipment stays unknown, so the
    // seller can still release it or link the right id (confirmation review 1).
    adapter.track = async (ref) => {
      if (ref.providerOrderId === "ORD-TYPO") throw new MengantarError("invalid_shape", "Mengantar: order not found in tracking response", 200);
      return { trackingNumber: ref.providerOrderId === "ORD-LINKED-1" ? "RESI-LINKED-1" : null, providerStatus: "PENDING PICKUP", paid: true, history: [] };
    };
    expect(await code(linkUnknownBooking(s.me, other, { providerOrderId: "ORD-TYPO" }))).toBe("provider_order_unknown");
    expect(await shipmentOf(other)).toMatchObject({ status: "unknown", providerOrderId: null });
    // An id already on another shipment of the store (the order booked above) is refused: one provider order, one shipment.
    expect(await code(linkUnknownBooking(s.me, other, { providerOrderId: `ORD-${orderId}` }))).toBe("provider_order_taken");
    await linkUnknownBooking(s.me, other, { providerOrderId: "ORD-LINKED-1" });
    // Nothing ships on the seller's word: the order waits for the tracking read on the store's own key, and only its resi ships it.
    expect(await shipmentOf(other)).toMatchObject({ status: "booked", providerOrderId: "ORD-LINKED-1", trackingNumber: null, paid: false });
    expect(await orderOf(other)).toMatchObject({ status: "placed", trackingNumber: null });
    expect(adapter.inputs.filter((i) => i.orderId === other)).toHaveLength(0); // linking never books
    const tracked = await platform.select({ key: job.key }).from(job).where(and(eq(job.kind, SHIPMENT_TRACK), sql`${job.key} like ${`track:${other}:link:%`}`));
    expect(tracked).toHaveLength(1);
    await run("track-link");
    expect(await shipmentOf(other)).toMatchObject({ status: "booked", trackingNumber: "RESI-LINKED-1", paid: true });
    expect(await orderOf(other)).toMatchObject({ status: "shipped", trackingNumber: "RESI-LINKED-1" });
    expect(await code(releaseUnknownBooking(s.me, other, { reason: "Sudah ditautkan sebelumnya" }))).toBe("not_unknown");
    const audit = await platform.select({ action: auditLog.action }).from(auditLog).where(and(eq(auditLog.storeId, s.storeId), sql`${auditLog.action} like 'shipment.unknown.%'`));
    expect(audit.map((a) => a.action).sort()).toEqual(["shipment.unknown.link", "shipment.unknown.release"]);
    // A 5xx after the request left is unknown as well; a definite 4xx is not.
    const third = await paidOrder(s);
    fail = new MengantarError("http", "Mengantar: HTTP 502", 502);
    await bookShipment(s.me, third);
    await run();
    expect((await shipmentOf(third))!.status).toBe("unknown");
    // So is an unreadable success (decision 30); a definite provider refusal is a plain failure the seller may retry.
    const fourth = await paidOrder(s);
    fail = new MengantarError("invalid_shape", "Mengantar create-order response shape mismatch", 200);
    await bookShipment(s.me, fourth);
    await run();
    expect((await shipmentOf(fourth))!.status).toBe("unknown");
    const fifth = await paidOrder(s);
    fail = new MengantarError("http", "Mengantar: HTTP 400", 400);
    await bookShipment(s.me, fifth);
    await run();
    expect((await shipmentOf(fifth))!.status).toBe("failed");
    // An uncertain pay-unpaid stays awaiting balance and says so: retrying it cannot create a second order (confirmation review 3).
    fail = null;
    const sixth = await paidOrder(s);
    adapter.createOrder = async (input) => ({ providerOrderId: `ORD-${input.orderId}`, providerBatchId: `B-${input.orderId}`, trackingNumber: null, paid: false, providerStatus: "PENDING PICKUP" });
    adapter.payUnpaid = async () => {
      throw new MengantarError("timeout", "Mengantar timed out after 8000 ms");
    };
    await bookShipment(s.me, sixth);
    await run();
    expect((await shipmentOf(sixth))!.status).toBe("awaiting_balance");
    await bookShipment(s.me, sixth);
    await run();
    expect(await shipmentOf(sixth)).toMatchObject({ status: "awaiting_balance", lastError: expect.stringContaining(PAY_UNCERTAIN_MESSAGE) });
  });

  it("an order on a platform account keeps the T-39 rule: an uncertain booking fails closed, and the seller can neither release nor link it", async () => {
    const s = await makeStore("t105-platform");
    setBookingAdapter(scripted(async () => {
      throw new MengantarError("timeout", "Mengantar timed out after 8000 ms");
    }));
    const { orderId } = await placeOrder(db, await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add"), buyer({ paymentMethod: "manual_transfer" }));
    await run("setup");
    await transitionOrder(s.owner, orderId, "pay");
    await bookShipment(s.owner, orderId);
    await run();
    expect(await shipmentOf(orderId)).toMatchObject({ status: "failed", lastError: expect.stringContaining(UNCERTAIN_MESSAGE) });
    // Even a shipment in the unknown state on a platform account is never released or linked by the seller: the seller cannot inspect that
    // account, and a linked id would be tracked on an account other stores share (review M1).
    await platform.update(shipment).set({ status: "unknown" }).where(eq(shipment.orderId, orderId));
    expect(await code(releaseUnknownBooking(s.owner, orderId, { reason: "Sudah dicek, tidak ada order" }))).toBe("not_own_account");
    expect(await code(linkUnknownBooking(s.owner, orderId, { providerOrderId: "ORD-OTHER-STORE" }))).toBe("not_own_account");
    expect(await shipmentOf(orderId)).toMatchObject({ status: "unknown", providerOrderId: null });
  });

  it("a provider COD refusal for the seller turns that courier's COD off for the store and tells the seller; only the seller turns it on again", async () => {
    const s = await ownStore("t105-codrefused");
    await searchDestinationAreas("gubeng", undefined, s.sf);
    const gubeng = { destinationAreaId: GUBENG, destinationAreaLabel: "Gubeng, Gubeng, Surabaya, Jawa Timur 60281" };
    setBookingAdapter(scripted(async () => {
      throw new MengantarError("http", "Mengantar: Pos Indonesia COD is not available for this account", 403, { success: false, status: "new_seller", deliveredRate: 0, minimumDeliveredRate: 82 });
    }));
    const orderId = await paidOrder(s, { paymentMethod: "cod", courier: "JNE", ...gubeng });
    await bookShipment(s.me, orderId);
    await run();
    expect(await shipmentOf(orderId)).toMatchObject({ status: "failed", lastError: COD_REFUSED_MESSAGE });
    const rule = (await platform.select().from(storeCourierRule).where(and(eq(storeCourierRule.storeId, s.storeId), eq(storeCourierRule.courierCode, "JNE"))))[0]!;
    expect(rule).toMatchObject({ enabled: true, codEnabled: false, codRefusedAt: expect.any(Date) });
    const [owner] = await platform.select({ email: user.email }).from(user).where(eq(user.id, s.ownerId));
    expect((await platform.select({ subject: mailOutbox.subject }).from(mailOutbox).where(eq(mailOutbox.toEmail, owner!.email))).map((m) => m.subject)).toContain("COD kurir JNE dimatikan untuk toko Anda");
    expect((await quote(s, GUBENG)).options.find((o) => o.courier === "JNE")!.cod).toBeNull();
    expect((await sellerShippingRules(s.me)).couriers.find((c) => c.courierCode === "JNE")).toMatchObject({ codEnabled: false, codRefusedAt: expect.any(Date) });
    // A form that did not show the refusal (opened before it) never switches the courier's COD back on (review minor 4).
    await saveCourierRules(s.me, { couriers: [{ courierCode: "JNE", enabled: true, codEnabled: true }] });
    expect((await sellerShippingRules(s.me)).couriers.find((c) => c.courierCode === "JNE")).toMatchObject({ enabled: true, codEnabled: false, codRefusedAt: expect.any(Date) });
    // Only the seller who saw it turns it on again.
    await saveCourierRules(s.me, { couriers: [{ courierCode: "JNE", enabled: true, codEnabled: true, refusalSeen: true }] });
    expect((await sellerShippingRules(s.me)).couriers.find((c) => c.courierCode === "JNE")).toMatchObject({ codEnabled: true, codRefusedAt: null });
    expect((await quote(s, GUBENG)).options.find((o) => o.courier === "JNE")!.cod).not.toBeNull();
  });
});

describe("T-105 the one client strips the key; the production switch", () => {
  it("the key is never present in a thrown error of the seller client (raw, URL-encoded or JSON-escaped), and the partner gate does not apply to it", async () => {
    const answers: (() => Promise<Response>)[] = [
      () => Promise.reject(new TypeError(`fetch failed for https://sandbox.example.test/api/public/${encodeURIComponent(KEY)}/order/estimate key=${KEY}`)),
      async () => new Response(`<html>upstream ${KEY} ${encodeURIComponent(KEY)}</html>`, { status: 502 }),
      async () => new Response(JSON.stringify({ success: false, message: `bad key ${KEY}`, errorsFront: `bad ${encodeURIComponent(KEY)}`, code: KEY }), { status: 401 }),
      async () => new Response(JSON.stringify({ success: true, data: { [KEY]: { price: "x" } } }), { status: 200 }),
    ];
    const client = new SellerMengantar(KEY, { mode: "live", origin: "https://sandbox.example.test" });
    const errors: unknown[] = [];
    for (const answer of answers) {
      setSellerMengantarFetch((() => answer()) as typeof fetch); // the same answer for the read's one retry
      errors.push(await client.estimate({ originAreaId: MENTENG, destinationAreaId: MENTENG, weightKg: 1 }).then(() => null, (e: unknown) => e));
    }
    // A booking error built from a provider body that echoes the key.
    setSellerMengantarFetch((async () => new Response(JSON.stringify({ success: true, data: [{ error: `refused for ${KEY}` }], errors: [KEY] }), { status: 200 })) as typeof fetch);
    const booking = client.booking("pickup1", scripted());
    errors.push(await booking.createOrder({ orderId: 1, storeId: 1, courierCode: "JNE", destinationAreaId: MENTENG, weightKg: 1, codAmount: 0, goodsValue: 1, quantity: 1, parcelContent: "x", buyerName: "x", buyerPhone: "081234567890", shippingAddress: "x" }).then(() => null, (e: unknown) => e));
    expect(errors.every((e) => e instanceof Error)).toBe(true);
    expect((errors as MengantarError[]).map((e) => e.code)).toEqual(["network", "http", "http", "invalid_shape", "provider"]);
    for (const e of errors) {
      const text = [inspect(e, { depth: 10, showHidden: true }), JSON.stringify(e), String(e), (e as Error).stack ?? "", JSON.stringify((e as MengantarError).body ?? null), String((e as MengantarError).providerCode)].join("\n");
      for (const form of KEY_FORMS) expect({ error: String(e).slice(0, 60), leaked: text.includes(form) }).toEqual({ error: String(e).slice(0, 60), leaked: false });
    }
    // An error the client itself does not scrub (the body stream fails with the URL in its text): only the one-client guard removes the key,
    // for every operation (confirmation review 6: the key check, the area search and tracking as well as the estimate and booking).
    setSellerMengantarFetch((async () => ({ ok: true, status: 200, text: async () => { throw new TypeError(`body stream failed for /api/public/${KEY}/x key=${encodeURIComponent(KEY)}`); } }) as unknown as Response) as typeof fetch);
    const raw: [string, unknown][] = [
      ["verifyKey", await client.verifyKey().then(() => null, (e: unknown) => e)],
      ["searchArea", await client.searchArea("menteng").then(() => null, (e: unknown) => e)],
      ["track", await client.booking("pickup1", scripted()).track({ providerOrderId: "ORD-1", trackingNumber: null }).then(() => null, (e: unknown) => e)], // a fresh adapter: the live client takes the fetch in force when it is built
      ["estimate", await client.estimate({ originAreaId: MENTENG, destinationAreaId: MENTENG, weightKg: 1 }).then(() => null, (e: unknown) => e)],
    ];
    for (const [op, e] of raw) {
      expect({ op, thrown: e instanceof Error }).toEqual({ op, thrown: true });
      const text = [inspect(e, { depth: 10, showHidden: true }), String(e), (e as Error).stack ?? ""].join("\n");
      for (const form of KEY_FORMS) expect({ op, leaked: text.includes(form) }).toEqual({ op, leaked: false });
    }
    // The platform client still refuses every call while the Partner Secret rotation is not recorded; the seller client did not.
    await expect(new MengantarClient({ apiKey: "platform", fetchImpl: (async () => new Response("{}")) as typeof fetch }).listOrigins()).rejects.toMatchObject({ code: "entry_gate" });
  });

  it("production calls on a seller's key need the Owner console switch, which opens only after a recorded sandbox pass; every change is audited", async () => {
    vi.stubEnv("MENGANTAR_PRODUCTION_ORIGIN", "https://api.example.test");
    expect(await code(sellerTransport(db, "production"))).toBe("provider_off");
    expect(await sellerTransport(db, "sandbox")).toEqual({ mode: "fake" }); // no sandbox origin configured here: the local fake
    // The shared four-eyes action `providers.production_on` (aligned with T-106) needs `providers.manage` of the requester and the approver.
    const op = await makeOperator([...DEFAULT_OPERATOR_CAPABILITIES, "providers.manage", "settings.manage"]);
    const second = await makeOperator([...DEFAULT_OPERATOR_CAPABILITIES, "providers.manage"]);
    await recordSellerTermsReview(op, { version: 1, adviserName: "Penasihat T-105", reviewedOn: "2026-11-23", note: "Syarat penjual v1 ditinjau sebelum uji switch produksi" }); // T-116 gate
    expect(await code(requestMengantarProductionOn(op, { revision: 0, reason: "Pilot dimulai" }))).toBe("sandbox_pass_missing");
    expect(await code(setMengantarProductionCalls(op, { revision: 0, enabled: true, reason: "Pilot dimulai" }))).toBe("sandbox_pass_missing");
    expect(await code(platform.insert(providerLiveSetting).values({ provider: "mengantar", productionEnabled: true, updatedBy: "x" }))).toBe("23514"); // the database refuses it too
    expect(await code(recordMengantarSandboxPass(op, { revision: 0, note: "pendek" }))).not.toBe("ok");
    await recordMengantarSandboxPass(op, { revision: 0, note: "2026-11-16 sandbox estimate + order + simulation lolos; catatan di track report" });
    // Four-eyes (review minor 1): the recorder cannot switch it on alone, nor approve their own request.
    expect(await code(setMengantarProductionCalls(op, { revision: 1, enabled: true, reason: "Pilot dimulai" }))).toBe("approval_invalid");
    const { approvalId } = await requestMengantarProductionOn(op, { revision: 1, reason: "Pilot dimulai" });
    expect(await code(decideApproval(op, approvalId, "approve"))).toBe("self_approval");
    expect(await code(setMengantarProductionCalls(op, { revision: 1, enabled: true, reason: "Pilot dimulai", approvalId }))).toBe("approval_invalid"); // not approved yet
    await decideApproval(second, approvalId, "approve");
    expect(await code(setMengantarProductionCalls(op, { revision: 0, enabled: true, reason: "Pilot dimulai", approvalId }))).toBe("conflict"); // stale revision
    expect(await code(setMengantarProductionCalls(second, { revision: 1, enabled: true, reason: "Pilot dimulai", approvalId }))).toBe("approval_invalid"); // only the requester applies
    // A new sandbox pass after the request voids the approval: the payload names the pass and the revision (confirmation review 5).
    await recordMengantarSandboxPass(op, { revision: 1, note: "2026-11-16 uji sandbox ulang setelah perubahan akun" });
    expect(await code(setMengantarProductionCalls(op, { revision: 2, enabled: true, reason: "Pilot dimulai", approvalId }))).toBe("approval_invalid");
    const fresh = await requestMengantarProductionOn(op, { revision: 2, reason: "Pilot dimulai" });
    await decideApproval(second, fresh.approvalId, "approve");
    await setMengantarProductionCalls(op, { revision: 2, enabled: true, reason: "Pilot dimulai", approvalId: fresh.approvalId });
    expect(await sellerTransport(db, "production")).toEqual({ mode: "live", origin: "https://api.example.test" });
    expect(await code(setMengantarProductionCalls(op, { revision: 3, enabled: true, reason: "Lagi dong", approvalId: fresh.approvalId }))).toBe("approval_invalid"); // used once
    // Switching OFF is immediate (the safe direction).
    await setMengantarProductionCalls(op, { revision: 3, enabled: false, reason: "Gangguan penyedia" });
    expect(await code(sellerTransport(db, "production"))).toBe("provider_off");
    const audit = await platform.select({ action: auditLog.action, actor: auditLog.actorUserId }).from(auditLog).where(and(eq(auditLog.subjectKind, "provider_live_setting"), sql`${auditLog.action} like 'provider.%'`)).orderBy(auditLog.id);
    expect(audit.map((a) => a.action)).toEqual(["provider.sandbox_pass", "provider.sandbox_pass", "provider.production.on", "provider.production.off"]);
    expect(audit.every((a) => a.actor === op.userId)).toBe(true);
    // The application role reads the switch and never writes it.
    expect(await code(db.update(providerLiveSetting).set({ productionEnabled: true }))).toBe("42501");
    // A production account's pickup registration (a provider call) is refused before any call while the switch is off.
    expect(await code(ownStore("t105-prod", { environment: "production" }))).toBe("provider_off");
  });
});

describe("T-105 review fixes: onboarding order, province per environment, provider-call limits, the worker's key", () => {
  it("a new seller checks and saves the key before any pickup area (the keyed pickup-address list), then searches the pickup area on that key", async () => {
    vi.stubEnv("MENGANTAR_SANDBOX_ORIGIN", "https://sandbox.example.test");
    setProviderCheckTransport(null); // the real check path: the live Mengantar check of shipping/seller.ts
    const calls = stubProvider({ JNE: 12_000 });
    const s = await makeStore("t105-new", { pickupArea: false });
    const me = bindSession(s.owner, await sessionOf(s.ownerId));
    await acceptSellerTerms(me, { version: 1, agreed: true }); // T-116
    await saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: KEY, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar" }) });
    const keyed = `https://sandbox.example.test/api/public/${encodeURIComponent(KEY)}`;
    // T-115: then the dedicated-account check reads one page of the account's order list on the same key (archive included).
    expect(calls.map((c) => [c.method, c.url.split("?")[0]])).toEqual([["GET", `${keyed}/address`], ["GET", `${keyed}/order`]]);
    const areas = await searchPickupAreas(me, "menteng");
    expect(areas[0]).toMatchObject({ id: MENTENG, province: "DKI JAKARTA" });
    expect(calls.at(-1)!.url).toBe(`${keyed}/address/search?keyword=menteng`);
    // A refused key stores nothing (the check is a provider read on that key).
    setSellerMengantarFetch((async () => new Response(JSON.stringify({ success: false, message: "invalid key" }), { status: 401 })) as typeof fetch);
    expect(await code(saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: `${KEY}-WRONG`, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar" }) }))).toBe("check_failed");
  });

  it("the province of an area is kept per environment: a sandbox answer never changes the production province", async () => {
    await rememberAreas(db, [{ id: MENTENG, label: "Menteng", province: "DKI JAKARTA" }], "production");
    await rememberAreas(db, [{ id: MENTENG, label: "Menteng", province: "PAPUA" }], "sandbox");
    expect(await areaProvince(db, MENTENG, "production")).toBe("dki-jakarta");
    expect(await areaProvince(db, MENTENG, "sandbox")).toBe("papua");
    expect(await areaProvince(db, GUBENG, "production")).toBeNull();
  });

  it("buyer-driven provider calls on a seller's key are rate limited per client IP and per store, before any call; the seller's pickup search has its own bucket", async () => {
    vi.stubEnv("MENGANTAR_SANDBOX_ORIGIN", "https://sandbox.example.test");
    const calls = stubProvider({ JNE: 12_000 });
    const s = await ownStore("t105-limits");
    const ip = { clientIp: "203.0.113.9" };
    for (let i = 0; i < SELLER_PROVIDER_LIMITS.area.ip.limit; i++) await searchDestinationAreas("menteng", undefined, s.sf, ip);
    let before = calls.length;
    expect(await code(searchDestinationAreas("menteng", undefined, s.sf, ip))).toBe("rate_limited");
    expect(calls.length).toBe(before); // refused before any provider call
    expect(await code(searchDestinationAreas("menteng", undefined, s.sf, { clientIp: "203.0.113.10" }))).toBe("ok"); // another buyer, same store
    // The store-wide buyer buckets are cost ceilings: full, they refuse buyers before the call, but never the seller's own pickup search.
    const window = sql`to_timestamp(floor(extract(epoch from now()) / 600) * 600)`;
    await admin.execute(sql`insert into rate_limit (key, window_start, count) values (${`seller-area:store:${s.storeId}`}, ${window}, ${SELLER_PROVIDER_LIMITS.area.store.limit}) on conflict (key, window_start) do update set count = excluded.count`);
    await admin.execute(sql`insert into rate_limit (key, window_start, count) values (${`seller-quote:store:${s.storeId}`}, ${window}, ${SELLER_PROVIDER_LIMITS.quote.store.limit})`);
    before = calls.length;
    expect(await code(searchDestinationAreas("menteng", undefined, s.sf, { clientIp: "203.0.113.11" }))).toBe("rate_limited");
    expect(await code(quote(s))).toBe("rate_limited");
    expect(calls.length).toBe(before);
    expect((await searchPickupAreas(s.me, "menteng")).map((a) => a.id)).toEqual([MENTENG]);
    expect(calls.length).toBe(before + 1);
  });

  it("the booking worker calls the provider with the order's own store key in the path, never another store's key or the platform key", async () => {
    vi.stubEnv("MENGANTAR_SANDBOX_ORIGIN", "https://sandbox.example.test");
    vi.stubEnv("MENGANTAR_API_KEY", "PLATFORM-KEY-never-used-0123456789");
    const KEY_B = "CANARY-T105-store-b-key-0123456789";
    const calls = stubProvider({ JNE: 12_000 });
    const a = await ownStore("t105-worker-a");
    await ownStore("t105-worker-b", { key: KEY_B });
    await searchDestinationAreas("menteng", undefined, a.sf);
    const orderId = await paidOrder(a);
    const from = calls.length;
    await bookShipment(a.me, orderId, { pickupType: "drop_off" });
    await run("book");
    const booking = calls.slice(from).filter((c) => c.method === "POST" && new URL(c.url).pathname.endsWith("/order"));
    expect(booking).toHaveLength(1);
    expect(booking[0]!.url).toBe(`https://sandbox.example.test/api/public/${encodeURIComponent(KEY)}/order`);
    expect(booking[0]!.headers.idempotencyKey).toBe(`bk-${a.storeId}-${orderId}-0`);
    expect(JSON.parse(booking[0]!.body!)).toMatchObject({ courier: "JNE", pickup: { type: "dropOff", address_id: "pickupaddr0001" } });
    for (const other of [KEY_B, "PLATFORM-KEY-never-used-0123456789"]) expect(calls.slice(from).some((c) => c.url.includes(encodeURIComponent(other)))).toBe(false);
    expect(await shipmentOf(orderId)).toMatchObject({ status: "booked", providerOrderId: "ORD-STUB-1", trackingNumber: "RESI-STUB-1" });
  });
});

