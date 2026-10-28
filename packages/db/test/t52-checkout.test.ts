import { eq, sql } from "drizzle-orm";
import type { Executor } from "../src/client.ts";
import { createCode } from "../src/affiliate/accounts.ts";
import { projectOffers } from "../src/affiliate/catalog.ts";
import { captureReferralClick } from "../src/affiliate/click.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { normalizePhone, samePhoneIdentity } from "../src/buyer/normalize.ts";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyLedger } from "../src/ledger/verify.ts";
import { bookCodSale } from "../src/ledger/ledger.ts";
import { saveVoucher } from "../src/promotions/manage.ts";
import { usableTypedCode } from "../src/affiliate/referral.ts";
import { affiliateAttribution } from "../src/affiliate/schema-affiliate.ts";
import { blockAffiliate, setOfferRate, setOfferStatus, optInProduct, saveAffiliatePolicy } from "../src/affiliate/seller.ts";
import { calculateAffiliateCommission } from "../src/affiliate/commission.ts";
import { ledgerEntry, order, orderFinancials } from "../src/schema.ts";
import { placeOrder } from "../src/seller/commerce/checkout.ts";
import { withStore } from "../src/platform/tenant.ts";
import { admin, buyer, db, makeStore, platform } from "./helpers.ts";
import { billingTestSetup } from "./t50-fixtures.ts";
import { addProduct, attributionOf, attributions, buy, cartOf, click, code, counter, errCode, fin, finLines, freshPhone, link, makeAffiliate, openStore, optIn, plantClick, resetFixtures, setAccountStatus, stockOf } from "./t52-fixtures.ts";

// T-52 slices 2 and 3 against real PostgreSQL under the real application role: who an order is attributed to, the single-floor commission frozen from the
// BILL-4 allocation, the deduction from the seller's sale, and everything that must never happen (a failed order, a second commission, a repriced old order).
billingTestSetup();
beforeEach(resetFixtures);

const window = () => ({ startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() + 3_600_000) });
/** A store with the default 10 % rate, one opted-in 100.000 product and an affiliate with a code and a link. */
async function world(slug = "toko-a", rateBps = 1_000) {
  const s = await makeStore(slug, { price: 100_000, stock: 200 });
  await openStore(s, rateBps);
  const offerId = await optIn(s);
  const a = await makeAffiliate();
  const c = await code(a, "HEMAT10");
  const l = await link(a, s);
  return { s, a, offerId, code: c.code, token: l.token, linkId: l.id };
}
const captureOrNull = (token: string) => captureReferralClick(db, { token, decision: "capture" });
const expectNoAttribution = async (orderId: number) => {
  expect(await attributionOf(orderId)).toBeUndefined();
  const f = await fin(orderId);
  expect(f.affiliateId).toBeNull();
  expect(f.affiliateCommissionIdr).toBe(0);
  expect((await finLines(orderId)).map((l) => l.commissionRateBps)).toSatisfy((r: (number | null)[]) => r.every((x) => x === null));
};

describe("T-52 slice 2: one server-side resolver, typed code before captured click", () => {
  it("a captured click earns the single-floor commission and the buyer's total never moves", async () => {
    const { s, a, token } = await world();
    const plain = await buy(s); // the same cart without any selector: the control
    const clickId = await click(token);
    const o = await buy(s, { clicks: [clickId] });
    const f = await fin(o.orderId);
    const control = await fin(plain.orderId);
    expect(f.payableIdr).toBe(control.payableIdr);
    expect(f.shippingChargedIdr).toBe(control.shippingChargedIdr);
    expect(f.goodsProceedsIdr).toBe(control.goodsProceedsIdr);
    expect(f.affiliateCommissionIdr).toBe(10_000);
    expect(f.saleAmountIdr).toBe(control.saleAmountIdr - 10_000);
    expect(f.affiliateId).toBe(a.affiliateId);
    const at = (await attributionOf(o.orderId))!;
    expect(at).toMatchObject({ affiliateId: a.affiliateId, storeId: s.storeId, source: "bukalaris", method: "link", clickId, codeId: null, commissionIdr: 10_000, commissionBaseIdr: 100_000, status: "pending", windowDays: 7, holdDays: 3 });
    expect((await finLines(o.orderId)).map((l) => l.commissionRateBps)).toEqual([1_000]);
    await expectNoAttribution(plain.orderId);
  });

  it("a typed code is a selector like any other: it wins, and it records the code and no click", async () => {
    const { s, a, code: c } = await world();
    const o = await buy(s, { code: c });
    expect(await attributionOf(o.orderId)).toMatchObject({ affiliateId: a.affiliateId, method: "code", clickId: null, commissionIdr: 10_000 });
    expect((await attributionOf(o.orderId))!.codeId).not.toBeNull();
  });

  it("every spelling of the code resolves to the same normalised code", async () => {
    const { s, a } = await world();
    for (const spelling of ["hemat10", " hemat-10 ", "HEMAT_10", "He Mat10"]) {
      const o = await buy(s, { code: spelling });
      expect((await attributionOf(o.orderId))!.affiliateId).toBe(a.affiliateId);
    }
  });

  it("precedence: a valid typed code beats a later click of another affiliate; an invalid code falls back to the click; no valid selector earns nothing and never fails the order", async () => {
    const { s, a } = await world();
    const b = await makeAffiliate({ name: "Afiliasi Dua" });
    const bLink = await link(b, s);
    const bClick = await click(bLink.token);
    const typed = await buy(s, { code: "HEMAT10", clicks: [bClick] });
    expect((await attributionOf(typed.orderId))!.affiliateId).toBe(a.affiliateId);
    const fallback = await buy(s, { code: "NOSUCH99", clicks: [bClick] });
    expect(await attributionOf(fallback.orderId)).toMatchObject({ affiliateId: b.affiliateId, method: "link" });
    const nothing = await buy(s, { code: "NOSUCH99" });
    await expectNoAttribution(nothing.orderId);
  });

  it("the LAST eligible click wins; equal capture times fall to the larger click id; only this store's clicks count", async () => {
    const { s, a, linkId } = await world();
    const b = await makeAffiliate({ name: "Afiliasi Dua" });
    const bLink = await link(b, s);
    const first = await click(bLink.token); // B first
    const second = await click((await link(a, s)).token); // A last
    const o = await buy(s, { clicks: [second, first] });
    expect((await attributionOf(o.orderId))!.affiliateId).toBe(a.affiliateId);
    // the cookie order is irrelevant: the capture time decides
    const o2 = await buy(s, { clicks: [first, second] });
    expect((await attributionOf(o2.orderId))!.affiliateId).toBe(a.affiliateId);
    // equal capture instants: the larger id wins, deterministically
    const at = new Date(Date.now() - 60_000);
    const later = new Date(Date.now() + 86_400_000);
    const idLow = await plantClick(a, s, linkId, { capturedAt: at, expiresAt: later }, `c${"1".repeat(32)}`);
    const bLinkId = (await platform.query.affiliateLink.findFirst({ where: (t, { eq: is }) => is(t.affiliateId, b.affiliateId) }))!.id;
    const idHigh = await plantClick(b, s, bLinkId, { capturedAt: at, expiresAt: later }, `c${"2".repeat(32)}`);
    const o3 = await buy(s, { clicks: [idLow, idHigh] });
    expect((await attributionOf(o3.orderId))!.clickId).toBe(idHigh);
  });

  it("a click captured for another store is not an authority here (forged cross-store handoff)", async () => {
    const { s, a } = await world();
    const other = await makeStore("toko-b", { price: 100_000, stock: 50 });
    await openStore(other, 1_000);
    await optIn(other);
    const bClick = await click((await link(a, other)).token); // a genuine click, but for store B
    const o = await buy(s, { clicks: [bClick] });
    await expectNoAttribution(o.orderId);
    const ob = await buy(other, { clicks: [bClick] }); // and it works where it belongs
    expect((await attributionOf(ob.orderId))!.storeId).toBe(other.storeId);
  });

  it("window: a click inside it earns, one past its own expiry earns nothing, and a later policy change never moves an existing click", async () => {
    const { s, a, linkId, token } = await world();
    const now = Date.now();
    const live = await plantClick(a, s, linkId, { capturedAt: new Date(now - 6 * 86_400_000), expiresAt: new Date(now + 60_000) });
    const dead = await plantClick(a, s, linkId, { capturedAt: new Date(now - 8 * 86_400_000), expiresAt: new Date(now - 60_000) });
    expect((await attributionOf((await buy(s, { clicks: [live] })).orderId))!.clickId).toBe(live);
    await expectNoAttribution((await buy(s, { clicks: [dead] })).orderId);
    // a real capture freezes capture time + window of THAT moment
    const real = await click(token);
    await admin.execute(sql`update affiliate_policy set attribution_window_days = 1`);
    const [row] = (await admin.execute(sql`select extract(epoch from expires_at - captured_at)::int as span from affiliate_click where id = ${real}`)) as unknown as { span: number }[];
    expect(row!.span).toBe(7 * 86_400);
    expect((await attributionOf((await buy(s, { clicks: [real] })).orderId))!.windowDays).toBe(1); // the attribution snapshots the policy of the order's moment
  });

  it("exact boundary: a click whose window ends AT this instant is expired; one microsecond later it still earns (the end is exclusive)", async () => {
    const { s, a, linkId } = await world();
    const o = await buy(s); // the order whose resolution we replay
    const resolve = (tx: Executor, ids: string[]) =>
      withStore(tx, s.storeId, async (t) => ((await t.execute(sql`select r_outcome, r_click_id from public.affiliate_resolve(${s.storeId}::bigint, ${o.orderId}::bigint, null::text, array[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::text[])`)) as unknown as { r_outcome: string; r_click_id: string | null }[])[0]!);
    await admin.transaction(async (tx) => {
      const ends = `c${"a".repeat(32)}`;
      const lasts = `c${"b".repeat(32)}`;
      // now() is the transaction start: the resolver reads the same instant, so "ends exactly now" is testable to the microsecond
      await tx.execute(sql`insert into affiliate_click (id, link_id, affiliate_id, store_id, captured_at, expires_at) values (${ends}, ${linkId}, ${a.affiliateId}, ${s.storeId}, now() - interval '1 day', now())`);
      await tx.execute(sql`insert into affiliate_click (id, link_id, affiliate_id, store_id, captured_at, expires_at) values (${lasts}, ${linkId}, ${a.affiliateId}, ${s.storeId}, now() - interval '1 day', now() + interval '1 microsecond')`);
      expect(await resolve(tx, [ends])).toMatchObject({ r_outcome: "none" });
      expect(await resolve(tx, [lasts])).toMatchObject({ r_outcome: "selected", r_click_id: lasts });
    });
  });

  it("an affiliate that is suspended, pending, rejected or closed earns nothing (suspension is derived: reactivation restores the same link)", async () => {
    const { s, a, token } = await world();
    const c1 = await click(token);
    for (const status of ["suspended", "closed"] as const) {
      await setAccountStatus(a.affiliateId, status);
      await expectNoAttribution((await buy(s, { code: "HEMAT10", clicks: [c1] })).orderId);
      if (status === "suspended") {
        await admin.execute(sql`update affiliate set status = 'active' where id = ${a.affiliateId}`);
        expect((await attributionOf((await buy(s, { clicks: [c1] })).orderId))!.affiliateId).toBe(a.affiliateId); // restored by reactivation, nothing rewritten
        await admin.execute(sql`update affiliate set status = 'suspended', status_reason = 'again' where id = ${a.affiliateId}`);
      }
    }
    const pending = await makeAffiliate({ status: "pending" });
    await expect(code(pending, "PENDING1")).rejects.toThrow(); // only an active account creates codes
  });

  it("revoked and expired selectors earn nothing", async () => {
    const { s, a } = await world();
    const c1 = await click((await link(a, s)).token);
    await admin.execute(sql`update affiliate_link set status = 'revoked', revoked_at = now()`);
    await expectNoAttribution((await buy(s, { clicks: [c1] })).orderId); // the click's link is revoked
    await admin.execute(sql`update affiliate_code set status = 'revoked', revoked_at = now()`);
    await expectNoAttribution((await buy(s, { code: "HEMAT10" })).orderId);
    await createCode(db, a.affiliateId, { code: "SHORTLIVED", expiresAt: new Date(Date.now() - 1_000) }); // a code never changes after creation: expiry is fixed when it is made
    await expectNoAttribution((await buy(s, { code: "SHORTLIVED" })).orderId);
  });

  it("a seller block stops new attribution for THAT store only: code and click are both ignored, another store still attributes, and what was earned stays", async () => {
    const { s, a, token } = await world();
    const other = await makeStore("toko-b", { price: 100_000, stock: 50 });
    await openStore(other, 1_000);
    await optIn(other);
    const earned = await buy(s, { code: "HEMAT10" });
    await blockAffiliate(s.owner, { affiliateId: a.affiliateId, reason: "uji blokir" });
    const c1 = await click((await link(a, other)).token);
    expect(await attributionOf(earned.orderId)).toMatchObject({ status: "pending", commissionIdr: 10_000 });
    await expectNoAttribution((await buy(s, { code: "HEMAT10" })).orderId);
    expect(await captureOrNull(token)).toBeNull(); // a blocked affiliate's link answers not-found, no click
    expect((await attributionOf((await buy(other, { code: "HEMAT10", clicks: [c1] })).orderId))!.storeId).toBe(other.storeId);
  });

  it("the order transaction rechecks the account and the block itself, whatever the pre-check saw (a stale answer cannot authorise)", async () => {
    const { s, a, token } = await world();
    const o = await buy(s); // the order whose resolution we replay
    const c1 = await click(token);
    const resolve = (typed: string | null, ids: string[]) =>
      withStore(admin, s.storeId, async (t) => ((await t.execute(sql`select r_outcome from public.affiliate_resolve(${s.storeId}::bigint, ${o.orderId}::bigint, ${typed}::text, ${ids.length ? sql`array[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::text[]` : sql`null::text[]`})`)) as unknown as { r_outcome: string }[])[0]!.r_outcome);
    expect([await resolve("HEMAT10", []), await resolve(null, [c1])]).toEqual(["selected", "selected"]); // the control
    await blockAffiliate(s.owner, { affiliateId: a.affiliateId, reason: "uji pemeriksaan ulang" });
    expect([await resolve("HEMAT10", []), await resolve(null, [c1]), await resolve("HEMAT10", [c1])]).toEqual(["none", "none", "none"]);
    await admin.execute(sql`delete from affiliate_block`);
    for (const status of ["suspended", "closed"] as const) {
      await setAccountStatus(a.affiliateId, status);
      expect([await resolve("HEMAT10", []), await resolve(null, [c1])], status).toEqual(["none", "none"]);
    }
  });

  it("a garbage selector never fails an order: malformed, oversized, hostile, foreign-script codes and forged click ids all place the order", async () => {
    const { s } = await world();
    const hostile = ["", "   ", "!!!", "x", "'; drop table affiliate; --", "<script>alert(1)</script>", "A".repeat(64), "kodé123", "\u0000HEMAT10", "HEMAT10\nX", "🎁🎁🎁🎁"];
    for (const code of hostile) await expectNoAttribution((await buy(s, { code })).orderId);
    const forged = [`c${"0".repeat(32)}`, `c${"f".repeat(31)}`, "c", "../../etc/passwd", `${"c".repeat(600)}`, "x'; select 1;--"];
    await expectNoAttribution((await buy(s, { clicks: forged })).orderId);
    await expectNoAttribution((await buy(s, { clicks: Array.from({ length: 80 }, (_, i) => `c${i.toString(16).padStart(32, "0")}`) })).orderId);
    expect(await errCode(buy(s, { over: { affiliateCode: "x".repeat(65) } }))).not.toBe("ok"); // the input schema's own length cap still applies: that is a validation error, not a selector
  });

  it("RL-CODE: after 10 invalid guesses on one cart the typed code is ignored (checkout continues); another cart is unaffected; failures are counted platform-wide", async () => {
    const { s, code: c } = await world();
    const cart = await cartOf(s);
    for (let i = 0; i < 10; i++) expect(await usableTypedCode(db, s.storeId, cart, `WRONG${i}XX`)).toBeNull();
    expect(await usableTypedCode(db, s.storeId, cart, c)).toBeNull(); // even the right code, over the limit
    const o = await buy(s, { cart, code: c });
    await expectNoAttribution(o.orderId);
    expect(await usableTypedCode(db, s.storeId, await cartOf(s), c)).toBe("HEMAT10");
    expect(await counter("code_failure")).toBe(10);
  });
});

describe("T-52 canonical-phone self-referral earns nothing and never falls back", () => {
  it("every spelling of the affiliate's own phone suppresses the commission; the order is placed; it is counted once for the risk queue", async () => {
    const own = "081299900011";
    const s = await makeStore("toko-a", { price: 100_000, stock: 200 });
    await openStore(s);
    await optIn(s);
    const a = await makeAffiliate({ phone: own });
    await code(a, "SELFCODE");
    let n = 0;
    for (const spelling of [own, "+6281299900011", "6281299900011", "006281299900011", "62081299900011"]) {
      const o = await buy(s, { code: "SELFCODE", phone: spelling });
      await expectNoAttribution(o.orderId);
      expect(await counter("self_referral_suppressed", a.affiliateId)).toBe(++n);
    }
    // another buyer with the same code earns
    expect((await attributionOf((await buy(s, { code: "SELFCODE" })).orderId))!.affiliateId).toBe(a.affiliateId);
  });

  it("no fallback: self code + another affiliate's click, and a self click after another's older click, both earn nothing", async () => {
    const s = await makeStore("toko-a", { price: 100_000, stock: 200 });
    await openStore(s);
    await optIn(s);
    const me = await makeAffiliate({ phone: "081299900022" });
    await code(me, "MYSELF99");
    const other = await makeAffiliate({ name: "Orang Lain" });
    const otherClick = await click((await link(other, s)).token);
    await expectNoAttribution((await buy(s, { code: "MYSELF99", clicks: [otherClick], phone: "081299900022" })).orderId);
    const myClick = await click((await link(me, s)).token); // newer than the other's
    await expectNoAttribution((await buy(s, { clicks: [myClick, otherClick], phone: "+6281299900022" })).orderId);
    // a typed code of the OTHER affiliate beats my own click: not a self-referral, the other earns
    await code(other, "OTHER123");
    expect((await attributionOf((await buy(s, { code: "OTHER123", clicks: [myClick], phone: "081299900022" })).orderId))!.affiliateId).toBe(other.affiliateId);
  });

  it("the SQL decision equals the T-57 TypeScript contract for every digit spelling the checkout accepts", async () => {
    const own = "081299900033";
    const s = await makeStore("toko-a", { price: 100_000, stock: 400 });
    await openStore(s);
    await optIn(s);
    await code(await makeAffiliate({ phone: own }), "PARITY77");
    const spellings = [own, "+081299900033", "81299900033", "+6281299900033", "6281299900033", "006281299900033", "62081299900033", "+62081299900033", "081299900034", "08129990003", "0812999000333", "+81299900033", "0812999000330", "6281299900034"];
    for (const spelling of spellings) {
      const o = await buy(s, { code: "PARITY77", phone: spelling });
      // Wave 5 review: fail closed. A spelling with no canonical Indonesian key (`+0812…`, `812…`) cannot be compared, so it earns nothing either.
      expect((await attributionOf(o.orderId)) === undefined, `spelling ${spelling}`).toBe(samePhoneIdentity(own, spelling) || normalizePhone(spelling) === null);
    }
  });
});

describe("T-52 slice 3: the commission is frozen from the canonical allocation, deducted from the seller's sale, never repriced", () => {
  it("mixed rates and a store-funded discount: each product keeps its own rate on its own discounted base, one floor over the sum", async () => {
    const s = await makeStore("toko-a", { price: 100_000, stock: 200 });
    await openStore(s, 1_000);
    await optIn(s, s.productId, 1_500); // override
    const p2 = await addProduct(s, 50_000);
    await optIn(s, p2.productId, null); // store default 10 %
    const a = await makeAffiliate();
    await code(a, "MIXED10");
    const v = await saveVoucher(s.owner, { kind: "percent", scope: "all", value: 1_000, ...window() });
    const cartId = await cartOf(s);
    await setCartLine(s.sf, cartId, { variantId: p2.variantId, quantity: 1 }, "add");
    const o = await buy(s, { cart: cartId, code: "MIXED10", over: { voucherCode: v.code } });
    const lines = await finLines(o.orderId);
    expect(lines.map((l) => [l.lineGrossIdr, l.discountAllocIdr, l.commissionBaseIdr, l.commissionRateBps])).toEqual([[100_000, 10_000, 90_000, 1_500], [50_000, 5_000, 45_000, 1_000]]);
    const expected = calculateAffiliateCommission(lines.map((l) => ({ commissionBase: l.commissionBaseIdr, rateBps: l.commissionRateBps! })));
    expect(expected).toBe(18_000);
    const f = await fin(o.orderId);
    expect(f.affiliateCommissionIdr).toBe(18_000);
    expect(f.saleAmountIdr).toBe(f.goodsProceedsIdr - 18_000);
    expect((await attributionOf(o.orderId))).toMatchObject({ commissionBaseIdr: 135_000, commissionIdr: 18_000 });
  });

  it("a line that is not opted in earns exactly zero; a cart with no opted-in line earns no attribution at all", async () => {
    const s = await makeStore("toko-a", { price: 100_000, stock: 200 });
    await openStore(s, 1_000);
    await optIn(s);
    const plain = await addProduct(s, 80_000, "Kaos Biasa"); // never opted in
    const a = await makeAffiliate();
    await code(a, "ZEROLINE");
    const mixed = await cartOf(s);
    await setCartLine(s.sf, mixed, { variantId: plain.variantId, quantity: 2 }, "add");
    const o = await buy(s, { cart: mixed, code: "ZEROLINE" });
    expect((await finLines(o.orderId)).map((l) => [l.commissionBaseIdr, l.commissionRateBps])).toEqual([[100_000, 1_000], [160_000, 0]]);
    expect((await fin(o.orderId)).affiliateCommissionIdr).toBe(10_000); // 10 % of the opted-in 100.000 only
    expect((await attributionOf(o.orderId))!.commissionBaseIdr).toBe(100_000); // the base column is the sum of the bases of the lines that earn
    const none = await buy(s, { variantId: plain.variantId, code: "ZEROLINE" });
    await expectNoAttribution(none.orderId);
  });

  it("one floor in the real checkout, in TypeScript and again in the database guard: two 7-rupiah lines at 11 % earn 1 rupiah, not the 0 that flooring each line gives", async () => {
    const s = await makeStore("toko-a", { price: 7, stock: 50 });
    await openStore(s, 1_100);
    await optIn(s);
    const second = await addProduct(s, 7, "Gantungan");
    await optIn(s, second.productId);
    await code(await makeAffiliate(), "ONEFLOOR");
    const cartId = await cartOf(s);
    await setCartLine(s.sf, cartId, { variantId: second.variantId, quantity: 1 }, "add");
    const o = await buy(s, { cart: cartId, code: "ONEFLOOR" });
    expect((await finLines(o.orderId)).map((l) => [l.commissionBaseIdr, l.commissionRateBps])).toEqual([[7, 1_100], [7, 1_100]]);
    expect((await fin(o.orderId)).affiliateCommissionIdr).toBe(1); // floor(14 * 1100 / 10000) = floor(1.54); each line alone would be floor(0.77) = 0
    expect(await attributionOf(o.orderId)).toMatchObject({ commissionIdr: 1, commissionBaseIdr: 14 });
  });

  it("zero base: a free product earns nothing and creates no attribution (a commission above zero is required)", async () => {
    const s = await makeStore("toko-a", { price: 0, stock: 20 });
    await openStore(s);
    await optIn(s);
    await code(await makeAffiliate(), "FREEITEM");
    await expectNoAttribution((await buy(s, { code: "FREEITEM" })).orderId);
    expect(await attributions()).toHaveLength(0);
  });

  it("shipping, COD fee and payment channel never enter the base: COD and prepaid, with and without free shipping, earn the same commission", async () => {
    const { s } = await world();
    const results: number[] = [];
    for (const over of [{ paymentMethod: "cod" }, { paymentMethod: "manual_transfer", paymentChannel: "VABCA" }]) {
      results.push((await fin((await buy(s, { code: "HEMAT10", over })).orderId)).affiliateCommissionIdr);
    }
    const free = await saveVoucher(s.owner, { kind: "free_shipping", scope: "all", value: 0, ...window() });
    const o = await buy(s, { code: "HEMAT10", over: { voucherCode: free.code } });
    expect((await fin(o.orderId)).shippingDiscountIdr).toBeGreaterThan(0);
    results.push((await fin(o.orderId)).affiliateCommissionIdr);
    expect(results).toEqual([10_000, 10_000, 10_000]);
  });

  it("a rate or policy change, a block, a withdrawal or a catalog refresh never reprices an existing order", async () => {
    const { s, a, offerId } = await world();
    const o = await buy(s, { code: "HEMAT10" });
    const before = { fin: await fin(o.orderId), lines: await finLines(o.orderId), at: await attributionOf(o.orderId) };
    await optInProduct(s.owner, { productId: s.productId, rateBps: 2_000 });
    await saveAffiliatePolicy(s.owner, { participation: "closed", defaultRateBps: 500 });
    await setOfferStatus(s.owner, { offerId, status: "withdrawn" });
    await blockAffiliate(s.owner, { affiliateId: a.affiliateId, reason: "uji" });
    await setAccountStatus(a.affiliateId, "suspended");
    expect({ fin: await fin(o.orderId), lines: await finLines(o.orderId), at: await attributionOf(o.orderId) }).toEqual(before);
  });

  it("the live offer rules decide at checkout: stale catalog data cannot authorise a commission (closed store, paused or withdrawn offer, rate over a lowered maximum)", async () => {
    const { s, offerId } = await world();
    await projectOffers(platform, s.storeId); // the catalog says: active, 10 %
    expect((await platform.query.affiliateCatalog.findFirst())!.active).toBe(true);
    // the seller changes the live tables underneath, with no projection run (stale outbox)
    await admin.execute(sql`update affiliate_seller_policy set participation = 'closed'`);
    await expectNoAttribution((await buy(s, { code: "HEMAT10" })).orderId);
    await admin.execute(sql`update affiliate_seller_policy set participation = 'open'`);
    expect((await attributionOf((await buy(s, { code: "HEMAT10" })).orderId))!.commissionIdr).toBe(10_000);
    for (const status of ["paused", "withdrawn"] as const) {
      await setOfferStatus(s.owner, { offerId, status });
      await expectNoAttribution((await buy(s, { code: "HEMAT10" })).orderId);
      await setOfferStatus(s.owner, { offerId, status: "active" });
    }
    await admin.execute(sql`update affiliate_policy set max_rate_bps = 500`);
    await expectNoAttribution((await buy(s, { code: "HEMAT10" })).orderId); // 10 % is now above the programme maximum
  });

  it("a commission that would leave the seller less than the shipping discount they fund is not earned, and the order still places", async () => {
    const probe = await makeStore("toko-probe", { price: 100_000, stock: 5 });
    const free = await saveVoucher(probe.owner, { kind: "free_shipping", scope: "all", value: 0, ...window() });
    const shippingDiscount = (await fin((await buy(probe, { over: { voucherCode: free.code } })).orderId)).shippingDiscountIdr;
    expect(shippingDiscount).toBeGreaterThan(8);
    const s = await makeStore("toko-a", { price: shippingDiscount + 1, stock: 20 });
    await openStore(s, 2_000);
    await optIn(s);
    await code(await makeAffiliate(), "TIGHTONE");
    const v = await saveVoucher(s.owner, { kind: "free_shipping", scope: "all", value: 0, ...window() });
    const o = await buy(s, { code: "TIGHTONE", over: { voucherCode: v.code } });
    expect((await fin(o.orderId)).shippingDiscountIdr).toBe(shippingDiscount);
    await expectNoAttribution(o.orderId);
    const ok = await buy(s, { code: "TIGHTONE" }); // without the funded shipping discount it earns
    expect((await attributionOf(ok.orderId))!.commissionIdr).toBeGreaterThan(0);
  });

  it("the deduction reaches the seller's ledger: the sale entry is the net of the commission, and the ledger verification finds nothing wrong", async () => {
    const { s } = await world();
    const o = await buy(s, { code: "HEMAT10" });
    const f = await fin(o.orderId);
    await admin.execute(sql`update "order" set status = 'placed' where id = ${o.orderId}`);
    await admin.execute(sql`update "order" set status = 'completed', tracking_number = 'T52TRACK1' where id = ${o.orderId}`);
    await platform.transaction((tx) => bookCodSale(tx, s.storeId, o.orderId));
    const sales = await platform.select().from(ledgerEntry).where(eq(ledgerEntry.orderId, o.orderId));
    expect(sales.filter((e) => e.kind === "sale").map((e) => e.amountIdr)).toEqual([f.saleAmountIdr]);
    expect(f.saleAmountIdr).toBe(90_000);
    const v = await verifyLedger(platform);
    expect(v.violations).toEqual([]);
  });
});

describe("T-52 exactly one attribution and deduction: rollback, replay, concurrency, direct duplicates", () => {
  it("a failed order transaction leaves no order, no commission, no attribution, no counter and the stock where it was", async () => {
    const { s } = await world();
    await admin.execute(sql`create function t52_boom() returns trigger language plpgsql as $$ begin raise exception 'boom after the attribution'; end $$`);
    await admin.execute(sql`create trigger t52_boom before delete on cart_line for each row execute function t52_boom()`);
    try {
      const cartId = await cartOf(s);
      const stock = await stockOf(s.variantId);
      await expect(buy(s, { cart: cartId, code: "HEMAT10" })).rejects.toThrow();
      expect(await platform.select().from(order)).toHaveLength(0);
      expect(await platform.select().from(orderFinancials)).toHaveLength(0);
      expect(await attributions()).toHaveLength(0);
      expect(await stockOf(s.variantId)).toBe(stock);
    } finally {
      await admin.execute(sql`drop trigger t52_boom on cart_line`);
      await admin.execute(sql`drop function t52_boom()`);
    }
    expect((await attributionOf((await buy(s, { code: "HEMAT10" })).orderId))!.commissionIdr).toBe(10_000); // and the same checkout works afterwards
  });

  it("a duplicate submit replays the first order: one attribution, one deduction", async () => {
    const { s } = await world();
    const cartId = await cartOf(s);
    const input = buyer({ buyerPhone: freshPhone(), affiliateCode: "HEMAT10" });
    const first = await placeOrder(db, cartId, input, undefined, { referral: { clickIds: [] } });
    const second = await placeOrder(db, cartId, input, undefined, { referral: { clickIds: [] } });
    expect(second).toEqual({ orderId: first.orderId, replayed: true });
    expect(await attributions()).toHaveLength(1);
    expect((await fin(first.orderId)).affiliateCommissionIdr).toBe(10_000);
  });

  it("eight concurrent submits of the same checkout yield one order, one immutable attribution and one deduction", async () => {
    const { s } = await world();
    const cartId = await cartOf(s);
    const input = buyer({ buyerPhone: freshPhone(), affiliateCode: "HEMAT10" });
    const settled = await Promise.allSettled(Array.from({ length: 8 }, () => placeOrder(db, cartId, input, undefined, { referral: { clickIds: [] } })));
    const ok = settled.filter((r): r is PromiseFulfilledResult<{ orderId: number; replayed: boolean }> => r.status === "fulfilled").map((r) => r.value.orderId);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok).size).toBe(1);
    expect(await platform.select().from(order)).toHaveLength(1);
    expect(await attributions()).toHaveLength(1);
    expect(await platform.select().from(orderFinancials).where(eq(orderFinancials.affiliateCommissionIdr, 10_000))).toHaveLength(1);
  });

  it("concurrent submits with DIFFERENT idempotency keys on one cart still yield exactly one attribution", async () => {
    const { s } = await world();
    const cartId = await cartOf(s);
    const phone = freshPhone();
    const settled = await Promise.allSettled(Array.from({ length: 6 }, () => placeOrder(db, cartId, buyer({ buyerPhone: phone, affiliateCode: "HEMAT10" }), undefined, { referral: { clickIds: [] } })));
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await attributions()).toHaveLength(1);
    expect(await platform.select().from(order)).toHaveLength(1);
  });

  it("many different buyers ordering at once through one affiliate: every order gets its own correct attribution and no lock deadlocks", async () => {
    const { s, a } = await world();
    const carts = await Promise.all(Array.from({ length: 8 }, () => cartOf(s)));
    const results = await Promise.all(carts.map((cart) => buy(s, { cart, code: "HEMAT10" })));
    const rows = await attributions();
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((r) => r.orderId))).toEqual(new Set(results.map((r) => r.orderId)));
    expect(rows.every((r) => r.affiliateId === a.affiliateId && r.commissionIdr === 10_000)).toBe(true);
  });

  it("seller edits and orders never deadlock: policy saves, offer changes and price edits race eight checkouts, the last of which takes the stock to zero", async () => {
    const s = await makeStore("toko-a", { price: 100_000, stock: 8 });
    await openStore(s, 1_000);
    const offerId = await optIn(s);
    await code(await makeAffiliate(), "RACE0001");
    const carts = await Promise.all(Array.from({ length: 8 }, () => cartOf(s)));
    const work = [
      ...carts.map((cart) => buy(s, { cart, code: "RACE0001" })),
      ...Array.from({ length: 6 }, (_, i) => saveAffiliatePolicy(s.owner, { participation: "open", defaultRateBps: 900 + i * 10 })),
      ...Array.from({ length: 4 }, (_, i) => setOfferRate(s.owner, { offerId, rateBps: 1_000 + i })),
      ...Array.from({ length: 4 }, (_, i) => admin.execute(sql`update variant set price = ${100_000 + i} where id = ${s.variantId}`)),
    ];
    const settled = await Promise.allSettled(work);
    const failures = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason?.cause?.code ?? r.reason?.code ?? String(r.reason));
    expect(failures.filter((c) => c === "40P01" || c === "40001"), "deadlock or serialization failure").toEqual([]);
    expect((await attributions()).length).toBe(carts.length);
    expect(await stockOf(s.variantId)).toBe(0);
  });

  it("a direct duplicate insert is rejected by the database (UNIQUE(order_id)), even for the table owner's own connection", async () => {
    const { s } = await world();
    const o = await buy(s, { code: "HEMAT10" });
    const first = (await attributionOf(o.orderId))!;
    const { id: _id, createdAt: _c, ...copy } = first;
    expect(await errCode(admin.insert(affiliateAttribution).values(copy))).toBe("23505");
    expect(await attributions()).toHaveLength(1);
    // the application role has no write privilege on the table at all
    expect(await errCode(withStore(db, s.storeId, (tx) => tx.insert(affiliateAttribution).values(copy)))).toBe("42501");
    expect(await errCode(platform.insert(affiliateAttribution).values(copy))).toBe("42501");
  });

  it("an order cannot commit a deduction without its obligation (deferred check), nor an obligation that differs from the frozen snapshot (insert guard)", async () => {
    const { s } = await world();
    const done = await buy(s, { code: "HEMAT10" });
    // 1. the attribution insert is swallowed by a rogue trigger: the snapshot would deduct 10.000 with no obligation behind it, and the COMMIT refuses
    await admin.execute(sql`create function t52_skip() returns trigger language plpgsql as $$ begin return null; end $$`);
    await admin.execute(sql`create trigger t52_skip before insert on affiliate_attribution for each row execute function t52_skip()`);
    try {
      await expect(buy(s, { code: "HEMAT10" })).rejects.toThrow(/without its attribution/);
    } finally {
      await admin.execute(sql`drop trigger t52_skip on affiliate_attribution`);
      await admin.execute(sql`drop function t52_skip()`);
    }
    expect(await attributions()).toHaveLength(1);
    expect(await platform.select().from(order)).toHaveLength(1); // the refused order left nothing behind
    // 2. an attribution that disagrees with the snapshot of its order is refused at insert
    const orphan = await buy(s);
    const { id: _id, createdAt: _c, orderId: _o, ...rest } = (await attributionOf(done.orderId))!;
    expect(await errCode(admin.insert(affiliateAttribution).values({ ...rest, orderId: orphan.orderId }))).toBe("23514"); // that order's snapshot names no affiliate and no commission
    expect(await errCode(admin.insert(affiliateAttribution).values({ ...rest, orderId: orphan.orderId, commissionIdr: 10_001 }))).toBe("23514");
  });
});
