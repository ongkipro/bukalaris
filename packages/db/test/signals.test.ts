import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { placeOrder } from "../src/checkout.ts";
import { MAX_ATTEMPTS, runOnce } from "../src/jobs.ts";
import { transitionOrder } from "../src/orders.ts";
import { job, membership, orderSignalContext, product, signalEvent, variant } from "../src/schema.ts";
import {
  browserSignals,
  collectFunnelEvent,
  destinationHealth,
  enqueuePurchase,
  listDestinations,
  metaOutcome,
  metaRequest,
  nameParts,
  normalizeEmail,
  openToken,
  parseClickCookie,
  phoneDigits62,
  phoneE164,
  purchaseEventId,
  purgeSignalContext,
  requestUser,
  saveDestination,
  sealToken,
  setSignalTransport,
  sha256,
  tiktokOutcome,
  tiktokRequest,
  tokenKey,
  type SignalPayload,
  type SignalRequest,
  type SignalResponse,
} from "../src/signals.ts";
import { setCartLine } from "../src/storefront.ts";
import { buyer, db, makeStore, makeUser, seller } from "./helpers.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");
process.env.INTEGRATION_TOKEN_KEY = KEY;

/** Records every request; answers from the script (last answer repeats), or throws when the script says so. */
function fakeTransport(script: (SignalResponse | Error)[] = [{ status: 200, body: { events_received: 1, code: 0 } }]) {
  const requests: SignalRequest[] = [];
  setSignalTransport(async (req) => {
    requests.push(req);
    const r = script.length > 1 ? script.shift()! : script[0]!;
    if (r instanceof Error) throw r;
    return r;
  });
  return requests;
}
afterEach(() => setSignalTransport(null));

const payload = (over: Partial<SignalPayload> = {}): SignalPayload => ({
  eventTime: 1_800_000_000,
  value: 200_000,
  currency: "IDR",
  contents: [{ id: "10001", quantity: 2, item_price: 100_000 }],
  contentIds: ["10001"],
  groupIds: ["10000"],
  numItems: 2,
  orderId: "7",
  user: { ph62: sha256("6281234567890"), phE164: sha256("+6281234567890"), fbp: "fb.1.1700000000000.123", ip: "203.0.113.7", ua: "UA" },
  ...over,
});
const request = (cookies: Record<string, string | undefined> = {}) => ({ cookies, clientIp: "203.0.113.7", userAgent: "Mozilla/5.0 test", url: "https://toko-a.localhost/" });
const events = (storeId: number) => db.select().from(signalEvent).where(eq(signalEvent.storeId, storeId)).orderBy(signalEvent.provider);

async function configured(slug: string, providers: ("meta" | "tiktok" | "google")[] = ["meta", "tiktok"]) {
  const s = await makeStore(slug, { price: 100_000 });
  for (const p of providers) {
    await saveDestination(s.owner, p, {
      pixelId: p === "meta" ? "123456789012345" : p === "tiktok" ? "C0FAKEPIXEL0001" : "AW-123456789",
      conversionLabel: p === "google" ? "abcDEF123" : undefined,
      token: p === "google" ? undefined : `tok-${p}-${slug}`,
      testEventCode: p === "meta" ? "TEST1234" : undefined,
      enabled: true,
    });
  }
  return s;
}

describe("normalization and hashing (PR-20 Matching)", () => {
  it("Indonesian phone → 62… digits for Meta and +62… for TikTok/Google; junk → null", () => {
    for (const raw of ["081234567890", "+62 812-3456-7890", "6281234567890", "62081234567890", "0812 3456 7890"]) {
      expect(phoneDigits62(raw), raw).toBe("6281234567890");
      expect(phoneE164(raw), raw).toBe("+6281234567890");
    }
    expect(phoneDigits62("abc")).toBeNull();
    expect(phoneDigits62("12")).toBeNull();
    expect(phoneE164("")).toBeNull();
  });
  it("email trim + lowercase, only when it is an address; names lowercase ASCII, single word = first name", () => {
    expect(normalizeEmail("  Budi@Example.COM ")).toBe("budi@example.com");
    expect(normalizeEmail("bukan email")).toBeNull();
    expect(nameParts("Budi Santoso")).toEqual({ fn: "budi", ln: "santoso" });
    expect(nameParts("Budi")).toEqual({ fn: "budi", ln: null });
    expect(nameParts("  Ésa  Van Dé ")).toEqual({ fn: "esa", ln: "de" });
    expect(nameParts("123")).toEqual({ fn: null, ln: null });
  });
  it("click cookie parsing is strict and _fbc is derived from fbclid only when the pixel cookie is absent", () => {
    expect(parseClickCookie(encodeURIComponent(JSON.stringify({ fbclid: "IwAR1abc", gclid: "Cj0K", utm: { source: "fb" }, t: 1700000000000 })))).toMatchObject({ fbclid: "IwAR1abc", gclid: "Cj0K" });
    expect(parseClickCookie("not json")).toBeNull();
    expect(parseClickCookie(encodeURIComponent(JSON.stringify({ fbclid: "<script>" })))).toBeNull();
    const derived = requestUser(request({ bl_click: encodeURIComponent(JSON.stringify({ fbclid: "IwAR1abc", t: 1700000000000 })) }));
    expect(derived.fbc).toBe("fb.1.1700000000000.IwAR1abc");
    const own = requestUser(request({ _fbc: "fb.1.1700000000001.real", _fbp: "fb.1.1700000000000.42", _ttp: "ttp-value", bl_click: encodeURIComponent(JSON.stringify({ fbclid: "IwAR1abc" })) }));
    expect(own).toMatchObject({ fbc: "fb.1.1700000000001.real", fbp: "fb.1.1700000000000.42", ttp: "ttp-value", ip: "203.0.113.7" });
    expect(requestUser(request({ _fbp: "garbage" })).fbp).toBeUndefined();
  });
});

describe("token sealing (SEC-11)", () => {
  it("round-trips, detects tampering, refuses another row's AAD and another key", () => {
    const sealed = sealToken("EAAB-secret-token", 1, "meta");
    expect(sealed).not.toContain("secret");
    expect(openToken(sealed, 1, "meta")).toBe("EAAB-secret-token");
    const [v, iv, ct, tag] = sealed.split(".");
    const flipped = ct![0] === "A" ? `B${ct!.slice(1)}` : `A${ct!.slice(1)}`;
    expect(() => openToken(`${v}.${iv}.${flipped}.${tag}`, 1, "meta")).toThrow(/tidak terbaca/);
    expect(() => openToken(sealed, 2, "meta")).toThrow(/tidak terbaca/);
    expect(() => openToken(sealed, 1, "tiktok")).toThrow(/tidak terbaca/);
    expect(() => openToken(sealed, 1, "meta", Buffer.alloc(32, 9))).toThrow(/tidak terbaca/);
    expect(() => openToken("garbage", 1, "meta")).toThrow(/tidak terbaca/);
  });
  it("validates the key material", () => {
    expect(tokenKey(KEY)).toHaveLength(32);
    expect(tokenKey("ff".repeat(32))).toHaveLength(32);
    expect(() => tokenKey("short")).toThrow(/32 byte/);
    expect(() => tokenKey("")).toThrow(/belum diatur/);
  });
});

describe("provider request shapes (unverified until a test-event call is approved)", () => {
  it("Meta: hashed ph/fn/ln arrays, raw fbp/IP/UA, value = goods subtotal, string content ids, test_event_code", () => {
    const req = metaRequest({ pixelId: "123456789012345", token: "tok", testEventCode: "TEST1" }, { eventName: "Purchase", eventId: "purchase:7", payload: payload() });
    expect(req.url).toBe("https://graph.facebook.com/v26.0/123456789012345/events?access_token=tok");
    const body = req.body as { data: Record<string, unknown>[]; test_event_code: string };
    expect(body.test_event_code).toBe("TEST1");
    expect(body.data[0]).toMatchObject({
      event_name: "Purchase",
      event_id: "purchase:7",
      event_time: 1_800_000_000,
      action_source: "website",
      user_data: { ph: [sha256("6281234567890")], fbp: "fb.1.1700000000000.123", client_ip_address: "203.0.113.7", client_user_agent: "UA" },
      custom_data: { value: 200_000, currency: "IDR", content_type: "product", content_ids: ["10001"], contents: [{ id: "10001", quantity: 2, item_price: 100_000 }], order_id: "7" },
    });
    const ud = body.data[0]!.user_data as Record<string, unknown>;
    expect(ud).not.toHaveProperty("em");
    expect(ud).not.toHaveProperty("fbc");
    expect(body.data[0]).not.toHaveProperty("event_source_url");
    const ic = metaRequest({ pixelId: "1", token: "t", testEventCode: null }, { eventName: "InitiateCheckout", eventId: "x", payload: payload({ orderId: undefined, url: "https://s/checkout" }) }).body as { data: Record<string, Record<string, unknown>>[]; test_event_code?: string };
    expect(ic.test_event_code).toBeUndefined();
    expect(ic.data[0]!.custom_data!.num_items).toBe(2);
    expect(ic.data[0]!.event_source_url).toBe("https://s/checkout");
  });
  it("TikTok: Access-Token header, event_source web, +E.164 phone hash, contents with content_id/price", () => {
    const req = tiktokRequest({ pixelId: "C0FAKEPIXEL0001", token: "tt-tok", testEventCode: null }, { eventName: "Purchase", eventId: "purchase:7", payload: payload() });
    expect(req.url).toBe("https://business-api.tiktok.com/open_api/v1.3/event/track/");
    expect(req.headers).toEqual({ "Access-Token": "tt-tok" });
    expect(req.body).toMatchObject({
      event_source: "web",
      event_source_id: "C0FAKEPIXEL0001",
      data: [
        {
          event: "Purchase",
          event_id: "purchase:7",
          user: { phone: [sha256("+6281234567890")], ip: "203.0.113.7", user_agent: "UA" },
          properties: { contents: [{ content_id: "10001", content_type: "product", quantity: 2, price: 100_000 }], currency: "IDR", value: 200_000, order_id: "7" },
        },
      ],
    });
    expect(req.body).not.toHaveProperty("test_event_code");
  });
  it("classifies responses: throttling/5xx retry, token/parameter errors permanent", () => {
    expect(metaOutcome({ status: 200, body: { events_received: 1 } })).toEqual({ kind: "ok" });
    expect(metaOutcome({ status: 500, body: "" }).kind).toBe("retry");
    expect(metaOutcome({ status: 400, body: { error: { code: 4, message: "too many calls" } } }).kind).toBe("retry");
    expect(metaOutcome({ status: 400, body: { error: { code: 190, message: "Invalid OAuth access token" } } })).toEqual({ kind: "permanent", error: "Meta HTTP 400 code 190: Invalid OAuth access token" });
    expect(metaOutcome({ status: 400, body: { error: { code: 100, message: "Invalid parameter" } } }).kind).toBe("permanent");
    expect(tiktokOutcome({ status: 200, body: { code: 0, message: "OK" } })).toEqual({ kind: "ok" });
    expect(tiktokOutcome({ status: 200, body: { code: 40001, message: "param" } }).kind).toBe("permanent");
    expect(tiktokOutcome({ status: 401, body: { code: 40105, message: "token" } }).kind).toBe("permanent");
    expect(tiktokOutcome({ status: 503, body: "" }).kind).toBe("retry");
    expect(tiktokOutcome({ status: 429, body: { code: 40100 } }).kind).toBe("retry");
  });
});

describe("destinations (seller settings)", () => {
  it("owner saves; token is sealed, write-only and kept when blank; staff is denied; validation per provider", async () => {
    const s = await makeStore("toko-a");
    await saveDestination(s.owner, "meta", { pixelId: "123456789012345", token: "EAAB-tok", enabled: true });
    const [d] = await listDestinations(s.owner);
    expect(d).toMatchObject({ provider: "meta", pixelId: "123456789012345", hasToken: true, enabled: true });
    expect(JSON.stringify(d)).not.toContain("EAAB");
    const [row] = await db.execute(sql`select token_ciphertext from signal_destination`);
    expect(String(row!.token_ciphertext)).toMatch(/^v1\./);
    expect(String(row!.token_ciphertext)).not.toContain("EAAB");
    expect(openToken(String(row!.token_ciphertext), s.storeId, "meta")).toBe("EAAB-tok");

    await saveDestination(s.owner, "meta", { pixelId: "123456789012345", enabled: false, testEventCode: "TEST99" });
    expect((await listDestinations(s.owner))[0]).toMatchObject({ hasToken: true, enabled: false, testEventCode: "TEST99" });
    expect(await browserSignals(db, s.storeId)).toBeNull(); // disabled → nothing for the browser

    await expect(saveDestination(s.owner, "meta", { pixelId: "abc", enabled: true })).rejects.toMatchObject({ code: "pixel_id" });
    await expect(saveDestination(s.owner, "tiktok", { pixelId: "lowercase1234", enabled: true })).rejects.toMatchObject({ code: "pixel_id" });
    await expect(saveDestination(s.owner, "google", { pixelId: "123", enabled: true })).rejects.toMatchObject({ code: "pixel_id" });
    await expect(saveDestination(s.owner, "google", { pixelId: "AW-123456789", conversionLabel: "a b", enabled: true })).rejects.toMatchObject({ code: "conversion_label" });
    await expect(saveDestination(s.owner, "pinterest", { pixelId: "1", enabled: true })).rejects.toThrow();

    const staffId = await makeUser("staff");
    await db.insert(membership).values({ storeId: s.storeId, userId: staffId, role: "staff" });
    const staff = await seller(staffId);
    await expect(saveDestination(staff, "meta", { pixelId: "123456789012345", enabled: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(listDestinations(staff)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("browser config carries public ids only and respects cross-store isolation", async () => {
    const a = await configured("toko-a", ["meta", "google"]);
    const b = await makeStore("toko-b");
    expect(await browserSignals(db, a.storeId)).toEqual({ meta: { pixelId: "123456789012345" }, google: { tagId: "AW-123456789", label: "abcDEF123" } });
    expect(await browserSignals(db, b.storeId)).toBeNull();
    expect(await listDestinations(b.owner)).toEqual([]);
  });
});

describe("server Purchase (COD at creation, prepaid at settlement)", () => {
  it("COD: one event per destination in the order transaction; value excludes shipping; content ids are catalog ids; context stored", async () => {
    const s = await configured("toko-a");
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 2 }, "add");
    const click = encodeURIComponent(JSON.stringify({ fbclid: "IwAR1click", gclid: "Cj0Kclick", utm: { source: "fb", campaign: "promo" }, t: 1700000000000 }));
    const { orderId } = await placeOrder(db, cartId, buyer(), undefined, { signal: request({ _fbp: "fb.1.1700000000000.42", _ttp: "ttp-cookie", bl_click: click }) });

    const rows = await events(s.storeId);
    expect(rows.map((r) => [r.provider, r.eventId, r.eventName, r.status, r.orderId])).toEqual([
      ["meta", purchaseEventId(orderId), "Purchase", "pending", orderId],
      ["tiktok", purchaseEventId(orderId), "Purchase", "pending", orderId],
    ]);
    const p = rows[0]!.payload as unknown as SignalPayload;
    const [v] = await db.select({ catalogId: variant.catalogId, productId: variant.productId }).from(variant).where(eq(variant.id, s.variantId));
    const [prod] = await db.select({ catalogId: product.catalogId }).from(product).where(eq(product.id, v!.productId));
    expect(p.value).toBe(200_000); // 2 × 100 000, no shipping fee (order total is 217 500)
    expect(p.contentIds).toEqual([v!.catalogId]);
    expect(p.groupIds).toEqual([prod!.catalogId]);
    expect(p.contents).toEqual([{ id: v!.catalogId, quantity: 2, item_price: 100_000 }]);
    expect(p.orderId).toBe(String(orderId));
    expect(p.user).toMatchObject({
      ph62: sha256("6281234567890"),
      phE164: sha256("+6281234567890"),
      fn: sha256("budi"),
      ln: sha256("santoso"),
      fbp: "fb.1.1700000000000.42",
      fbc: "fb.1.1700000000000.IwAR1click",
      ttp: "ttp-cookie",
      gclid: "Cj0Kclick",
      ip: "203.0.113.7",
    });
    expect(JSON.stringify(p)).not.toContain("081234567890");
    const [ctx] = await db.select().from(orderSignalContext).where(eq(orderSignalContext.orderId, orderId));
    expect(ctx).toMatchObject({ storeId: s.storeId, fbp: "fb.1.1700000000000.42", gclid: "Cj0Kclick", utm: { source: "fb", campaign: "promo" }, clientIp: "203.0.113.7" });
    // Two outbox jobs, one per destination; a second enqueue is a no-op.
    expect((await db.select().from(job).where(eq(job.kind, "signal.deliver")))).toHaveLength(2);
    expect(await enqueuePurchase(db, s.storeId, orderId)).toBe(0);
    expect(await events(s.storeId)).toHaveLength(2);
  });

  it("delivers through the transport with the shared event id and records sent + health", async () => {
    const s = await configured("toko-a");
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, cartId, buyer(), undefined, { signal: request() });
    const requests = fakeTransport();
    const out = await runOnce(db, { workerId: "w1" });
    expect(out.map((o) => o.status)).toEqual(["done", "done"]);
    expect(requests).toHaveLength(2);
    const meta = requests.find((r) => r.url.includes("graph.facebook.com"))!;
    expect(meta.url).toContain("/123456789012345/events?access_token=tok-meta-toko-a");
    expect((meta.body as { data: { event_id: string; custom_data: { value: number } }[] }).data[0]).toMatchObject({ event_id: purchaseEventId(orderId), custom_data: { value: 100_000 } });
    const tiktok = requests.find((r) => r.url.includes("tiktok"))!;
    expect(tiktok.headers["Access-Token"]).toBe("tok-tiktok-toko-a");
    expect((tiktok.body as { data: { event_id: string }[] }).data[0]!.event_id).toBe(purchaseEventId(orderId));
    const rows = await events(s.storeId);
    expect(rows.every((r) => r.status === "sent" && r.sentAt && r.lastError === null)).toBe(true);
    const health = await destinationHealth(s.owner);
    expect(health).toEqual([
      expect.objectContaining({ provider: "meta", sent: 1, failed: 0, pending: 0, simulated: 0, lastError: null }),
      expect.objectContaining({ provider: "tiktok", sent: 1, failed: 0, pending: 0, simulated: 0, lastError: null }),
    ]);
    // Re-running the worker sends nothing again (jobs done, events no longer pending).
    expect(await runOnce(db, { workerId: "w1" })).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it("without SIGNALS_LIVE the delivery is simulated: no transport call, status simulated", async () => {
    const s = await configured("toko-a", ["meta"]);
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    await placeOrder(db, cartId, buyer(), undefined, { signal: request() });
    delete process.env.SIGNALS_LIVE;
    expect((await runOnce(db, { workerId: "w1" })).map((o) => o.status)).toEqual(["done"]);
    const [row] = await events(s.storeId);
    expect(row).toMatchObject({ status: "simulated", lastError: null });
    expect(row!.sentAt).not.toBeNull();
    expect((await destinationHealth(s.owner))[0]).toMatchObject({ simulated: 1, sent: 0 });
  });

  it("prepaid: nothing at creation, Purchase when the seller marks it paid, once", async () => {
    const s = await configured("toko-a", ["meta"]);
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, cartId, buyer({ paymentMethod: "manual_transfer" }), undefined, { signal: request({ _fbp: "fb.1.1700000000000.9" }) });
    expect(await events(s.storeId)).toEqual([]);
    const [ctx] = await db.select().from(orderSignalContext).where(eq(orderSignalContext.orderId, orderId));
    expect(ctx?.fbp).toBe("fb.1.1700000000000.9"); // kept for the delayed purchase
    await transitionOrder(s.owner, orderId, "pay");
    const rows = await events(s.storeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "meta", eventId: purchaseEventId(orderId), eventName: "Purchase" });
    expect((rows[0]!.payload as unknown as SignalPayload).user?.fbp).toBe("fb.1.1700000000000.9");
    await expect(transitionOrder(s.owner, orderId, "pay")).rejects.toMatchObject({ code: "invalid_transition" });
    expect(await enqueuePurchase(db, s.storeId, orderId)).toBe(0);
    expect(await events(s.storeId)).toHaveLength(1);
  });

  it("transient failure retries with the error recorded; a permanent provider error fails fast", async () => {
    const s = await configured("toko-a", ["meta"]);
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    await placeOrder(db, cartId, buyer(), undefined, { signal: request() });
    const requests = fakeTransport([{ status: 503, body: "upstream" }, new Error("ECONNRESET"), { status: 400, body: { error: { code: 190, message: "Invalid OAuth access token: Bearer secret-value" } } }]);

    const first = await runOnce(db, { workerId: "w1" });
    expect(first[0]).toMatchObject({ status: "pending", attempts: 1 });
    let [row] = await events(s.storeId);
    expect(row).toMatchObject({ status: "pending", lastError: "Meta HTTP 503: " });
    // Due in 5 s; pull the job forward instead of waiting.
    await db.update(job).set({ nextAttemptAt: sql`now()` });
    const second = await runOnce(db, { workerId: "w1" });
    expect(second[0]).toMatchObject({ status: "pending", attempts: 2 });
    [row] = await events(s.storeId);
    expect(row!.lastError).toBe("meta: Error"); // network error: name only, never the request
    await db.update(job).set({ nextAttemptAt: sql`now()` });
    const third = await runOnce(db, { workerId: "w1" });
    expect(third[0]).toMatchObject({ status: "done", attempts: 3 }); // permanent → job completes, no retry
    [row] = await events(s.storeId);
    expect(row).toMatchObject({ status: "failed", lastError: "Meta HTTP 400 code 190: Invalid OAuth access token: Bearer secret-value" });
    expect(requests).toHaveLength(3);
    expect((await destinationHealth(s.owner))[0]).toMatchObject({ failed: 1, sent: 0, lastError: expect.stringContaining("code 190") });
    expect(await runOnce(db, { workerId: "w1" })).toEqual([]);
  });

  it("a destination disabled before delivery, an exhausted retry budget and a stale event all end as failed", async () => {
    const s = await configured("toko-a", ["meta"]);
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    await placeOrder(db, cartId, buyer(), undefined, { signal: request() });
    await saveDestination(s.owner, "meta", { pixelId: "123456789012345", enabled: false });
    const requests = fakeTransport();
    expect((await runOnce(db, { workerId: "w1" }))[0]!.status).toBe("done");
    expect(requests).toHaveLength(0);
    expect((await events(s.storeId))[0]).toMatchObject({ status: "failed", lastError: expect.stringContaining("dinonaktifkan") });

    // Exhausted budget: last attempt fails transiently → event failed, job terminal.
    await db.delete(signalEvent);
    await saveDestination(s.owner, "meta", { pixelId: "123456789012345", enabled: true });
    const cart2 = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    await placeOrder(db, cart2, buyer(), undefined, { signal: request() });
    fakeTransport([{ status: 500, body: "" }]);
    await db.update(job).set({ attempts: MAX_ATTEMPTS - 1, nextAttemptAt: sql`now()` }).where(eq(job.kind, "signal.deliver"));
    // The handler marks the event failed on its last allowed attempt and completes the job (no terminal retry loop).
    expect((await runOnce(db, { workerId: "w1" })).find((o) => o.kind === "signal.deliver")).toMatchObject({ status: "done", attempts: MAX_ATTEMPTS });
    expect((await events(s.storeId))[0]).toMatchObject({ status: "failed", lastError: "Meta HTTP 500: " });

    // Stale (> 7 days): permanent without calling the provider.
    await db.delete(signalEvent);
    const cart3 = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    await placeOrder(db, cart3, buyer(), undefined, { signal: request() });
    await db.update(signalEvent).set({ payload: sql`jsonb_set(payload, '{eventTime}', to_jsonb(extract(epoch from now())::bigint - 8 * 86400))` });
    const reqs = fakeTransport();
    await db.update(job).set({ nextAttemptAt: sql`now()` });
    await runOnce(db, { workerId: "w1" });
    expect(reqs).toHaveLength(0);
    expect((await events(s.storeId))[0]).toMatchObject({ status: "failed", lastError: expect.stringContaining("7 hari") });
  });

  it("cross-store: store B's destination never receives store A's purchase; health and config stay per store", async () => {
    const a = await configured("toko-a", ["meta"]);
    const b = await configured("toko-b", ["meta", "tiktok"]);
    const cartId = await setCartLine(a.sf, undefined, { variantId: a.variantId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, cartId, buyer(), undefined, { signal: request() });
    const requests = fakeTransport();
    await runOnce(db, { workerId: "w1" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain("access_token=tok-meta-toko-a");
    expect(await events(b.storeId)).toEqual([]);
    expect((await events(a.storeId))[0]!.eventId).toBe(purchaseEventId(orderId));
    expect(await destinationHealth(b.owner)).toEqual([]);
    // Same event id in another store is a different row (unique is per store).
    await db.insert(signalEvent).values({ storeId: b.storeId, provider: "meta", eventId: purchaseEventId(orderId), eventName: "Purchase", payload: payload() });
    expect(await events(b.storeId)).toHaveLength(1);
  });
});

describe("browser funnel events reported to the server leg", () => {
  it("re-prices from the catalog, drops unknown ids, dedups on event id and ignores stores without a server destination", async () => {
    const a = await configured("toko-a", ["meta", "google"]); // google: browser only → one row
    const b = await makeStore("toko-b");
    const [v] = await db.select({ catalogId: variant.catalogId }).from(variant).where(eq(variant.id, a.variantId));
    const eventId = "11111111-2222-4333-8444-555555555555";
    const input = { event: "AddToCart", eventId, items: [{ id: v!.catalogId, quantity: 3 }, { id: "99999", quantity: 1 }], url: "https://toko-a.localhost/cart" };
    expect(await collectFunnelEvent(a.sf, input, request({ _fbp: "fb.1.1700000000000.1" }))).toBe(1);
    expect(await collectFunnelEvent(a.sf, input, request())).toBe(0); // same id → no-op
    const [row] = await events(a.storeId);
    expect(row).toMatchObject({ provider: "meta", eventId, eventName: "AddToCart", orderId: null });
    const p = row!.payload as unknown as SignalPayload;
    expect(p).toMatchObject({ value: 300_000, contentIds: [v!.catalogId], numItems: 3, url: "https://toko-a.localhost/cart" });
    expect(p.user).toMatchObject({ fbp: "fb.1.1700000000000.1", ip: "203.0.113.7" });
    expect(p.user).not.toHaveProperty("ph62");
    // Unknown-only ids → nothing; a foreign store's catalog id is unknown here (TEN-1).
    expect(await collectFunnelEvent(a.sf, { ...input, eventId: "11111111-2222-4333-8444-555555555556", items: [{ id: "99999", quantity: 1 }] }, request())).toBe(0);
    const [vb] = await db.select({ catalogId: variant.catalogId }).from(variant).where(eq(variant.id, b.variantId));
    expect(await collectFunnelEvent(a.sf, { ...input, eventId: "11111111-2222-4333-8444-555555555557", items: [{ id: vb!.catalogId, quantity: 1 }] }, request())).toBe(0);
    expect(await collectFunnelEvent(b.sf, { ...input, items: [{ id: vb!.catalogId, quantity: 1 }] }, request())).toBe(0); // no destination
    await expect(collectFunnelEvent(a.sf, { ...input, event: "Purchase" }, request())).rejects.toThrow();
    await expect(collectFunnelEvent(a.sf, { ...input, eventId: "purchase:1" }, request())).rejects.toThrow();
  });
});

describe("retention (PRIV-3)", () => {
  it("purges click context and strips match data older than 30 days, keeps newer rows", async () => {
    const s = await configured("toko-a", ["meta"]);
    const c1 = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const { orderId: old } = await placeOrder(db, c1, buyer(), undefined, { signal: request({ _fbp: "fb.1.1.old" }) });
    const c2 = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const { orderId: fresh } = await placeOrder(db, c2, buyer(), undefined, { signal: request({ _fbp: "fb.1.1.fresh" }) });
    await db.update(orderSignalContext).set({ createdAt: sql`now() - interval '31 days'` }).where(eq(orderSignalContext.orderId, old));
    await db.update(signalEvent).set({ createdAt: sql`now() - interval '31 days'` }).where(eq(signalEvent.orderId, old));
    expect(await purgeSignalContext(db)).toEqual({ contexts: 1, events: 1 });
    expect(await db.select().from(orderSignalContext)).toHaveLength(1);
    const rows = await db.select().from(signalEvent).orderBy(signalEvent.id);
    expect((rows[0]!.payload as SignalPayload).user).toBeUndefined();
    expect((rows[0]!.payload as SignalPayload).value).toBe(100_000);
    expect((rows[1]!.payload as unknown as SignalPayload).user?.fbp).toBe("fb.1.1.fresh");
    expect(rows[1]!.orderId).toBe(fresh);
    expect(await purgeSignalContext(db)).toEqual({ contexts: 0, events: 0 });
  });
});
