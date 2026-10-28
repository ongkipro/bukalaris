import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { captureReferralClick } from "../src/affiliate/click.ts";
import { classifyClickRequest } from "../src/affiliate/code.ts";
import { affiliateFraudFlags, affiliateRiskCounters } from "../src/affiliate/risk.ts";
import { affiliateClick } from "../src/affiliate/schema-affiliate.ts";
import { blockAffiliate } from "../src/affiliate/seller.ts";
import { RL_CLICK } from "../src/affiliate/settings.ts";
import { verifyLedger } from "../src/ledger/verify.ts";
import { hit } from "../src/platform/rate-limit.ts";
import { purgeBatch, purgeClass, setRetentionPeriod } from "../src/ops/jobs/retention.ts";
import { registeredKinds, runOnce } from "../src/ops/jobs/jobs.ts";
import { registeredSchedules } from "../src/ops/jobs/scheduler.ts";
import { admin, db, makeStore, platform } from "./helpers.ts";
import { billingTestSetup, operatorWith } from "./t50-fixtures.ts";
import { attributionOf, buy, click, code, counter, errCode, fin, link, makeAffiliate, openStore, optIn, plantClick, resetFixtures, setAccountStatus, type A } from "./t52-fixtures.ts";

// T-52 HTTP-27 / SEC-20 click capture (service level; the route handler is a thin wrapper proved by e2e/t52.spec.ts), the cookie-stuffing and rate-limit rules,
// the retention job JOB-27 (OFF until a period is recorded) and the phase-1 fraud counters.
billingTestSetup();
beforeEach(async () => {
  resetFixtures();
  await admin.execute(sql`delete from retention_policy where class = 'affiliate_click'`); // a period set by one test must never leak into the next: JOB-27 is OFF unless a test turns it on
});

const clicksOf = (a?: A) => (a ? platform.select().from(affiliateClick).where(eq(affiliateClick.affiliateId, a.affiliateId)) : platform.select().from(affiliateClick));
async function world() {
  const s = await makeStore("toko-a", { price: 100_000, stock: 400 });
  await openStore(s, 1_000);
  const offerId = await optIn(s);
  const a = await makeAffiliate();
  const l = await link(a, s);
  return { s, a, offerId, ...l };
}
const capture = (token: string, decision: "capture" | "non_navigation" = "capture", clientIp?: string) => captureReferralClick(db, { token, decision, clientIp });
const linkKey = (token: string) => `click:link:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;

describe("T-52 a click is a server-timestamped, opaque, target-bound record (HTTP-27)", () => {
  it("a top-level navigation captures exactly one click whose target and clock are the server's", async () => {
    const { s, a, token, id } = await world();
    const before = Date.now();
    const out = (await capture(token))!;
    expect(out.mode).toBe("capture");
    expect(out.clickId).toMatch(/^c[0-9a-f]{32}$/);
    expect(out.target).toEqual({ storeSlug: "toko-a", productPath: null });
    const rows = await clicksOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: out.clickId, linkId: id, affiliateId: a.affiliateId, storeId: s.storeId, offerId: null });
    expect(rows[0]!.capturedAt.getTime()).toBeGreaterThanOrEqual(before - 2_000);
    expect(rows[0]!.capturedAt.getTime()).toBeLessThanOrEqual(Date.now() + 2_000);
    expect(rows[0]!.expiresAt.getTime() - rows[0]!.capturedAt.getTime()).toBe(7 * 86_400_000);
    expect(out.expiresAt!.getTime()).toBe(rows[0]!.expiresAt.getTime()); // the cookie lives exactly as long as the click counts
    expect(await counter("click_captured", a.affiliateId)).toBe(1);
    // ids are opaque and unguessable: 128 random bits, never sequential or derived from the link, the clock or the buyer
    const more = await Promise.all(Array.from({ length: 20 }, () => capture(token)));
    const ids = [out.clickId, ...more.map((m) => m!.clickId)];
    expect(new Set(ids).size).toBe(21);
  });

  it("a product link redirects to that product of that store only; a destination offer that is no longer active falls back to the store front", async () => {
    const { s, a, offerId } = await world();
    const withOffer = await link(a, s, offerId);
    const product = (await platform.query.product.findFirst({ where: (p, { eq: is }) => is(p.id, s.productId) }))!;
    const out = (await capture(withOffer.token))!;
    expect(out.target).toEqual({ storeSlug: "toko-a", productPath: product.slug ?? product.catalogId });
    expect((await clicksOf())[0]!.offerId).toBe(offerId);
    await admin.execute(sql`update affiliate_offer set status = 'paused'`);
    expect((await capture(withOffer.token))!.target.productPath).toBeNull();
  });

  it("no destination is ever an input: a token with a query string, a path, an absolute URL or any other decoration is not a token", async () => {
    const { token } = await world();
    for (const hostile of [`${token}?next=https://evil.example`, `${token}/../../x`, `https://evil.example/${token}`, `${token}%0d%0aSet-Cookie:x=1`, `${token}#x`, `${token} `, "", "short", "a".repeat(65), "../etc/passwd"]) {
      expect(await capture(hostile), hostile).toBeNull();
    }
    expect(await clicksOf()).toHaveLength(0);
  });

  it("unknown, revoked, expired, blocked and suspended links all answer the same: nothing, and no click", async () => {
    const { s, a, token } = await world();
    const revoked = await link(a, s);
    await admin.execute(sql`update affiliate_link set status = 'revoked', revoked_at = now() where id = ${revoked.id}`);
    const expired = await link(a, s);
    await admin.execute(sql`alter table affiliate_link disable trigger affiliate_selector_guard`); // a link's expiry is fixed at creation: the fixture rewinds it with the guard off
    await admin.execute(sql`update affiliate_link set expires_at = now() - interval '1 second' where id = ${expired.id}`);
    await admin.execute(sql`alter table affiliate_link enable trigger affiliate_selector_guard`);
    const answers = [await capture("A".repeat(16)), await capture(revoked.token), await capture(expired.token)];
    await blockAffiliate(s.owner, { affiliateId: a.affiliateId, reason: "uji" });
    answers.push(await capture(token));
    await admin.execute(sql`delete from affiliate_block`);
    await setAccountStatus(a.affiliateId, "suspended");
    answers.push(await capture(token));
    await setAccountStatus(a.affiliateId, "active");
    await admin.execute(sql`update store set status = 'suspended' where id = ${s.storeId}`);
    answers.push(await capture(token));
    expect(answers).toEqual([null, null, null, null, null, null]);
    expect(await clicksOf()).toHaveLength(0);
    await admin.execute(sql`update store set status = 'active' where id = ${s.storeId}`);
    expect((await capture(token))!.clickId).not.toBeNull(); // reactivation restores the very same link
  });
});

describe("T-52 SEC-20 cookie stuffing: embedding a link captures nothing", () => {
  const facts = (h: Record<string, string>, method = "GET") => classifyClickRequest({ method, headers: { get: (n: string) => h[n.toLowerCase()] ?? null } });
  it("an <img>, a hidden iframe, a prefetch, a script, fetch() and a request without Fetch Metadata are redirected without a click; the buyer is never blocked", async () => {
    const { a, token } = await world();
    const embeds: Record<string, string>[] = [
      { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" },
      { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
      { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-purpose": "prefetch" },
      { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" },
      { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
      {},
    ];
    for (let round = 0; round < 2; round++) {
      for (const h of embeds) {
        const out = (await capture(token, facts(h)))!;
        expect(out.clickId).toBeNull();
        expect(out.target.storeSlug).toBe("toko-a"); // the visitor still lands where the link points
      }
    }
    expect(await clicksOf()).toHaveLength(0);
    expect(await counter("click_non_navigation", a.affiliateId)).toBe(12); // visible to the risk queue
    expect((await capture(token, facts({ "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" })))!.clickId).not.toBeNull(); // the real navigation still captures
    expect(await clicksOf()).toHaveLength(1);
  });

  it("an attacker page that stuffs a victim's cookie with a link gains nothing by stuffing: a later genuine click or typed code of another affiliate beats it, and a stuffed id of another store is inert", async () => {
    const { s, a, token } = await world();
    for (let i = 0; i < 3; i++) await capture(token, facts({ "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" }));
    const o = await buy(s); // the victim checks out with no click at all
    expect(await attributionOf(o.orderId)).toBeUndefined();
    expect(await clicksOf(a)).toHaveLength(0);
  });
});

describe("T-52 RL-CLICK: over the limit the buyer is redirected without a click; the refusal is counted once per window", () => {
  it("per client IP: the 121st request of a window is redirected without a click and a second IP is unaffected; a refusal caused by the visitor's IP is NOT charged to the link's owner", async () => {
    const { a, token } = await world();
    const ip = "203.0.113.7";
    await hit(db, `click:ip:${ip}`, RL_CLICK.ip);
    await admin.execute(sql`update rate_limit set count = ${RL_CLICK.ip.limit} where key = ${`click:ip:${ip}`}`); // a window already holding exactly the limit
    const first = (await capture(token, "capture", ip))!;
    expect(first).toMatchObject({ clickId: null, mode: "redirect_only" });
    expect(first.target.storeSlug).toBe("toko-a");
    expect((await capture(token, "capture", ip))!).toMatchObject({ clickId: null, mode: "redirect_only" });
    expect(await counter("click_refused_rate", a.affiliateId)).toBe(0); // wave 5 review: the owner is flagged only for the link dimension
    expect((await capture(token, "capture", "203.0.113.8"))!.clickId).not.toBeNull();
    expect(await clicksOf()).toHaveLength(1);
  });

  it("per link: the 601st request of a window is refused for every visitor", async () => {
    const { a, token } = await world();
    await admin.execute(sql`insert into rate_limit (key, window_start, count) values (${linkKey(token)}, to_timestamp(floor(extract(epoch from now()) / ${RL_CLICK.link.windowSec}) * ${RL_CLICK.link.windowSec}), ${RL_CLICK.link.limit}) on conflict (key, window_start) do update set count = excluded.count`);
    expect((await capture(token, "capture", "198.51.100.1"))!).toMatchObject({ clickId: null, mode: "refused_rate" });
    expect((await capture(token, "capture", "198.51.100.2"))!).toMatchObject({ clickId: null, mode: "redirect_only" });
    expect(await counter("click_refused_rate", a.affiliateId)).toBe(1);
    expect(await clicksOf()).toHaveLength(0);
  });

  it("the limits are the documented rows of 16-OBSERVABILITY (RL-CLICK 120 per IP and 600 per link in 10 minutes)", () => {
    expect(RL_CLICK).toEqual({ ip: { limit: 120, windowSec: 600 }, link: { limit: 600, windowSec: 600 } });
  });
});

describe("T-52 JOB-27 `retention.affiliate_click`: registered, OFF until a period is recorded, never touches financial evidence", () => {
  async function evidence() {
    const { s, a, linkId } = await world().then((w) => ({ ...w, linkId: w.id }));
    const now = Date.now();
    const old = await plantClick(a, s, linkId, { capturedAt: new Date(now - 40 * 86_400_000), expiresAt: new Date(now + 3_600_000) }); // captured long ago, still inside its (hand-made) window
    const young = await plantClick(a, s, linkId, { capturedAt: new Date(now - 5 * 86_400_000), expiresAt: new Date(now + 3_600_000) });
    const orphan = await plantClick(a, s, linkId, { capturedAt: new Date(now - 90 * 86_400_000), expiresAt: new Date(now - 80 * 86_400_000) });
    const earned = await buy(s, { clicks: [old] });
    return { s, a, old, young, orphan, earned };
  }

  it("with no period nothing is deleted, however old; the kind and its daily schedule exist", async () => {
    const { old, young, orphan } = await evidence();
    expect(await purgeBatch(platform, "affiliate_click")).toBe(0);
    expect(await purgeClass(platform, "affiliate_click")).toBe(0);
    expect((await clicksOf()).map((c) => c.id).sort()).toEqual([old, young, orphan].sort());
    expect(registeredKinds()).toContain("retention.affiliate_click");
    expect(registeredSchedules().map((x) => x.kind)).toContain("retention.affiliate_click");
    expect((await platform.execute(sql`select kind from platform_job_kind where kind = 'retention.affiliate_click'`)).length).toBe(1);
    expect((await platform.execute(sql`select period_days from retention_policy where class = 'affiliate_click'`)).length).toBe(0);
  });

  it("with a period it removes expired raw clicks and detaches the attribution evidence; commission, snapshot, ledger and aggregate counters are unchanged", async () => {
    const { s, a, old, young, orphan, earned } = await evidence();
    const before = { fin: await fin(earned.orderId), at: await attributionOf(earned.orderId), ledger: await verifyLedger(platform), clicks: await counter("click_captured", a.affiliateId) };
    expect(before.at).toMatchObject({ clickId: old, clickDetachedAt: null, commissionIdr: 10_000 });
    const op = await operatorWith("ops.jobs.manage");
    await setRetentionPeriod(op, { dataClass: "affiliate_click", days: 30, reason: "uji retensi dengan jam terkendali" });
    expect(await purgeClass(platform, "affiliate_click")).toBe(2); // the 40-day-old and the 90-day-old; the 5-day-old stays
    expect((await clicksOf()).map((c) => c.id)).toEqual([young]);
    const after = (await attributionOf(earned.orderId))!;
    expect(after).toMatchObject({ clickId: null, commissionIdr: 10_000, commissionBaseIdr: 100_000, status: "pending", method: "link" });
    expect(after.clickDetachedAt).not.toBeNull();
    expect({ ...after, clickId: before.at!.clickId, clickDetachedAt: null }).toEqual(before.at);
    expect(await fin(earned.orderId)).toEqual(before.fin);
    expect(await verifyLedger(platform)).toEqual(before.ledger);
    expect(await counter("click_captured", a.affiliateId)).toBe(before.clicks); // aggregate counts stay consistent after the raw rows are gone
    expect(await purgeClass(platform, "affiliate_click")).toBe(0); // idempotent
    // the retired click can no longer attribute: a later order carrying its (cookie) id earns nothing, and nothing fails
    expect(await attributionOf((await buy(s, { clicks: [old] })).orderId)).toBeUndefined();
  });

  it("is bounded per run, and only the platform role may call the purge (the app role and the generic purge are closed)", async () => {
    const { a, s } = await world();
    const l = (await platform.query.affiliateLink.findFirst())!;
    for (let i = 0; i < 5; i++) await plantClick(a, s, l.id, { capturedAt: new Date(Date.now() - (60 + i) * 86_400_000), expiresAt: new Date(Date.now() - 50 * 86_400_000) });
    await setRetentionPeriod(await operatorWith("ops.jobs.manage"), { dataClass: "affiliate_click", days: 30, reason: "uji batas batch" });
    expect(await purgeBatch(platform, "affiliate_click", 2)).toBe(2);
    expect(await purgeBatch(platform, "affiliate_click", 2)).toBe(2);
    expect(await purgeBatch(platform, "affiliate_click", 2)).toBe(1);
    expect(await errCode(db.execute(sql`select retention_purge_affiliate_click(10)`))).toBe("42501");
    expect(await errCode(platform.execute(sql`select retention_purge('affiliate_click', 10)`))).toBe("42501");
    expect(await errCode(setRetentionPeriod(await operatorWith("tenants.read"), { dataClass: "affiliate_click", days: 1, reason: "tanpa izin" }))).not.toBe("ok");
  });

  it("the scheduled sweep runs through the worker and honours the same off switch", async () => {
    const { old } = await evidence();
    await admin.execute(sql`insert into job (kind, key, payload) values ('retention.affiliate_click', 'test-sweep-1', '{}')`);
    expect((await runOnce(platform, { workerId: "t52" })).map((o) => o.status)).toContain("done");
    expect((await clicksOf()).map((c) => c.id)).toContain(old); // no period: the sweep deleted nothing
    await setRetentionPeriod(await operatorWith("ops.jobs.manage"), { dataClass: "affiliate_click", days: 30, reason: "uji sapuan terjadwal" });
    await admin.execute(sql`insert into job (kind, key, payload) values ('retention.affiliate_click', 'test-sweep-2', '{}')`);
    await runOnce(platform, { workerId: "t52" });
    expect((await clicksOf()).map((c) => c.id)).not.toContain(old);
  });
});

describe("T-52 SA-18 phase-1 fraud counters: the read side the risk queue needs (no fingerprint, no raw click)", () => {
  it("counts clicks, refusals, non-navigations, self-referral suppressions, attributed and voided orders per affiliate, and failed codes platform-wide", async () => {
    const s = await makeStore("toko-a", { price: 100_000, stock: 400 });
    await openStore(s);
    await optIn(s);
    const a = await makeAffiliate({ phone: "081277700001", name: "Afiliasi Satu" });
    const b = await makeAffiliate({ name: "Afiliasi Dua" });
    const la = await link(a, s);
    await code(a, "COUNT001");
    const lb = await link(b, s);
    for (let i = 0; i < 4; i++) await capture(la.token);
    for (let i = 0; i < 2; i++) await capture(la.token, "non_navigation");
    await capture(lb.token);
    await admin.execute(sql`insert into rate_limit (key, window_start, count) values (${linkKey(lb.token)}, to_timestamp(floor(extract(epoch from now()) / 600) * 600), ${RL_CLICK.link.limit}) on conflict (key, window_start) do update set count = excluded.count`);
    await capture(lb.token);
    await capture(lb.token);
    for (const phone of ["081277700001", "+6281277700001"]) await buy(s, { code: "COUNT001", phone });
    await buy(s, { code: "WRONG123" });
    const c1 = await click(la.token);
    const earned = await Promise.all([buy(s, { clicks: [c1] }), buy(s, { clicks: [c1] }), buy(s, { code: "COUNT001" })]);
    await admin.execute(sql`update affiliate_attribution set status = 'void', void_reason = 'dibatalkan sebelum terkirim' where order_id = ${earned[0].orderId}`);
    const snap = await affiliateRiskCounters(platform);
    const row = (id: number) => snap.affiliates.find((r) => r.affiliateId === id)!;
    expect(row(a.affiliateId)).toMatchObject({ clicksCaptured: 5, attributedOrders: 3, voidedOrders: 1, selfReferralSuppressed: 2, clickRefusedRate: 0, clickNonNavigation: 2 });
    expect(row(a.affiliateId).clicksPerOrder).toBeCloseTo(5 / 3);
    expect(row(a.affiliateId).voidedShare).toBeCloseTo(1 / 3);
    expect(row(b.affiliateId)).toMatchObject({ clicksCaptured: 1, attributedOrders: 0, clickRefusedRate: 1, clicksPerOrder: null, voidedShare: null });
    expect(snap.platformCodeFailures).toBe(1);
    expect(snap.affiliates[0]!.affiliateId).toBe(a.affiliateId); // busiest first
    expect(affiliateFraudFlags(snap.affiliates, { selfReferralSuppressed: 2, clickRefusedRate: 1, clicksPerOrder: 5, voidedShare: 0.3, minOrdersForShares: 3 }).map((f) => `${f.affiliateId}:${f.rule}`).sort()).toEqual(
      [`${a.affiliateId}:self_referral`, `${a.affiliateId}:voided_share`, `${b.affiliateId}:click_flood`].sort(),
    );
    expect(JSON.stringify(snap)).not.toMatch(/phone|buyer|orderId|order_id|081277700001/); // counters carry no contact and no order
  });

  it("counters only ever grow through the observing functions: no login role can write one", async () => {
    await world();
    expect(await errCode(db.execute(sql`insert into affiliate_counter (day, kind, n) values (current_date, 'code_failure', 99)`))).toBe("42501");
    expect(await errCode(platform.execute(sql`insert into affiliate_counter (day, kind, n) values (current_date, 'code_failure', 99)`))).toBe("42501");
    expect(await errCode(db.execute(sql`select affiliate_bump('code_failure', null)`))).toBe("42501");
    expect(await errCode(db.execute(sql`select affiliate_resolve_core(1, 1, null, null)`))).toBe("42501");
    expect(await errCode(db.execute(sql`select affiliate_resolve(1, 1, null, null)`))).toBe("42501"); // callable, but only with the transaction's own store: without one it refuses
  });
});

describe("wave 5 review: one noisy request cannot use up a link's click budget or flag its owner", () => {
  it("non-navigation requests and an over-limit IP do not spend the link's budget: a real visitor from another IP still captures, and nothing is charged to the owner", async () => {
    const { a, token } = await world();
    for (let i = 0; i < RL_CLICK.link.limit + 5; i++) await capture(token, "non_navigation", "198.51.100.7"); // HEAD / <img> / fetch noise on the link
    for (let i = 0; i < RL_CLICK.ip.limit + 5; i++) await capture(token, "capture", "198.51.100.8"); // one noisy IP
    const visitor = (await capture(token, "capture", "203.0.113.9"))!;
    expect(visitor.mode).toBe("capture");
    expect(visitor.clickId).toMatch(/^c[0-9a-f]{32}$/);
    // The owner is charged only for refusals of the LINK dimension, never for a visitor's IP.
    expect(await counter("click_refused_rate", a.affiliateId)).toBe(0);
  });
});
