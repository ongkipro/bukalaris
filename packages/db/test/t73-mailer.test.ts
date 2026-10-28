import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInvitation, dbMailer, listOutbox } from "../src/platform/accounts.ts";
import { FakeMailTransport, configuredMailTransport, requireMailConfiguration, setMailTransport } from "../src/platform/mail-transport.ts";
import { MAIL_DELIVER, MAIL_PURGE, purgeExpiredMailBodies, recordMailDeliveryResult } from "../src/ops/jobs/mail.ts";
import { runOnce } from "../src/ops/jobs/jobs.ts";
import { reconcileUnknownJobs } from "../src/ops/jobs/manage.ts";
import { schedulerTick } from "../src/ops/jobs/scheduler.ts";
import { ORDER_NOTIFY } from "../src/ops/jobs/notify.ts";
import { exportBuyerData, redactOrders } from "../src/seller/commerce/privacy.ts";
import { placeOrder } from "../src/seller/commerce/checkout.ts";
import { transitionOrder } from "../src/seller/commerce/orders.ts";
import { job, mailOutbox } from "../src/schema.ts";
import { withStore } from "../src/platform/tenant.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { admin, buyer, db, makeStore, platform } from "./helpers.ts";

// T-73: real-mailer boundary and mail_outbox hardening. Each case fails if its invariant is broken.

beforeEach(() => admin.execute(sql`truncate mail_outbox, job restart identity cascade`));
afterEach(() => {
  vi.unstubAllEnvs();
  setMailTransport(null);
});

const pgCode = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code;
};
const denied = (p: Promise<unknown>) => p.then(() => "allowed", pgCode);
const acceptUrl = (token: string) => `http://localhost:3000/invite/${token}`;
const providerEnv = () => {
  vi.stubEnv("MAIL_MODE", "provider");
  vi.stubEnv("MAIL_PROVIDER", "fake");
  vi.stubEnv("MAIL_FROM", "no-reply@mail.example.test");
};
const rows = () => platform.select().from(mailOutbox).orderBy(mailOutbox.id);
const secretLink = (text: string) => /\/invite\/([A-Za-z0-9_-]+)/.exec(text)![1]!;

async function invitation(s: Awaited<ReturnType<typeof makeStore>>, email = "baru@example.com") {
  await createInvitation(s.owner, dbMailer(db), { email, role: "staff" }, acceptUrl);
  const [m] = await rows();
  return { id: m!.id, token: secretLink(m!.textBody) };
}

async function orderMails(s: Awaited<ReturnType<typeof makeStore>>) {
  const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
  const { orderId } = await placeOrder(db, cartId, buyer({ buyerEmail: "budi@example.com" }));
  await runOnce(platform, { workerId: "N" }); // order.notify handlers enqueue mail through the app-safe function
  return orderId;
}

describe("the app role can neither read bodies nor update rows (D-10 revoked)", () => {
  it("every direct statement on mail_outbox and its sequence is refused with 42501; the registered functions still work", async () => {
    const s = await makeStore("toko-a");
    const { token } = await invitation(s);
    for (const stmt of [
      sql`select id from mail_outbox`,
      sql`select text_body from mail_outbox`,
      sql`select count(*) from mail_outbox`,
      sql`insert into mail_outbox (to_email, subject, text_body) values ('a@b.test', 's', 'b')`,
      sql`update mail_outbox set text_body = '[dihapus]'`,
      sql`delete from mail_outbox`,
      sql`select nextval('mail_outbox_id_seq')`,
    ]) expect({ stmt, code: await denied(db.execute(stmt)) }).toMatchObject({ code: "42501" });
    // A body-bearing view through the function is not exposed for credential mail: the app function returns order copies only.
    const leaked = await db.execute(sql`select text_body from public.mail_privacy_export(array[0]::bigint[])`);
    expect([...leaked]).toEqual([]);
    expect((await rows())[0]!.textBody).toContain(token); // the platform worker side still has it
  });

  it("the invitation, recovery-style one-time and order flows enqueue through the function (one job per mail, body never readable by app)", async () => {
    const s = await makeStore("toko-a");
    await invitation(s);
    await dbMailer(db).send({ to: "x@example.com", subject: "Reset", text: "https://x/reset/abc", oneTime: { purpose: "recovery", expiresAt: new Date(Date.now() + 3_600_000) } });
    const all = await rows();
    expect(all.map((m) => [m.oneTimePurpose, m.deliveryStatus])).toEqual([["invitation", "pending"], ["recovery", "pending"]]);
    const jobs = await platform.select().from(job).where(eq(job.kind, MAIL_DELIVER));
    expect(jobs.map((j) => j.key).sort()).toEqual(all.map((m) => `mail:${m.id}`).sort());
    expect(jobs.every((j) => j.storeId === null)).toBe(true);
  });

  it("a one-time mail without a future expiry is refused (no credential body may outlive an unknown lifetime)", async () => {
    await expect(dbMailer(db).send({ to: "x@example.com", subject: "s", text: "t", oneTime: { purpose: "recovery", expiresAt: new Date(Date.now() - 1000) } })).rejects.toMatchObject({ cause: { code: "22023" } });
    await expect(admin.execute(sql`insert into mail_outbox (to_email, subject, text_body, one_time_purpose) values ('a@b.test','s','t','invitation')`)).rejects.toMatchObject({ cause: { code: "23514" } });
    expect(await rows()).toEqual([]);
  });

  it("order mail is bound to the caller's store: another store's context cannot enqueue, export or redact it", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const orderId = await orderMails(a);
    await expect(withStore(db, b.storeId, (tx) => dbMailer(tx).send({ to: "z@example.com", subject: `Pesanan #${orderId}`, text: "t", order: { id: orderId, recipient: "buyer" } }))).rejects.toMatchObject({ cause: { code: "42501" } });
    const before = await rows();
    const cross = await withStore(db, b.storeId, async (tx) => ({
      exported: [...(await tx.execute(sql`select 1 from public.mail_privacy_export(array[${orderId}]::bigint[])`))].length,
      redacted: (await tx.execute(sql`select public.mail_privacy_redact(array[${orderId}]::bigint[])::int as n`))[0]!.n,
    }));
    expect(cross).toEqual({ exported: 0, redacted: 0 });
    expect(await rows()).toEqual(before);
    // No store context at all behaves the same (fail closed).
    expect([...(await db.execute(sql`select 1 from public.mail_privacy_export(array[${orderId}]::bigint[])`))]).toEqual([]);
  });
});

describe("T-43 redaction through the platform-side function still reaches every copy", () => {
  it("buyer copy loses address and body, owner copy keeps its address and loses the body, export lists the buyer copy before and not after; a second run is a no-op", async () => {
    const s = await makeStore("toko-a");
    const orderId = await orderMails(s);
    await transitionOrder(s.owner, orderId, "confirm");
    await runOnce(platform, { workerId: "N2" });
    const before = await exportBuyerData(s.owner, "budi@example.com");
    expect(before.orders[0]!.mails.length).toBeGreaterThanOrEqual(2);
    const first = await redactOrders(s.owner, { orderIds: [orderId], override: true, reason: "permintaan pembeli" });
    expect(first.mails).toBe(3);
    const copies = (await rows()).filter((m) => m.orderId === orderId);
    expect(copies).toHaveLength(3);
    expect(copies.every((m) => m.textBody === "[dihapus]" && m.htmlBody === null)).toBe(true);
    expect(copies.filter((m) => m.recipient === "buyer").every((m) => m.toEmail === "[dihapus]")).toBe(true);
    expect(copies.filter((m) => m.recipient === "seller").every((m) => m.toEmail !== "[dihapus]")).toBe(true);
    expect((await redactOrders(s.owner, { orderIds: [orderId], override: true, reason: "permintaan pembeli" })).mails).toBe(0);
  });

  it("redaction wins over a late notification: a mail for an already redacted order is never enqueued", async () => {
    const s = await makeStore("toko-a");
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, cartId, buyer({ buyerEmail: "budi@example.com" }));
    await redactOrders(s.owner, { orderIds: [orderId], override: true, reason: "buyer request" });
    await runOnce(platform, { workerId: "late" }); // the queued order.notify jobs now find a redacted order
    expect((await rows()).filter((m) => m.orderId === orderId)).toEqual([]);
    expect(await withStore(db, s.storeId, (tx) => dbMailer(tx).send({ to: "budi@example.com", subject: `Pesanan #${orderId}`, text: "x", order: { id: orderId, recipient: "buyer" } }))).toBeUndefined();
    expect((await rows()).filter((m) => m.orderId === orderId)).toEqual([]);
  });
});

describe("bodies of one-time-link mail are purged after expiry (the rule is the link's own lifetime) or delivery", () => {
  it("expiry purges body and html but keeps the audit row; idempotent; unexpired and order mail are untouched; the batch is bounded", async () => {
    const s = await makeStore("toko-a");
    const { id } = await invitation(s);
    const orderId = await orderMails(s);
    expect(await purgeExpiredMailBodies(platform)).toBe(0); // not expired yet
    await admin.execute(sql`update mail_outbox set expires_at = now() - interval '1 minute' where id = ${id}`);
    expect(await purgeExpiredMailBodies(platform)).toBe(1);
    expect(await purgeExpiredMailBodies(platform)).toBe(0); // idempotent
    const all = await rows();
    const purged = all.find((m) => m.id === id)!;
    expect(purged).toMatchObject({ textBody: "", htmlBody: null, deliveryStatus: "expired" });
    expect(purged.bodiesPurgedAt).toBeInstanceOf(Date);
    expect(all.filter((m) => m.orderId === orderId).every((m) => m.textBody !== "")).toBe(true);
    await expect(platform.execute(sql`select public.mail_purge_expired(0)`)).rejects.toMatchObject({ cause: { code: "22023" } });
    expect(await denied(db.execute(sql`select public.mail_purge_expired(10)`))).toBe("42501");
  });

  it("the periodic mail.purge job runs through the T-74 scheduler and purges expired bodies", async () => {
    const s = await makeStore("toko-a");
    const { id } = await invitation(s);
    await admin.execute(sql`update mail_outbox set expires_at = now() - interval '1 minute' where id = ${id}`);
    await schedulerTick(platform, { now: new Date(), tickIntervalMs: 30_000 });
    const out = await runOnce(platform, { workerId: "P", batch: 50 });
    expect(out.find((o) => o.kind === MAIL_PURGE)).toMatchObject({ status: "done" });
    expect((await rows()).find((m) => m.id === id)).toMatchObject({ textBody: "", deliveryStatus: "expired" });
  });
});

describe("real delivery through the transport interface (fake transport); results are recorded without the body", () => {
  const send = async () => {
    const s = await makeStore("toko-a");
    const { id, token } = await invitation(s);
    return { id, token };
  };

  it("accepted: one send, idempotency key = mail id, body purged immediately, provider message id kept", async () => {
    providerEnv();
    const fake = new FakeMailTransport("accepted");
    setMailTransport(fake);
    const { id, token } = await send();
    expect((await runOnce(platform, { workerId: "D" })).find((o) => o.kind === MAIL_DELIVER)).toMatchObject({ status: "done" });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ idempotencyKey: `mail:${id}`, from: "no-reply@mail.example.test", to: "baru@example.com" });
    expect(fake.sent[0]!.text).toContain(token);
    const m = (await rows())[0]!;
    expect(m).toMatchObject({ deliveryStatus: "accepted", provider: "fake", providerMessageId: `fake-mail:${id}`, textBody: "", htmlBody: null });
    expect(JSON.stringify(m)).not.toContain(token);
    expect(await runOnce(platform, { workerId: "D2" })).toEqual([]); // nothing left to do, nothing re-sent
    expect(fake.sent).toHaveLength(1);
  });

  it.each(["bounced", "failed"] as const)("%s is recorded as the final status and the body is purged", async (status) => {
    providerEnv();
    setMailTransport(new FakeMailTransport(status));
    const { token } = await send();
    await runOnce(platform, { workerId: "D" });
    const m = (await rows())[0]!;
    expect(m.deliveryStatus).toBe(status);
    expect(m.textBody).toBe("");
    expect(JSON.stringify(m)).not.toContain(token);
  });

  it("two workers racing for the same mail send it once", async () => {
    providerEnv();
    const fake = new FakeMailTransport();
    setMailTransport(fake);
    await send();
    await Promise.all([runOnce(platform, { workerId: "A" }), runOnce(platform, { workerId: "B" })]);
    expect(fake.sent).toHaveLength(1);
  });

  it("a transport error or timeout makes the outcome unknown: never re-dispatched by the runner, body kept until a result or expiry, reconcilable only after a recorded result", async () => {
    providerEnv();
    let calls = 0;
    setMailTransport({ provider: "fake", async send() { calls++; throw new Error("socket hang up key=sk_live_123"); } });
    await send();
    const out = (await runOnce(platform, { workerId: "E" })).find((o) => o.kind === MAIL_DELIVER)!;
    expect(out.status).toBe("unknown");
    expect(out.error ?? "").not.toContain("sk_live_123");
    expect(calls).toBe(1);
    expect(await runOnce(platform, { workerId: "E2" })).toEqual([]);
    expect(calls).toBe(1);
    expect((await rows())[0]!.deliveryStatus).toBe("pending");
    expect(await reconcileUnknownJobs(platform)).toMatchObject({ settled: 0 }); // no result recorded: an operator must decide
    await recordMailDeliveryResult(platform, (await rows())[0]!.id, "fake", { status: "accepted", messageId: "late-1" }); // result arrives out of band
    expect(await reconcileUnknownJobs(platform)).toMatchObject({ settled: 1 });
    expect((await platform.select().from(job).where(eq(job.kind, MAIL_DELIVER)))[0]!.status).toBe("done");
  });

  it("malformed provider output is treated as unknown and never stored", async () => {
    providerEnv();
    setMailTransport({ provider: "fake", send: async () => ({ status: "accepted", messageId: "<script>x</script>" }) });
    await send();
    expect((await runOnce(platform, { workerId: "M" })).find((o) => o.kind === MAIL_DELIVER)!.status).toBe("unknown");
    expect((await rows())[0]).toMatchObject({ deliveryStatus: "pending", providerMessageId: null });
  });

  it("result recording is bound and replay-safe: wrong provider or message id is refused, an exact replay is a no-op, a late bounce may follow accepted, nothing leaves a final state otherwise", async () => {
    providerEnv();
    setMailTransport(new FakeMailTransport());
    await send();
    await runOnce(platform, { workerId: "R" });
    const id = (await rows())[0]!.id;
    const msg = `fake-mail:${id}`;
    await recordMailDeliveryResult(platform, id, "fake", { status: "accepted", messageId: msg }); // replay
    await expect(recordMailDeliveryResult(platform, id, "other", { status: "bounced", messageId: msg })).rejects.toThrow("binding mismatch");
    await expect(recordMailDeliveryResult(platform, id, "fake", { status: "bounced", messageId: "someone-elses" })).rejects.toThrow("binding mismatch");
    expect((await rows())[0]!.deliveryStatus).toBe("accepted");
    await recordMailDeliveryResult(platform, id, "fake", { status: "bounced", messageId: msg }); // asynchronous bounce
    expect((await rows())[0]!.deliveryStatus).toBe("bounced");
    await expect(recordMailDeliveryResult(platform, id, "fake", { status: "accepted", messageId: msg })).rejects.toThrow("invalid mail delivery result transition");
  });

  it("local mode never reports delivery: the job completes, the row stays pending and the dev outbox shows it to the platform pool only", async () => {
    vi.stubEnv("MAIL_MODE", "local");
    const { id, token } = await send();
    expect((await runOnce(platform, { workerId: "L" })).find((o) => o.kind === MAIL_DELIVER)).toMatchObject({ status: "done" });
    expect((await rows())[0]).toMatchObject({ deliveryStatus: "pending", provider: null });
    expect((await listOutbox(platform, 1))[0]!.textBody).toContain(token);
    expect(await denied(db.execute(sql`select 1 from mail_outbox where id = ${id}`))).toBe("42501");
  });

  it("order mail rendering is unchanged when delivered: the order.notify handler still produces one mail per event and recipient", async () => {
    const s = await makeStore("toko-a");
    const orderId = await orderMails(s);
    const mails = (await rows()).filter((m) => m.orderId === orderId);
    expect(mails.map((m) => m.recipient).sort()).toEqual(["buyer", "seller"]);
    expect((await platform.select().from(job).where(eq(job.kind, ORDER_NOTIFY))).every((j) => j.status === "done")).toBe(true);
  });
});

describe("production refuses to start without an explicit, installed provider (Q-16); the dev outbox is never a silent fallback", () => {
  const prod = { NODE_ENV: "production", BETTER_AUTH_URL: "https://app.bukalaris.example" };
  it("missing, partial, invalid or uninstalled provider configuration throws; DEV_OUTBOX alone changes nothing; local mode is loopback-only in production", () => {
    expect(() => requireMailConfiguration(prod)).toThrow(/MAIL_PROVIDER and MAIL_FROM/);
    expect(() => requireMailConfiguration({ ...prod, MAIL_PROVIDER: "ses" })).toThrow(/MAIL_FROM/);
    expect(() => requireMailConfiguration({ ...prod, MAIL_FROM: "a@b.test" })).toThrow(/MAIL_PROVIDER/);
    expect(() => requireMailConfiguration({ ...prod, MAIL_PROVIDER: "ses", MAIL_FROM: "not-an-address" })).toThrow();
    expect(() => requireMailConfiguration({ ...prod, DEV_OUTBOX: "1" })).toThrow(/MAIL_PROVIDER and MAIL_FROM/);
    expect(() => requireMailConfiguration({ ...prod, MAIL_MODE: "local" })).toThrow(/loopback/);
    expect(() => requireMailConfiguration({ ...prod, MAIL_PROVIDER: "ses", MAIL_FROM: "a@b.test", MAIL_TRANSPORT_TIMEOUT_MS: "999999" })).toThrow(/TIMEOUT/);
    expect(requireMailConfiguration({ NODE_ENV: "production", MAIL_MODE: "local", BETTER_AUTH_URL: "http://localhost:3100" })).toEqual({ mode: "local" });
    expect(requireMailConfiguration({ NODE_ENV: "development" })).toEqual({ mode: "local" });
    const config = requireMailConfiguration({ ...prod, MAIL_PROVIDER: "ses", MAIL_FROM: "a@b.test" });
    expect(() => configuredMailTransport(config)).toThrow(/no installed transport/);
    setMailTransport({ provider: "other", send: async () => ({ status: "accepted", messageId: "x" }) });
    expect(() => configuredMailTransport(config)).toThrow(/no installed transport/);
  });

  it("wave 2 review: local mail in production needs EVERY surface origin on loopback, not only BETTER_AUTH_URL (T-70 origins win)", () => {
    const local = { NODE_ENV: "production", MAIL_MODE: "local" };
    expect(requireMailConfiguration({ ...local, BETTER_AUTH_URL: "http://localhost:3100" })).toEqual({ mode: "local" });
    expect(() => requireMailConfiguration({ ...local, BETTER_AUTH_URL: "http://localhost:3100", PLATFORM_ORIGIN: "https://bukalaris.com" })).toThrow(/loopback/);
    expect(() => requireMailConfiguration({ ...local, BETTER_AUTH_URL: "http://localhost:3100", APP_ORIGIN: "https://app.bukalaris.com" })).toThrow(/loopback/);
    expect(() => requireMailConfiguration({ ...local, PLATFORM_ORIGIN: "http://localhost:3100", OWNER_ORIGIN: "http://owner.localhost:3100" })).not.toThrow();
  });

  it("wave 2 review: the recipient must be one plain address and the subject cannot carry a header line break", async () => {
    for (const to of ["a@example.com\r\nBcc: x@example.com", "a@example.com, b@example.com", "Name <a@example.com>", "not-an-address"]) {
      await expect(dbMailer(db).send({ to, subject: "s", text: "t" }), to).rejects.toThrow(/plain address/);
    }
    await dbMailer(db).send({ to: "ok@example.com", subject: "Pesanan\r\nBcc: evil@example.com", text: "t" });
    const all = await rows();
    const row = all[all.length - 1];
    expect(row!.subject).toBe("Pesanan Bcc: evil@example.com");
  });

  it("the Mailer cannot even be created in production without configuration, so invitation and recovery mail cannot land in the dev sink", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MAIL_MODE", "");
    vi.stubEnv("MAIL_PROVIDER", "");
    vi.stubEnv("MAIL_FROM", "");
    expect(() => dbMailer(db)).toThrow();
  });

  it("the worker process exits non-zero before claiming any job when production has no provider, and says why", () => {
    const worker = fileURLToPath(new URL("../src/worker.ts", import.meta.url));
    const r = spawnSync(process.execPath, [worker, "--once"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: process.env.PATH, NODE_ENV: "production", PLATFORM_DATABASE_URL: process.env.PLATFORM_DATABASE_URL, BETTER_AUTH_URL: "https://app.bukalaris.example" },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/MAIL_PROVIDER and MAIL_FROM are required/);
    expect(r.stdout).not.toContain('"event":"started"');
  });
});
