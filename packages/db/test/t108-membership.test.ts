import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAffiliate } from "../src/affiliate/accounts.ts";
import { releasePayableCommissions } from "../src/affiliate/jobs.ts";
import { applyToStore, listMemberships, listOwnCommissions, listOwnMemberships, listStoreCommissions, reviewMembership } from "../src/affiliate/membership.ts";
import { affiliate, affiliateAttribution, affiliateCommission, affiliateMembership } from "../src/affiliate/schema-affiliate.ts";
import { affiliateSettings, blockAffiliate, saveAffiliatePolicy } from "../src/affiliate/seller.ts";
import { RL_AFF_STORE_APPLY } from "../src/affiliate/settings.ts";
import { issueSellerStepUp } from "../src/ledger/stepup.ts";
import { verifyLedger } from "../src/ledger/verify.ts";
import { addBankAccount, BANK_ACCOUNT_STEP_UP, confirmBankTransfer } from "../src/payments/bank-transfer.ts";
import { FakeProviderCheck, saveProviderKey, setPaymentAccountDetails, setProviderCheckTransport } from "../src/payments/provider-accounts.ts";
import { fakeProviders } from "../src/payments/providers.ts";
import { FakeAutoLarisAccounts, setSellerPaymentTransport } from "../src/payments/seller.ts";
import { bindSession, type SellerScope } from "../src/platform/scoped.ts";
import { acceptSellerTerms } from "../src/platform/terms.ts";
import { withAffiliate, withStore } from "../src/platform/tenant.ts";
import { digitalGrant, order, orderFinancials, user, variant } from "../src/schema.ts";
import { createProduct, updateProduct } from "../src/seller/commerce/catalog.ts";
import { placeOrder } from "../src/seller/commerce/checkout.ts";
import { addAccessLink, revokeDigitalGrant } from "../src/seller/commerce/digital.ts";
import { applyProviderTransition, transitionOrder } from "../src/seller/commerce/orders.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { deliver } from "./deliver.ts";
import { admin, buyer, db, makeStore, makeUser, platform } from "./helpers.ts";
import { billingTestSetup } from "./t50-fixtures.ts";
import { sessionOf } from "./t37-fixtures.ts";
import { attributionOf, buy, cartOf, click, code, errCode, fin, finLines, freshPhone, link, makeAffiliate, member, openStore, optIn, resetFixtures, setAccountStatus, type A, type S } from "./t52-fixtures.ts";

// T-108 (ADR-0015 decisions 1 to 4; D-29, D-31, D-32 C-A3/C-A4/C-A6; D-38) against real PostgreSQL under the real roles: store membership, attribution only
// through an ACTIVE membership, the commission as the seller's obligation (never a deduction from the sale), its pending / void / payable life and the
// isolation of both new tables. The mutation checks of docs/tracks/t108-affiliate-membership.md break the invariants on purpose and name the test that fails.
billingTestSetup();
beforeEach(resetFixtures);

let accounts: FakeAutoLarisAccounts;
beforeEach(() => {
  accounts = new FakeAutoLarisAccounts();
  setSellerPaymentTransport(accounts);
  setProviderCheckTransport(new FakeProviderCheck());
});
afterEach(() => {
  setSellerPaymentTransport(null);
  setProviderCheckTransport(null);
});

/** A platform-held store (the T-52 world): open at 10 %, one opted-in 100.000 product, an affiliate with code HEMAT10 and a link. No membership yet. */
async function world(slug = "toko-a") {
  const s = await makeStore(slug, { price: 100_000, stock: 200 });
  await openStore(s, 1_000);
  await optIn(s);
  const a = await makeAffiliate();
  await code(a, "HEMAT10");
  const l = await link(a, s);
  return { s, a, token: l.token };
}
const commissionOf = async (orderId: number) => (await platform.select().from(affiliateCommission).where(eq(affiliateCommission.orderId, orderId)))[0];
const commissions = () => platform.select().from(affiliateCommission).orderBy(affiliateCommission.id);
const nothingEarned = async (orderId: number) => {
  expect(await attributionOf(orderId)).toBeUndefined();
  expect(await commissionOf(orderId)).toBeUndefined();
  expect((await finLines(orderId)).every((l) => l.commissionRateBps === null)).toBe(true);
};
/** The seller's side of the financial snapshot: everything but the identity of the order. */
const proceeds = async (orderId: number) => {
  const { orderId: _o, createdAt: _c, ...rest } = await fin(orderId);
  return rest;
};
const pg = (p: Promise<unknown>) => p.then(() => "ok", (e: { cause?: { code?: string; message?: string }; code?: string; message?: string }) => `${e.cause?.code ?? e.code}: ${e.cause?.message ?? e.message}`);

type Dig = S & { me: SellerScope; digId: number; digVarId: number };
/**
 * A store on its own money (D-36: a listed bank account makes it `seller_owned`) selling one digital product; optionally with a SANDBOX AutoLaris account, whose
 * QRIS/VA orders are sandbox test orders (T-105 decision 11). Open at 10 % with the digital product opted in.
 */
async function digitalStore(slug: string, opts: { sandboxAutoLaris?: boolean } = {}): Promise<Dig> {
  const s = await makeStore(slug, { pickupArea: false });
  const me = bindSession(s.owner, await sessionOf(s.ownerId));
  await acceptSellerTerms(me, { version: 1, agreed: true });
  await addBankAccount(me, { bankCode: "BCA", accountNumber: "1234567890", holderName: "Pemilik Digital", proofId: await issueSellerStepUp(me, BANK_ACCOUNT_STEP_UP) });
  if (opts.sandboxAutoLaris) {
    await saveProviderKey(me, { provider: "autolaris", environment: "sandbox", apiKey: "CANARY-T108-AUTOLARIS-KEY-0123456789abcdef", proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "autolaris" }) });
    await setPaymentAccountDetails(me, { originAreaId: "3517100", destinationAreaId: "3518010", shipperEmail: `${slug}@example.invalid`, senderAddress: "Jl. Braga No. 1, Bandung", paymentOnlyConfirmed: true });
  }
  const digId = await createProduct(me, { title: `E-Book ${slug}`, kind: "digital", status: "draft", variant: { title: "PDF", price: 100_000, stock: 0 } });
  await addAccessLink(me, digId, { label: "Unduh", url: "https://drive.google.com/file/d/T108/view" });
  await updateProduct(me, digId, { title: `E-Book ${slug}`, description: "Panduan", kind: "digital", status: "active", slug: null });
  const [dv] = await admin.select().from(variant).where(eq(variant.productId, digId));
  await openStore(s, 1_000);
  await optIn(s, digId);
  return { ...s, me, digId, digVarId: dv!.id };
}
async function buyDigital(s: Dig, o: { code?: string; method?: "bank_transfer" | "manual_transfer" } = {}) {
  const cartId = await setCartLine(s.sf, undefined, { variantId: s.digVarId, quantity: 1 }, "add");
  const method = o.method ?? "bank_transfer";
  const { orderId } = await placeOrder(
    db,
    cartId,
    { idempotencyKey: randomUUID(), buyerName: "Pembeli Digital", buyerPhone: freshPhone(), buyerEmail: "pembeli@example.com", paymentMethod: method, ...(method === "manual_transfer" ? { paymentChannel: "VABCA" } : {}), ...(o.code ? { affiliateCode: o.code } : {}) },
    fakeProviders,
    { referral: { clickIds: [] } },
  );
  return orderId;
}
/** A COD order through confirm, process and ship (the courier's DELIVERED or RTS comes next). */
async function shipped(s: S, o: { code?: string } = {}) {
  const { orderId } = await buy(s, o);
  await transitionOrder(s.owner, orderId, "confirm");
  await transitionOrder(s.owner, orderId, "process");
  await transitionOrder(s.owner, orderId, "ship", { trackingNumber: `T108-${orderId}` });
  return orderId;
}

describe("T-108 membership: apply, review, auto-approval and the C-A4 projection", () => {
  it("an affiliate applies to an open store and lands pending; the seller sees display name, channels and note only; approve, reject, suspend and reinstate follow the state machine", async () => {
    const { s, a } = await world();
    await admin.update(affiliate).set({ displayName: "Rina Promosi" }).where(eq(affiliate.id, a.affiliateId));
    const r = await applyToStore(db, a.affiliateId, { storeId: s.storeId, note: "Saya punya 20 ribu pengikut", channels: ["instagram.com/rina", "tiktok @rina"] });
    expect(r.status).toBe("pending");
    expect(await applyToStore(db, a.affiliateId, { storeId: s.storeId })).toEqual(r); // idempotent: one open application per affiliate and store
    const [row] = await listMemberships(s.owner);
    expect(row).toEqual({ membershipId: r.membershipId, affiliateId: a.affiliateId, displayName: "Rina Promosi", channels: ["instagram.com/rina", "tiktok @rina"], applicationNote: "Saya punya 20 ribu pengikut", status: "pending", statusReason: null, appliedAt: expect.any(Date), reviewedAt: null });
    expect(JSON.stringify(await listMemberships(s.owner))).not.toMatch(new RegExp(`${a.phone.slice(1)}|@test\\.local|contact|email|npwp`, "i")); // C-A4: no e-mail, phone or tax identity
    expect(await errCode(reviewMembership(s.owner, { membershipId: r.membershipId, to: "suspended", reason: "x" }))).toBe("illegal_transition"); // pending cannot be suspended
    expect(await errCode(reviewMembership(s.owner, { membershipId: r.membershipId, to: "rejected", reason: " " }))).not.toBe("ok"); // a refusal needs a reason
    await reviewMembership(s.owner, { membershipId: r.membershipId, to: "rejected", reason: "Belum cocok" });
    expect((await listOwnMemberships(db, a.affiliateId))[0]).toMatchObject({ storeId: s.storeId, status: "rejected" });
    expect(await applyToStore(db, a.affiliateId, { storeId: s.storeId, note: "Coba lagi" })).toEqual({ membershipId: r.membershipId, status: "pending" }); // a new application
    expect((await listMemberships(s.owner))[0]).toMatchObject({ status: "pending", statusReason: null, reviewedAt: null, applicationNote: "Coba lagi" });
    await reviewMembership(s.owner, { membershipId: r.membershipId, to: "active" });
    await reviewMembership(s.owner, { membershipId: r.membershipId, to: "suspended", reason: "Spam" });
    expect(await errCode(applyToStore(db, a.affiliateId, { storeId: s.storeId }))).toBe("unavailable"); // a suspended member cannot apply its way back
    await reviewMembership(s.owner, { membershipId: r.membershipId, to: "active" });
    const [m] = await platform.select().from(affiliateMembership);
    expect(m).toMatchObject({ status: "active", reviewedBy: s.ownerId, revision: 6 }); // pending, rejected, pending, active, suspended, active
    // the database holds the machine for every writer, and the seller cannot rewrite the application
    expect(await errCode(admin.execute(sql`update affiliate_membership set status = 'pending'`))).toBe("23514");
    expect(await errCode(withStore(db, s.storeId, (tx) => tx.update(affiliateMembership).set({ applicationNote: "ditulis penjual" })))).toBe("42501");
    expect(await errCode(withStore(db, s.storeId, (tx) => tx.insert(affiliateMembership).values({ storeId: s.storeId, affiliateId: a.affiliateId, displayName: "Palsu" })))).toBe("42501");
    expect(await errCode(admin.execute(sql`delete from affiliate_membership`))).toBe("42501");
  });

  it("applications are refused alike for a closed, unknown or blocking store, an inactive account and a staff without the capability; auto-approval (off by default) admits at once", async () => {
    const { s, a } = await world();
    const closed = await makeStore("toko-tutup");
    expect(await errCode(applyToStore(db, a.affiliateId, { storeId: closed.storeId }))).toBe("unavailable"); // programme never opened
    expect(await errCode(applyToStore(db, a.affiliateId, { storeId: 999_999 }))).toBe("unavailable");
    await blockAffiliate(s.owner, { affiliateId: a.affiliateId, reason: "uji" });
    expect(await errCode(applyToStore(db, a.affiliateId, { storeId: s.storeId }))).toBe("unavailable");
    await admin.execute(sql`delete from affiliate_block`);
    const pending = await makeAffiliate({ status: "pending" });
    expect(await errCode(applyToStore(db, pending.affiliateId, { storeId: s.storeId }))).toBe("unavailable");
    expect(await errCode(applyToStore(db, a.affiliateId, { storeId: s.storeId, channels: ["a", "b", "c", "d", "e", "f"] }))).not.toBe("ok"); // at most five channels
    // the definer function takes the affiliate from the context only: without one it refuses, and nothing names another affiliate
    expect(await errCode(db.execute(sql`select * from public.affiliate_apply(${s.storeId}::bigint, null::text, '{}'::text[])`))).toBe("42501");
    expect((await affiliateSettings(s.owner)).autoApprove).toBe(false);
    await saveAffiliatePolicy(s.owner, { participation: "open", defaultRateBps: 1_000, autoApprove: true });
    expect(await applyToStore(db, a.affiliateId, { storeId: s.storeId })).toMatchObject({ status: "active" });
    expect((await platform.select().from(affiliateMembership))[0]).toMatchObject({ status: "active", reviewedBy: "system:auto_approve" });
    await saveAffiliatePolicy(s.owner, { participation: "open", defaultRateBps: 900 }); // omitted: the switch stays as it is
    expect((await affiliateSettings(s.owner)).autoApprove).toBe(true);
  });

  it("RL-AFF-STORE-APPLY: 20 applications a day per affiliate, the 21st is refused before the database is asked; another affiliate is unaffected", async () => {
    const { s, a } = await world();
    for (let i = 0; i < RL_AFF_STORE_APPLY.limit; i++) await applyToStore(db, a.affiliateId, { storeId: s.storeId });
    expect(await errCode(applyToStore(db, a.affiliateId, { storeId: s.storeId }))).toBe("rate_limited");
    const b = await makeAffiliate({ name: "Afiliasi Dua" });
    expect(await applyToStore(db, b.affiliateId, { storeId: s.storeId })).toMatchObject({ status: "pending" });
  });

  it("C-A3: a user with a verified e-mail registers active, an unverified one pending; the database refuses an active account for an unverified e-mail", async () => {
    const verified = await makeUser("aff-ok");
    await platform.update(user).set({ emailVerified: true }).where(eq(user.id, verified));
    const okId = await registerAffiliate(platform, { userId: verified, displayName: "Sudah Verifikasi", phone: freshPhone() });
    const waitId = await registerAffiliate(platform, { userId: await makeUser("aff-wait"), displayName: "Belum Verifikasi", phone: freshPhone() });
    const rows = await platform.select({ id: affiliate.id, status: affiliate.status }).from(affiliate).orderBy(affiliate.id);
    expect(rows).toEqual([{ id: okId, status: "active" }, { id: waitId, status: "pending" }]);
    expect(await errCode(admin.execute(sql`insert into affiliate (user_id, display_name, contact_phone, status) values (${await makeUser("aff-x")}, 'Langsung Aktif', '6281200000001', 'active')`))).toBe("23514");
  });
});

describe("T-108 attribution requires an active membership", () => {
  it("no attribution without active membership: none, pending, rejected and suspended each earn nothing by code or click; active earns; a suspension stops new attribution and keeps what was earned", async () => {
    const { s, a, token } = await world();
    const c1 = await click(token);
    await nothingEarned((await buy(s, { code: "HEMAT10", clicks: [c1] })).orderId); // no membership at all
    const mid = await member(a, s, "pending");
    await nothingEarned((await buy(s, { code: "HEMAT10", clicks: [c1] })).orderId);
    await reviewMembership(s.owner, { membershipId: mid, to: "rejected", reason: "uji" });
    await nothingEarned((await buy(s, { code: "HEMAT10", clicks: [c1] })).orderId);
    await applyToStore(db, a.affiliateId, { storeId: s.storeId });
    await reviewMembership(s.owner, { membershipId: mid, to: "active" });
    const earned = await buy(s, { code: "HEMAT10" });
    expect(await attributionOf(earned.orderId)).toMatchObject({ affiliateId: a.affiliateId, method: "code", commissionIdr: 10_000 });
    expect((await attributionOf((await buy(s, { clicks: [c1] })).orderId))!.method).toBe("link");
    await reviewMembership(s.owner, { membershipId: mid, to: "suspended", reason: "uji" });
    await nothingEarned((await buy(s, { code: "HEMAT10", clicks: [c1] })).orderId);
    expect(await commissionOf(earned.orderId)).toMatchObject({ status: "pending", commissionIdr: 10_000 }); // nothing earned is rewritten
  });

  it("an ineligible code falls back to an eligible click of a member; the RL-CODE validity check counts a non-member's code as unusable here", async () => {
    const { s, a } = await world();
    const b = await makeAffiliate({ name: "Afiliasi Dua" });
    await member(b, s);
    const bClick = await click((await link(b, s)).token);
    expect(await attributionOf((await buy(s, { code: "HEMAT10", clicks: [bClick] })).orderId)).toMatchObject({ affiliateId: b.affiliateId, method: "link" });
    const valid = () => withStore(db, s.storeId, async (tx) => ((await tx.execute(sql`select public.affiliate_code_valid(${s.storeId}::bigint, 'HEMAT10') as ok`)) as unknown as { ok: boolean }[])[0]!.ok);
    expect(await valid()).toBe(false);
    await member(a, s);
    expect(await valid()).toBe(true);
  });

  it("the database refuses an attribution without an active membership whoever writes it (guard), and the resolver never selects one", async () => {
    const { s, a } = await world();
    const mid = await member(a, s);
    const earned = await buy(s, { code: "HEMAT10" });
    const plain = await buy(s);
    await reviewMembership(s.owner, { membershipId: mid, to: "suspended", reason: "uji" });
    const resolve = (orderId: number) => withStore(admin, s.storeId, async (t) => ((await t.execute(sql`select r_outcome from public.affiliate_resolve(${s.storeId}::bigint, ${orderId}::bigint, 'HEMAT10'::text, null::text[])`)) as unknown as { r_outcome: string }[])[0]!.r_outcome);
    expect(await resolve(plain.orderId)).toBe("none");
    const { id: _i, createdAt: _c, orderId: _o, ...rest } = (await attributionOf(earned.orderId))!;
    expect(await pg(admin.insert(affiliateAttribution).values({ ...rest, orderId: plain.orderId }))).toMatch(/^23514: .*no active membership/);
  });
});

describe("T-108 the commission is the seller's obligation, never a deduction from the sale", () => {
  it("seller order_financials proceeds identical with and without attribution: platform-held COD and seller-owned bank transfer", async () => {
    const { s, a } = await world();
    await member(a, s);
    const control = await buy(s);
    const attributed = await buy(s, { code: "HEMAT10" });
    expect(await attributionOf(attributed.orderId)).toMatchObject({ commissionIdr: 10_000, commissionBaseIdr: 100_000 });
    expect(await commissionOf(attributed.orderId)).toMatchObject({ affiliateId: a.affiliateId, commissionIdr: 10_000, commissionBaseIdr: 100_000, holdDays: 3, status: "pending" });
    expect(await proceeds(attributed.orderId)).toEqual(await proceeds(control.orderId));
    expect(await fin(attributed.orderId)).toMatchObject({ moneyMode: "platform_held", affiliateId: null, affiliateCommissionIdr: 0, saleAmountIdr: 100_000 });
    expect((await finLines(attributed.orderId)).map((l) => l.commissionRateBps)).toEqual([1_000]); // the frozen rate, on the line

    const d = await digitalStore("toko-digital");
    await member(a, d);
    const dControl = await buyDigital(d);
    const dAttributed = await buyDigital(d, { code: "HEMAT10" });
    expect(await commissionOf(dAttributed)).toMatchObject({ commissionIdr: 10_000, status: "pending" });
    expect(await proceeds(dAttributed)).toEqual(await proceeds(dControl));
    expect(await fin(dAttributed)).toMatchObject({ moneyMode: "seller_owned", affiliateId: null, affiliateCommissionIdr: 0, saleAmountIdr: 100_000 });
    expect((await verifyLedger(platform)).violations).toEqual([]);
  });

  it("the database refuses a snapshot that deducts a commission, and an attribution without its obligation (deferred check at COMMIT)", async () => {
    const { s, a } = await world();
    await member(a, s);
    await buy(s, { code: "HEMAT10" });
    // 1. a rogue trigger swallows the obligation: the order cannot commit
    await admin.execute(sql`create function t108_skip() returns trigger language plpgsql as $$ begin return null; end $$`);
    await admin.execute(sql`create trigger t108_skip before insert on affiliate_commission for each row execute function t108_skip()`);
    try {
      expect(await pg(buy(s, { code: "HEMAT10" }))).toMatch(/without its obligation/);
    } finally {
      await admin.execute(sql`drop trigger t108_skip on affiliate_commission`);
      await admin.execute(sql`drop function t108_skip()`);
    }
    // 2. a rogue trigger makes the snapshot deduct (the T-52 shape): refused at COMMIT for every role
    await admin.execute(sql.raw(`create function t108_deduct() returns trigger language plpgsql as $$ begin new.affiliate_commission_idr := 10000; new.sale_amount_idr := new.sale_amount_idr - 10000; new.affiliate_id := ${a.affiliateId}; return new; end $$`));
    await admin.execute(sql`create trigger t108_deduct before insert on order_financials for each row execute function t108_deduct()`);
    try {
      expect(await pg(buy(s))).toMatch(/deducts an affiliate commission/); // the deferred check, for any order
      expect(await pg(buy(s, { code: "HEMAT10" }))).toMatch(/without a commission deduction/); // the attribution guard refuses first
    } finally {
      await admin.execute(sql`drop trigger t108_deduct on order_financials`);
      await admin.execute(sql`drop function t108_deduct()`);
    }
    expect(await commissions()).toHaveLength(1);
    // 3. an obligation must equal its attribution, and only the definer function writes one
    const first = (await commissions())[0]!;
    const plain = await buy(s);
    expect(await errCode(admin.insert(affiliateCommission).values({ storeId: s.storeId, orderId: plain.orderId, affiliateId: a.affiliateId, commissionBaseIdr: 1, commissionIdr: 1, holdDays: 3 }))).toBe("23514"); // no attribution behind it (guard; the foreign key is the backstop)
    expect(await errCode(admin.execute(sql`update affiliate_commission set commission_idr = 1 where id = ${first.id}`))).toBe("42501");
    expect(await errCode(withStore(db, s.storeId, (tx) => tx.update(affiliateCommission).set({ status: "void", voidReason: "penjual" })))).toBe("42501");
    expect(await errCode(admin.execute(sql`delete from affiliate_commission`))).toBe("42501");
  });

  it("one obligation per order under concurrent submits (same request, and different idempotency keys on one cart)", async () => {
    const { s, a } = await world();
    await member(a, s);
    const cartId = await cartOf(s);
    const input = buyer({ buyerPhone: freshPhone(), affiliateCode: "HEMAT10" });
    const settled = await Promise.allSettled(Array.from({ length: 8 }, () => placeOrder(db, cartId, input, undefined, { referral: { clickIds: [] } })));
    expect(new Set(settled.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ orderId: number }>).value.orderId)).size).toBe(1);
    const cart2 = await cartOf(s);
    const phone = freshPhone();
    await Promise.allSettled(Array.from({ length: 6 }, () => placeOrder(db, cart2, buyer({ buyerPhone: phone, affiliateCode: "HEMAT10" }), undefined, { referral: { clickIds: [] } })));
    const orders = await platform.select({ id: order.id }).from(order);
    expect(orders).toHaveLength(2);
    const rows = await commissions();
    expect(rows.map((r) => r.orderId).sort()).toEqual(orders.map((o) => o.id).sort());
    expect(await platform.select().from(affiliateAttribution)).toHaveLength(2);
    expect(await errCode(admin.execute(sql`insert into affiliate_commission (store_id, order_id, affiliate_id, commission_base_idr, commission_idr, hold_days) select store_id, order_id, affiliate_id, commission_base_idr, commission_idr, hold_days from affiliate_commission limit 1`))).toBe("23505");
  });

  it("sandbox orders earn nothing: a sandbox AutoLaris order of a member's code records no attribution and no obligation, and the resolver and the guard refuse a test order", async () => {
    const d = await digitalStore("toko-sandbox", { sandboxAutoLaris: true });
    const a = await makeAffiliate();
    await code(a, "HEMAT10");
    await member(a, d);
    const testOrder = await buyDigital(d, { code: "HEMAT10", method: "manual_transfer" });
    expect((await platform.select({ t: order.testOrder }).from(order).where(eq(order.id, testOrder)))[0]!.t).toBe(true);
    await nothingEarned(testOrder);
    const real = await buyDigital(d, { code: "HEMAT10" }); // bank transfer: not a sandbox order, it earns
    expect(await commissionOf(real)).toMatchObject({ commissionIdr: 10_000 });
    expect(await withStore(admin, d.storeId, async (t) => ((await t.execute(sql`select r_outcome from public.affiliate_resolve(${d.storeId}::bigint, ${testOrder}::bigint, 'HEMAT10'::text, null::text[])`)) as unknown as { r_outcome: string }[])[0]!.r_outcome)).toBe("none");
    const { id: _i, createdAt: _c, orderId: _o, ...rest } = (await attributionOf(real))!;
    expect(await pg(admin.insert(affiliateAttribution).values({ ...rest, orderId: testOrder }))).toMatch(/^23514: a sandbox test order earns no commission/);
  });
});

describe("T-108 obligation life: void before delivery, payable after the hold", () => {
  it("the order status writer voids on cancel and on return before delivery, and stamps delivery with the snapshotted hold", async () => {
    const { s, a } = await world();
    await member(a, s);
    const rejected = (await buy(s, { code: "HEMAT10" })).orderId; // COD awaiting confirmation, rejected by the seller
    await transitionOrder(s.owner, rejected, "reject", { reason: "Stok habis" });
    expect(await commissionOf(rejected)).toMatchObject({ status: "void", voidReason: "order_cancelled", deliveredAt: null, voidedAt: expect.any(Date) });
    const returned = await shipped(s, { code: "HEMAT10" });
    await withStore(platform, s.storeId, (tx) => applyProviderTransition(tx, s.storeId, returned, "returned", { source: "provider", note: "RTS" }));
    expect(await commissionOf(returned)).toMatchObject({ status: "void", voidReason: "order_returned" });
    const delivered = await shipped(s, { code: "HEMAT10" });
    await admin.execute(sql`update affiliate_policy set hold_days = 5`); // a later policy change never moves an existing obligation
    await deliver(s.storeId, delivered);
    const c = (await commissionOf(delivered))!;
    expect(c).toMatchObject({ status: "pending", holdDays: 3 });
    expect(c.payableAt!.getTime() - c.deliveredAt!.getTime()).toBe(3 * 86_400_000);
    expect(await releasePayableCommissions(platform)).toBe(0); // inside the hold
    // a delivered order cannot be cancelled any more, so nothing reverses the obligation automatically
    expect(await errCode(admin.execute(sql`update "order" set status = 'cancelled' where id = ${delivered}`))).toBe("23514");
    // and delivery is stamped once, by the hook only
    expect(await errCode(admin.execute(sql`update affiliate_commission set delivered_at = now(), payable_at = now() + interval '3 days' where order_id = ${delivered}`))).toBe("23514");
    expect(await errCode(admin.execute(sql`update affiliate_commission set delivered_at = now(), payable_at = now() + interval '3 days' where order_id = ${(await buy(s, { code: "HEMAT10" })).orderId}`))).toBe("23514"); // not completed
  });

  it("void and payable transitions exactly at the boundary: at payable_at the obligation is payable and no longer voidable; one microsecond before it is still voidable and not released", async () => {
    const { s, a } = await world();
    await member(a, s);
    const atBoundary = await shipped(s, { code: "HEMAT10" });
    const before = await shipped(s, { code: "HEMAT10" });
    const undelivered = (await buy(s, { code: "HEMAT10" })).orderId;
    await deliver(s.storeId, atBoundary);
    await deliver(s.storeId, before);
    const status = async (orderId: number) => (await commissionOf(orderId))!.status;
    await admin.transaction(async (tx) => {
      // now() is the transaction start: move both delivery stamps so that payable_at is exactly now() and now() + 1 µs (the guard is off only for this rewrite)
      await tx.execute(sql`alter table affiliate_commission disable trigger affiliate_commission_guard`);
      await tx.execute(sql`update affiliate_commission set delivered_at = now() - make_interval(days => hold_days), payable_at = now() where order_id = ${atBoundary}`);
      await tx.execute(sql`update affiliate_commission set delivered_at = now() - make_interval(days => hold_days) + interval '1 microsecond', payable_at = now() + interval '1 microsecond' where order_id = ${before}`);
      await tx.execute(sql`alter table affiliate_commission enable trigger affiliate_commission_guard`);
      const attempt = (q: ReturnType<typeof sql>) => tx.transaction((t) => t.execute(q)).then(() => "ok", (e: { cause?: { code?: string } }) => e.cause?.code);
      expect(await attempt(sql`update affiliate_commission set status = 'void', void_reason = 'uji' where order_id = ${atBoundary}`)).toBe("23514");
      expect(await attempt(sql`update affiliate_commission set status = 'payable' where order_id = ${before}`)).toBe("23514");
      expect(await attempt(sql`update affiliate_commission set status = 'payable' where order_id = ${undelivered}`)).toBe("23514"); // release before delivery: refused
      expect(await releasePayableCommissions(tx)).toBe(1);
      expect(await attempt(sql`update affiliate_commission set status = 'void', void_reason = 'akses dicabut' where order_id = ${before}`)).toBe("ok");
    });
    expect([await status(atBoundary), await status(before), await status(undelivered)]).toEqual(["payable", "void", "pending"]);
    expect(await errCode(admin.execute(sql`update affiliate_commission set status = 'void', void_reason = 'x' where order_id = ${atBoundary}`))).toBe("23514"); // payable is never voided automatically
    expect(await releasePayableCommissions(platform)).toBe(0); // replay-safe: nothing left to move
  });

  it("a digital-only order is delivered when paid; revoking its last grant inside the hold voids the obligation, after the hold it does not", async () => {
    const d = await digitalStore("toko-digital");
    const a = await makeAffiliate();
    await code(a, "HEMAT10");
    await member(a, d);
    const inside = await buyDigital(d, { code: "HEMAT10" });
    const after = await buyDigital(d, { code: "HEMAT10" });
    for (const o of [inside, after]) await confirmBankTransfer(d.me, { orderId: o, reason: "Mutasi BCA cocok" });
    const c = (await commissionOf(inside))!;
    expect(c).toMatchObject({ status: "pending" });
    expect(c.payableAt!.getTime() - c.deliveredAt!.getTime()).toBe(3 * 86_400_000); // the hold starts at completion = grant issuance (ADR-0016 decision 20)
    const grantOf = async (orderId: number) => (await admin.select({ id: digitalGrant.id }).from(digitalGrant).where(eq(digitalGrant.orderId, orderId)))[0]!.id;
    await revokeDigitalGrant(d.me, await grantOf(inside), { reason: "Pembeli minta batal" });
    expect(await commissionOf(inside)).toMatchObject({ status: "void", voidReason: "digital_grant_revoked: Pembeli minta batal" });
    await admin.transaction(async (tx) => {
      await tx.execute(sql`alter table affiliate_commission disable trigger affiliate_commission_guard`);
      await tx.execute(sql`update affiliate_commission set delivered_at = now() - interval '3 days', payable_at = now() where order_id = ${after}`);
      await tx.execute(sql`alter table affiliate_commission enable trigger affiliate_commission_guard`);
    });
    await revokeDigitalGrant(d.me, await grantOf(after), { reason: "Dicabut setelah masa tahan" });
    expect(await commissionOf(after)).toMatchObject({ status: "pending" });
    expect(await releasePayableCommissions(platform)).toBe(1);
    expect(await commissionOf(after)).toMatchObject({ status: "payable" });
  });
});

describe("T-108 isolation of memberships and obligations", () => {
  it("store A cannot read or change store B's memberships or obligations, affiliate A cannot read affiliate B's, and nothing is readable without a context", async () => {
    const a = await world("toko-a");
    const b = await makeStore("toko-b", { price: 100_000, stock: 50 });
    await openStore(b, 1_000);
    await optIn(b);
    const y: A = await makeAffiliate({ name: "Afiliasi Dua" });
    await code(y, "YYYY2222");
    const xa = await member(a.a, a.s);
    const xb = await member(a.a, b);
    const yb = await member(y, b);
    const oa = (await buy(a.s, { code: "HEMAT10" })).orderId;
    const ob = (await buy(b, { code: "HEMAT10" })).orderId;
    const oy = (await buy(b, { code: "YYYY2222" })).orderId;

    // sellers: their own store only, through the services and through raw statements under the store policy
    expect((await listMemberships(a.s.owner)).map((m) => m.membershipId)).toEqual([xa]);
    expect((await listMemberships(b.owner)).map((m) => m.membershipId)).toEqual([xb, yb]);
    expect((await listStoreCommissions(a.s.owner)).map((c) => c.orderId)).toEqual([oa]);
    expect((await listStoreCommissions(b.owner)).map((c) => c.orderId).sort()).toEqual([ob, oy].sort());
    expect(await errCode(reviewMembership(a.s.owner, { membershipId: yb, to: "suspended", reason: "bukan milik A" }))).toBe("not_found");
    await withStore(db, a.s.storeId, async (tx) => {
      expect(await tx.select().from(affiliateMembership).where(eq(affiliateMembership.id, yb))).toEqual([]);
      expect(await tx.select().from(affiliateCommission).where(eq(affiliateCommission.orderId, ob))).toEqual([]);
      expect(await tx.update(affiliateMembership).set({ status: "suspended", statusReason: "x", reviewedBy: "x" }).where(eq(affiliateMembership.id, yb)).returning()).toEqual([]);
    });
    expect(await errCode(withStore(db, a.s.storeId, (tx) => tx.update(affiliateMembership).set({ storeId: b.storeId }).where(eq(affiliateMembership.id, xa))))).toBe("42501");
    expect((await platform.select().from(affiliateMembership).where(eq(affiliateMembership.id, yb)))[0]!.status).toBe("active");

    // affiliates: their own rows across stores, never another affiliate's, never an order id
    expect((await listOwnMemberships(db, a.a.affiliateId)).map((m) => m.membershipId)).toEqual([xa, xb]);
    expect((await listOwnMemberships(db, y.affiliateId)).map((m) => m.membershipId)).toEqual([yb]);
    const own = await listOwnCommissions(db, y.affiliateId);
    expect(own.map((c) => c.commissionIdr)).toEqual([10_000]);
    expect(Object.keys(own[0]!)).not.toContain("orderId");
    expect(JSON.stringify(own)).not.toContain(`"${oy}"`);
    expect((await listOwnCommissions(db, a.a.affiliateId)).map((c) => c.storeId).sort()).toEqual([a.s.storeId, b.storeId].sort());
    // the affiliate context opens neither table directly (they are store records), and no context sees nothing
    await withAffiliate(db, y.affiliateId, async (tx) => {
      expect(await tx.select().from(affiliateMembership)).toEqual([]);
      expect(await tx.select().from(affiliateCommission)).toEqual([]);
    });
    expect(await db.select().from(affiliateMembership)).toEqual([]);
    expect(await db.select().from(affiliateCommission)).toEqual([]);
    expect(await db.execute(sql`select * from public.affiliate_own_commissions()`)).toHaveLength(0);
  });
});

describe("T-108 programme bounds and legacy rows", () => {
  it("the decided bounds (100 to 5000 bps, 7-day window) apply to the store default and the per-product override", async () => {
    const s = await makeStore("toko-a");
    expect((await affiliateSettings(s.owner)).bounds).toEqual({ minRateBps: 100, maxRateBps: 5_000 });
    await saveAffiliatePolicy(s.owner, { participation: "open", defaultRateBps: 5_000 });
    expect(await errCode(saveAffiliatePolicy(s.owner, { participation: "open", defaultRateBps: 5_001 }))).toBe("rate_out_of_bounds");
    expect(await errCode(saveAffiliatePolicy(s.owner, { participation: "open", defaultRateBps: 99 }))).toBe("rate_out_of_bounds");
    expect(await errCode(optIn(s, s.productId, 5_001))).toBe("rate_out_of_bounds");
    expect(await optIn(s, s.productId, 4_000)).toBeGreaterThan(0);
  });

  it("a T-52 attribution written before T-108 keeps its deduction and gets no obligation; the order hooks leave it alone", async () => {
    const { s, a } = await world();
    await member(a, s);
    const o = await shipped(s);
    // the pre-0028 shape, written as the old checkout did (rates on the lines, the deduction on the snapshot), with the checks of this migration off
    await admin.transaction(async (tx) => {
      await tx.execute(sql`alter table order_line_financials disable trigger user`);
      await tx.execute(sql`alter table order_financials disable trigger user`);
      await tx.execute(sql`alter table affiliate_attribution disable trigger user`);
      await tx.execute(sql`update order_line_financials set commission_rate_bps = 1000 where order_id = ${o}`);
      await tx.execute(sql`update order_financials set affiliate_id = ${a.affiliateId}, affiliate_commission_idr = 10000, sale_amount_idr = sale_amount_idr - 10000 where order_id = ${o}`);
      await tx.execute(sql`insert into affiliate_attribution (order_id, store_id, affiliate_id, method, code_id, window_days, hold_days, policy_revision, seller_policy_revision, commission_base_idr, commission_idr)
        select ${o}, ${s.storeId}, ${a.affiliateId}, 'code', c.id, 7, 3, 1, 1, 100000, 10000 from affiliate_code c limit 1`);
      await tx.execute(sql`alter table order_line_financials enable trigger user`);
      await tx.execute(sql`alter table order_financials enable trigger user`);
      await tx.execute(sql`alter table affiliate_attribution enable trigger user`);
    });
    await deliver(s.storeId, o);
    expect(await commissionOf(o)).toBeUndefined();
    expect(await attributionOf(o)).toMatchObject({ status: "pending", eligibleAt: null, commissionIdr: 10_000 });
    expect(await fin(o)).toMatchObject({ affiliateCommissionIdr: 10_000, saleAmountIdr: 90_000 });
    expect((await verifyLedger(platform)).violations).toEqual([]);
  });
});
