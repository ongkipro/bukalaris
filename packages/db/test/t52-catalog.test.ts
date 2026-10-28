import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { listAffiliateCatalog, projectOffers } from "../src/affiliate/catalog.ts";
import { AFFILIATE_CATALOG_PROJECT, AFFILIATE_CATALOG_PROJECTION } from "../src/affiliate/jobs.ts";
import { saveAffiliatePolicy, setOfferStatus } from "../src/affiliate/seller.ts";
import { job } from "../src/schema.ts";
import { kindPolicy, registeredKinds, runOnce } from "../src/ops/jobs/jobs.ts";
import { rebuildableProjections, rebuildProjection } from "../src/ops/jobs/manage.ts";
import { admin, platform } from "./helpers.ts";
import { billingTestSetup, operatorWith } from "./t50-fixtures.ts";
import { addProduct, catalogRows, errCode, openStore, optIn, resetFixtures, type S } from "./t52-fixtures.ts";
import { makeStore } from "./helpers.ts";

// T-52 JOB-20 `affiliate.catalog.project`: the discovery projection is filled and withdrawn by an ID-only outbox job that reads the live seller rows, idempotently by source
// revision. A stale, duplicated or reordered job can never republish a newer revocation, and the projection never widens seller-table RLS.
billingTestSetup();
beforeEach(resetFixtures);

/** Run the worker (platform pool, as in production) until nothing is due; returns the outcomes. */
async function drain() {
  const all = [];
  for (let i = 0; i < 12; i++) {
    const out = await runOnce(platform, { workerId: "t52" });
    if (out.length === 0) break;
    all.push(...out);
  }
  return all;
}
const jobs = () => platform.select().from(job).where(eq(job.kind, AFFILIATE_CATALOG_PROJECT)).orderBy(job.id);
const offerJobs = async () => (await jobs()).filter((j) => j.key.startsWith("offer:"));
const store = async (slug = "toko-a", price = 100_000) => {
  const s = await makeStore(slug, { price, stock: 10 });
  await openStore(s, 1_000);
  return s;
};
const rowOf = async (s: S) => (await catalogRows()).find((r) => r.storeId === s.storeId)!;

describe("T-52 JOB-20: opt-in, change and withdrawal are projected by an ID-only job from the live row", () => {
  it("an opt-in leaves exactly one job carrying only ids; the worker publishes the public fields", async () => {
    const s = await store();
    const offerId = await optIn(s);
    const queued = await offerJobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ storeId: s.storeId, key: `offer:${offerId}:1`, status: "pending", priority: 2 });
    expect(Object.keys(queued[0]!.payload).sort()).toEqual(["offerId", "revision"]); // IDs only: no title, price, rate or state in the payload
    expect((await jobs()).filter((j) => j.key.startsWith("policy:")).map((j) => Object.keys(j.payload))).toEqual([["revision"]]); // the store policy leaves one store-wide ID-only job
    const outcomes = await drain();
    expect(outcomes.filter((o) => o.kind === AFFILIATE_CATALOG_PROJECT).map((o) => o.status)).toEqual(["done", "done"]); // the policy job and the offer job
    const row = await rowOf(s);
    expect(row).toMatchObject({ source: "bukalaris", offerId, storeSlug: "toko-a", storeName: "Toko toko-a", productTitle: "Kaos toko-a", priceFromIdr: 100_000, inStock: true, rateBps: 1_000, active: true, sourceRevision: 1 });
    expect(row.productPath).toMatch(/^[0-9]{5,}$/); // the catalog id: this product has no readable slug (DATA-5)
    expect(kindPolicy(AFFILIATE_CATALOG_PROJECT)).toMatchObject({ replaySafe: true, priority: 2 });
    expect(registeredKinds()).toContain(AFFILIATE_CATALOG_PROJECT);
    expect(rebuildableProjections()).toContain(AFFILIATE_CATALOG_PROJECTION);
  });

  it("price, availability and title changes of the product are projected without any caller remembering to enqueue; a stock count that stays positive enqueues nothing", async () => {
    const s = await store();
    const offerId = await optIn(s);
    await drain();
    const base = (await jobs()).length;
    await admin.execute(sql`update variant set stock = stock - 1 where id = ${s.variantId}`); // 10 -> 9: nothing a buyer of the catalog can see
    expect(await jobs()).toHaveLength(base);
    await admin.execute(sql`update variant set price = 90000 where id = ${s.variantId}`);
    await drain();
    expect(await rowOf(s)).toMatchObject({ priceFromIdr: 90_000, inStock: true, sourceRevision: 2 });
    await admin.execute(sql`update variant set stock = 0 where id = ${s.variantId}`);
    await drain();
    expect(await rowOf(s)).toMatchObject({ inStock: false, active: true, sourceRevision: 3 }); // sold out stays listed, flagged
    await admin.execute(sql`update product set title = 'Judul Baru' where id = ${s.productId}`);
    await drain();
    expect((await rowOf(s)).productTitle).toBe("Judul Baru");
    await admin.execute(sql`insert into variant (store_id, product_id, title, price, stock, weight_grams) values (${s.storeId}, ${s.productId}, 'XL', 70000, 3, 800)`);
    await drain();
    expect(await rowOf(s)).toMatchObject({ priceFromIdr: 70_000, inStock: true });
    await admin.execute(sql`insert into media (store_id, product_id, position, mime, width, height, bytes) values (${s.storeId}, ${s.productId}, 1, 'image/png', 10, 10, 100)`);
    await drain();
    expect((await rowOf(s)).imageMediaId).not.toBeNull();
    await admin.execute(sql`update product set status = 'archived' where id = ${s.productId}`);
    await drain();
    expect(await rowOf(s)).toMatchObject({ active: false, rateBps: null }); // an unpublished product is withdrawn, not deleted
    expect(offerId).toBeGreaterThan(0);
  });

  it("pause, withdrawal and a store-wide policy change withdraw and restore every affected offer; a withdrawn row is a tombstone, never deleted", async () => {
    const s = await store();
    const second = await addProduct(s, 50_000);
    const o1 = await optIn(s);
    const o2 = await optIn(s, second.productId, 1_500);
    await drain();
    expect((await catalogRows()).map((r) => [r.offerId, r.rateBps, r.active])).toEqual([[o1, 1_000, true], [o2, 1_500, true]]);
    await setOfferStatus(s.owner, { offerId: o1, status: "paused" });
    await drain();
    expect((await catalogRows()).map((r) => [r.offerId, r.active])).toEqual([[o1, false], [o2, true]]);
    await saveAffiliatePolicy(s.owner, { participation: "closed", defaultRateBps: 1_000 }); // the store closes: both offers leave the catalog
    await drain();
    expect((await catalogRows()).map((r) => r.active)).toEqual([false, false]);
    await saveAffiliatePolicy(s.owner, { participation: "open", defaultRateBps: 800 });
    await setOfferStatus(s.owner, { offerId: o1, status: "active" });
    await drain();
    expect((await catalogRows()).map((r) => [r.offerId, r.rateBps, r.active])).toEqual([[o1, 800, true], [o2, 1_500, true]]); // the default changed, the override did not
    await setOfferStatus(s.owner, { offerId: o2, status: "withdrawn" });
    await drain();
    expect(await catalogRows()).toHaveLength(2); // tombstone kept
    expect((await listAffiliateCatalog(platform)).map((r) => r.offerId)).toEqual([o1]); // and never listed
  });
});

describe("T-52 stale, duplicated and reordered events never republish a withdrawn offer", () => {
  it("a replayed job and a second projection of the same revision change nothing; the same (kind, key) is one job", async () => {
    const s = await store();
    const offerId = await optIn(s);
    await drain();
    const before = await rowOf(s);
    expect(await projectOffers(platform, s.storeId, [offerId])).toEqual({ written: 0, stale: 1 }); // same revision: nothing to write
    await platform.insert(job).values({ kind: AFFILIATE_CATALOG_PROJECT, storeId: s.storeId, key: `offer:${offerId}:1`, payload: { offerId, revision: 1 } }).onConflictDoNothing();
    expect(await offerJobs()).toHaveLength(1); // the unique key of the outbox
    await drain();
    expect(await rowOf(s)).toEqual(before);
  });

  it("jobs processed out of order end on the newest revision; a stale job claiming 'active' cannot undo a newer withdrawal", async () => {
    const s = await store();
    const offerId = await optIn(s); // revision 1
    await setOfferStatus(s.owner, { offerId, status: "paused" }); // revision 2
    await setOfferStatus(s.owner, { offerId, status: "withdrawn" }); // revision 3
    const queued = await offerJobs();
    expect(queued.map((j) => j.key)).toEqual([`offer:${offerId}:1`, `offer:${offerId}:2`, `offer:${offerId}:3`]);
    // reverse the claim order: revision 3 first, then the two older ones
    await admin.execute(sql`update job set next_attempt_at = now() - (id * interval '1 second') where kind = ${AFFILIATE_CATALOG_PROJECT} and key like 'offer:%'`);
    await drain();
    expect(await rowOf(s)).toMatchObject({ active: false, sourceRevision: 3 });
    // a hand-made stale event that CLAIMS to be an active revision-1 publication: the payload carries no state and the handler reads the live row
    await platform.insert(job).values({ kind: AFFILIATE_CATALOG_PROJECT, storeId: s.storeId, key: "forged-stale", payload: { offerId, revision: 1, active: true, rateBps: 9_999 } });
    await drain();
    expect(await rowOf(s)).toMatchObject({ active: false, rateBps: null, sourceRevision: 3 });
  });

  it("the database itself refuses a lower or equal revision, a changed identity, and the app role cannot write the catalog at all", async () => {
    const s = await store();
    const offerId = await optIn(s);
    await drain();
    const stale = (set: ReturnType<typeof sql>) => errCode(platform.execute(sql`update affiliate_catalog set ${set} where offer_id = ${offerId}`));
    expect(await stale(sql`active = false, source_revision = 1`)).toBe("23514"); // equal
    expect(await stale(sql`active = false, source_revision = 0`)).toBe("23514"); // older
    expect(await stale(sql`store_id = store_id + 1, source_revision = 9`)).toBe("23514");
    expect(await stale(sql`offer_id = offer_id + 1, source_revision = 9`)).toBe("23514");
    expect(await stale(sql`active = false, rate_bps = null, source_revision = 2`)).toBe("ok");
    expect(await stale(sql`active = true, rate_bps = 500, source_revision = 2`)).toBe("23514"); // the withdrawal at revision 2 cannot be replaced by a same-revision publication
    expect(await errCode(platform.execute(sql`update affiliate_catalog set active = true, rate_bps = null where offer_id = ${offerId}`))).toBe("23514"); // an active row needs a rate (CHECK)
    expect(await rowOf(s)).toMatchObject({ active: false, sourceRevision: 2 });
  });

  it("a job on one store's row cannot project another store's offer: the store comes from the job row, never the payload", async () => {
    const a = await store("toko-a");
    const b = await store("toko-b");
    const offerB = await optIn(b);
    await drain();
    await setOfferStatus(b.owner, { offerId: offerB, status: "withdrawn" });
    await platform.delete(job).where(eq(job.kind, AFFILIATE_CATALOG_PROJECT)); // pretend B's withdrawal job was lost: B's row is now stale
    await platform.insert(job).values({ kind: AFFILIATE_CATALOG_PROJECT, storeId: a.storeId, key: "cross-store", payload: { offerId: offerB, revision: 2 } });
    await drain();
    expect((await rowOf(b)).active).toBe(true); // untouched: a job of store A names no offer of store B
  });
});

describe("T-52 the full rebuild of `affiliate_catalog` (T-74 hook, JOB-22)", () => {
  it("needs ops.jobs.manage, is a pure replace (idempotent), restores lost rows and applies a changed programme bound; it is audited", async () => {
    const s = await store();
    const second = await addProduct(s, 50_000);
    await optIn(s);
    await optIn(s, second.productId, 1_900);
    await drain();
    const good = (await catalogRows()).map(({ projectedAt: _p, ...r }) => r);
    const denied = await operatorWith("tenants.read");
    expect(await errCode(rebuildProjection(denied, { name: AFFILIATE_CATALOG_PROJECTION, reason: "uji tanpa izin" }))).not.toBe("ok");
    const op = await operatorWith("ops.jobs.manage");
    await admin.execute(sql`truncate affiliate_catalog`);
    expect(await rebuildProjection(op, { name: AFFILIATE_CATALOG_PROJECTION, reason: "pulihkan katalog" })).toEqual({ rows: 2 });
    expect((await catalogRows()).map(({ projectedAt: _p, ...r }) => r)).toEqual(good);
    expect(await rebuildProjection(op, { name: AFFILIATE_CATALOG_PROJECTION, reason: "ulangi" })).toEqual({ rows: 2 }); // idempotent
    expect((await catalogRows()).map(({ projectedAt: _p, ...r }) => r)).toEqual(good);
    await admin.execute(sql`update affiliate_policy set max_rate_bps = 1_200`); // the programme lowers its ceiling: the 19 % offer is no longer eligible
    await rebuildProjection(op, { name: AFFILIATE_CATALOG_PROJECTION, reason: "batas baru" });
    expect((await catalogRows()).map((r) => [r.rateBps, r.active])).toEqual([[1_000, true], [null, false]]);
    const audit = await platform.execute(sql`select action from audit_log where action = 'projection.rebuild' order by id`);
    expect(audit).toHaveLength(3);
  });

  it("discovery pages by offer id and never lists an inactive row", async () => {
    const s = await store();
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await optIn(s, (await addProduct(s, 10_000 + i, `Barang ${i}`)).productId));
    await drain();
    await setOfferStatus(s.owner, { offerId: ids[1]!, status: "paused" });
    await drain();
    const first = await listAffiliateCatalog(platform, { limit: 2 });
    expect(first.map((r) => r.offerId)).toEqual([ids[0], ids[2]]);
    expect((await listAffiliateCatalog(platform, { limit: 2, afterOfferId: first.at(-1)!.offerId })).map((r) => r.offerId)).toEqual([ids[3], ids[4]]);
  });
});
