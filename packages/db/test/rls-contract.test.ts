import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, platformDb, type Db } from "../src/client.ts";
import { applySqlFile, localRoleUrl, pendingFile, prepareLocalDatabase, wipeLocalDatabase } from "../src/local-roles.ts";
import { ISOLATION_REGISTRY } from "../src/platform/isolation-registry.ts";
import { createStore, listStores, setStoreStatus, storeAudit } from "../src/platform/platform.ts";
import { decideApproval, requestApproval } from "../src/ops/capabilities-approvals.ts";
import { grantCapability } from "../src/ops/capabilities-grants.ts";
import { purgeClass, setRetentionPeriod } from "../src/ops/jobs/retention.ts";
import { schedulerHealth, schedulerTick } from "../src/ops/jobs/scheduler.ts";
import { getStoreDetail } from "../src/storefront/content.ts";
import { seedFakeCourierPolicy } from "../src/ledger/fixtures.ts";
import { operatorScope, sellerContext, storefrontScope } from "../src/platform/scoped.ts";
import { revokeSessionsIfOrphaned } from "../src/platform/accounts.ts";
import { getSystemLog, listSystemLogs, recordLogEvent } from "../src/ops/ops.ts";
import { withPersonalDataAccess } from "../src/ops/console-access.ts";
import { approvalInbox } from "../src/ops/console-approvals.ts";
import { consoleDashboard, consoleJobHealth } from "../src/ops/console.ts";
import { consoleIssues, reportConsoleIssue } from "../src/ops/console-issues.ts";
import { openCase, addCaseNote, moveCase } from "../src/ops/accounts-governance-cases.ts";
import { requestBreakGlass, activateBreakGlass, revealAccountField } from "../src/ops/accounts-governance-reveal.ts";
import { redeemSupportRecovery, requestMfaReset, revokeUserSessions, setIdentitySuspension, startSupportRecovery } from "../src/ops/accounts-governance-support.ts";
import { deactivateStaff } from "../src/ops/accounts-governance-staff.ts";
import { searchAccounts } from "../src/ops/accounts-governance-accounts.ts";
import { riskQueue, submitVerification } from "../src/ops/accounts-governance-stores.ts";
import type { PlatformCapability } from "../src/ops/schema-ops.ts";
import { billingOverview, createInvoiceAsOperator, setBillingControls } from "../src/billing/console.ts";
import { paySubscription, recordSubscriptionInquiry } from "../src/billing/attempts.ts";
import { acceptAutoLarisCallback } from "../src/billing/callback.ts";
import { runBillingCycle } from "../src/billing/cycle.ts";
import { FakeAutoLaris } from "../src/payments/fake.ts";
import { callbackToken } from "../src/payments/signature.ts";
import { fakeProviders } from "../src/payments/providers.ts";
import "../src/billing/jobs.ts";
import { runOnce } from "../src/ops/jobs/jobs.ts";
import "../src/ops/jobs/notify.ts";
import "../src/storefront/signals.ts";
import { createProduct } from "../src/seller/commerce/catalog.ts";
import { cleanupIdleCarts, placeOrder } from "../src/seller/commerce/checkout.ts";
import { redactStaleOrders } from "../src/seller/commerce/privacy.ts";
import { transitionOrder } from "../src/seller/commerce/orders.ts";
import { getMarginRule, setMarginRule, setPickupArea } from "../src/shipping/shipping.ts";
import { requestMarginRule } from "../src/shipping/policy.ts";
import { bookShipment, setBookingAdapter, type BookingAdapter } from "../src/shipping/fulfillment.ts";
import { operatorGrant, order, platformOperator, session, shipment, user, variant } from "../src/schema.ts";
import { purgeSignalContext, saveDestination } from "../src/storefront/signals.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { withStore } from "../src/platform/tenant.ts";
import { completenessProblems, readDefiners, readRelations, resolverProblems, definerProblems, tableProblems } from "./isolation-catalog.ts";

// The CONTRACT step of T-59 (drizzle-pending/t59-contract.sql) is deferred: it needs the new web version deployed and
// the owner's approval (D-22 item 4). This file proves it is safe to ship later. It builds a scratch copy of the schema
// (migrations + pending expand SQL), applies the contract file, then checks the grants against the registry and drives the
// production paths of the platform pool (Owner console, outbox worker, cleanup, retention, session revocation) and of the
// app pool through the narrowed role. Nothing here touches the main test database.

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {}
const mainUrl = process.env.TEST_DATABASE_URL ?? "";
if (!/_test$/.test(mainUrl)) throw new Error("TEST_DATABASE_URL must point at a *_test database");
const scratchUrl = mainUrl.replace(/_test$/, "_contract_test");
process.env.PLATFORM_DATABASE_URL = localRoleUrl(scratchUrl, "bukalaris_platform"); // the lazy platformDb() singleton of this file's module graph

let admin: Db; // superuser: fixtures only (the narrowed platform role must not be used to build them)
let app: Db;
// The outbox worker delivers ad signals, which seal tokens with this key (dev placeholder only).
process.env.INTEGRATION_TOKEN_KEY ??= Buffer.alloc(32, 9).toString("base64");
let platform: Db;

beforeAll(async () => {
  const roles = await prepareLocalDatabase(scratchUrl);
  await wipeLocalDatabase(scratchUrl);
  const ownerDb = createDb(roles.owner);
  await migrate(ownerDb, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  await seedFakeCourierPolicy(ownerDb); // the scenario below checks out COD with the fake courier JNE (the migration seeds SPX only)
  await ownerDb.$client.end();
  await applySqlFile(roles.owner, pendingFile("t59-contract.sql"));
  admin = createDb(scratchUrl);
  app = createDb(roles.app);
  platform = platformDb();
});
afterAll(async () => {
  setBookingAdapter(null);
  await Promise.all([admin?.$client.end(), app?.$client.end(), platform?.$client.end()]);
});

describe("contract step: grants", () => {
  it("bukalaris_platform holds exactly its registry privileges on every table, the app role keeps exactly its own, restricted tables stay closed", async () => {
    const rels = await readRelations(admin);
    expect(completenessProblems(rels.map((r) => r.name))).toEqual([]);
    expect(rels.flatMap((r) => tableProblems(r, ISOLATION_REGISTRY[r.name]!, "contract"))).toEqual([]);
    expect(resolverProblems(rels)).toEqual([]);
    expect(definerProblems(await readDefiners(admin))).toEqual([]);
  });

  it("the platform role has no default privileges on future tables any more, so a new table starts closed for both login roles", async () => {
    const rows = await admin.execute(sql`select defaclrole::regrole::text as owner, defaclacl::text as acl from pg_default_acl where defaclobjtype = 'r' and (defaclacl::text like '%bukalaris_platform=%' or defaclacl::text like '%bukalaris_app=%')`);
    expect([...rows]).toEqual([]);
    await admin.execute(sql`set role bukalaris_owner`);
    try {
      await admin.execute(sql`create table contract_probe (id bigint primary key)`);
      const [{ platform: p, app: a }] = (await admin.execute(sql`select has_table_privilege('bukalaris_platform', 'contract_probe', 'SELECT') as platform, has_table_privilege('bukalaris_app', 'contract_probe', 'SELECT') as app`)) as unknown as { platform: boolean; app: boolean }[];
      expect({ platform: p, app: a }).toEqual({ platform: false, app: false });
    } finally {
      await admin.execute(sql`drop table if exists contract_probe`);
      await admin.execute(sql`reset role`);
    }
  });

  it("audit_log is append-only for the platform role after the contract: SELECT and INSERT only", async () => {
    await expect(platform.execute(sql`update audit_log set reason = 'x'`)).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(platform.execute(sql`delete from audit_log`)).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(platform.execute(sql`truncate audit_log`)).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("applying the contract file twice is harmless", async () => {
    await applySqlFile(localRoleUrl(scratchUrl, "bukalaris_owner"), pendingFile("t59-contract.sql"));
    expect((await readRelations(admin)).flatMap((r) => tableProblems(r, ISOLATION_REGISTRY[r.name]!, "contract"))).toEqual([]);
  });
});

describe("contract step: the production access paths still work through the narrowed roles", () => {
  it("Owner console, seller, storefront, checkout, outbox worker (payment, mail, shipment, ad signals), cleanup, retention and session revocation", async () => {
    // Fixtures through the superuser: an operator with the capabilities below, a seller user.
    const opId = randomUUID();
    const ownerId = randomUUID();
    await admin.insert(user).values([
      { id: opId, name: "op", email: `op-${opId.slice(0, 6)}@test.local` },
      { id: ownerId, name: "owner", email: `owner-${ownerId.slice(0, 6)}@test.local` },
    ]);
    await admin.insert(platformOperator).values({ userId: opId });
    // T-60: every Owner operation checks its own capability, so the probe operator holds exactly the ones it uses.
    const needed: PlatformCapability[] = ["logs.read", "tenants.read", "tenants.manage", "audit.read", "shipping.manage", "staff.manage", "ops.jobs.manage"];
    await admin.insert(operatorGrant).values(needed.map((capability) => ({ userId: opId, capability })));

    // Owner console (platform pool): operator lookup, store create/list/suspend/reactivate, audit read, margin, logs.
    const op = (await operatorScope(platform, opId))!;
    expect(op).not.toBeNull();
    const storeId = await createStore(op, { slug: "toko-c", name: "Toko C", ownerUserId: ownerId });
    expect((await listStores(op)).map((s) => s.id)).toEqual([storeId]);
    await setStoreStatus(op, storeId, { status: "suspended", reason: "contract probe" });
    expect(await storefrontScope(app, "toko-c")).toBeNull(); // resolver on the app pool: suspended
    await setStoreStatus(op, storeId, { status: "active", reason: "contract probe" });
    expect((await storeAudit(op, storeId)).length).toBe(3);
    expect(await getMarginRule(platform)).toMatchObject({ fixedIdr: expect.any(Number) });
    const marginOp2 = randomUUID();
    await admin.insert(user).values({ id: marginOp2, name: "op2", email: `op2-${marginOp2.slice(0, 6)}@test.local` });
    await admin.insert(platformOperator).values({ userId: marginOp2 });
    await admin.insert(operatorGrant).values({ userId: marginOp2, capability: "shipping.manage" });
    const marginRule = { fixedIdr: 1000, percentBps: 100, roundTo: 500 };
    const marginApproval = await requestMarginRule(op, marginRule);
    await decideApproval((await operatorScope(platform, marginOp2))!, marginApproval.approvalId, "approve");
    await setMarginRule(op, marginRule, marginApproval.approvalId);
    const logId = await recordLogEvent(app, { level: "info", message: "contract probe", module: "test" }); // the app role may log
    expect((await listSystemLogs(op, {})).items.some((e) => e.id === logId)).toBe(true);
    expect((await getSystemLog(op, logId))?.event.id).toBe(logId);

    // Seller and storefront on the app pool (resolvers, RLS), through the app role only.
    const ctx = await sellerContext(app, ownerId);
    if (!ctx.ok) throw new Error(ctx.reason);
    const owner = ctx.scope;
    await createProduct(owner, { title: "Kaos", status: "active", variant: { title: "M", price: 100_000, stock: 20, weightGrams: 1000 } });
    await setPickupArea(owner, { areaId: "a1a1a1a1a1a1a1a1a1a1a1a1", areaLabel: "Braga, Sumur Bandung, Bandung, Jawa Barat 40111" });
    await saveDestination(owner, "meta", { pixelId: "123456789012345", token: "EAAB-token", enabled: true });
    const sf = (await storefrontScope(app, "toko-c"))!;
    const [variantRow] = await admin.select({ id: variant.id }).from(variant).limit(1);
    const variantId = variantRow!.id;
    const buy = (over: Record<string, unknown>) => ({
      idempotencyKey: randomUUID(), buyerName: "Budi Santoso", buyerPhone: "081234567890", buyerEmail: "budi@example.com",
      shippingAddress: "Jl. Merdeka No. 1, Bandung 40111", destinationAreaId: "b1b1b1b1b1b1b1b1b1b1b1b1",
      destinationAreaLabel: "Menteng, Menteng, Jakarta Pusat, DKI Jakarta 10310", courier: "JNE", paymentChannel: "VABCA", ...over,
    });
    const transferCart = await setCartLine(sf, undefined, { variantId, quantity: 1 }, "add");
    const { orderId: transferId } = await placeOrder(app, transferCart, buy({ paymentMethod: "manual_transfer" }));
    const codCart = await setCartLine(sf, undefined, { variantId, quantity: 1 }, "add");
    const { orderId: codId } = await placeOrder(app, codCart, buy({ paymentMethod: "cod" }));
    await setCartLine(sf, undefined, { variantId, quantity: 1 }, "add"); // an idle cart for cleanup

    // Outbox worker on the platform pool: payment instruction, order mails (order_notification, mail_outbox), ad signal.
    const first = await runOnce(platform, { workerId: "contract" });
    expect(first.length).toBeGreaterThanOrEqual(4);
    expect(first.filter((o) => o.status !== "done")).toEqual([]);
    expect(first.map((o) => o.kind)).toEqual(expect.arrayContaining(["payment.instruction", "order.notify", "signal.deliver", "buyer.resolve"]));
    // T-57: the buyer.resolve handler reaches the identity tables only through buyer_resolve_order() (EXECUTE); the narrowed platform role holds no table privilege on them. Both orders carry one phone: one buyer, two links.
    expect((await admin.execute(sql`select (select count(*) from buyer)::int as buyers, (select count(*) from buyer_order_link)::int as links`))[0]).toEqual({ buyers: 1, links: 2 });

    // Shipment: seller books (app pool), the worker books at the provider (scripted adapter), the order ships.
    setBookingAdapter({
      async createOrder(input) {
        return { providerOrderId: `MGT-${input.orderId}`, providerBatchId: `B-${input.orderId}`, trackingNumber: `RESI-${input.orderId}`, paid: true, providerStatus: "PENDING PICKUP" };
      },
      async payUnpaid() {},
      async track() {
        return { trackingNumber: null, providerStatus: "PENDING PICKUP", paid: null, history: [] };
      },
    } satisfies BookingAdapter);
    await transitionOrder(owner, codId, "confirm");
    process.env.ALLOW_COD_BOOKING = "1";
    await bookShipment(owner, codId);
    const second = await runOnce(platform, { workerId: "contract" });
    expect(second.filter((o) => o.status !== "done")).toEqual([]);
    expect(second.map((o) => o.kind)).toEqual(expect.arrayContaining(["shipment.book"]));
    const [shipped] = await admin.select({ status: order.status }).from(order).where(eq(order.id, codId));
    expect(shipped!.status).toBe("shipped");
    expect((await admin.select({ status: shipment.status }).from(shipment))[0]!.status).toBe("booked");
    delete process.env.ALLOW_COD_BOOKING;

    // Cleanup, signal-context purge and buyer-data retention (platform pool), over backdated rows.
    await admin.execute(sql`update cart set created_at = now() - interval '30 days' where id not in (select cart_id from "order")`);
    await admin.execute(sql`update rate_limit set window_start = now() - interval '3 days'`);
    await admin.execute(sql`insert into order_signal_context (store_id, order_id, fbp, created_at) values (${storeId}, ${transferId}, 'fb.1.1.1', now() - interval '60 days')`);
    await admin.execute(sql`update "order" set status = 'cancelled', updated_at = now() - interval '60 days' where id = ${transferId}`);
    expect((await cleanupIdleCarts(platform, { idleHours: 24 })).carts).toBeGreaterThanOrEqual(1);
    expect((await purgeSignalContext(platform)).contexts).toBeGreaterThanOrEqual(1);
    expect((await redactStaleOrders(platform, { days: 30 })).orders).toBe(1);
    expect(await withStore(app, storeId, (tx) => tx.select({ id: order.id }).from(order))).toHaveLength(2); // rows are redacted, never deleted

    // IAM-9 revocation and the store-less audit write of the auth adapter (platform pool).
    const orphan = randomUUID();
    await admin.insert(user).values({ id: orphan, name: "orphan", email: `orphan-${orphan.slice(0, 6)}@test.local` });
    await admin.insert(session).values({ id: randomUUID(), userId: orphan, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
    expect(await revokeSessionsIfOrphaned(platform, orphan)).toBe(1);
    await platform.execute(sql`insert into audit_log (actor_user_id, store_id, action) values (${orphan}, null, 'password.reset')`);

    // Review finding: the Owner store detail counts collection/page/media on the platform pool; a missing grant broke it silently.
    expect((await getStoreDetail(op, storeId))?.counts).toMatchObject({ products: 1, collections: 0, pages: 0, images: 0 });

    // IAM-15 on the platform pool: a sensitive-grant approval (second operator decides), a plain grant, then the scheduler and retention.
    const second2 = randomUUID();
    await admin.insert(user).values({ id: second2, name: "second", email: `second-${second2.slice(0, 6)}@test.local` });
    await admin.insert(platformOperator).values({ userId: second2 });
    await admin.insert(operatorGrant).values({ userId: second2, capability: "staff.manage" });
    const other = (await operatorScope(platform, second2))!;
    const { id: approvalId } = await requestApproval(op, { actionKey: "grant.sensitive", targetKind: "operator", targetId: second2, payload: { userId: second2, capability: "logs.read" }, reason: "contract probe approval" });
    await decideApproval(other, approvalId, "approve");
    await grantCapability(op, { userId: second2, capability: "logs.read", reason: "contract probe grant" });
    const tick = await schedulerTick(platform, { now: new Date(), tickIntervalMs: 30_000 });
    expect(tick.enqueued).toBeDefined();
    expect((await schedulerHealth(platform, { now: new Date() })).state).toBe("ok");
    await setRetentionPeriod(op, { dataClass: "system_log", days: 3650, reason: "contract probe" });
    expect(await purgeClass(platform, "system_log")).toBe(0); // nothing is ten years old
  }, 60_000);

  it("T-62 console paths: access evidence through the restricted table's functions, issue reports, approvals inbox and job health on the narrowed platform role", async () => {
    const id = randomUUID();
    await admin.insert(user).values({ id, name: "console", email: `console-${id.slice(0, 6)}@test.local` });
    await admin.insert(platformOperator).values({ userId: id });
    const caps: PlatformCapability[] = ["ops.issues.report", "ops.issues.manage", "ops.read", "audit.read", "accounts.reveal", "dashboard.read", "settings.manage", "providers.read", "payouts.process"];
    await admin.insert(operatorGrant).values(caps.map((capability) => ({ userId: id, capability })));
    const op = (await operatorScope(platform, id))!;
    // The restricted table is closed to both login roles; the function is the only way in and out.
    await expect(platform.execute(sql`select * from personal_data_access_event`)).rejects.toMatchObject({ cause: { code: "42501" } });
    await withPersonalDataAccess(op, { capability: "accounts.reveal", targetKind: "account", targetId: "a1", fieldClass: "phone", purposeCode: "support_case", caseId: "CASE-1", reason: "contract probe", accessLevel: "full", expiresAt: new Date(Date.now() + 60_000) }, async () => "value");
    expect((await platform.execute(sql`select count(*)::int as n from console_access_events(10, null)`))[0]).toEqual({ n: 2 }); // the store-detail read of the scenario above (T-63, masked) and this reveal
    const report = await reportConsoleIssue(op, { schemaVersion: 1, clientRequestId: randomUUID(), pathname: "/admin/logs", category: "other", severity: "low", description: "contract probe report" });
    expect((await consoleIssues(op, { id: report.id })).items).toHaveLength(1);
    expect(await approvalInbox(op)).toEqual([]);
    expect((await consoleJobHealth(op)).scheduler).toBeDefined();
    expect((await consoleDashboard(op)).asOf).toBeInstanceOf(Date);
  }, 60_000);

  it("T-50 billing paths: the store insert bootstraps the subscription, the cycle, Owner console and settlement run on the narrowed platform role, seller Pay and the callback on the app role", async () => {
    const id = randomUUID();
    const ownerId = randomUUID();
    await admin.insert(user).values([
      { id, name: "billing", email: `billing-${id.slice(0, 6)}@test.local` },
      { id: ownerId, name: "owner", email: `owner-${ownerId.slice(0, 6)}@test.local` },
    ]);
    await admin.insert(platformOperator).values({ userId: id });
    const caps: PlatformCapability[] = ["tenants.manage", "billing.read", "billing.manage"];
    await admin.insert(operatorGrant).values(caps.map((capability) => ({ userId: id, capability })));
    const op = (await operatorScope(platform, id))!;
    const storeId = await createStore(op, { slug: "toko-bill", name: "Toko Bill", ownerUserId: ownerId });
    expect((await billingOverview(op)).rows.map((r) => [r.storeId, r.derivedState])).toContainEqual([storeId, "trial"]); // the trigger created the subscription
    expect((await runBillingCycle(platform)).errors).toEqual([]);
    await setBillingControls(op, { dunningEnabled: false, reason: "contract probe" });
    const created = await createInvoiceAsOperator(op, { storeId, reason: "contract probe" });
    expect(created.kind === "invoice" && created.created).toBe(false); // the cycle's invoice, returned
    // seller Pay on the app pool, then the worker settles on the platform pool through the verify-by-pull path
    const ctx = await sellerContext(app, ownerId, storeId);
    if (!ctx.ok) throw new Error("no seller context");
    const fake = new FakeAutoLaris();
    const paid = await paySubscription(ctx.scope, { channel: "VABCA" }, { ...fakeProviders, payment: fake });
    await withStore(platform, storeId, async (tx) => {
      const [a] = await tx.execute(sql`select * from subscription_payment_attempt where id = ${paid.attempt.id}`);
      expect(a).toBeDefined();
    });
    const { setPaymentAdapter } = await import("../src/payments/jobs.ts");
    setPaymentAdapter(fake);
    try {
      for (let i = 0; i < 3; i++) await runOnce(platform, { workerId: "contract-50", providers: { ...fakeProviders, payment: fake } });
    } finally {
      setPaymentAdapter(null);
    }
    const [accepted] = await withStore(platform, storeId, (tx) => tx.execute(sql`select reff_id, transaction_id, total_idr from subscription_payment_attempt where id = ${paid.attempt.id}`));
    fake.adviceResults.set(String(accepted!.transaction_id), { rc: "00", data: { status: "PAID", amount: Number(accepted!.total_idr) } });
    const cb = await acceptAutoLarisCallback(app, { token: callbackToken(String(accepted!.reff_id)), rawBody: JSON.stringify({ reff_id: accepted!.reff_id, amount: Number(accepted!.total_idr) }) });
    expect(cb.outcome).toBe("accepted");
    const settled = await recordSubscriptionInquiry({ exec: platform, storeId }, paid.attempt.id, fake.adviceResults.get(String(accepted!.transaction_id)), { source: "callback", mode: "fake" });
    expect(settled.coverageApplied).toBe(true);
    expect((await billingOverview(op)).rows.find((r) => r.storeId === storeId)!.derivedState).toBe("active");
  }, 60_000);
});

describe("contract step: T-63 account governance paths on the narrowed platform role", () => {
  it("cases, store and identity lifecycle, support actions (sessions, recovery mail, MFA reset, suspension), reveal, break-glass, staff deactivation, risk queue and the app-role redemption", async () => {
    const mk = async (name: string, caps: PlatformCapability[] = []) => {
      const id = randomUUID();
      await admin.insert(user).values({ id, name, email: `${name}-${id.slice(0, 6)}@test.local`, emailVerified: true });
      if (caps.length) {
        await admin.insert(platformOperator).values({ userId: id });
        await admin.insert(operatorGrant).values(caps.map((capability) => ({ userId: id, capability })));
      }
      return id;
    };
    const all: PlatformCapability[] = ["cases.read", "cases.write", "accounts.read", "accounts.support", "accounts.suspend", "accounts.reveal", "tenants.read", "tenants.manage", "tenants.verify", "audit.read", "staff.manage", "break_glass.approve"];
    const a = (await operatorScope(platform, await mk("t63a", all)))!;
    const b = (await operatorScope(platform, await mk("t63b", ["break_glass.approve", "staff.manage", "accounts.support"])))!;
    const target = await mk("t63target");
    const staffTarget = await mk("t63staff", ["tenants.read"]);
    const storeId = await createStore(a, { slug: "toko-t63", name: "Toko T63", ownerUserId: target });
    await admin.insert(session).values({ id: randomUUID(), userId: target, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });

    const c = await openCase(a, { subjectKind: "user", subjectId: target, title: "uji kontrak", reason: "uji jalur platform" });
    await addCaseNote(a, c.id, "catatan uji");
    await moveCase(a, c.id, { from: "open", to: "in_progress", reason: "dikerjakan" });
    await setStoreStatus(a, storeId, { status: "suspended", reason: "uji kontrak" });
    await setStoreStatus(a, storeId, { status: "active", reason: "uji kontrak" });
    await submitVerification(a, storeId, { kind: "identity", verifiedName: "Uji Kontrak", reason: "uji kontrak" });
    expect((await riskQueue(a)).unavailableRules.length).toBeGreaterThan(0);
    expect((await searchAccounts(a, { query: target })).hits).toHaveLength(1);

    const key = () => `contract-${randomUUID()}`;
    const base = { caseRef: c.id, reasonCode: "contract_probe", reason: "uji jalur platform" };
    expect((await startSupportRecovery(a, target, { ...base, idempotencyKey: key() })).outcome).toBe("recovery_link_queued"); // mail_enqueue + link insert on the platform role
    const [mail] = (await admin.execute(sql`select text_body from mail_outbox where one_time_purpose = 'support_recovery'`)) as unknown as { text_body: string }[];
    const token = /support-recovery\/([A-Za-z0-9_-]+)/.exec(mail!.text_body)![1]!;
    expect(await redeemSupportRecovery(app, token)).toBe(target); // the app role's only path
    expect(await redeemSupportRecovery(app, token)).toBeNull();
    expect((await revokeUserSessions(a, target, { ...base, idempotencyKey: key() })).count).toBe(1);
    await admin.insert(session).values({ id: randomUUID(), userId: target, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
    expect((await setIdentitySuspension(a, target, { ...base, suspend: true, idempotencyKey: key() })).outcome).toBe("identity_suspended");
    expect(await sellerContext(app, target)).toEqual({ ok: false, reason: "identity_suspended" });
    await setIdentitySuspension(a, target, { ...base, suspend: false, idempotencyKey: key() });
    expect((await requestMfaReset(a, target, { ...base, idempotencyKey: key() })).outcome).toBe("mfa_reset_awaiting_approval"); // the target owns a store: four-eyes

    // Reveal with evidence on the restricted table, then a break-glass elevation approved by the second holder.
    expect((await revealAccountField(a, "seller", target, { field: "email", purposeCode: "support_case", caseRef: c.id, reason: "uji jalur platform" })).value).toContain("@test.local");
    const asked = await requestBreakGlass(b, { userId: target, caseRef: c.id, capabilities: ["accounts.reveal"], durationSeconds: 60, reason: "uji jalur platform" });
    await decideApproval(a, asked.approvalId, "approve");
    expect((await activateBreakGlass(b, asked.approvalId)).grantId).toBeGreaterThan(0);

    // Staff deactivation: grants, requests, sessions and the operator row in one transaction.
    expect((await deactivateStaff(a, staffTarget, { reasonCode: "contract_probe", reason: "uji jalur platform" })).revokedGrants).toBe(1);
    expect(await operatorScope(platform, staffTarget)).toBeNull();
  }, 90_000);
});
