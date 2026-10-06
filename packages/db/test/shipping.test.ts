import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MengantarClient, MengantarError, MengantarWriteDisabledError, redactUrl } from "../src/mengantar/client.ts";
import { mengantarAdapter, toProviderQuote } from "../src/mengantar/adapter.ts";
import { areaListSchema, pickupAddressListSchema, rateMapSchema } from "../src/mengantar/schemas.ts";
import { fakeMengantar, type ProviderQuote } from "../src/providers.ts";
import { auditLog, shippingMarginRule } from "../src/schema.ts";
import {
  applyMargin,
  DEFAULT_MARGIN_RULE,
  getMarginRule,
  getPickupArea,
  marginRuleAudit,
  quoteWithMargin,
  searchPickupAreas,
  setMarginRule,
  setPickupAddress,
  setPickupArea,
  shippingOptions,
} from "../src/shipping.ts";
import { membership } from "../src/schema.ts";
import { db, makeStore, makeUser, seller } from "./helpers.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/mengantar/${name}.json`, import.meta.url), "utf8"));
const KEY = "testkey-0123456789abcdef";
const quote = (over: Partial<ProviderQuote> = {}): ProviderQuote => ({
  courier: "JNE",
  label: "JNE",
  unsupported: false,
  unsupportedCod: false,
  providerCost: 10_500,
  providerCostCod: 15_494,
  ...over,
});

/** A fetch stub returning the given body/status (or throwing) per call. */
function fetchStub(responses: ({ status?: number; body: unknown } | Error)[]) {
  const calls: string[] = [];
  const f: typeof fetch = async (input) => {
    calls.push(String(input));
    const r = responses.shift();
    if (!r) throw new Error("no more stubbed responses");
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { f, calls };
}

describe("margin math (Q-12)", () => {
  it("fixed + percent, rounded up to the step; margin = buyer fee − cost; integer IDR", () => {
    expect(applyMargin(10_500, { fixedIdr: 2_000, percentBps: 0, roundTo: 500 })).toEqual({ providerCost: 10_500, margin: 2_000, buyerFee: 12_500 });
    // 15_494 + 2_000 = 17_494 → 17_500
    expect(applyMargin(15_494, DEFAULT_MARGIN_RULE)).toEqual({ providerCost: 15_494, margin: 2_006, buyerFee: 17_500 });
    // 2.5 % of 22_320 = 558 → 22_320 + 1_000 + 558 = 23_878 → 24_000 (step 1000)
    expect(applyMargin(22_320, { fixedIdr: 1_000, percentBps: 250, roundTo: 1000 })).toEqual({ providerCost: 22_320, margin: 1_680, buyerFee: 24_000 });
    // percent ceil: 1 bp of 9_000 = 0.9 → 1; no rounding step
    expect(applyMargin(9_000, { fixedIdr: 0, percentBps: 1, roundTo: 1 })).toEqual({ providerCost: 9_000, margin: 1, buyerFee: 9_001 });
    // exact multiple does not round up again
    expect(applyMargin(10_000, { fixedIdr: 0, percentBps: 0, roundTo: 500 }).buyerFee).toBe(10_000);
    expect(() => applyMargin(10_000.5, DEFAULT_MARGIN_RULE)).toThrow();
    expect(() => applyMargin(-1, DEFAULT_MARGIN_RULE)).toThrow();
  });

  it("gating: unsupported couriers are dropped, COD-refused couriers keep prepaid only; cheapest first", () => {
    const options = quoteWithMargin(
      [
        quote({ courier: "pos", unsupported: true }),
        quote({ courier: "SiCepat", unsupportedCod: true, providerCost: 8_000, providerCostCod: 12_994 }),
        quote({ courier: "JNE" }),
      ],
      DEFAULT_MARGIN_RULE,
    );
    expect(options.map((o) => o.courier)).toEqual(["SiCepat", "JNE"]);
    expect(options[0]!.cod).toBeNull();
    expect(options[0]!.prepaid).toEqual({ providerCost: 8_000, margin: 2_000, buyerFee: 10_000 });
    expect(options[1]!.cod).toEqual({ providerCost: 15_494, margin: 2_006, buyerFee: 17_500 });
    expect(options[1]!.prepaid.buyerFee).toBe(12_500);
  });
});

describe("Mengantar client", () => {
  it("redacts the key segment of a URL and any other occurrence of the key", () => {
    const url = `https://api-public.mengantar.com/api/public/${KEY}/order/estimate?origin_id=1&x=${KEY}`;
    const red = redactUrl(url, KEY);
    expect(red).not.toContain(KEY);
    expect(red).toBe("https://api-public.mengantar.com/api/public/**redacted**/order/estimate?origin_id=1&x=**redacted**");
    expect(redactUrl(`https://h/api/public/${KEY}/address`)).toBe("https://h/api/public/**redacted**/address");
  });

  it("write methods throw without MENGANTAR_WRITE_ENABLED=1 and never call fetch", async () => {
    const { f, calls } = fetchStub([]);
    const c = new MengantarClient({ apiKey: KEY, fetchImpl: f });
    expect(c.writeEnabled).toBe(false);
    const writes = [
      () => c.createOrder({ courier: "JNE", pickup: {}, orders: [] }),
      () => c.upsertOrigin({}),
      () => c.deleteAddress("x"),
      () => c.addPickupTime({ address_id: "x", date: "01-01-2027", time: "9:00" }),
      () => c.payUnpaid("b"),
      () => c.addDropshipper({ name: "n", phone: "0" }),
      () => c.deleteOrders(["x"]),
      () => c.deleteBatch("x"),
    ];
    for (const w of writes) await expect(w()).rejects.toBeInstanceOf(MengantarWriteDisabledError);
    expect(calls).toEqual([]);
  });

  it("reads: redacted onRequest, envelope unwrap, zod validation, provider errors without the URL", async () => {
    const { f, calls } = fetchStub([{ body: fixture("address-search") }, { status: 403, body: { success: false, message: "Not allowed" } }, { body: { success: true, data: [{ nope: 1 }] } }]);
    const seen: string[] = [];
    const c = new MengantarClient({ apiKey: KEY, fetchImpl: f, onRequest: (i) => seen.push(i.url) });
    const areas = await c.searchArea("Bandung");
    expect(areas).toHaveLength(2);
    expect(areas[0]!._id).toMatch(/^[a-f0-9]{24}$/);
    expect(calls[0]).toContain(KEY); // the real request carries the key …
    expect(seen[0]).not.toContain(KEY); // … the log never does
    expect(seen[0]).toContain("/api/public/**redacted**/address/search?keyword=Bandung");

    const err = await c.getReceiverScore("081234567890").catch((e) => e);
    expect(err).toBeInstanceOf(MengantarError);
    expect(err).toMatchObject({ code: "http", status: 403, message: "Mengantar: Not allowed" });
    expect(JSON.stringify(err.body)).not.toContain(KEY);

    await expect(c.listOrigins()).rejects.toMatchObject({ code: "invalid_shape" });
    expect(await c.searchArea("ab")).toEqual([]); // too short: no call
    expect(calls).toHaveLength(3);
  });

  it("retries an idempotent read once on a network error and on 5xx, not on 4xx", async () => {
    const ok = { body: fixture("estimate-3pl") };
    const a = fetchStub([new Error("ECONNRESET"), ok]);
    const c1 = new MengantarClient({ apiKey: KEY, fetchImpl: a.f });
    expect(Object.keys(await c1.estimate3pl({ originAreaId: "o", destinationAreaId: "d", weightKg: 1 }))).toContain("JNE");
    expect(a.calls).toHaveLength(2);
    expect(a.calls[0]).not.toContain(KEY); // 3PL endpoint is keyless by contract

    const b = fetchStub([{ status: 502, body: "bad gateway" }, { status: 502, body: "bad gateway" }]);
    await expect(new MengantarClient({ apiKey: KEY, fetchImpl: b.f }).listOrigins()).rejects.toMatchObject({ code: "http", status: 502 });
    expect(b.calls).toHaveLength(2);

    const d = fetchStub([{ status: 400, body: { success: false, message: "Invalid courier", code: "COURIER_DISABLED" } }]);
    await expect(new MengantarClient({ apiKey: KEY, fetchImpl: d.f }).listOrigins()).rejects.toMatchObject({ providerCode: "COURIER_DISABLED" });
    expect(d.calls).toHaveLength(1);
  });

  it("times out", async () => {
    const f: typeof fetch = (_u, init) =>
      new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)));
    const c = new MengantarClient({ apiKey: KEY, fetchImpl: f, timeoutMs: 20 });
    await expect(c.listOrigins()).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("recorded fixtures (observed 2026-10-06, sanitized)", () => {
  it("validate against the schemas and contain no key", () => {
    for (const name of ["address-search", "address-list", "estimate-3pl", "estimate-all-cod", "receiver-score-403"]) {
      expect(JSON.stringify(fixture(name))).not.toMatch(/api\/public\/[A-Za-z0-9]{16,}/);
    }
    expect(areaListSchema.parse(fixture("address-search").data)).toHaveLength(2);
    expect(pickupAddressListSchema.parse(fixture("address-list").data)[0]!.PICKUP_AUTOFILL).toMatch(/^[a-f0-9]{24}$/);
    const threePl = rateMapSchema.parse(fixture("estimate-3pl").data);
    expect(threePl.JNE).toMatchObject({ price: 21000, unsupported: null });
    const account = rateMapSchema.parse(fixture("estimate-all-cod").data);
    expect(account.JNE).toMatchObject({ price: 11000, estimatedSpecialPrice: 15494, codFee: 4994 });
    expect(account.SapCargo!.unsupported_cod).toBe(true);
    expect(fixture("receiver-score-403")).toEqual({ status: 403, body: { success: false, message: "Not allowed" } });
  });

  it("map to provider quotes: cost basis, flags, cargo minimum weight; adapter end-to-end over the fixture", async () => {
    const account = rateMapSchema.parse(fixture("estimate-all-cod").data);
    expect(toProviderQuote("JNE", account.JNE!, 1)).toEqual({
      courier: "JNE",
      label: "JNE Express",
      etd: "1 - 2 days",
      unsupported: false,
      unsupportedCod: false,
      providerCost: 10_500, // 15_494 − codFee 4_994
      providerCostCod: 15_494,
    });
    expect(toProviderQuote("SapCargo", account.SapCargo!, 1)).toBeNull(); // minimumWeightCargo 5
    expect(toProviderQuote("SapCargo", account.SapCargo!, 5)).toMatchObject({ unsupportedCod: true });
    expect(toProviderQuote("x", { unsupported: true }, 1)).toBeNull(); // no price
    expect(toProviderQuote("x", { price: 100, unsupportedOriginSpx: true }, 1)).toMatchObject({ unsupported: true, label: "x" });

    const { f } = fetchStub([{ body: fixture("estimate-all-cod") }, { body: fixture("address-search") }]);
    const adapter = mengantarAdapter(new MengantarClient({ apiKey: KEY, fetchImpl: f }));
    const quotes = await adapter.estimate({ originAreaId: "a".repeat(24), destinationAreaId: "b".repeat(24), weightKg: 1, codAmount: 150_000 });
    expect(quotes.map((q) => q.courier)).not.toContain("SapCargo");
    expect(quotes.find((q) => q.courier === "anteraja")).toMatchObject({ providerCost: 8_500, providerCostCod: 13_494 });
    const areas = await adapter.searchArea("Bandung");
    expect(areas[0]).toEqual({ id: "5fc64922f8f44b34aa4ce896", label: "SUMUR BANDUNG, JAYANTI, TANGERANG, BANTEN 15610" });
  });
});

describe("margin rule and pickup origin (store-scoped)", () => {
  it("operator edits the rule with an audit row; the default applies until then", async () => {
    await db.delete(shippingMarginRule);
    const s = await makeStore("toko-a");
    expect(await getMarginRule(db)).toEqual(DEFAULT_MARGIN_RULE);
    await setMarginRule(s.op, { fixedIdr: "1500", percentBps: 250, roundTo: "1000" });
    await setMarginRule(s.op, { fixedIdr: 3000, percentBps: 0, roundTo: 500 });
    expect(await getMarginRule(db)).toEqual({ fixedIdr: 3000, percentBps: 0, roundTo: 500 });
    const audit = await marginRuleAudit(s.op);
    expect(audit.map((a) => a.reason)).toEqual(["fixed=3000 bps=0 roundTo=500", "fixed=1500 bps=250 roundTo=1000"]);
    expect(audit[0]).toMatchObject({ actorUserId: s.op.userId, storeId: null });
    await expect(setMarginRule(s.op, { fixedIdr: -1, percentBps: 0, roundTo: 500 })).rejects.toMatchObject({ name: "ZodError" });
    await expect(setMarginRule(s.op, { fixedIdr: 0, percentBps: 0, roundTo: 7 })).rejects.toMatchObject({ name: "ZodError" });
    expect(await db.select().from(auditLog)).toHaveLength(2 + 1); // + store.create
  });

  it("pickup area is per store, owner-only, searched server-side through the adapter", async () => {
    const a = await makeStore("toko-a", { pickupArea: false });
    const b = await makeStore("toko-b", { pickupArea: false });
    expect(await getPickupArea(a.owner)).toBeNull();

    const found = await searchPickupAreas(a.owner, "braga", fakeMengantar);
    expect(found).toHaveLength(1);
    await expect(searchPickupAreas(a.owner, "br", fakeMengantar)).rejects.toMatchObject({ code: "keyword" });

    await expect(setPickupAddress(a.owner, { addressText: "Jl. Braga No. 10, Bandung" })).rejects.toMatchObject({ code: "no_pickup_area" });
    await setPickupArea(a.owner, { areaId: found[0]!.id, areaLabel: found[0]!.label });
    await setPickupAddress(a.owner, { addressText: "Jl. Braga No. 10, Bandung" });
    expect(await getPickupArea(a.owner)).toMatchObject({ areaId: found[0]!.id, areaLabel: found[0]!.label, addressText: "Jl. Braga No. 10, Bandung" });
    // Re-choosing an area keeps the address text (upsert on store_id).
    await setPickupArea(a.owner, { areaId: "a2a2a2a2a2a2a2a2a2a2a2a2", areaLabel: "Cihapit, Bandung" });
    expect(await getPickupArea(a.owner)).toMatchObject({ areaId: "a2a2a2a2a2a2a2a2a2a2a2a2", addressText: "Jl. Braga No. 10, Bandung" });

    // Isolation: store B sees nothing and its own write does not touch A.
    expect(await getPickupArea(b.owner)).toBeNull();
    await setPickupArea(b.owner, { areaId: "b1b1b1b1b1b1b1b1b1b1b1b1", areaLabel: "Menteng, Jakarta Pusat" });
    expect((await getPickupArea(a.owner))!.areaId).toBe("a2a2a2a2a2a2a2a2a2a2a2a2");
    expect((await getPickupArea(b.owner))!.areaId).toBe("b1b1b1b1b1b1b1b1b1b1b1b1");

    // Staff can read but not manage.
    const staffId = await makeUser("staff");
    await db.insert(membership).values({ storeId: a.storeId, userId: staffId, role: "staff" });
    const staff = await seller(staffId);
    expect((await getPickupArea(staff))!.areaId).toBe("a2a2a2a2a2a2a2a2a2a2a2a2");
    await expect(setPickupArea(staff, { areaId: "c1c1c1c1c1c1c1c1c1c1c1c1", areaLabel: "Gubeng" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(searchPickupAreas(staff, "braga", fakeMengantar)).rejects.toMatchObject({ code: "forbidden" });
    // Browser-supplied ids are validated.
    await expect(setPickupArea(a.owner, { areaId: "../etc", areaLabel: "x" })).rejects.toMatchObject({ name: "ZodError" });
  });

  it("shippingOptions: needs the store's pickup area, applies the rule and gating, is ready for the order snapshot", async () => {
    await db.delete(shippingMarginRule);
    const a = await makeStore("toko-a", { pickupArea: false });
    const b = await makeStore("toko-b", { pickupArea: false });
    await expect(shippingOptions(a.sf, "b1b1b1b1b1b1b1b1b1b1b1b1", { items: 2, subtotal: 200_000 }, fakeMengantar)).rejects.toMatchObject({ code: "no_pickup_area" });
    await setPickupArea(a.owner, { areaId: "a1a1a1a1a1a1a1a1a1a1a1a1", areaLabel: "Braga, Bandung" });
    await setMarginRule(a.op, { fixedIdr: 2000, percentBps: 0, roundTo: 500 });

    const r = await shippingOptions(a.sf, "b1b1b1b1b1b1b1b1b1b1b1b1", { items: 2, subtotal: 200_000 }, fakeMengantar);
    expect(r).toMatchObject({ originAreaId: "a1a1a1a1a1a1a1a1a1a1a1a1", destinationAreaId: "b1b1b1b1b1b1b1b1b1b1b1b1", weightKg: 2 });
    expect(r.options.map((o) => o.courier)).toEqual(["SiCepat", "JNE"]); // pos unsupported → hidden
    expect(r.options[0]!.cod).toBeNull(); // SiCepat refuses COD
    // JNE at 2 kg: prepaid 15_500 + 2_000 = 17_500; COD 20_494 + 2_000 = 22_494 → 22_500
    expect(r.options[1]!.prepaid).toEqual({ providerCost: 15_500, margin: 2_000, buyerFee: 17_500 });
    expect(r.options[1]!.cod).toEqual({ providerCost: 20_494, margin: 2_006, buyerFee: 22_500 });
    for (const o of r.options) for (const f of [o.prepaid, o.cod]) if (f) expect(f.buyerFee).toBe(f.providerCost + f.margin);

    // Store B has no pickup area: its storefront gets the error even though A is configured.
    await expect(shippingOptions(b.sf, "a1a1a1a1a1a1a1a1a1a1a1a1", { items: 1, subtotal: 50_000 }, fakeMengantar)).rejects.toMatchObject({ code: "no_pickup_area" });
    await expect(shippingOptions(a.sf, "not-an-area", { items: 1, subtotal: 50_000 }, fakeMengantar)).rejects.toMatchObject({ name: "ZodError" });
  });
});
