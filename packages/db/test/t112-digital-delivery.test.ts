import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueSellerStepUp } from "../src/ledger/stepup.ts";
import { RESERVED_MEMBER_AREA_PATHS } from "../src/member-area/index.ts";
import { runOnce } from "../src/ops/jobs/jobs.ts";
import { addBankAccount, BANK_ACCOUNT_STEP_UP, confirmBankTransfer } from "../src/payments/bank-transfer.ts";
import { acceptPaymentCallback } from "../src/payments/callback.ts";
import { FakeProviderCheck, saveProviderKey, setPaymentAccountDetails, setProviderCheckTransport } from "../src/payments/provider-accounts.ts";
import { fakeProviders, type Providers } from "../src/payments/providers.ts";
import { paymentAttempt } from "../src/payments/schema-payments.ts";
import { confirmPaymentByHand, FakeAutoLarisAccounts, setSellerPaymentTransport } from "../src/payments/seller.ts";
import { callbackToken } from "../src/payments/signature.ts";
import { dispatchHostPath } from "../src/platform/host.ts";
import { bindSession, type SellerScope } from "../src/platform/scoped.ts";
import { acceptSellerTerms } from "../src/platform/terms.ts";
import { withStore } from "../src/platform/tenant.ts";
import { auditLog, digitalGrant, mailOutbox, media, order, productAccessItem, store, variant } from "../src/schema.ts";
import { createProduct, updateProduct } from "../src/seller/commerce/catalog.ts";
import { placeOrder, searchDestinationAreas } from "../src/seller/commerce/checkout.ts";
import {
  ACCESS_LINKS_MAX,
  ACCESS_OPEN_LIMITS,
  addAccessLink,
  extendDigitalGrant,
  getProductAccessContent,
  grantDigitalAccessInTx,
  removeAccessLink,
  reorderAccessLink,
  RESERVED_ACCESS_ITEM_TYPES,
  resolveOrderDigitalGrants,
  revokeDigitalGrant,
  saveAccessNote,
  sellerOrderDigitalGrants,
} from "../src/seller/commerce/digital.ts";
import { recordSellerRefund, transitionOrder } from "../src/seller/commerce/orders.ts";
import { redactOrders } from "../src/seller/commerce/privacy.ts";
import { feedItems } from "../src/storefront/feeds.ts";
import { getCart, getPublishedProduct, listPublishedProducts, setCartLine } from "../src/storefront/storefront.ts";
import { admin, db, makeStore, platform } from "./helpers.ts";
import { sessionOf } from "./t37-fixtures.ts";

// T-112 (PR-2, ADR-0016 section 4, section 7 and decisions 18, 20, 23, 24; C-G1..C-G3):
// Access links, plain-text access note, settlement-only digital grants, single content reader with
// RL-ACCESS-OPEN and suspended-store hiding, audited extend/revoke, cancel/refund/redaction revocation,
// no leaks into storefront/API/feeds/e-mails/logs, cross-store FORCE RLS isolation, and unreachable
// reserved member-area paths on every host.

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code ?? String(e));
const pgCode = (p: Promise<unknown>) => p.then(() => "allowed", (e: { cause?: { code?: string }; code?: string }) => e.cause?.code ?? e.code);

const SECRET_LINK = "https://drive.google.com/file/d/CANARY-T112-SECRET-LINK-9f8e7d/view";
const SECRET_NOTE = "CANARY-T112-NOTE <script>alert('xss')</script> kata sandi arsip: BUKA-112";
const AUTOLARIS_KEY = "CANARY-T112-AUTOLARIS-KEY-0123456789abcdef";

let accounts: FakeAutoLarisAccounts;
beforeEach(() => {
  accounts = new FakeAutoLarisAccounts();
  setProviderCheckTransport(new FakeProviderCheck());
  setSellerPaymentTransport(accounts);
});
afterEach(() => {
  setProviderCheckTransport(null);
  setSellerPaymentTransport(null);
  vi.restoreAllMocks();
});

const providers = (): Providers => ({ ...fakeProviders, payment: fakeProviders.payment });

type Own = Awaited<ReturnType<typeof makeStore>> & { me: SellerScope; digId: number; digVarId: number };

async function digitalStore(slug: string, opts: { withAutoLaris?: boolean } = {}): Promise<Own> {
  const s = await makeStore(slug, { pickupArea: false });
  const me = bindSession(s.owner, await sessionOf(s.ownerId));
  await acceptSellerTerms(me, { version: 1, agreed: true });
  await addBankAccount(me, { bankCode: "BCA", accountNumber: "1234567890", holderName: "Pemilik Digital", proofId: await issueSellerStepUp(me, BANK_ACCOUNT_STEP_UP) });
  if (opts.withAutoLaris) {
    await saveProviderKey(me, { provider: "autolaris", environment: "sandbox", apiKey: AUTOLARIS_KEY, proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "autolaris" }) });
    await setPaymentAccountDetails(me, { originAreaId: "3517100", destinationAreaId: "3518010", shipperEmail: `${slug}@example.invalid`, senderAddress: "Jl. Braga No. 1, Bandung", paymentOnlyConfirmed: true });
  }
  const digId = await createProduct(me, { title: `E-Book ${slug}`, kind: "digital", status: "draft", variant: { title: "PDF", price: 65_000, stock: 0 } });
  await addAccessLink(me, digId, { label: "Unduh PDF Utama", url: SECRET_LINK });
  await saveAccessNote(me, digId, { note: SECRET_NOTE });
  await updateProduct(me, digId, { title: `E-Book ${slug}`, description: "Panduan lengkap", kind: "digital", status: "active", slug: null });
  const [dv] = await admin.select().from(variant).where(eq(variant.productId, digId));
  return { ...s, me, digId, digVarId: dv!.id };
}

describe("T-112 access links, access note and reserved item types", () => {
  it("validates https-only URLs without credentials, enforces caps and reserved types, makes no outbound request, and blocks activation without content", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const s = await digitalStore("t112-links");
    const draftId = await createProduct(s.me, { title: "Draft Digital", kind: "digital", status: "draft", variant: { title: "Akses", price: 50_000, stock: 0 } });
    // Cannot activate without delivery content (ADR-0016 decision 3).
    expect(await code(updateProduct(s.me, draftId, { title: "Draft Digital", description: "", kind: "digital", status: "active", slug: null }))).toBe("delivery_content_required");

    // Invalid URLs refused on save.
    for (const bad of [
      "http://drive.google.com/file/d/123",
      "javascript:alert(1)",
      "https://user:pass@drive.google.com/file/d/123",
      "https://drive.google.com/a b",
      `https://drive.google.com/${"a".repeat(2000)}`,
    ]) {
      expect(await code(addAccessLink(s.me, draftId, { label: "Bad", url: bad }))).not.toBe("ok");
    }
    // Reserved types refused in service AND database CHECK.
    for (const reserved of RESERVED_ACCESS_ITEM_TYPES) {
      expect(await code(addAccessLink(s.me, draftId, { itemType: reserved, label: "Video", url: "https://example.com/v" }))).toBe("reserved_access_type");
      expect(await pgCode(admin.execute(sql`insert into product_access_item (store_id, product_id, item_type, label, url) values (${s.storeId}, ${draftId}, ${reserved}, 'Video', 'https://example.com/v')`))).toBe("23514");
    }
    // Physical product cannot hold access links (service + DB trigger).
    expect(await code(addAccessLink(s.me, s.productId, { label: "Nope", url: "https://example.com/x" }))).toBe("not_digital");
    expect(await pgCode(admin.execute(sql`insert into product_access_item (store_id, product_id, item_type, label, url) values (${s.storeId}, ${s.productId}, 'link', 'Nope', 'https://example.com/x')`))).toBe("23514");

    // Add up to cap (10), reorder, remove, and 11th refused (service + DB trigger).
    const ids: number[] = [];
    for (let i = 0; i < ACCESS_LINKS_MAX; i++) {
      const r = await addAccessLink(s.me, draftId, { label: `File ${i + 1}`, url: `https://files.example.com/doc-${i + 1}` });
      ids.push(r.id);
    }
    expect(await code(addAccessLink(s.me, draftId, { label: "Overflow", url: "https://files.example.com/doc-11" }))).toBe("access_link_limit");
    expect(await pgCode(admin.execute(sql`insert into product_access_item (store_id, product_id, item_type, label, url) values (${s.storeId}, ${draftId}, 'link', 'DB Overflow', 'https://files.example.com/doc-11')`))).toBe("23514");

    await reorderAccessLink(s.me, draftId, ids[1]!, "up");
    const afterReorder = await getProductAccessContent(s.me, draftId);
    expect(afterReorder!.items[0]!.id).toBe(ids[1]);
    await removeAccessLink(s.me, draftId, ids[9]!);
    expect((await getProductAccessContent(s.me, draftId))!.items).toHaveLength(9);

    // Server never requested any access link.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("T-112 settlement-only grants, single reader, revocations, privacy and isolation", () => {
  it("no grant before paid and none from callback alone; exactly one grant per line under concurrent/replayed settlement; test orders marked as test", async () => {
    const s = await digitalStore("t112-settle", { withAutoLaris: true });
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.digVarId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, cartId, {
      idempotencyKey: randomUUID(),
      buyerName: "Pembeli Digital",
      buyerPhone: "081211112222",
      buyerEmail: "buyer@example.com",
      paymentMethod: "manual_transfer",
      paymentChannel: "VABCA",
    }, providers());
    // No grant on order creation (and DB trigger refuses direct insert while unpaid).
    expect((await resolveOrderDigitalGrants(db, { storeId: s.storeId, orderId })).grants).toEqual([]);
    expect(await pgCode(admin.execute(sql`insert into digital_grant (store_id, order_id, variant_id, product_id) values (${s.storeId}, ${orderId}, ${s.digVarId}, ${s.digId})`))).toBe("23514");

    // Run instruction creation job, then send a valid AutoLaris callback alone -> STILL NO GRANT (callback is evidence only).
    for (let i = 0; i < 4; i++) if ((await runOnce(platform, { workerId: "t112", providers: providers() })).length === 0) break;
    const [att] = await admin.select().from(paymentAttempt).where(eq(paymentAttempt.orderId, orderId));
    expect(att?.transactionId).toBeTruthy();
    const rawBody = JSON.stringify({ transaction_id: att!.transactionId, reff_id: att!.reffId, status: "PAID", amount: att!.totalIdr });
    await acceptPaymentCallback(db, { token: callbackToken(att!.reffId), rawBody });
    expect((await resolveOrderDigitalGrants(db, { storeId: s.storeId, orderId })).grants).toEqual([]);

    // Settle via seller manual confirmation -> grant created in same transaction, marked isTest (sandbox AutoLaris).
    await confirmPaymentByHand(s.me, { attemptId: att!.id, reason: "Dana terlihat di mutasi", evidence: "MUT-T112" });
    const firstRead = await resolveOrderDigitalGrants(db, { storeId: s.storeId, orderId });
    expect(firstRead.grants).toHaveLength(1);
    expect(firstRead.grants[0]).toMatchObject({
      active: true,
      isTest: true,
      note: SECRET_NOTE,
      links: [{ label: "Unduh PDF Utama", host: "drive.google.com", url: SECRET_LINK }],
    });

    // Replayed / concurrent grant calls never create a second grant.
    const counts = await Promise.all([
      withStore(db, s.storeId, (tx) => grantDigitalAccessInTx(tx, s.storeId, orderId)),
      withStore(db, s.storeId, (tx) => grantDigitalAccessInTx(tx, s.storeId, orderId)),
    ]);
    expect(counts).toEqual([0, 0]);
    expect(await admin.select().from(digitalGrant).where(eq(digitalGrant.orderId, orderId))).toHaveLength(1);
  });

  it("access links and note never leak into storefront reads, feeds, e-mails or audit logs", async () => {
    const s = await digitalStore("t112-noleak");
    await admin.insert(media).values({ storeId: s.storeId, productId: s.digId, mime: "image/png", bytes: 100, width: 100, height: 100, alt: "dig", position: 0 });
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.digVarId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, cartId, {
      idempotencyKey: randomUUID(),
      buyerName: "Pembeli Leak",
      buyerPhone: "081233334444",
      buyerEmail: "noleak@example.com",
      paymentMethod: "bank_transfer",
    }, fakeProviders);
    await confirmBankTransfer(s.me, { orderId, reason: "Mutasi BCA cocok" });
    for (let i = 0; i < 4; i++) if ((await runOnce(platform, { workerId: "t112-mail" })).length === 0) break;

    const surfaces = JSON.stringify({
      list: await listPublishedProducts(s.sf),
      pdp: await getPublishedProduct(s.sf, String((await admin.select({ c: sql<string>`catalog_id` }).from(sql`product`).where(sql`id = ${s.digId}`))[0]!.c)),
      cart: await getCart(s.sf, cartId),
      feeds: await feedItems(s.sf),
      mails: await admin.select({ subject: mailOutbox.subject, text: mailOutbox.textBody, html: mailOutbox.htmlBody }).from(mailOutbox),
      audits: await admin.select({ action: auditLog.action, reason: auditLog.reason }).from(auditLog).where(eq(auditLog.storeId, s.storeId)),
    });
    expect(surfaces).not.toContain(SECRET_LINK);
    expect(surfaces).not.toContain("CANARY-T112-SECRET-LINK");
    expect(surfaces).not.toContain("CANARY-T112-NOTE");
  });

  it("expired, revoked, suspended-store, refunded and redacted orders show nothing; seller extend/revoke audited; RL-ACCESS-OPEN throttles; cross-store isolated", async () => {
    const a = await digitalStore("t112-a");
    const b = await digitalStore("t112-b");

    const placeAndPay = async (s: Own, email: string) => {
      const c = await setCartLine(s.sf, undefined, { variantId: s.digVarId, quantity: 1 }, "add");
      const { orderId } = await placeOrder(db, c, { idempotencyKey: randomUUID(), buyerName: "Pembeli", buyerPhone: "081255556666", buyerEmail: email, paymentMethod: "bank_transfer" }, fakeProviders);
      await confirmBankTransfer(s.me, { orderId, reason: "Dana masuk rekening" });
      return orderId;
    };

    // 1. Extend -> expiry -> shows nothing when past expiry; revoke -> shows nothing, audited, cannot reactivate.
    const o1 = await placeAndPay(a, "o1@example.com");
    const [g1] = await sellerOrderDigitalGrants(a.me, o1);
    const { expiresAt } = await extendDigitalGrant(a.me, g1!.id, { days: 7, reason: "Beri batas waktu 7 hari" });
    expect(expiresAt).not.toBeNull();
    // Past expiry -> active=false, links=[], note=null.
    const expiredRead = await resolveOrderDigitalGrants(db, { storeId: a.storeId, orderId: o1 }, { now: new Date(expiresAt!.getTime() + 60_000) });
    expect(expiredRead.grants[0]).toMatchObject({ active: false, expired: true, links: [], note: null });

    // Cross-store isolation: store B cannot read, extend, revoke or alter store A's access items or grants.
    expect(await getProductAccessContent(b.me, a.digId)).toBeNull();
    expect(await code(addAccessLink(b.me, a.digId, { label: "Cross", url: "https://evil.example.com/x" }))).toBe("not_found");
    expect(await sellerOrderDigitalGrants(b.me, o1)).toEqual([]);
    expect(await code(extendDigitalGrant(b.me, g1!.id, { days: 30, reason: "Cross store attempt" }))).toBe("not_found");
    expect(await code(revokeDigitalGrant(b.me, g1!.id, { reason: "Cross store attempt" }))).toBe("not_found");

    // Revoke -> active=false, links=[], note=null, audited, DB refuses delete or reactivation.
    await revokeDigitalGrant(a.me, g1!.id, { reason: "Pembeli salah beli" });
    const revokedRead = await resolveOrderDigitalGrants(db, { storeId: a.storeId, orderId: o1 });
    expect(revokedRead.grants[0]).toMatchObject({ active: false, state: "revoked", links: [], note: null });
    expect(await pgCode(admin.execute(sql`delete from digital_grant where id = ${g1!.id}`))).toBe("42501");
    expect(await pgCode(admin.execute(sql`update digital_grant set state = 'active', revoked_at = null, revoked_by = null, revoked_reason = null where id = ${g1!.id}`))).toBe("23514");

    // 2. Seller refund revokes active grants (ADR-0016 decision 18).
    const o2 = await placeAndPay(a, "o2@example.com");
    await recordSellerRefund(a.me, o2, { amountIdr: 65_000, refundedOn: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date()), method: "bank_transfer", reason: "Refund penuh pembeli" });
    expect((await resolveOrderDigitalGrants(db, { storeId: a.storeId, orderId: o2 })).grants[0]).toMatchObject({ active: false, state: "revoked", links: [], note: null });

    // 3. Redacting an order revokes active grants (C-G3).
    const o3 = await placeAndPay(a, "o3@example.com");
    await redactOrders(a.me, { orderIds: [o3] });
    expect((await resolveOrderDigitalGrants(db, { storeId: a.storeId, orderId: o3 })).grants[0]).toMatchObject({ active: false, state: "revoked", links: [], note: null });

    // 4. Suspended store hides all access links (C-G1).
    const o4 = await placeAndPay(a, "o4@example.com");
    await admin.update(store).set({ status: "suspended", suspendedAt: new Date() }).where(eq(store.id, a.storeId));
    expect(await resolveOrderDigitalGrants(db, { storeId: a.storeId, orderId: o4 })).toEqual({ storeSuspended: true, rateLimited: false, grants: [] });
    await admin.update(store).set({ status: "active", suspendedAt: null }).where(eq(store.id, a.storeId));

    // 5. RL-ACCESS-OPEN throttles after 60 reads per order.
    let limited = false;
    for (let i = 0; i <= ACCESS_OPEN_LIMITS.order.limit; i++) {
      const r = await resolveOrderDigitalGrants(db, { storeId: a.storeId, orderId: o4 }, { countRateLimit: true });
      if (r.rateLimited) { limited = true; break; }
    }
    expect(limited).toBe(true);
  });

  it("reserved member-area paths answer 404 on every host (ADR-0016 item 27)", () => {
    const hosts = [
      "bukalaris.com",
      "owner.bukalaris.com",
      "app.bukalaris.com",
      "checkout.bukalaris.com",
      "buyer.bukalaris.com",
      "affiliate.bukalaris.com",
      "toko-a.bukalaris.id",
      "localhost:3000",
    ];
    const roots = { platform: "bukalaris.com", store: "bukalaris.id" };
    for (const host of hosts) {
      for (const path of [...RESERVED_MEMBER_AREA_PATHS, "/s/toko-a/member", "/member/courses", "/buyer/members/1", "/seller/memberships/1"]) {
        const res = dispatchHostPath({ host, rootDomain: roots, pathname: path, method: "GET" });
        expect({ host, path, action: res.action, status: res.action === "not_found" ? res.status : 200 }).toEqual({ host, path, action: "not_found", status: 404 });
      }
    }
  });
});
