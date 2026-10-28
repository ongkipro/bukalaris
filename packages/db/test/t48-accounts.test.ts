import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registeredKinds } from "../src/ops/jobs/jobs.ts";
import "../src/shipping/jobs.ts"; // the worker's registrations (a module that needs the services alone never adds schedules)
import { resealShippingCredentials, selectShippingAccount, sellerShippingAccounts, setPartnerTransport, shippingAccountHealth, provisionShippingAccount, queueShippingAccountRecovery, sweepPendingAccounts, syncShippingAccounts } from "../src/shipping/accounts.ts";
import { sealShippingKey, shippingKeyring, unsealShippingKey } from "../src/shipping/credentials.ts";
import { MengantarClient, MengantarError } from "../src/shipping/mengantar/client.ts";
import { mengantarRotationRecorded, MengantarEntryGateError } from "../src/shipping/mengantar/gate.ts";
import { FakePartnerTransport, PartnerClient, PartnerError, PARTNER_MAX_PAGES, PARTNER_REGISTRATIONS_PER_DAY, PARTNER_REQUESTS_PER_MINUTE, signPartnerBody, takePartnerBudget, type PartnerRequest, type PartnerTransport } from "../src/shipping/mengantar/partner.ts";
import { storeShippingAccount } from "../src/shipping/schema-accounts.ts";
import { withStore } from "../src/platform/tenant.ts";
import { admin, db, makeOperator, makeStore, openMengantarGate, platform } from "./helpers.ts";
import { accountsOf, fakeTransport, KNOWN_SECRET_CANARY } from "./t48-fixtures.ts";

// T-48: Partner Mengantar accounts against the FAKE transport. No request leaves the process: the fake has no fetch, and every real client case below
// uses a stub `fetch` that counts calls. Credentials are canaries so a leak into any DTO, row, log or error is a failing assertion.

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code);
const ENV_KEYS = ["MENGANTAR_PARTNER_SECRET_ROTATED_AT", "MENGANTAR_PARTNER_OLD_SECRET_REVOKED", "KEYRING_SHIPPING_CREDENTIALS", "INTEGRATION_TOKEN_KEY"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  vi.restoreAllMocks();
});
const partnerRows = async (storeId: number) => (await accountsOf(storeId)).filter((a) => a.kind === "partner_managed");
const registrationsOf = (t: FakePartnerTransport) => t.calls.filter((c) => c.path === "/api/partner/v1/sellers");

describe("provisioning: one Bukalaris-generated account per store, idempotent, sealed", () => {
  it("every store gets a master and a pending partner binding named store:<id>; provisioning registers through the Partner API with a per-store routing e-mail and seals the key", async () => {
    const s = await makeStore("toko-a");
    expect((await accountsOf(s.storeId)).map((a) => [a.kind, a.status, a.externalUserId])).toEqual([["platform_master", "active", `store:${s.storeId}`], ["partner_managed", "pending", `store:${s.storeId}`]]);
    const { transport, client } = fakeTransport();
    transport.fixedApiKey = KNOWN_SECRET_CANARY;
    expect(await provisionShippingAccount(platform, s.storeId, client())).toMatchObject({ outcome: "active" });
    const [p] = await partnerRows(s.storeId);
    expect(p).toMatchObject({ status: "active", mengantarSellerId: `fake-store:${s.storeId}`, keyId: "testship", lastResult: "ready", registeredEmail: `store-${s.storeId}@shipping.bukalaris.invalid` });
    expect(registrationsOf(transport)).toEqual([{ path: "/api/partner/v1/sellers", externalUserId: `store:${s.storeId}`, email: `store-${s.storeId}@shipping.bukalaris.invalid` }]);
    expect(p!.sealedKey).not.toContain(KNOWN_SECRET_CANARY);
    expect(p!.sealedKey!.split(".")).toHaveLength(3);
    expect(unsealShippingKey(p!.sealedKey!, p!.keyId!, s.storeId, p!.id)).toBe(KNOWN_SECRET_CANARY); // the worker primitive, test-only
    expect(await provisionShippingAccount(platform, s.storeId, client())).toMatchObject({ outcome: "active" }); // replay: nothing more is created
    expect(registrationsOf(transport)).toHaveLength(1);
  });

  it("concurrent provisioning of one store yields ONE provider registration and ONE account row (claim lease + unique index)", async () => {
    const s = await makeStore("toko-a");
    const { transport, client } = fakeTransport();
    const results = await Promise.all(Array.from({ length: 8 }, () => provisionShippingAccount(platform, s.storeId, client())));
    expect(registrationsOf(transport)).toHaveLength(1);
    expect(results.some((r) => r.outcome === "active")).toBe(true);
    expect(results.filter((r) => r.outcome === "busy" || r.outcome === "active")).toHaveLength(8);
    expect(await partnerRows(s.storeId)).toHaveLength(1);
    // The database itself refuses a second partner binding for the store, and a kind that is not one of the two (no own_key).
    await expect(code(admin.execute(sql`insert into store_shipping_account (store_id, kind, external_user_id) values (${s.storeId}, 'partner_managed', ${`store:${s.storeId}`})`))).resolves.toBe("23505");
    await expect(code(admin.execute(sql`insert into store_shipping_account (store_id, kind, external_user_id) values (${s.storeId}, 'own_key', ${`store:${s.storeId}`})`))).resolves.toBe("23514");
  });

  it("409 EMAIL_ALREADY_REGISTERED retries with a fresh e-mail; three conflicts leave the store on the master account with no key and a code-only result", async () => {
    const s = await makeStore("toko-a");
    const { transport, client } = fakeTransport();
    transport.conflictNext = 1;
    expect(await provisionShippingAccount(platform, s.storeId, client())).toMatchObject({ outcome: "active" });
    const emails = registrationsOf(transport).map((c) => c.email);
    expect(emails).toHaveLength(2);
    expect(emails[0]).toBe(`store-${s.storeId}@shipping.bukalaris.invalid`);
    expect(emails[1]).toMatch(new RegExp(`^store-${s.storeId}-[0-9a-f]{16}@shipping\\.bukalaris\\.invalid$`));

    const t = await makeStore("toko-b");
    const failing = fakeTransport();
    failing.transport.conflictNext = 3;
    await expect(provisionShippingAccount(platform, t.storeId, failing.client())).rejects.toMatchObject({ code: "EMAIL_ALREADY_REGISTERED" });
    expect(registrationsOf(failing.transport)).toHaveLength(3);
    const [p] = await partnerRows(t.storeId);
    expect(p).toMatchObject({ status: "pending", sealedKey: null, keyId: null, lastResult: "EMAIL_ALREADY_REGISTERED" });
    const picked = await selectShippingAccount({ exec: db, storeId: t.storeId });
    expect(picked.kind).toBe("platform_master"); // fallback for NEW orders only; existing snapshots never move
  });

  it("a missing, malformed or reused key ring fails before the provider creates anything", async () => {
    const s = await makeStore("toko-a");
    const { transport, client } = fakeTransport();
    for (const bad of [undefined, "", "nocolon", "k:AAAA", `k:${Buffer.alloc(32, 1).toString("base64")},k:${Buffer.alloc(32, 2).toString("base64")}`]) {
      if (bad === undefined) delete process.env.KEYRING_SHIPPING_CREDENTIALS;
      else process.env.KEYRING_SHIPPING_CREDENTIALS = bad;
      await expect(provisionShippingAccount(platform, s.storeId, client())).rejects.toThrow("shipping_key_unavailable");
    }
    process.env.INTEGRATION_TOKEN_KEY = Buffer.alloc(32, 9).toString("base64");
    process.env.KEYRING_SHIPPING_CREDENTIALS = `reused:${Buffer.alloc(32, 9).toString("base64")}`;
    expect(() => shippingKeyring()).toThrow("shipping_key_purpose_reused");
    expect(transport.calls).toEqual([]);
    expect((await partnerRows(s.storeId))[0]!.status).toBe("pending");
  });
});

describe("credentials never leave the sealed column (canary tests)", () => {
  it("the canary key appears in no table, no DTO, no log line and no error, and the app role cannot read the sealed column", async () => {
    const s = await makeStore("toko-a");
    const op = await makeOperator(["shipping.manage"]);
    const { transport, client } = fakeTransport();
    transport.fixedApiKey = KNOWN_SECRET_CANARY;
    const logs: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    await provisionShippingAccount(platform, s.storeId, client());
    // A transport failure whose message carries the key (a keyed URL in a network error) is reduced to a code.
    const t = await makeStore("toko-b");
    const failing = fakeTransport();
    failing.transport.failNextWith = `connect ECONNREFUSED https://x.invalid/api/public/${KNOWN_SECRET_CANARY}/address`;
    const err = await provisionShippingAccount(platform, t.storeId, failing.client()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartnerError);
    expect(`${String(err)} ${JSON.stringify(err)} ${(err as Error).stack}`).not.toContain(KNOWN_SECRET_CANARY);
    expect((await partnerRows(t.storeId))[0]!.lastResult).toBe("PROVIDER_UNAVAILABLE");

    const tables = (await admin.execute(sql`select tablename from pg_tables where schemaname = 'public'`)) as unknown as { tablename: string }[];
    for (const { tablename } of tables) {
      const rows = (await admin.execute(sql.raw(`select count(*)::int as n from "${tablename}" x where x::text like '%${KNOWN_SECRET_CANARY}%'`))) as unknown as { n: number }[];
      expect({ tablename, n: rows[0]!.n }).toEqual({ tablename, n: 0 });
    }
    const owner = await sellerShippingAccounts(s.owner);
    const health = await shippingAccountHealth(op);
    const dtos = JSON.stringify([owner, health, await selectShippingAccount({ exec: db, storeId: s.storeId })]);
    expect(dtos).not.toContain(KNOWN_SECRET_CANARY);
    const allowed = ["id", "kind", "lastCheckedAt", "lastResult", "revision", "status", "storeId"];
    for (const a of owner.accounts) expect(Object.keys(a).sort()).toEqual(allowed);
    // The operator-only health view adds exactly two non-secret retry counters (T-48 fix 8); every sealed or identity column stays out.
    for (const a of health.accounts) expect(Object.keys(a).sort()).toEqual([...allowed, "autoRetryStopped", "registrationAttempts"].sort());
    expect(JSON.stringify(transport.calls)).not.toContain(KNOWN_SECRET_CANARY);
    expect(logs.join("\n")).not.toContain(KNOWN_SECRET_CANARY);

    const p = (await partnerRows(s.storeId))[0]!;
    for (const column of ["sealed_key", "key_id", "registered_email", "mengantar_seller_id"]) {
      expect(await code(withStore(db, s.storeId, (tx) => tx.execute(sql.raw(`select ${column} from store_shipping_account`))))).toBe("42501");
    }
    expect(await code(withStore(db, s.storeId, (tx) => tx.execute(sql`select * from store_shipping_account`)))).toBe("42501");
    expect(await code(withStore(db, s.storeId, (tx) => tx.execute(sql`update store_shipping_account set status = 'active' where id = ${p.id}`)))).toBe("42501");
    expect(await code(withStore(db, s.storeId, (tx) => tx.execute(sql`insert into store_shipping_account (store_id, kind, external_user_id, sealed_key) values (${s.storeId}, 'partner_managed', ${`store:${s.storeId}`}, 'pasted-own-key')`)))).toBe("42501");
  });

  it("the envelope is bound to its store and account and authenticated: another account, a tampered byte or a wrong key id cannot open it", async () => {
    const sealed = sealShippingKey(KNOWN_SECRET_CANARY, 7, 11);
    expect(unsealShippingKey(sealed.sealedKey, sealed.keyId, 7, 11)).toBe(KNOWN_SECRET_CANARY);
    expect(() => unsealShippingKey(sealed.sealedKey, sealed.keyId, 7, 12)).toThrow("shipping_envelope_invalid");
    expect(() => unsealShippingKey(sealed.sealedKey, sealed.keyId, 8, 11)).toThrow("shipping_envelope_invalid");
    const [iv, body, tag] = sealed.sealedKey.split(".");
    const flipped = Buffer.from(body!, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(() => unsealShippingKey([iv, flipped.toString("base64"), tag].join("."), sealed.keyId, 7, 11)).toThrow("shipping_envelope_invalid");
    expect(() => unsealShippingKey(sealed.sealedKey, "nope", 7, 11)).toThrow("shipping_key_unavailable");
    expect(sealed.sealedKey).not.toContain(KNOWN_SECRET_CANARY);
  });

  it("the re-seal job moves every envelope to the leading key one row at a time, keeps the AAD and is idempotent; the old key can then be retired", async () => {
    const s = await makeStore("toko-a");
    const { client } = fakeTransport();
    await provisionShippingAccount(platform, s.storeId, client());
    const before = (await partnerRows(s.storeId))[0]!;
    const old = process.env.KEYRING_SHIPPING_CREDENTIALS!;
    const next = `rotated:${Buffer.alloc(32, 7).toString("base64")}`;
    process.env.KEYRING_SHIPPING_CREDENTIALS = `${next},${old}`;
    expect(await resealShippingCredentials(platform)).toEqual({ changed: 1 });
    const after = (await partnerRows(s.storeId))[0]!;
    expect(after.keyId).toBe("rotated");
    expect(after.sealedKey).not.toBe(before.sealedKey);
    expect(await resealShippingCredentials(platform)).toEqual({ changed: 0 });
    process.env.KEYRING_SHIPPING_CREDENTIALS = next; // old key retired once no envelope carries it
    expect(unsealShippingKey(after.sealedKey!, after.keyId!, s.storeId, after.id)).toMatch(/^fake-/);
    expect(registeredKinds()).toContain("shipping.credentials.reseal");
  });
});

describe("entry gate: while the Partner Secret rotation is unrecorded NO real provider call of any kind is possible", () => {
  const stubFetch = () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    return f;
  };
  const allMethods = (c: MengantarClient) => [
    () => c.searchArea("bandung"), () => c.listOrigins(), () => c.estimateAll({ originAreaId: "a", destinationAreaId: "b", weightKg: 1 }), () => c.estimate3pl({ originAreaId: "a", destinationAreaId: "b", weightKg: 1 }),
    () => c.getReceiverScore("0812"), () => c.getOrder({ providerOrderId: "x" }), () => c.createOrder({ courier: "JNE", pickup: {}, orders: [] }), () => c.upsertOrigin({}),
    () => c.deleteAddress("x"), () => c.addPickupTime({ address_id: "x", date: "01-01-2027", time: "9:00" }), () => c.payUnpaid("b"), () => c.addDropshipper({ name: "n", phone: "0" }),
    () => c.deleteOrders(["x"]), () => c.deleteBatch("x"),
  ];

  it("the gate opens only for a past UTC timestamp AND the revocation confirmation; every other value keeps it shut", () => {
    const now = Date.parse("2026-10-28T00:00:00Z");
    const ok = { MENGANTAR_PARTNER_SECRET_ROTATED_AT: "2026-10-27T00:00:00Z", MENGANTAR_PARTNER_OLD_SECRET_REVOKED: "1" };
    expect(mengantarRotationRecorded(ok, now)).toBe(true);
    for (const bad of [{}, { ...ok, MENGANTAR_PARTNER_OLD_SECRET_REVOKED: undefined }, { ...ok, MENGANTAR_PARTNER_OLD_SECRET_REVOKED: "true" }, { MENGANTAR_PARTNER_OLD_SECRET_REVOKED: "1" }, { ...ok, MENGANTAR_PARTNER_SECRET_ROTATED_AT: "yes" }, { ...ok, MENGANTAR_PARTNER_SECRET_ROTATED_AT: "2026-10-27" }, { ...ok, MENGANTAR_PARTNER_SECRET_ROTATED_AT: "2026-10-27T00:00:00+07:00" }, { ...ok, MENGANTAR_PARTNER_SECRET_ROTATED_AT: "2030-01-01T00:00:00Z" }, { ...ok, MENGANTAR_PARTNER_SECRET_ROTATED_AT: "" }]) {
      expect(mengantarRotationRecorded(bad as NodeJS.ProcessEnv, now)).toBe(false);
    }
  });

  it("unrecorded: every method of the keyed client (reads, 3PL, sandbox-style reads and every write) is refused before fetch; the live partner client sends nothing and spends no budget", async () => {
    delete process.env.MENGANTAR_PARTNER_SECRET_ROTATED_AT;
    const f = stubFetch();
    const c = new MengantarClient({ apiKey: "k-0123456789abcdef", fetchImpl: f as unknown as typeof fetch, writeEnabled: true });
    for (const call of allMethods(c)) await expect(call()).rejects.toMatchObject({ code: "entry_gate" });
    expect(f).not.toHaveBeenCalled();
    let sends = 0;
    const live: PartnerTransport = { mode: "live", async send() { sends++; return { status: 200, body: {} }; } };
    const partner = new PartnerClient(platform, live);
    await expect(partner.register("store:1", "a@b.invalid")).rejects.toBeInstanceOf(MengantarEntryGateError);
    await expect(partner.currentKey("x")).rejects.toBeInstanceOf(MengantarEntryGateError);
    await expect(partner.list(1)).rejects.toBeInstanceOf(MengantarEntryGateError);
    expect(sends).toBe(0);
    expect(((await admin.execute(sql`select count(*)::int as n from shipping_partner_budget`)) as unknown as { n: number }[])[0]!.n).toBe(0);
    // The fake adapter is unaffected by the gate.
    const s = await makeStore("toko-a");
    const { client } = fakeTransport();
    expect(await provisionShippingAccount(platform, s.storeId, client())).toMatchObject({ outcome: "active" });
    // The real worker handler path cannot sneak a live transport in: it uses the fake unless a test installs another fake.
    const err = await new MengantarClient({ apiKey: "k-0123456789abcdef", fetchImpl: f as unknown as typeof fetch }).searchArea("bandung").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MengantarError);
    expect(String((err as Error).message)).not.toContain("k-0123456789abcdef");
  });

  it("a recorded rotation lets a stubbed client call through (positive control)", async () => {
    openMengantarGate();
    const f = vi.fn(async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const c = new MengantarClient({ apiKey: "k-0123456789abcdef", fetchImpl: f as unknown as typeof fetch });
    await c.searchArea("bandung");
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("Partner client: signed exact body, shared budget, Retry-After", () => {
  beforeEach(openMengantarGate); // stub transports: no provider is contacted
  const capture = () => {
    const sent: PartnerRequest[] = [];
    const transport: PartnerTransport = { mode: "fake", async send(r) { sent.push(r); return { status: 200, body: { sellers: [], hasMore: false } }; } };
    return { sent, transport };
  };

  it("signs sha256(METHOD:PATH:TYPE:BODY:TIMESTAMP:SECRET) over the exact serialized bytes that are sent, with a fresh unix-seconds timestamp", async () => {
    const { sent, transport } = capture();
    const secret = "test-only-partner-secret";
    await new PartnerClient(platform, transport, { partnerId: "p-1", partnerSecret: secret }).list(1);
    const r = sent[0]!;
    expect(r.path).toBe("/api/partner/v1/sellers/list");
    expect(r.body).toBe(JSON.stringify({ page: 1, limit: 50 }));
    expect(r.headers["partner-id"]).toBe("p-1");
    expect(r.headers.timestamp).toMatch(/^\d{10}$/);
    expect(Math.abs(Date.now() / 1000 - Number(r.headers.timestamp))).toBeLessThanOrEqual(5);
    expect(r.headers.signature).toBe(createHash("sha256").update(`POST:${r.path}:${r.type}:${r.body}:${r.headers.timestamp}:${secret}`).digest("hex"));
    expect(r.headers.signature).toBe(signPartnerBody(r.path, r.type, r.body, r.headers.timestamp, secret));
    expect(signPartnerBody(r.path, r.type, r.body + " ", r.headers.timestamp, secret)).not.toBe(r.headers.signature); // the body is bound
    expect(JSON.stringify(r)).not.toContain(secret); // the secret is never in the request
  });

  it("the shared database bucket allows 60 requests a minute across clients and refills with elapsed seconds; 1000 registrations a day, then reads still work", async () => {
    for (let i = 0; i < PARTNER_REQUESTS_PER_MINUTE; i++) await takePartnerBudget(platform, false);
    await admin.execute(sql`update shipping_partner_budget set refilled_at = now() + interval '1 minute'`); // no refill sneaks in on a slow machine (a future instant, so even a one-second stall between the two statements cannot return a token)
    await expect(takePartnerBudget(platform, false)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await admin.execute(sql`update shipping_partner_budget set refilled_at = now() - interval '5 seconds'`);
    await takePartnerBudget(platform, false); // five tokens came back
    await admin.execute(sql`update shipping_partner_budget set tokens = 60, registrations = ${PARTNER_REGISTRATIONS_PER_DAY}`);
    await expect(takePartnerBudget(platform, true)).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSec: 86_400 });
    await takePartnerBudget(platform, false); // a read is not a registration
    await admin.execute(sql`update shipping_partner_budget set day_start = day_start - interval '1 day'`);
    await takePartnerBudget(platform, true); // a new Jakarta day resets the registration count
    expect(((await admin.execute(sql`select registrations::int as n from shipping_partner_budget`)) as unknown as { n: number }[])[0]!.n).toBe(1);
    expect(await code(admin.execute(sql`update shipping_partner_budget set tokens = 61`))).toBe("23514");
  });

  it("a 429 stores the provider's Retry-After (seconds or an HTTP date) for every worker and nothing is sent until it passes", async () => {
    const { transport, client } = fakeTransport();
    transport.rateLimitNext = "120";
    await expect(client().list(1)).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSec: 120 });
    const sentBefore = transport.calls.length;
    await expect(client().list(1)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(transport.calls.length).toBe(sentBefore); // blocked in the database, not at the provider
    await admin.execute(sql`update shipping_partner_budget set blocked_until = now() - interval '1 second'`);
    await expect(client().list(1)).resolves.toMatchObject({ hasMore: false });
    transport.rateLimitNext = new Date(Date.now() + 90_000).toUTCString();
    const e = await client().list(1).catch((x: PartnerError) => x);
    expect((e as PartnerError).retryAfterSec).toBeGreaterThan(80);
    expect((e as PartnerError).retryAfterSec).toBeLessThanOrEqual(91);
  });
});

describe("key lifecycle, disablement and JOB-08 reconciliation", () => {
  it("key recovery fetches the CURRENT key through api-key and never re-registers; the new envelope replaces the old", async () => {
    const s = await makeStore("toko-a");
    const op = await makeOperator(["shipping.manage"]);
    const { transport, client } = fakeTransport();
    await provisionShippingAccount(platform, s.storeId, client());
    const before = (await partnerRows(s.storeId))[0]!;
    await queueShippingAccountRecovery(op, { accountId: before.id, revision: before.revision, reason: "kunci perlu dipulihkan" });
    expect((await partnerRows(s.storeId))[0]).toMatchObject({ status: "needs_key" });
    expect(await code(queueShippingAccountRecovery(op, { accountId: before.id, revision: before.revision, reason: "revisi lama" }))).toBe("conflict");
    expect(await provisionShippingAccount(platform, s.storeId, client())).toMatchObject({ outcome: "active" });
    expect(transport.calls.map((c) => c.path)).toEqual(["/api/partner/v1/sellers", "/api/partner/v1/sellers/api-key"]);
    const after = (await partnerRows(s.storeId))[0]!;
    expect(after.status).toBe("active");
    expect(after.sealedKey).not.toBe(before.sealedKey);
    expect(await code(queueShippingAccountRecovery(await makeOperator(["tenants.read"]), { accountId: after.id, revision: after.revision, reason: "tanpa izin" }))).toBe("forbidden");
  });

  it("SELLER_DEACTIVATED / API_KEY_DISABLED disable the account for good: no retry, no further provider call, no recovery, and the database refuses re-activation", async () => {
    const s = await makeStore("toko-a");
    const op = await makeOperator(["shipping.manage"]);
    const { transport, client } = fakeTransport();
    await provisionShippingAccount(platform, s.storeId, client());
    const p = (await partnerRows(s.storeId))[0]!;
    transport.sellers.get(`store:${s.storeId}`)!.active = false;
    await queueShippingAccountRecovery(op, { accountId: p.id, revision: p.revision, reason: "kunci ditolak penyedia" });
    expect(await provisionShippingAccount(platform, s.storeId, client())).toMatchObject({ outcome: "disabled" });
    const calls = transport.calls.length;
    expect(await provisionShippingAccount(platform, s.storeId, client())).toMatchObject({ outcome: "disabled" });
    expect(transport.calls.length).toBe(calls);
    const disabled = (await partnerRows(s.storeId))[0]!;
    expect(disabled).toMatchObject({ status: "disabled", lastResult: "SELLER_DEACTIVATED" });
    expect(await code(queueShippingAccountRecovery(op, { accountId: disabled.id, revision: disabled.revision, reason: "coba lagi" }))).toBe("account_disabled");
    expect(await code(Promise.resolve(platform.update(storeShippingAccount).set({ status: "active" }).where(eq(storeShippingAccount.id, disabled.id))))).toBe("23514");
    expect((await selectShippingAccount({ exec: db, storeId: s.storeId })).kind).toBe("platform_master");
  });

  it("JOB-08 reconciliation is bounded, matches store AND seller id, and a foreign or mismatched remote seller never disables a binding", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const { transport, client } = fakeTransport();
    await provisionShippingAccount(platform, a.storeId, client());
    await provisionShippingAccount(platform, b.storeId, client());
    transport.sellers.get(`store:${a.storeId}`)!.active = false;
    transport.sellers.get(`store:${b.storeId}`)!.sellerId = "someone-else"; // the remote id no longer matches what we hold for store b
    transport.sellers.get(`store:${b.storeId}`)!.active = false;
    transport.sellers.set("store:999999", { sellerId: "fake-store:999999", apiKey: "x", email: "x@y.invalid", active: false });
    expect(await syncShippingAccounts(platform, client())).toMatchObject({ checked: 1 });
    expect((await partnerRows(a.storeId))[0]!.status).toBe("disabled");
    expect((await partnerRows(b.storeId))[0]!.status).toBe("active");
    for (let i = 0; i < 300; i++) transport.sellers.set(`store:${1_000_000 + i}`, { sellerId: `f${i}`, apiKey: "x", email: "x@y.invalid", active: true });
    const before = transport.calls.filter((c) => c.path.endsWith("/list")).length;
    await syncShippingAccounts(platform, client());
    expect(transport.calls.filter((c) => c.path.endsWith("/list")).length - before).toBe(PARTNER_MAX_PAGES);
    expect(registeredKinds()).toContain("shipping.account.sync");
  });
});

describe("automatic provisioning sweep (every store, bounded) and the production guard", () => {
  it("provisions every pending store; one failure does not stop the batch, backs that store off for later, and the next sweep retries it only when due", async () => {
    const stores = [await makeStore("toko-a"), await makeStore("toko-b"), await makeStore("toko-c")];
    const { transport, client } = fakeTransport();
    transport.failNextWith = "network down";
    expect((await sweepPendingAccounts(platform, client())).map((o) => o.outcome)).toEqual(["PROVIDER_UNAVAILABLE", "active", "active"]);
    const [first] = await partnerRows(stores[0]!.storeId);
    expect(first).toMatchObject({ status: "pending", lastResult: "PROVIDER_UNAVAILABLE" });
    expect(first!.nextRetryAt!.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    expect(await sweepPendingAccounts(platform, client())).toEqual([]); // not due yet: no provider call at all
    await admin.execute(sql`update store_shipping_account set next_retry_at = now() - interval '1 second' where id = ${first!.id}`);
    expect((await sweepPendingAccounts(platform, client())).map((o) => o.outcome)).toEqual(["active"]);
    expect(registeredKinds()).toContain("shipping.account.sweep");
  });

  it("a worker without a live adapter in production refuses to provision instead of minting fake accounts and keys", async () => {
    const s = await makeStore("toko-a");
    setPartnerTransport(null);
    vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(provisionShippingAccount(platform, s.storeId)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
      await expect(sweepPendingAccounts(platform)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await partnerRows(s.storeId))[0]).toMatchObject({ status: "pending", sealedKey: null, mengantarSellerId: null });
  });
});
