import { eq, sql } from "drizzle-orm";
import type { Tx } from "../src/client.ts";
import { beforeEach, describe, expect, it } from "vitest";
import { createCode, createLink, listOwnLinks, registerAffiliate, reviewAffiliate, revokeCode, revokeLink } from "../src/affiliate/accounts.ts";
import { listAffiliateCatalog, projectOffers } from "../src/affiliate/catalog.ts";
import { AFFILIATE_ATTRIBUTION_WINDOW_DAYS_DEFAULT, AFFILIATE_HOLD_DAYS_DEFAULT, AFFILIATE_MAX_RATE_BPS_DEFAULT, AFFILIATE_MIN_RATE_BPS_DEFAULT } from "../src/affiliate/settings.ts";
import { affiliate, affiliateAttribution, affiliateBlock, affiliateCatalog, affiliateClick, affiliateCode, affiliateLink, affiliateOffer, affiliatePolicy, affiliateSellerPolicy } from "../src/affiliate/schema-affiliate.ts";
import { affiliateSettings, blockAffiliate, listBlocks, listOffers, optInProduct, saveAffiliatePolicy, setOfferRate, setOfferStatus, unblockAffiliate } from "../src/affiliate/seller.ts";
import { withAffiliate, withStore } from "../src/platform/tenant.ts";
import { orderFinancials, orderLineFinancials, product } from "../src/schema.ts";
import { admin, db, makeStore, makeUser, platform, seller } from "./helpers.ts";
import { billingTestSetup, operatorWith, sellerAs } from "./t50-fixtures.ts";
import { addProduct, attributionOf, buy, click, code, errCode, link, makeAffiliate, openStore, optIn, resetFixtures, setAccountStatus, freshPhone, type A } from "./t52-fixtures.ts";

// T-52 slice 1: the DATA-11 schema as the database enforces it (state machines, uniqueness, matching-store and matching-affiliate foreign keys, immutability), the named
// defaults, the seller services and the isolation of every table under the real application role. Mutation checks are recorded in docs/tracks/t52.md.
billingTestSetup();
beforeEach(resetFixtures);

const asApp = <T>(storeId: number, fn: (tx: Tx) => Promise<T>) => withStore(db, storeId, fn);
const throws = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code ?? "error");

describe("T-52 the affiliate account state machine is the database's (ADR-0009 section 3)", () => {
  const STATES = ["pending", "active", "rejected", "suspended", "closed"] as const;
  const LEGAL = new Set(["pending>active", "pending>rejected", "active>suspended", "active>closed", "suspended>active", "suspended>closed", "rejected>pending"]);
  const reach = (to: (typeof STATES)[number]) => ({ pending: [], active: ["active"], rejected: ["rejected"], suspended: ["active", "suspended"], closed: ["active", "closed"] })[to];

  it("every one of the 25 moves is accepted exactly when it is on the legal list (closed is final)", async () => {
    for (const from of STATES) {
      for (const to of STATES) {
        const id = await registerAffiliate(platform, { userId: await makeUser("aff"), displayName: "Uji Status", phone: freshPhone() });
        for (const step of reach(from)) await admin.execute(sql`update affiliate set status = ${step}, status_reason = 'path' where id = ${id}`);
        const outcome = await throws(admin.execute(sql`update affiliate set status = ${to}, status_reason = 'uji' where id = ${id}`));
        expect(outcome, `${from} -> ${to}`).toBe(from === to || LEGAL.has(`${from}>${to}`) ? "ok" : "23514");
      }
    }
  });

  it("an account starts pending only, keeps its identity, and a refusal, suspension or closure carries a reason", async () => {
    const userId = await makeUser("aff");
    expect(await throws(admin.execute(sql`insert into affiliate (user_id, display_name, contact_phone, status) values (${userId}, 'Langsung Aktif', '6281200000001', 'active')`))).toBe("23514");
    const id = await registerAffiliate(platform, { userId, displayName: "Satu Akun", phone: freshPhone() });
    expect(await errCode(registerAffiliate(platform, { userId, displayName: "Akun Ganda", phone: freshPhone() }))).toBe("conflict"); // one account, one affiliate
    expect(await throws(admin.execute(sql`update affiliate set user_id = ${await makeUser("aff")} where id = ${id}`))).toBe("23514");
    expect(await throws(admin.execute(sql`update affiliate set status = 'rejected' where id = ${id}`))).toBe("23514"); // no reason
    expect(await throws(admin.execute(sql`update affiliate set status = 'rejected', status_reason = '   ' where id = ${id}`))).toBe("23514");
    expect(await errCode(registerAffiliate(platform, { userId: await makeUser("aff"), displayName: "Nomor Salah", phone: "021 5551234" }))).toBe("bad_phone"); // a landline has no canonical identity
    expect(await throws(admin.execute(sql`insert into affiliate (user_id, display_name, contact_phone) values (${await makeUser("aff")}, 'Nomor Mentah', '081200000009')`))).toBe("23514"); // only the canonical form is stored
  });

  it("the Owner console review needs the capability, refuses a staff identity as target, audits, and leaves earned attribution untouched", async () => {
    const a = await makeAffiliate({ status: "pending" });
    const noCap = await operatorWith("tenants.read");
    expect(await errCode(reviewAffiliate(noCap, { affiliateId: a.affiliateId, to: "active" }))).toBe("forbidden");
    const reviewer = await operatorWith("affiliate.accounts.review");
    expect(await errCode(reviewAffiliate(reviewer, { affiliateId: a.affiliateId, to: "suspended", reason: "x" }))).toBe("illegal_transition"); // pending cannot be suspended
    expect(await errCode(reviewAffiliate(reviewer, { affiliateId: a.affiliateId, to: "rejected" }))).toBe("reason_required");
    await reviewAffiliate(reviewer, { affiliateId: a.affiliateId, to: "active" });
    expect((await platform.select().from(affiliate).where(eq(affiliate.id, a.affiliateId)))[0]).toMatchObject({ status: "active", reviewedBy: reviewer.userId });
    expect(await errCode(reviewAffiliate(reviewer, { affiliateId: 999_999, to: "active" }))).toBe("not_found");
    // a staff member is never a target of an affiliate account action (answers not-found)
    const staffAffiliate = await makeAffiliate({ status: "pending" });
    await platform.execute(sql`insert into platform_operator (user_id) values (${staffAffiliate.userId})`);
    expect(await errCode(reviewAffiliate(reviewer, { affiliateId: staffAffiliate.affiliateId, to: "active" }))).toBe("not_found");
    const audit = await platform.execute(sql`select action, actor_capability from audit_log where subject_kind = 'affiliate' and subject_id = ${String(a.affiliateId)}`);
    expect(audit).toEqual([expect.objectContaining({ action: "affiliate.account.active", actor_capability: "affiliate.accounts.review" })]);
  });

  it("a seller membership grants no affiliate account and the account table is closed to the seller role", async () => {
    const s = await makeStore("toko-a");
    const a = await makeAffiliate();
    expect(await asApp(s.storeId, (tx) => tx.select().from(affiliate))).toEqual([]);
    expect(await throws(asApp(s.storeId, (tx) => tx.update(affiliate).set({ status: "suspended", statusReason: "x" }).where(eq(affiliate.id, a.affiliateId))))).toBe("42501");
    expect(await throws(db.insert(affiliate).values({ userId: await makeUser("x"), displayName: "Palsu", contactPhone: "6281200000002" }))).toBe("42501");
  });
});

describe("T-52 selectors: globally unique codes, tokens, matching-store and matching-affiliate foreign keys", () => {
  it("a code is globally unique after normalisation, across affiliates and spellings; the stored form is checked by the database", async () => {
    const a = await makeAffiliate();
    const b = await makeAffiliate({ name: "Afiliasi Dua" });
    await code(a, "Hemat 10");
    expect(await errCode(createCode(db, b.affiliateId, { code: "HEMAT-10" }))).toBe("code_taken");
    expect(await errCode(createCode(db, a.affiliateId, { code: "hemat_10" }))).toBe("code_taken"); // not even its own owner twice
    expect(await errCode(createCode(db, b.affiliateId, { code: "ab" }))).toBe("bad_code");
    expect(await throws(admin.execute(sql`insert into affiliate_code (affiliate_id, code) values (${b.affiliateId}, 'lowercase1')`))).toBe("23514");
    expect(await throws(admin.execute(sql`insert into affiliate_code (affiliate_id, code) values (${b.affiliateId}, 'HEMAT10')`))).toBe("23505");
    expect(await throws(admin.execute(sql`insert into affiliate_code (affiliate_id, code) values (${b.affiliateId}, 'ABC DEF')`))).toBe("23514");
  });

  it("only an active account creates links and codes; a revoked selector stays revoked and nothing else about it ever changes", async () => {
    const s = await makeStore("toko-a");
    const pending = await makeAffiliate({ status: "pending" });
    expect(await errCode(createLink(db, pending.affiliateId, { storeId: s.storeId }))).toBe("not_active");
    expect(await errCode(createCode(db, pending.affiliateId, { code: "PENDING1" }))).toBe("not_active");
    const a = await makeAffiliate();
    const l = await link(a, s);
    const c = await code(a, "REVOKEME");
    await revokeLink(db, a.affiliateId, l.id);
    await revokeCode(db, a.affiliateId, c.id);
    expect(await errCode(revokeLink(db, a.affiliateId, l.id))).toBe("not_found");
    expect(await throws(admin.execute(sql`update affiliate_link set status = 'active', revoked_at = null where id = ${l.id}`))).toBe("23514");
    expect(await throws(admin.execute(sql`update affiliate_link set token = 'AAAAAAAAAAAAAAAAAAAA' where id = ${l.id}`))).toBe("23514");
    expect(await throws(admin.execute(sql`update affiliate_link set store_id = ${s.storeId + 1} where id = ${l.id}`))).toBe("23514");
    expect(await throws(admin.execute(sql`update affiliate_code set code = 'OTHERONE' where id = ${c.id}`))).toBe("23514");
    expect(await throws(admin.execute(sql`insert into affiliate_link (affiliate_id, token, store_id, source) values (${a.affiliateId}, 'tokentokentokentok', ${s.storeId}, 'tokophi')`))).toBe("23514"); // source is `bukalaris` only
    expect(await throws(admin.execute(sql`insert into affiliate_link (affiliate_id, token, store_id) values (${a.affiliateId}, 'short', ${s.storeId})`))).toBe("23514");
  });

  it("a link's offer must belong to the link's own store (matching-store foreign key)", async () => {
    const s = await makeStore("toko-a");
    const other = await makeStore("toko-b");
    await openStore(other);
    const otherOffer = await optIn(other);
    const a = await makeAffiliate();
    expect(await errCode(createLink(db, a.affiliateId, { storeId: s.storeId, offerId: otherOffer }))).toBe("not_found");
    expect((await createLink(db, a.affiliateId, { storeId: other.storeId, offerId: otherOffer })).token).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(await errCode(createLink(db, a.affiliateId, { storeId: 999_999 }))).toBe("not_found");
  });

  it("a click is bound to its link's affiliate AND store by composite foreign keys; it holds no buyer, address, agent or referrer column", async () => {
    const s = await makeStore("toko-a");
    const other = await makeStore("toko-b");
    const a = await makeAffiliate();
    const b = await makeAffiliate({ name: "Afiliasi Dua" });
    const l = await link(a, s);
    const ins = (affiliateId: number, storeId: number, id: string) =>
      admin.execute(sql`insert into affiliate_click (id, link_id, affiliate_id, store_id, captured_at, expires_at) values (${id}, ${l.id}, ${affiliateId}, ${storeId}, now(), now() + interval '1 day')`);
    expect(await throws(ins(a.affiliateId, s.storeId, `c${"1".repeat(32)}`))).toBe("ok");
    expect(await throws(ins(b.affiliateId, s.storeId, `c${"2".repeat(32)}`))).toBe("23503"); // another affiliate's click on this link
    expect(await throws(ins(a.affiliateId, other.storeId, `c${"3".repeat(32)}`))).toBe("23503"); // another store's click on this link
    expect(await throws(ins(a.affiliateId, s.storeId, "not-an-opaque-id"))).toBe("23514");
    expect(await throws(admin.execute(sql`insert into affiliate_click (id, link_id, affiliate_id, store_id, captured_at, expires_at) values (${`c${"4".repeat(32)}`}, ${l.id}, ${a.affiliateId}, ${s.storeId}, now(), now())`))).toBe("23514"); // a window of no length
    const columns = ((await admin.execute(sql`select column_name from information_schema.columns where table_name = 'affiliate_click' order by column_name`)) as unknown as { column_name: string }[]).map((r) => r.column_name);
    expect(columns).toEqual(["affiliate_id", "captured_at", "expires_at", "id", "link_id", "offer_id", "store_id"]); // no IP, user agent, referrer, URL or fingerprint (PRIV-7)
  });

  it("the attribution's click and code references must belong to the same affiliate and store (matching foreign keys)", async () => {
    const s = await makeStore("toko-a", { price: 100_000, stock: 20 });
    await openStore(s);
    await optIn(s);
    const a = await makeAffiliate();
    const b = await makeAffiliate({ name: "Afiliasi Dua" });
    await code(a, "OWNCODE1");
    const bCode = await code(b, "OTHERCODE");
    const bClick = await click((await link(b, s)).token);
    const o = await buy(s, { code: "OWNCODE1" });
    const { id: _id, createdAt: _c, orderId: _o, ...row } = (await attributionOf(o.orderId))!;
    // replay the insert inside a transaction that is rolled back: the guard passes (the snapshot matches), only the foreign keys can object
    const attempt = (patch: Partial<typeof row>) =>
      throws(
        admin.transaction(async (tx) => {
          await tx.execute(sql`select set_config('bukalaris.affiliate_reset', 'demo', true)`);
          await tx.delete(affiliateAttribution).where(eq(affiliateAttribution.orderId, o.orderId));
          await tx.insert(affiliateAttribution).values({ ...row, orderId: o.orderId, ...patch });
          tx.rollback();
        }),
      );
    expect(await throws(attempt({}).then(() => Promise.reject(new Error("rolled back"))))).toBe("error"); // the harness: an untouched copy inserts and is rolled back
    expect(await attempt({ method: "link", codeId: null, clickId: bClick })).toBe("23503"); // B's click under A's attribution
    expect(await attempt({ codeId: bCode.id })).toBe("23503"); // B's code under A's attribution
    expect(await attributionOf(o.orderId)).toBeDefined(); // nothing of the experiment survived
  });

  it("the attribution's order foreign key is the order's own financial snapshot in the same store, and UNIQUE(order_id) is a database constraint", async () => {
    const s = await makeStore("toko-a", { price: 100_000, stock: 20 });
    await openStore(s);
    await optIn(s);
    const a = await makeAffiliate();
    await code(a, "UNIQUE01");
    const o = await buy(s, { code: "UNIQUE01" });
    const other = await makeStore("toko-b", { price: 100_000, stock: 20 });
    const { id: _id, createdAt: _c, ...row } = (await attributionOf(o.orderId))!;
    expect(await throws(admin.insert(affiliateAttribution).values({ ...row, storeId: other.storeId }))).toBe("23514"); // wrong store for that order: the snapshot lookup fails first
    const idx = (await admin.execute(sql`select indexdef from pg_indexes where tablename = 'affiliate_attribution' and indexdef ilike '%unique%'`)) as unknown as { indexdef: string }[];
    expect(idx.map((i) => i.indexdef).join("\n")).toMatch(/\(order_id\)/);
    expect(await throws(admin.insert(affiliateAttribution).values(row))).toBe("23505");
  });
});

describe("T-52 an attribution and a click are immutable evidence", () => {
  it("clicks: no update, no delete, for any role including the superuser; the retention function is the only deleter", async () => {
    const s = await makeStore("toko-a");
    const a = await makeAffiliate();
    const l = await link(a, s);
    const id = await click(l.token);
    expect(await throws(admin.execute(sql`update affiliate_click set captured_at = now() - interval '30 days' where id = ${id}`))).toBe("42501"); // tampered time
    expect(await throws(admin.execute(sql`update affiliate_click set store_id = ${s.storeId + 1}, affiliate_id = ${a.affiliateId} where id = ${id}`))).toBe("42501"); // tampered target
    expect(await throws(admin.execute(sql`update affiliate_click set expires_at = expires_at + interval '1 year' where id = ${id}`))).toBe("42501");
    expect(await throws(admin.execute(sql`delete from affiliate_click where id = ${id}`))).toBe("42501");
    expect(await throws(platform.execute(sql`delete from affiliate_click where id = ${id}`))).toBe("42501"); // no privilege either
    expect(await throws(db.execute(sql`insert into affiliate_click (id, link_id, affiliate_id, store_id, expires_at) values (${`c${"5".repeat(32)}`}, ${l.id}, ${a.affiliateId}, ${s.storeId}, now() + interval '1 day')`))).toBe("42501");
  });

  it("attributions: a frozen row is never rewritten or deleted; state moves only along its legal path with its references", async () => {
    const s = await makeStore("toko-a", { price: 100_000, stock: 20 });
    await openStore(s);
    await optIn(s);
    const a = await makeAffiliate();
    await code(a, "FROZEN01");
    const o = await buy(s, { code: "FROZEN01" });
    const id = (await attributionOf(o.orderId))!.id;
    const upd = (set: ReturnType<typeof sql>) => throws(admin.execute(sql`update affiliate_attribution set ${set} where id = ${id}`));
    for (const set of [sql`commission_idr = 9_999`, sql`commission_base_idr = 1`, sql`affiliate_id = ${a.affiliateId + 1}`, sql`order_id = order_id + 1`, sql`method = 'link'`, sql`window_days = 30`, sql`hold_days = 0`, sql`policy_revision = 9`, sql`created_at = now() - interval '1 day'`]) {
      expect(await upd(set), String(set)).toBe("42501");
    }
    expect(await throws(admin.execute(sql`delete from affiliate_attribution where id = ${id}`))).toBe("42501");
    expect(await upd(sql`status = 'paid_out', eligible_at = now()`)).toBe("23514"); // pending cannot jump to paid_out
    expect(await upd(sql`status = 'credited'`)).toBe("23514"); // credited needs eligible_at (CHECK)
    expect(await upd(sql`status = 'void'`)).toBe("23514"); // void needs its reason
    expect(await upd(sql`credit_ref = 'x'`)).toBe("23514"); // a reference moves only with its state
    expect(await upd(sql`status = 'credited', eligible_at = now() + interval '3 days'`)).toBe("ok");
    expect(await upd(sql`eligible_at = now()`)).toBe("23514"); // set once
    expect(await upd(sql`status = 'void', void_reason = 'late'`)).toBe("23514"); // a credited attribution is never voided (no automatic clawback)
    expect(await upd(sql`status = 'paid_out'`)).toBe("ok");
    expect(await upd(sql`status = 'pending'`)).toBe("23514");
  });

  it("the attribution stays out of reach of the login roles: no write at all, and no order, click or code reference readable by the application role", async () => {
    const s = await makeStore("toko-a", { price: 100_000, stock: 20 });
    await openStore(s);
    await optIn(s);
    const a = await makeAffiliate();
    await code(a, "COLUMNS01");
    const o = await buy(s, { code: "COLUMNS01" });
    const rows = await withAffiliate(db, a.affiliateId, (tx) => tx.select({ id: affiliateAttribution.id, storeId: affiliateAttribution.storeId, method: affiliateAttribution.method, commissionIdr: affiliateAttribution.commissionIdr, status: affiliateAttribution.status }).from(affiliateAttribution));
    expect(rows).toHaveLength(1);
    for (const column of ["order_id", "click_id", "code_id", "click_detached_at", "credit_ref"]) {
      expect(await throws(withAffiliate(db, a.affiliateId, (tx) => tx.execute(sql.raw(`select ${column} from affiliate_attribution`)))), column).toBe("42501");
    }
    expect(await throws(withAffiliate(db, a.affiliateId, (tx) => tx.execute(sql`select * from affiliate_attribution`)))).toBe("42501"); // `select *` is refused: services name their columns
    expect(await throws(withAffiliate(db, a.affiliateId, (tx) => tx.execute(sql`update affiliate_attribution set status = 'void'`)))).toBe("42501");
    expect(await throws(platform.execute(sql`update affiliate_attribution set status = 'void', void_reason = 'x' where order_id = ${o.orderId}`))).toBe("42501");
  });
});

describe("T-52 the programme limits are named settings pinned to their stored row (D-22 item 3)", () => {
  it("the seeded row equals the named defaults; the hold is the owner's decided 3 days; there is one row", async () => {
    await admin.execute(sql`update affiliate_policy set min_rate_bps = min_rate_bps`); // reset by helpers: read the seeded values after a no-op
    const [row] = await platform.select().from(affiliatePolicy);
    expect({ min: row!.minRateBps, max: row!.maxRateBps, window: row!.attributionWindowDays, hold: row!.holdDays }).toEqual({ min: AFFILIATE_MIN_RATE_BPS_DEFAULT, max: AFFILIATE_MAX_RATE_BPS_DEFAULT, window: AFFILIATE_ATTRIBUTION_WINDOW_DAYS_DEFAULT, hold: AFFILIATE_HOLD_DAYS_DEFAULT });
    expect(AFFILIATE_HOLD_DAYS_DEFAULT).toBe(3);
    expect(await throws(admin.execute(sql`insert into affiliate_policy (id, min_rate_bps, max_rate_bps, attribution_window_days, hold_days, updated_by) values (2, 1, 2, 3, 4, 'x')`))).toBe("23514");
    expect(await throws(admin.execute(sql`update affiliate_policy set min_rate_bps = 3000`))).toBe("23514"); // min above max
    expect(await throws(admin.execute(sql`update affiliate_policy set max_rate_bps = 10001`))).toBe("23514");
    expect(await throws(admin.execute(sql`update affiliate_policy set attribution_window_days = 0`))).toBe("23514");
    expect(await throws(db.execute(sql`update affiliate_policy set max_rate_bps = 10000`))).toBe("42501"); // read-only for the seller side
  });
});

describe("T-52 seller opt-in: closed by default, no invented rate, state machine and the programme's bounds", () => {
  it("no row means closed with no rate; opening and a rate are the seller's explicit act; bounds are enforced by the service and by the database", async () => {
    const s = await makeStore("toko-a");
    expect(await affiliateSettings(s.owner)).toMatchObject({ participation: "closed", defaultRateBps: null, revision: 0, bounds: { minRateBps: AFFILIATE_MIN_RATE_BPS_DEFAULT, maxRateBps: AFFILIATE_MAX_RATE_BPS_DEFAULT } });
    expect(await listOffers(s.owner)).toEqual([]);
    expect(await errCode(saveAffiliatePolicy(s.owner, { participation: "open", defaultRateBps: AFFILIATE_MAX_RATE_BPS_DEFAULT + 1 }))).toBe("rate_out_of_bounds");
    expect(await errCode(saveAffiliatePolicy(s.owner, { participation: "open", defaultRateBps: AFFILIATE_MIN_RATE_BPS_DEFAULT - 1 }))).toBe("rate_out_of_bounds");
    expect(await errCode(saveAffiliatePolicy(s.owner, { participation: "open", defaultRateBps: 10_001 }))).not.toBe("ok");
    expect(await errCode(saveAffiliatePolicy(s.owner, { participation: "open", defaultRateBps: 12.5 }))).not.toBe("ok");
    await saveAffiliatePolicy(s.owner, { participation: "open", defaultRateBps: null }); // open, no rate: nothing earns until a rate exists
    await saveAffiliatePolicy(s.owner, { participation: "open", defaultRateBps: 1_000 });
    expect(await affiliateSettings(s.owner)).toMatchObject({ participation: "open", defaultRateBps: 1_000, revision: 2 });
    expect(await throws(asApp(s.storeId, (tx) => tx.insert(affiliateSellerPolicy).values({ storeId: s.storeId, participation: "open", defaultRateBps: 9_999, updatedBy: "x" }).onConflictDoNothing()))).toBe("23514");
  });

  it("offers: a published own product only, one row per product, the legal transitions, resume re-validates, and a product of another store is not found", async () => {
    const s = await makeStore("toko-a");
    const other = await makeStore("toko-b");
    await openStore(s);
    const draft = await addProduct(s, 10_000, "Draf");
    await admin.execute(sql`update product set status = 'draft' where id = ${draft.productId}`);
    expect(await errCode(optInProduct(s.owner, { productId: draft.productId, rateBps: null }))).toBe("product_unavailable");
    expect(await errCode(optInProduct(s.owner, { productId: other.productId, rateBps: null }))).toBe("not_found");
    expect(await errCode(optInProduct(s.owner, { productId: s.productId, rateBps: 5_000 }))).toBe("rate_out_of_bounds");
    const offerId = await optInProduct(s.owner, { productId: s.productId, rateBps: 1_500 });
    expect(await optInProduct(s.owner, { productId: s.productId, rateBps: 1_200 })).toBe(offerId); // the same row, never two for one product
    expect(await platform.select().from(affiliateOffer)).toHaveLength(1);
    await setOfferStatus(s.owner, { offerId, status: "paused" });
    await setOfferStatus(s.owner, { offerId, status: "withdrawn" });
    expect(await errCode(setOfferStatus(s.owner, { offerId, status: "paused" }))).toBe("illegal_transition");
    await setOfferStatus(s.owner, { offerId, status: "active" }); // re-opt-in
    await admin.execute(sql`update affiliate_policy set max_rate_bps = 1_000`); // the programme lowers its maximum: the stored 12 % is now out of bounds
    await setOfferStatus(s.owner, { offerId, status: "paused" }); // pausing is never blocked
    expect(await errCode(setOfferStatus(s.owner, { offerId, status: "active" }))).toBe("rate_out_of_bounds"); // resuming re-validates
    await setOfferRate(s.owner, { offerId, rateBps: null }); // back to the store default (10 %)
    await setOfferStatus(s.owner, { offerId, status: "active" });
    expect((await listOffers(s.owner))[0]).toMatchObject({ status: "active", rateBps: null, productId: s.productId });
    expect(await errCode(setOfferStatus(s.owner, { offerId: 999_999, status: "paused" }))).toBe("not_found");
    expect(await throws(admin.execute(sql`update affiliate_offer set product_id = ${draft.productId} where id = ${offerId}`))).toBe("23514");
    expect(await throws(admin.execute(sql`insert into affiliate_offer (store_id, source, product_id, updated_by) values (${s.storeId}, 'bukalaris', ${s.productId}, 'x')`))).toBe("23505");
    expect(await throws(admin.execute(sql`insert into affiliate_offer (store_id, source, product_id, updated_by) values (${s.storeId}, 'other', ${draft.productId}, 'x')`))).toBe("23514");
    expect(await throws(admin.execute(sql`insert into affiliate_offer (store_id, source, product_id, updated_by) values (${s.storeId}, 'bukalaris', ${other.productId}, 'x')`))).toBe("23514"); // the guard finds no published product of THIS store (the compound FK is the backstop)
  });

  it("blocks: this store only, idempotent, the unknown affiliate answers like any other, unblock restores; nothing earned moves", async () => {
    const s = await makeStore("toko-a");
    const a = await makeAffiliate();
    await blockAffiliate(s.owner, { affiliateId: a.affiliateId, reason: "kecurangan" });
    await blockAffiliate(s.owner, { affiliateId: a.affiliateId, reason: "kecurangan lagi" });
    expect(await listBlocks(s.owner)).toHaveLength(1);
    expect(await errCode(blockAffiliate(s.owner, { affiliateId: 999_999, reason: "x" }))).toBe("not_found");
    expect(await errCode(blockAffiliate(s.owner, { affiliateId: a.affiliateId, reason: "  " }))).not.toBe("ok");
    await unblockAffiliate(s.owner, a.affiliateId);
    expect(await errCode(unblockAffiliate(s.owner, a.affiliateId))).toBe("not_found");
    expect(await listBlocks(s.owner)).toEqual([]);
  });

  it("capabilities: staff read but never write; an unpaid subscription keeps the reads and refuses every write (BILL-7)", async () => {
    const s = await makeStore("toko-a");
    const staffId = await makeUser("staff");
    await platform.execute(sql`insert into membership (user_id, store_id, role) values (${staffId}, ${s.storeId}, 'staff')`);
    const staff = await seller(staffId, s.storeId);
    expect(await affiliateSettings(staff)).toMatchObject({ participation: "closed" });
    expect(await errCode(saveAffiliatePolicy(staff, { participation: "open", defaultRateBps: 1_000 }))).toBe("forbidden");
    expect(await errCode(optInProduct(staff, { productId: s.productId, rateBps: null }))).toBe("forbidden");
    expect(await errCode(blockAffiliate(staff, { affiliateId: 1, reason: "x" }))).toBe("forbidden");
    const unpaid = await sellerAs(s.ownerId, s.storeId, new Date(Date.now() + 30 * 86_400_000));
    expect(await affiliateSettings(unpaid)).toMatchObject({ participation: "closed" });
    expect(await errCode(saveAffiliatePolicy(unpaid, { participation: "open", defaultRateBps: 1_000 }))).toBe("billing_read_only");
    expect(await errCode(optInProduct(unpaid, { productId: s.productId, rateBps: null }))).toBe("billing_read_only");
  });
});

describe("T-52 store isolation of offers, blocks, policies and order snapshots under the real application role", () => {
  async function two() {
    const A = await makeStore("toko-a", { price: 100_000, stock: 50 });
    const B = await makeStore("toko-b", { price: 100_000, stock: 50 });
    for (const s of [A, B]) {
      await openStore(s);
      await optIn(s);
    }
    const aff = await makeAffiliate();
    for (const s of [A, B]) await blockAffiliate(s.owner, { affiliateId: aff.affiliateId, reason: `blokir ${s.storeId}` });
    await code(aff, "ISOLATE1");
    await admin.execute(sql`delete from affiliate_block`); // the block would hide the code: the isolation checks below need real attributions
    const oa = await buy(A, { code: "ISOLATE1" });
    const ob = await buy(B, { code: "ISOLATE1" });
    return { A, B, aff, oa, ob };
  }

  it("seller A sees only A's rows in every tenant table; no context sees nothing; same-store reads succeed", async () => {
    const { A, B, oa, ob } = await two();
    const own = await asApp(A.storeId, async (tx) => ({
      policy: await tx.select().from(affiliateSellerPolicy),
      offers: await tx.select().from(affiliateOffer),
      fin: await tx.select().from(orderFinancials),
      lines: await tx.select().from(orderLineFinancials),
    }));
    expect(own.policy.map((r) => r.storeId)).toEqual([A.storeId]);
    expect(own.offers.map((r) => r.storeId)).toEqual([A.storeId]);
    expect(own.fin.map((r) => r.orderId)).toEqual([oa.orderId]);
    expect(own.lines.map((r) => r.orderId)).toEqual([oa.orderId]);
    expect(own.fin[0]).toMatchObject({ affiliateCommissionIdr: 10_000 }); // the seller sees its own deduction
    const noContext = await Promise.all([db.select().from(affiliateOffer), db.select().from(affiliateSellerPolicy), db.select().from(affiliateBlock), db.select().from(orderFinancials)]);
    expect(noContext.map((r) => r.length)).toEqual([0, 0, 0, 0]);
    expect(ob.orderId).not.toBe(oa.orderId);
  });

  it("seller A cannot read, change, withdraw, rate or block through B's ids; and cannot insert rows for B", async () => {
    const { A, B } = await two();
    const bOffer = (await platform.select().from(affiliateOffer).where(eq(affiliateOffer.storeId, B.storeId)))[0]!;
    expect(await asApp(A.storeId, (tx) => tx.select().from(affiliateOffer).where(eq(affiliateOffer.storeId, B.storeId)))).toEqual([]);
    expect(await errCode(setOfferStatus(A.owner, { offerId: bOffer.id, status: "withdrawn" }))).toBe("not_found");
    expect(await errCode(setOfferRate(A.owner, { offerId: bOffer.id, rateBps: 500 }))).toBe("not_found");
    expect(await errCode(optInProduct(A.owner, { productId: B.productId, rateBps: null }))).toBe("not_found");
    expect(await asApp(A.storeId, (tx) => tx.update(affiliateOffer).set({ status: "withdrawn", updatedBy: "evil" }).where(eq(affiliateOffer.id, bOffer.id)).returning())).toEqual([]);
    expect(await throws(asApp(A.storeId, (tx) => tx.insert(affiliateOffer).values({ storeId: B.storeId, productId: B.productId, updatedBy: "evil" })))).toBe("42501");
    expect(await throws(asApp(A.storeId, (tx) => tx.insert(affiliateSellerPolicy).values({ storeId: B.storeId, participation: "closed", updatedBy: "evil" })))).toBe("42501");
    expect(await throws(asApp(A.storeId, (tx) => tx.insert(affiliateBlock).values({ storeId: B.storeId, affiliateId: 1, reason: "evil", blockedBy: "evil" })))).toBe("42501");
    expect(await asApp(A.storeId, (tx) => tx.delete(affiliateBlock).returning())).toEqual([]);
    expect(await throws(asApp(A.storeId, (tx) => tx.update(orderFinancials).set({ affiliateCommissionIdr: 0 })))).toBe("42501"); // a snapshot has no UPDATE grant at all
    expect((await platform.select().from(affiliateOffer).where(eq(affiliateOffer.id, bOffer.id)))[0]).toMatchObject({ status: "active", updatedBy: bOffer.updatedBy });
  });

  it("the projection reads B's offer only to publish public fields; cross-store public catalog discovery stays valid for everyone", async () => {
    const { A, B } = await two();
    await projectOffers(platform, A.storeId);
    await projectOffers(platform, B.storeId);
    const seenByA = await withStore(db, A.storeId, () => listAffiliateCatalog(db));
    expect(seenByA.map((r) => r.storeSlug).sort()).toEqual(["toko-a", "toko-b"]); // intentionally cross-store
    expect(await listAffiliateCatalog(db)).toHaveLength(2); // and with no store context at all
    expect(Object.keys(seenByA[0]!).sort()).toEqual(["imageMediaId", "inStock", "offerId", "priceFromIdr", "productPath", "productTitle", "rateBps", "storeId", "storeName", "storeSlug"]);
    expect(await throws(db.insert(affiliateCatalog).values({ offerId: 1, storeId: A.storeId, productId: A.productId, storeSlug: "x", storeName: "x", productTitle: "x", productPath: "x", sourceRevision: 1 }))).toBe("42501"); // read-only for the app role
    expect(await throws(db.execute(sql`update affiliate_catalog set active = false`))).toBe("42501");
  });

  it("affiliate A cannot read B's links, codes, attributions or clicks; its own are readable only without any order or buyer identifier", async () => {
    const A = await makeStore("toko-a", { price: 100_000, stock: 50 });
    await openStore(A);
    await optIn(A);
    const a = await makeAffiliate();
    const b = await makeAffiliate({ name: "Afiliasi Dua" });
    await code(a, "AAAA1111");
    await code(b, "BBBB2222");
    const la = await link(a, A);
    const lb = await link(b, A);
    await click(la.token);
    await click(lb.token);
    const oa = await buy(A, { code: "AAAA1111", phone: "081355500001" });
    const ob = await buy(A, { code: "BBBB2222", phone: "081355500002" });
    expect(oa.orderId).not.toBe(ob.orderId);
    const view = (who: A) =>
      withAffiliate(db, who.affiliateId, async (tx) => ({
        self: await tx.select().from(affiliate),
        links: await tx.select().from(affiliateLink),
        codes: await tx.select().from(affiliateCode),
        attributions: await tx.select({ id: affiliateAttribution.id, affiliateId: affiliateAttribution.affiliateId, storeId: affiliateAttribution.storeId, commissionIdr: affiliateAttribution.commissionIdr, status: affiliateAttribution.status }).from(affiliateAttribution),
      }));
    const seenA = await view(a);
    expect(seenA.self.map((r) => r.id)).toEqual([a.affiliateId]);
    expect(seenA.links.map((r) => r.id)).toEqual([la.id]);
    expect(seenA.codes.map((r) => r.code)).toEqual(["AAAA1111"]);
    expect(seenA.attributions.map((r) => r.affiliateId)).toEqual([a.affiliateId]);
    expect((await listOwnLinks(db, a.affiliateId)).map((r) => r.id)).toEqual([la.id]);
    // B's rows by explicit id, with the right context for A: nothing
    expect(await withAffiliate(db, a.affiliateId, (tx) => tx.select().from(affiliateLink).where(eq(affiliateLink.affiliateId, b.affiliateId)))).toEqual([]);
    expect(await throws(withAffiliate(db, a.affiliateId, (tx) => tx.select().from(affiliateClick)))).toBe("42501"); // the raw click log is closed to the app role altogether
    expect(await withAffiliate(db, a.affiliateId, (tx) => tx.update(affiliateLink).set({ status: "revoked", revokedAt: new Date() }).where(eq(affiliateLink.id, lb.id)).returning())).toEqual([]);
    expect(await errCode(revokeLink(db, a.affiliateId, lb.id))).toBe("not_found");
    expect(await throws(withAffiliate(db, a.affiliateId, (tx) => tx.insert(affiliateLink).values({ affiliateId: b.affiliateId, token: "forgedtokenforgedtoken", storeId: A.storeId })))).toBe("42501"); // WITH CHECK: not for another affiliate
    // no context, store context only: nothing
    expect((await Promise.all([db.select().from(affiliate), db.select().from(affiliateLink), db.select().from(affiliateCode)])).map((r) => r.length)).toEqual([0, 0, 0]);
    expect((await asApp(A.storeId, (tx) => tx.select().from(affiliateLink))).length).toBe(0);
    // the serialised affiliate-facing data carries no buyer contact and no order identifier
    const wire = JSON.stringify({ seenA, catalog: await listAffiliateCatalog(db) });
    for (const forbidden of ["081355500001", "081355500002", "6281355500001", "Budi Santoso", "Jl. Merdeka", "buyer_phone", "buyerPhone", "orderId", "order_id"]) expect(wire).not.toContain(forbidden);
  });
});

describe("T-52 grants of the two login roles are exactly the registry (nothing wider than the services need)", () => {
  it("the app role writes none of the platform-owned affiliate tables; the platform role deletes only catalog rows", async () => {
    const privileges = async (role: string) =>
      ((await admin.execute(sql`select table_name, privilege_type from information_schema.role_table_grants where grantee = ${role} and table_name like 'affiliate\\_%' order by 1, 2`)) as unknown as { table_name: string; privilege_type: string }[]).map((r) => `${r.table_name}:${r.privilege_type}`);
    const app = await privileges("bukalaris_app");
    const plat = await privileges("bukalaris_platform");
    for (const t of ["affiliate_click", "affiliate_attribution", "affiliate_catalog", "affiliate_policy", "affiliate_counter", "affiliate"]) {
      expect(app.filter((p) => p.startsWith(`${t}:`) && !p.endsWith(":SELECT")), t).toEqual([]);
    }
    expect(plat.filter((p) => p.endsWith(":DELETE"))).toEqual(["affiliate_catalog:DELETE"]);
    expect(plat.filter((p) => p.endsWith(":TRUNCATE") || p.endsWith(":REFERENCES") || p.endsWith(":TRIGGER"))).toEqual([]);
    expect(app.includes("affiliate_attribution:SELECT")).toBe(false); // column grants only
    expect(app.includes("affiliate_click:SELECT")).toBe(false);
    expect(plat.filter((p) => p.startsWith("affiliate_counter:"))).toEqual(["affiliate_counter:SELECT"]);
  });

  it("the catalog is where cross-store discovery lives: it stays platform-written and read-only for sellers, with no column for a buyer, order or account", async () => {
    const columns = ((await admin.execute(sql`select column_name from information_schema.columns where table_name = 'affiliate_catalog'`)) as unknown as { column_name: string }[]).map((r) => r.column_name);
    for (const c of columns) expect(c).not.toMatch(/phone|email|buyer|order|user|address|account|token/);
    expect(await platform.select({ n: product.id }).from(product).limit(1)).toBeDefined();
  });
});
