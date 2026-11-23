import { confirmDedicatedAccount } from "../src/shipping/sync.ts";
import { setSellerMengantarFetch } from "../src/shipping/seller.ts";
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeSellerStepUp, issueSellerStepUp } from "../src/ledger/stepup.ts";
import { checkProviderNow, FakeProviderCheck, fakeCheckAllowed, openProviderKey, paymentReadiness, PROVIDER_CHECK_LIMIT, providerOrigin, removeProviderKey, saveProviderKey, sellerProviderAccounts, setPaymentAccountDetails, setProviderCheckTransport, shippingReadiness, storeReadiness, type Provider } from "../src/payments/provider-accounts.ts";
import { storePaymentAccount } from "../src/payments/schema-payments.ts";
import { bindSession, type SellerScope } from "../src/platform/scoped.ts";
import { acceptSellerTerms } from "../src/platform/terms.ts";
import { withStore } from "../src/platform/tenant.ts";
import { auditLog, mailOutbox, membership, user } from "../src/schema.ts";
import { resealShippingCredentials } from "../src/shipping/accounts.ts";
import { credentialKeyring, keyFingerprint, keyHint, paymentKeyring, sealCredential, shippingKeyring, unsealCredential } from "../src/shipping/credentials.ts";
import { storeShippingAccount } from "../src/shipping/schema-accounts.ts";
import { admin, db, makeStore, makeUser, platform } from "./helpers.ts";
import { sessionOf } from "./t37-fixtures.ts";

// T-104 (ADR-0013 sections 1 to 3, D-27): the store's own Mengantar and AutoLaris keys. Everything runs on the FAKE connection check; the keys
// are canaries, so a leak into any value, error, row, mail or log line is a failing literal scan.

const CANARY = { mengantar: "CANARY-MENGANTAR-KEY-7f3a9c1e5b2d4f60aa11", autolaris: "CANARY-AUTOLARIS-KEY-0b9e8d7c6a5f4e3d2c1b" } as const;
const ENCODED = (k: string) => [k, encodeURIComponent(k), Buffer.from(k).toString("base64"), Buffer.from(k).toString("hex")];
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code ?? String(e));

let check: FakeProviderCheck;
beforeEach(() => {
  check = new FakeProviderCheck();
  setProviderCheckTransport(check);
});
afterEach(() => {
  setProviderCheckTransport(null);
  setSellerMengantarFetch(null);
  vi.restoreAllMocks();
});

type S = Awaited<ReturnType<typeof makeStore>>;
/** The store owner on a server-side session that verified a second factor (the step-up precondition). */
async function ownerOf(s: S): Promise<SellerScope> {
  const me = bindSession(s.owner, await sessionOf(s.ownerId));
  await acceptSellerTerms(me, { version: 1, agreed: true }); // T-116: owner must accept seller terms before saving provider keys
  return me;
}
const proof = (scope: SellerScope, provider: Provider) => issueSellerStepUp(scope, { action: "integrations.provider_key", subjectId: provider });
async function connect(scope: SellerScope, provider: Provider, apiKey: string = CANARY[provider], environment: "sandbox" | "production" = "sandbox") {
  return saveProviderKey(scope, { provider, environment, apiKey, proofId: await proof(scope, provider) });
}
const shipRow = async (storeId: number) => (await admin.select().from(storeShippingAccount).where(and(eq(storeShippingAccount.storeId, storeId), eq(storeShippingAccount.kind, "seller_owned"))))[0];
const payRow = async (storeId: number) => (await admin.select().from(storePaymentAccount).where(eq(storePaymentAccount.storeId, storeId)))[0];
const auditOf = (storeId: number) => admin.select({ action: auditLog.action, subjectId: auditLog.subjectId, reason: auditLog.reason, actor: auditLog.actorUserId }).from(auditLog).where(and(eq(auditLog.storeId, storeId), eq(auditLog.subjectKind, "provider_account"))).orderBy(auditLog.id);

describe("T-104 seller provider accounts: sealed keys, environment, connection check", () => {
  it("connect seals each key under its own keyring, the view shows only state, masked hint and last check, the audit row holds the fingerprint, and every owner is told", async () => {
    const s = await makeStore("toko-a");
    const me = await ownerOf(s);
    // A second owner of the same store is told too.
    const coOwner = await makeUser("co-owner");
    await platform.insert(membership).values({ storeId: s.storeId, userId: coOwner, role: "owner" });
    const m = await connect(me, "mengantar");
    const a = await connect(me, "autolaris", CANARY.autolaris, "production");
    expect(m).toEqual({ provider: "mengantar", connected: true, environment: "sandbox", keyHint: "CANA••••aa11", lastCheckedAt: expect.any(Date), lastResult: "ready", revision: 1 });
    expect(a).toMatchObject({ provider: "autolaris", connected: true, environment: "production", keyHint: "CANA••••2c1b", lastResult: "ready" });
    const ship = (await shipRow(s.storeId))!, pay = (await payRow(s.storeId))!;
    expect(ship).toMatchObject({ kind: "seller_owned", status: "active", keyId: "testship", environment: "sandbox", keyFingerprint: keyFingerprint("shipping_credentials", CANARY.mengantar) });
    expect(pay).toMatchObject({ status: "active", keyId: "testpay", environment: "production", keyFingerprint: keyFingerprint("payment_credentials", CANARY.autolaris) });
    for (const sealed of [ship.sealedKey!, pay.sealedKey!]) for (const form of [...ENCODED(CANARY.mengantar), ...ENCODED(CANARY.autolaris)]) expect(sealed).not.toContain(form);
    expect(await openProviderKey(me, "mengantar")).toBe(CANARY.mengantar);
    expect(await openProviderKey(me, "autolaris")).toBe(CANARY.autolaris);
    // The purposes are separate: the payment envelope does not open under the shipping ring and vice versa.
    expect(() => unsealCredential("shipping_credentials", pay.sealedKey!, pay.keyId!, s.storeId, pay.id, "autolaris")).toThrow(/key_unavailable|envelope_invalid/);
    expect(await auditOf(s.storeId)).toEqual([
      { action: "provider.key.connect", subjectId: "mengantar", reason: `environment=sandbox; fingerprint=${keyFingerprint("shipping_credentials", CANARY.mengantar)}`, actor: s.ownerId },
      { action: "provider.key.connect", subjectId: "autolaris", reason: `environment=production; fingerprint=${keyFingerprint("payment_credentials", CANARY.autolaris)}`, actor: s.ownerId },
    ]);
    const emails = (await admin.select({ email: user.email }).from(user).where(sql`${user.id} in (${s.ownerId}, ${coOwner})`)).map((u) => u.email).sort();
    const mails = await admin.select({ to: mailOutbox.toEmail, subject: mailOutbox.subject }).from(mailOutbox).where(sql`${mailOutbox.toEmail} in (${sql.join(emails.map((e) => sql`${e}`), sql`, `)})`);
    expect(mails.filter((x) => x.subject.startsWith("Kunci Mengantar")).map((x) => x.to).sort()).toEqual(emails);
    expect(mails.filter((x) => x.subject.startsWith("Kunci AutoLaris")).map((x) => x.to).sort()).toEqual(emails);
    expect(check.calls).toEqual([{ provider: "mengantar", environment: "sandbox", origin: null }, { provider: "autolaris", environment: "production", origin: null }]);
  });

  it("canary-key literal scan: no returned value, error, log line, audit row, mail, job, rate-limit key or check call carries the key", async () => {
    const s = await makeStore("toko-a");
    const me = await ownerOf(s);
    const out: string[] = [];
    for (const stream of [process.stdout, process.stderr]) vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; });
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { out.push(args.map(String).join(" ")); });
    const results: unknown[] = [];
    const keep = async (p: Promise<unknown>) => results.push(await p.catch((e: unknown) => ({ error: String(e), message: (e as Error).message, cause: String((e as Error).cause) })));
    await keep(connect(me, "mengantar"));
    await keep(connect(me, "autolaris"));
    await keep(sellerProviderAccounts(me));
    await keep(storeReadiness(me));
    // A provider error that carries the key in its text (the Mengantar key travels in the URL path) reaches nobody.
    check.next = new Error(`GET https://example.invalid/api/${CANARY.mengantar}/estimate?key=${encodeURIComponent(CANARY.mengantar)} failed`);
    await keep(checkProviderNow(me, "mengantar"));
    check.next = new Error(`401 for ${CANARY.autolaris}`);
    await keep(connect(me, "autolaris", `${CANARY.autolaris}-NEXT-VALUE`));
    await keep(connect(me, "mengantar", `INVALID-${CANARY.mengantar}`));
    await keep(setPaymentAccountDetails(me, { originAreaId: "AREA1", destinationAreaId: "AREA2", shipperEmail: "toko@example.invalid", senderAddress: "Jl. Braga No. 1, Bandung", paymentOnlyConfirmed: true }));
    await keep(removeProviderKey(me, { provider: "mengantar", proofId: await proof(me, "mengantar") }));
    await keep(sellerProviderAccounts(me));
    expect(results).toHaveLength(10);
    expect(results.filter((r) => typeof r === "object" && r !== null && "error" in r)).toHaveLength(2); // the two failed saves are refusals, not leaks
    expect(results[4]).toEqual({ ok: false, code: "PROVIDER_UNAVAILABLE" }); // the provider error of check-now is a code
    const rows = async (table: string) => (await admin.execute(sql`select row_to_json(t)::text as j from ${sql.identifier(table)} t`)).map((r) => (r as { j: string }).j).join("\n");
    const haystacks = {
      results: JSON.stringify(results),
      logs: out.join("\n"),
      audit_log: await rows("audit_log"),
      mail_outbox: await rows("mail_outbox"),
      system_log: await rows("system_log"),
      job: await rows("job"),
      rate_limit: await rows("rate_limit"),
      calls: JSON.stringify(check.calls),
    };
    for (const [where, text] of Object.entries(haystacks)) for (const form of [...ENCODED(CANARY.mengantar), ...ENCODED(CANARY.autolaris)]) expect({ where, leaked: text.includes(form) }).toEqual({ where, leaked: false });
    // The views are exact allow-lists: a new property must be decided here.
    const view = results[2] as Awaited<ReturnType<typeof sellerProviderAccounts>>;
    expect(Object.keys(view).sort()).toEqual(["autolaris", "details", "mengantar", "readiness"]);
    expect(Object.keys(view.autolaris).sort()).toEqual(["connected", "environment", "keyHint", "lastCheckedAt", "lastResult", "provider", "revision"]);
  });

  it("an empty key field keeps the stored key; the same environment is no change; moving the environment re-checks the stored key and is audited", async () => {
    const s = await makeStore("toko-a");
    const me = await ownerOf(s);
    await connect(me, "autolaris");
    const before = (await payRow(s.storeId))!;
    expect(await code(saveProviderKey(me, { provider: "autolaris", environment: "sandbox", apiKey: "   ", proofId: await proof(me, "autolaris") }))).toBe("no_change");
    expect((await payRow(s.storeId))!.sealedKey).toBe(before.sealedKey);
    const moved = await saveProviderKey(me, { provider: "autolaris", environment: "production", apiKey: "", proofId: await proof(me, "autolaris") });
    expect(moved).toMatchObject({ connected: true, environment: "production", keyHint: before.keyHint });
    expect(await openProviderKey(me, "autolaris")).toBe(CANARY.autolaris);
    expect((await payRow(s.storeId))!.keyFingerprint).toBe(before.keyFingerprint);
    expect((await auditOf(s.storeId)).map((r) => r.action)).toEqual(["provider.key.connect", "provider.key.environment"]);
    // Without a stored key an empty field is refused, not stored.
    const t = await makeStore("toko-b");
    const other = await ownerOf(t);
    expect(await code(saveProviderKey(other, { provider: "mengantar", environment: "sandbox", apiKey: "", proofId: await proof(other, "mengantar") }))).toBe("invalid_key");
    expect(await shipRow(t.storeId)).toBeUndefined();
  });

  it("a failed check keeps the previous key and stores nothing new, on save and on check-now", async () => {
    const s = await makeStore("toko-a");
    const me = await ownerOf(s);
    await connect(me, "mengantar");
    const before = (await shipRow(s.storeId))!;
    // Save of a key the provider refuses: nothing changes, and the proof stays unconsumed (it is consumed only by a write).
    const p = await proof(me, "mengantar");
    expect(await code(saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: "INVALID-0123456789-new-key-value", proofId: p }))).toBe("check_failed");
    const after = (await shipRow(s.storeId))!;
    expect({ sealedKey: after.sealedKey, keyFingerprint: after.keyFingerprint, revision: after.revision, lastResult: after.lastResult }).toEqual({ sealedKey: before.sealedKey, keyFingerprint: before.keyFingerprint, revision: before.revision, lastResult: "ready" });
    expect((await admin.execute(sql`select consumed_at from store_step_up_proof where id = ${p}`))[0]).toEqual({ consumed_at: null });
    expect(await openProviderKey(me, "mengantar")).toBe(CANARY.mengantar);
    // An unreachable provider during save: the same.
    check.next = { ok: false, code: "PROVIDER_UNAVAILABLE" };
    expect(await code(saveProviderKey(me, { provider: "mengantar", environment: "production", apiKey: "", proofId: p }))).toBe("check_failed");
    expect((await shipRow(s.storeId))!.environment).toBe("sandbox");
    // Check-now that fails: the key stays, the result is recorded, and shipping is not ready until a check passes again.
    check.next = { ok: false, code: "AUTH_FAILED" };
    expect(await checkProviderNow(me, "mengantar")).toEqual({ ok: false, code: "AUTH_FAILED" });
    expect((await shipRow(s.storeId))!).toMatchObject({ status: "active", sealedKey: before.sealedKey, lastResult: "AUTH_FAILED" });
    expect((await shippingReadiness(me)).missing).toContain("check");
    expect(await checkProviderNow(me, "mengantar")).toEqual({ ok: true });
    expect((await shipRow(s.storeId))!.lastResult).toBe("ready");
  });

  it("no step-up, a used or foreign proof, a session without a fresh second factor and staff are all refused; the database refuses a key change without a consumed proof", async () => {
    const s = await makeStore("toko-a");
    const me = await ownerOf(s);
    expect(await code(saveProviderKey(me, { provider: "autolaris", environment: "sandbox", apiKey: CANARY.autolaris, proofId: "" }))).toBe("reauth_required");
    expect(await code(saveProviderKey(me, { provider: "autolaris", environment: "sandbox", apiKey: CANARY.autolaris, proofId: await proof(me, "mengantar") }))).toBe("reauth_required"); // the proof names the provider
    expect(await code(saveProviderKey(me, { provider: "autolaris", environment: "sandbox", apiKey: CANARY.autolaris, proofId: await issueSellerStepUp(me, { action: "payout.destination", subjectId: "autolaris" }) }))).toBe("reauth_required");
    expect(await payRow(s.storeId)).toBeUndefined();
    expect(await code(issueSellerStepUp(bindSession(s.owner, await sessionOf(s.ownerId, false)), { action: "integrations.provider_key", subjectId: "autolaris" }))).toBe("reauth_required");
    expect(await code(saveProviderKey({ ...me, role: "staff" }, { provider: "autolaris", environment: "sandbox", apiKey: CANARY.autolaris, proofId: await proof(me, "autolaris") }))).toBe("forbidden");
    const used = await proof(me, "autolaris");
    await saveProviderKey(me, { provider: "autolaris", environment: "sandbox", apiKey: CANARY.autolaris, proofId: used });
    expect(await code(saveProviderKey(me, { provider: "autolaris", environment: "sandbox", apiKey: `${CANARY.autolaris}-2`, proofId: used }))).toBe("reauth_required");
    expect(await code(removeProviderKey(me, { provider: "autolaris", proofId: used }))).toBe("reauth_required");
    expect(await openProviderKey(me, "autolaris")).toBe(CANARY.autolaris);
    // Below the service: the application role cannot change a key or the environment without a proof consumed in the same transaction.
    const row = (await payRow(s.storeId))!;
    const sealed = sealCredential("payment_credentials", "pasted-key-without-step-up", s.storeId, row.id, "autolaris");
    const asApp = (q: ReturnType<typeof sql>) => code(withStore(db, s.storeId, (tx) => tx.execute(q)));
    expect(await asApp(sql`update store_payment_account set sealed_key = ${sealed.sealedKey}, key_id = ${sealed.keyId}, key_fingerprint = 'hmac:x', key_hint = 'x' where id = ${row.id}`)).toBe("42501");
    expect(await asApp(sql`update store_payment_account set environment = 'production' where id = ${row.id}`)).toBe("42501");
    expect(await asApp(sql`update store_payment_account set sealed_key = null, key_id = null, sealed_at = null, key_fingerprint = null, key_hint = null, status = 'needs_key', step_up_ref = ${used} where id = ${row.id}`)).toBe("42501"); // an old, already consumed proof
    expect(await asApp(sql`update store_shipping_account set status = 'active' where kind = 'partner_managed'`)).toBe("42501"); // never a Partner or master row
    const t = await makeStore("toko-b");
    expect(await code(withStore(db, t.storeId, (tx) => tx.execute(sql`insert into store_payment_account (store_id, environment, status, sealed_key, key_id, sealed_at, key_fingerprint, key_hint) values (${t.storeId}, 'sandbox', 'active', 'x.y.z', 'testpay', now(), 'f', 'h')`)))).toBe("42501");
    expect((await payRow(s.storeId))!.sealedKey).toBe(row.sealedKey);
  });

  it("store B cannot read, use or replace store A's key under the application role", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const meA = await ownerOf(a), meB = await ownerOf(b);
    await connect(meA, "mengantar");
    await connect(meA, "autolaris");
    const before = { ship: (await shipRow(a.storeId))!, pay: (await payRow(a.storeId))! };
    // Read: the envelope function refuses another store's id; B's own call finds nothing; no sealed column is readable at all; RLS hides A's rows.
    for (const provider of ["mengantar", "autolaris"]) {
      expect(await code(withStore(db, b.storeId, (tx) => tx.execute(sql`select * from public.provider_key_envelope(${a.storeId}::bigint, ${provider})`)))).toBe("42501");
      expect(await withStore(db, b.storeId, (tx) => tx.execute(sql`select * from public.provider_key_envelope(${b.storeId}::bigint, ${provider})`))).toHaveLength(0);
    }
    expect(await code(withStore(db, a.storeId, (tx) => tx.execute(sql`select sealed_key from store_payment_account`)))).toBe("42501");
    expect(await code(withStore(db, a.storeId, (tx) => tx.execute(sql`select key_id from store_shipping_account`)))).toBe("42501");
    expect(await withStore(db, b.storeId, (tx) => tx.execute(sql`select id from store_payment_account`))).toHaveLength(0);
    expect(await withStore(db, b.storeId, (tx) => tx.execute(sql`select id from store_shipping_account where kind = 'seller_owned'`))).toHaveLength(0);
    expect(await code(withStore(db, b.storeId, (tx) => tx.execute(sql`select 1 from public.provider_key_envelope(${a.storeId}::bigint, 'autolaris')`)))).toBe("42501");
    // Use: B's services see B's (empty) accounts only.
    expect((await sellerProviderAccounts(meB)).autolaris.connected).toBe(false);
    expect(await code(checkProviderNow(meB, "autolaris"))).toBe("not_connected");
    expect(await code(openProviderKey(meB, "mengantar"))).toBe("not_connected");
    // Replace: B's write paths cannot reach A's rows (zero rows, or the policy refuses moving a row into A).
    expect(await code(removeProviderKey(meB, { provider: "autolaris", proofId: await proof(meB, "autolaris") }))).toBe("not_connected");
    const updated = await withStore(db, b.storeId, (tx) => tx.update(storePaymentAccount).set({ lastResult: "AUTH_FAILED" }).where(eq(storePaymentAccount.storeId, a.storeId)).returning({ id: storePaymentAccount.id }));
    expect(updated).toEqual([]);
    expect(await code(withStore(db, b.storeId, (tx) => tx.execute(sql`insert into store_payment_account (store_id, environment) values (${a.storeId}, 'sandbox')`)))).toBe("42501");
    await connect(meB, "autolaris", "store-b-own-autolaris-key-000000000000");
    expect(await openProviderKey(meA, "autolaris")).toBe(CANARY.autolaris);
    expect((await payRow(a.storeId))!.sealedKey).toBe(before.pay.sealedKey);
    expect((await shipRow(a.storeId))!.sealedKey).toBe(before.ship.sealedKey);
    // An envelope copied into B's row (a database-level slip) does not open: purpose, store, row and kind are its additional data.
    await admin.execute(sql`alter table store_payment_account disable trigger provider_account_guard`);
    try {
      await admin.execute(sql`update store_payment_account set sealed_key = ${before.pay.sealedKey}, key_id = ${before.pay.keyId} where store_id = ${b.storeId}`);
    } finally {
      await admin.execute(sql`alter table store_payment_account enable trigger provider_account_guard`);
    }
    await expect(openProviderKey(meB, "autolaris")).rejects.toThrow("payment_envelope_invalid");
  });

  it("remove is an explicit action: step-up consumed, key cleared, row kept, audited and every owner told", async () => {
    const s = await makeStore("toko-a");
    const me = await ownerOf(s);
    await connect(me, "mengantar");
    await admin.execute(sql`update store_shipping_account set pickup_registered_at = now(), pickup_address_id = 'pickup1' where store_id = ${s.storeId} and kind = 'seller_owned'`);
    const removed = await removeProviderKey(me, { provider: "mengantar", proofId: await proof(me, "mengantar") });
    expect(removed).toEqual({ provider: "mengantar", connected: false, environment: "sandbox", keyHint: null, lastCheckedAt: null, lastResult: null, revision: 2 });
    expect(await shipRow(s.storeId)).toMatchObject({ status: "needs_key", sealedKey: null, keyId: null, keyFingerprint: null, keyHint: null, pickupRegisteredAt: null });
    expect(await code(openProviderKey(me, "mengantar"))).toBe("not_connected");
    expect(await code(removeProviderKey(me, { provider: "mengantar", proofId: await proof(me, "mengantar") }))).toBe("not_connected");
    expect((await auditOf(s.storeId)).map((r) => [r.action, r.reason])).toEqual([
      ["provider.key.connect", `environment=sandbox; fingerprint=${keyFingerprint("shipping_credentials", CANARY.mengantar)}`],
      ["provider.key.remove", `environment=sandbox; fingerprint=${keyFingerprint("shipping_credentials", CANARY.mengantar)}`],
    ]);
    const [owner] = await admin.select({ email: user.email }).from(user).where(eq(user.id, s.ownerId));
    expect((await admin.select({ subject: mailOutbox.subject, text: mailOutbox.textBody }).from(mailOutbox).where(and(eq(mailOutbox.toEmail, owner!.email), sql`${mailOutbox.subject} like '%dihapus'`)))).toEqual([{ subject: `Kunci Mengantar toko ${s.owner.storeName} dihapus`, text: expect.stringContaining("dihapus oleh") }]);
    // Reconnecting reuses the row.
    await connect(me, "mengantar", "another-own-mengantar-key-000000000000");
    expect(await admin.execute(sql`select id from store_shipping_account where store_id = ${s.storeId} and kind = 'seller_owned'`)).toHaveLength(1);
  });

  it("RL-PROVIDER-CHECK: five saves or checks per ten minutes per store; the sixth is refused before any provider call and changes nothing", async () => {
    const s = await makeStore("toko-a");
    const me = await ownerOf(s);
    await connect(me, "autolaris");
    for (let i = 0; i < PROVIDER_CHECK_LIMIT.limit - 1; i++) expect(await checkProviderNow(me, "autolaris")).toEqual({ ok: true });
    expect(check.calls).toHaveLength(5);
    expect(await code(checkProviderNow(me, "autolaris"))).toBe("rate_limited");
    const before = (await payRow(s.storeId))!;
    expect(await code(saveProviderKey(me, { provider: "autolaris", environment: "sandbox", apiKey: `${CANARY.autolaris}-new`, proofId: await proof(me, "autolaris") }))).toBe("rate_limited");
    expect(check.calls).toHaveLength(5);
    expect((await payRow(s.storeId))!).toMatchObject({ sealedKey: before.sealedKey, lastCheckedAt: before.lastCheckedAt });
    // Per store: another store is not affected.
    const t = await makeStore("toko-b");
    expect(await connect(await ownerOf(t), "autolaris")).toMatchObject({ connected: true });
  });

  it("no provider URL: the input refuses a URL field, neither table has a URL column, and the origin comes only from the environment and server configuration", async () => {
    const s = await makeStore("toko-a");
    const me = await ownerOf(s);
    for (const extra of [{ baseUrl: "https://attacker.example" }, { origin: "https://attacker.example" }, { url: "http://169.254.169.254" }]) {
      expect(await code(saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: CANARY.mengantar, proofId: await proof(me, "mengantar"), ...extra }))).toMatch(/unrecognized_keys|ZodError/);
    }
    expect(await code(saveProviderKey(me, { provider: "mengantar", environment: "https://attacker.example", apiKey: CANARY.mengantar, proofId: await proof(me, "mengantar") }))).toMatch(/invalid_value|ZodError/);
    const columns = await admin.execute(sql`select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name in ('store_payment_account', 'store_shipping_account') and column_name ~ '(url|host|endpoint|base|^origin$|_origin$)'`); // origin_area_id is a provider AREA id, not an address
    expect(columns).toEqual([]);
    vi.stubEnv("MENGANTAR_SANDBOX_ORIGIN", "https://sandbox.mengantar.example.invalid");
    vi.stubEnv("MENGANTAR_PRODUCTION_ORIGIN", "https://api.mengantar.example.invalid");
    // T-115: a configured origin also runs the dedicated-account read of the order list on the key: answered by a stub, nothing leaves the process.
    setSellerMengantarFetch((async () => new Response(JSON.stringify({ success: true, data: [], nextCursor: "" }), { status: 200 })) as typeof fetch);
    await connect(me, "mengantar");
    // T-115: moving to production is another account, whose order list is read on the production key: that needs the Owner console switch (T-105).
    await admin.execute(sql`insert into provider_live_setting (provider, sandbox_passed_at, sandbox_pass_note, sandbox_pass_by, production_enabled, updated_by) values ('mengantar', now(), 'test', 'test', true, 'test')`);
    await saveProviderKey(me, { provider: "mengantar", environment: "production", apiKey: "", proofId: await proof(me, "mengantar") });
    await admin.execute(sql`truncate provider_live_setting`);
    expect(check.calls.map((c) => [c.environment, c.origin])).toEqual([["sandbox", "https://sandbox.mengantar.example.invalid"], ["production", "https://api.mengantar.example.invalid"]]);
    // Without the test seam, a configured origin and no live transport refuse the check (the fake never answers for a configured provider).
    setProviderCheckTransport(null);
    vi.stubEnv("AUTOLARIS_SANDBOX_ORIGIN", "https://h2h-sandbox.example.invalid");
    expect(await code(connect(me, "autolaris"))).toBe("provider_unavailable");
    expect((await sellerProviderAccounts(me)).autolaris.connected).toBe(false);
    expect(providerOrigin("autolaris", "sandbox", {})).toBeNull();
    for (const bad of ["http://api.example.invalid", "https://api.example.invalid/v1", "https://user:pw@api.example.invalid", "not a url"]) expect(() => providerOrigin("autolaris", "production", { AUTOLARIS_PRODUCTION_ORIGIN: bad })).toThrow("provider_origin_invalid");
    expect(providerOrigin("autolaris", "production", { AUTOLARIS_PRODUCTION_ORIGIN: "https://h2h.example.invalid/" })).toBe("https://h2h.example.invalid");
  });

  it("readiness follows decisions 12 to 14: shipping needs a checked key, a pickup area and a registered pickup; QRIS/VA needs a checked key, the order fields, a sender address and the payment-only confirmation", async () => {
    const s = await makeStore("toko-a");
    const me = await ownerOf(s);
    expect(await storeReadiness(me)).toEqual({
      shipping: { ready: false, missing: ["key", "pickup_registered"] },
      qrisVa: { ready: false, missing: ["key", "order_fields", "sender_address", "payment_only"] },
      bankTransfer: false, // T-113: no bank account listed
      canOpen: false,
      physicalProducts: false,
    });
    expect(await code(setPaymentAccountDetails(me, { originAreaId: "A1", destinationAreaId: "A2", shipperEmail: "toko@example.invalid", senderAddress: "Jl. Braga No. 1, Bandung", paymentOnlyConfirmed: true }))).toBe("not_connected");
    await connect(me, "autolaris");
    expect(await paymentReadiness(me)).toEqual({ ready: false, missing: ["order_fields", "sender_address", "payment_only"] });
    await setPaymentAccountDetails(me, { originAreaId: "A1", destinationAreaId: "A2", shipperEmail: "toko@example.invalid", senderAddress: "Jl. Braga No. 1, Bandung", paymentOnlyConfirmed: false });
    expect(await paymentReadiness(me)).toEqual({ ready: false, missing: ["payment_only"] });
    const details = await setPaymentAccountDetails(me, { originAreaId: "A1", destinationAreaId: "A2", shipperEmail: "toko@example.invalid", senderAddress: "Jl. Braga No. 1, Bandung", paymentOnlyConfirmed: true });
    expect(details.paymentOnlyConfirmedAt).toBeInstanceOf(Date);
    expect(await storeReadiness(s.sf)).toMatchObject({ qrisVa: { ready: true, missing: [] }, canOpen: true, physicalProducts: false }); // the storefront scope reads the same
    check.next = { ok: false, code: "AUTH_FAILED" };
    await checkProviderNow(me, "autolaris");
    expect(await paymentReadiness(me)).toEqual({ ready: false, missing: ["check"] });
    // Shipping: a connected, checked key still waits for the pickup registration of that account (written by T-105).
    // T-115 (decision 41): and the seller's confirmation that this account is new and dedicated to the store.
    await connect(me, "mengantar");
    expect(await shippingReadiness(me)).toEqual({ ready: false, missing: ["dedicated", "pickup_registered"] });
    await confirmDedicatedAccount(me, { confirmed: true });
    await admin.execute(sql`update store_shipping_account set pickup_registered_at = now(), pickup_address_id = 'pickup1' where store_id = ${s.storeId} and kind = 'seller_owned'`);
    expect(await storeReadiness(me)).toMatchObject({ shipping: { ready: true, missing: [] }, canOpen: true, physicalProducts: true });
    // Another account (a different key) needs its own registration and its own confirmation.
    await connect(me, "mengantar", "a-different-mengantar-account-key-0000");
    expect(await shippingReadiness(me)).toEqual({ ready: false, missing: ["dedicated", "pickup_registered"] });
    expect((await auditOf(s.storeId)).map((r) => r.action)).toContain("provider.details.update");
    const t = await makeStore("toko-b", { pickupArea: false });
    expect(await shippingReadiness(await ownerOf(t))).toEqual({ ready: false, missing: ["key", "pickup_area", "pickup_registered"] });
  });

  it("keyrings are purpose-separated, the re-seal job keeps a seller key's kind, and the masked hint follows the 24-character rule", async () => {
    const pay = process.env.KEYRING_PAYMENT_CREDENTIALS!;
    const shipKey = process.env.KEYRING_SHIPPING_CREDENTIALS!.split(":")[1]!;
    expect(() => paymentKeyring({ ...process.env, KEYRING_PAYMENT_CREDENTIALS: `p1:${shipKey}` })).toThrow("payment_key_purpose_reused");
    expect(() => shippingKeyring({ ...process.env, KEYRING_SHIPPING_CREDENTIALS: `s1:${pay.split(":")[1]}` })).toThrow("shipping_key_purpose_reused");
    expect(() => credentialKeyring("payment_credentials", { KEYRING_PAYMENT_CREDENTIALS: "" })).toThrow("payment_key_unavailable");
    expect(keyHint("short-key-123")).toBe("••••••••");
    expect(keyHint("x".repeat(23))).toBe("••••••••");
    expect(keyHint("abcd" + "x".repeat(16) + "wxyz")).toBe("abcd••••wxyz");
    // The fingerprint is an HMAC keyed per purpose (review finding 2): equal for equal keys under one ring, different across purposes and rings.
    expect(keyFingerprint("payment_credentials", CANARY.autolaris)).toMatch(/^hmac:[0-9a-f]{16}$/);
    expect(keyFingerprint("payment_credentials", CANARY.autolaris)).toBe(keyFingerprint("payment_credentials", CANARY.autolaris));
    expect(keyFingerprint("shipping_credentials", CANARY.autolaris)).not.toBe(keyFingerprint("payment_credentials", CANARY.autolaris));
    const s = await makeStore("toko-a");
    const me = await ownerOf(s);
    await connect(me, "mengantar");
    const old = process.env.KEYRING_SHIPPING_CREDENTIALS!;
    const next = `rot1:${randomBytes(32).toString("base64")}`;
    vi.stubEnv("KEYRING_SHIPPING_CREDENTIALS", `${next},${old}`);
    expect((await resealShippingCredentials(platform)).changed).toBeGreaterThanOrEqual(1);
    expect((await shipRow(s.storeId))!.keyId).toBe("rot1");
    expect(await openProviderKey(me, "mengantar")).toBe(CANARY.mengantar);
    // The fingerprint moved with the envelope: it is keyed by the new current ring key, so a later equality check still works.
    expect((await shipRow(s.storeId))!.keyFingerprint).toBe(keyFingerprint("shipping_credentials", CANARY.mengantar));
    vi.stubEnv("KEYRING_SHIPPING_CREDENTIALS", old);
    expect(keyFingerprint("shipping_credentials", CANARY.mengantar)).not.toBe((await shipRow(s.storeId))!.keyFingerprint);
  });
  it("the fake check never answers in production (unless the explicit e2e flag is set) nor for a configured origin: the save is refused and the stored key and its last result stay", async () => {
    const s = await makeStore("toko-a");
    const me = await ownerOf(s);
    await connect(me, "autolaris");
    const before = (await payRow(s.storeId))!;
    setProviderCheckTransport(null);
    vi.stubEnv("NODE_ENV", "production");
    expect(await code(saveProviderKey(me, { provider: "autolaris", environment: "sandbox", apiKey: `${CANARY.autolaris}-next`, proofId: await proof(me, "autolaris") }))).toBe("provider_unavailable");
    expect(await code(checkProviderNow(me, "autolaris"))).toBe("provider_unavailable");
    expect(await code(connect(me, "mengantar"))).toBe("provider_unavailable");
    expect((await payRow(s.storeId))!).toMatchObject({ sealedKey: before.sealedKey, keyFingerprint: before.keyFingerprint, lastResult: "ready", lastCheckedAt: before.lastCheckedAt, revision: before.revision });
    expect(await shipRow(s.storeId)).toBeUndefined();
    expect(fakeCheckAllowed(null, { NODE_ENV: "production" })).toBe(false);
    expect(fakeCheckAllowed(null, { NODE_ENV: "production", PROVIDER_CHECK_FAKE: "1" })).toBe(true);
    expect(fakeCheckAllowed(null, { NODE_ENV: "production", PROVIDER_CHECK_FAKE: "true" })).toBe(false);
    // The flag is honoured only in the loopback harness: on a real deployment it does nothing.
    expect(fakeCheckAllowed(null, { NODE_ENV: "production", PROVIDER_CHECK_FAKE: "1", APP_ORIGIN: "https://app.bukalaris.com" })).toBe(false);
    expect(fakeCheckAllowed(null, { NODE_ENV: "production", PROVIDER_CHECK_FAKE: "1", PLATFORM_ORIGIN: "https://bukalaris.com", BETTER_AUTH_URL: "https://bukalaris.com" })).toBe(false);
    expect(fakeCheckAllowed(null, { NODE_ENV: "production", PROVIDER_CHECK_FAKE: "1", APP_ORIGIN: "http://app.localhost:3300" })).toBe(true);
    expect(fakeCheckAllowed("https://h2h.example.invalid", { NODE_ENV: "test" })).toBe(false);
    expect(fakeCheckAllowed(null, { NODE_ENV: "test" })).toBe(true);
  });

  it("an environment move with an empty key field never re-seals the old key over a replacement saved while it was being checked", async () => {
    const s = await makeStore("toko-a");
    const me = await ownerOf(s);
    await connect(me, "autolaris");
    const replacement = `${CANARY.autolaris}-REPLACED-meanwhile`;
    const p2 = await proof(me, "autolaris");
    let hook: (() => Promise<unknown>) | null = () => saveProviderKey(me, { provider: "autolaris", environment: "sandbox", apiKey: replacement, proofId: p2 });
    setProviderCheckTransport({ mode: "fake", async check() { const h = hook; hook = null; if (h) await h(); return { ok: true }; } });
    // The move opened the OLD key and is checking it while the replacement commits.
    expect(await code(saveProviderKey(me, { provider: "autolaris", environment: "production", apiKey: "", proofId: await proof(me, "autolaris") }))).toBe("conflict");
    expect(await openProviderKey(me, "autolaris")).toBe(replacement);
    expect((await payRow(s.storeId))!).toMatchObject({ environment: "sandbox", keyFingerprint: keyFingerprint("payment_credentials", replacement) });
    expect((await auditOf(s.storeId)).map((r) => r.action)).toEqual(["provider.key.connect", "provider.key.replace"]);
  });

  it("the database binds the proof to the action and the provider: a consumed proof of another action or another provider never authorises a key write", async () => {
    const s = await makeStore("toko-a");
    const me = await ownerOf(s);
    await connect(me, "autolaris");
    await connect(me, "mengantar");
    const row = (await payRow(s.storeId))!;
    const sealed = sealCredential("payment_credentials", "pasted-key-under-a-foreign-proof", s.storeId, row.id, "autolaris");
    const writeWith = async (action: "payout.destination" | "integrations.provider_key", subjectId: string) => {
      const p = await issueSellerStepUp(me, { action, subjectId });
      return code(withStore(db, s.storeId, async (tx) => {
        await consumeSellerStepUp(tx, me, p, { action, subjectId }); // consumed in THIS transaction, but for something else
        await tx.execute(sql`update store_payment_account set sealed_key = ${sealed.sealedKey}, key_id = ${sealed.keyId}, key_fingerprint = 'hmac:x', key_hint = 'x', step_up_ref = ${p} where id = ${row.id}`);
      }));
    };
    expect(await writeWith("payout.destination", "autolaris")).toBe("42501"); // another action
    expect(await writeWith("integrations.provider_key", "mengantar")).toBe("42501"); // another provider
    expect((await payRow(s.storeId))!.sealedKey).toBe(row.sealedKey);
    expect(await openProviderKey(me, "autolaris")).toBe(CANARY.autolaris);
  });
});
