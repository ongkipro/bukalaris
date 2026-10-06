import { and, eq, like } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { dbMailer, type Mailer } from "../src/accounts.ts";
import { createProduct } from "../src/catalog.ts";
import { placeOrder } from "../src/checkout.ts";
import { claimBatch, enqueue, getHandler, runOnce } from "../src/jobs.ts";
import { enqueueOrderNotifications, getOrderForLink, ORDER_LINK_TTL_MS, ORDER_NOTIFY, setNotifyMailer, signOrderLink, verifyOrderLink } from "../src/notify.ts";
import { transitionOrder } from "../src/orders.ts";
import { fakeProviders } from "../src/providers.ts";
import { job, mailOutbox, membership, orderNotification, user } from "../src/schema.ts";
import { setCartLine } from "../src/storefront.ts";
import { admin, buyer, db, makeStore, makeUser, platform, seller } from "./helpers.ts";

// mail_outbox has no FK to the truncated tables, so the shared helper's cascade does not reach it.
beforeEach(() => admin.execute("truncate mail_outbox restart identity"));

const notifyJobs = (orderId: number) =>
  platform
    .select({ key: job.key, status: job.status, attempts: job.attempts, payload: job.payload, lastError: job.lastError })
    .from(job)
    .where(and(eq(job.kind, ORDER_NOTIFY), like(job.key, `notify:${orderId}:%`)))
    .orderBy(job.id);
const mails = (orderId: number) =>
  platform
    .select({ to: mailOutbox.toEmail, subject: mailOutbox.subject, text: mailOutbox.textBody, html: mailOutbox.htmlBody })
    .from(mailOutbox)
    .where(like(mailOutbox.textBody, `%Pesanan #${orderId} ·%`))
    .orderBy(mailOutbox.id);
const notifyOutcomes = async (workerId = "W") => (await runOnce(platform, { workerId })).filter((o) => o.kind === ORDER_NOTIFY);
const makeDue = (orderId: number) =>
  platform.execute(`update job set next_attempt_at = now() - interval '1 second', locked_until = case when locked_until is null then null else now() - interval '1 second' end where key like 'notify:${orderId}:%'`);
const ownerEmail = async (userId: string) => (await platform.select({ email: user.email }).from(user).where(eq(user.id, userId)))[0]!.email;
const BUYER = "budi@example.com";

async function orderWith(s: Awaited<ReturnType<typeof makeStore>>, over: Record<string, unknown> = {}) {
  const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
  const input = buyer({ buyerEmail: BUYER, ...over });
  const { orderId } = await placeOrder(db, cartId, input);
  return { orderId, cartId, input };
}

describe("order e-mail notifications (T-36, PR-21)", () => {
  it("checkout enqueues created notifications in the order transaction; buyer only with an e-mail; replay adds nothing", async () => {
    const s = await makeStore("toko-a");
    const { orderId, cartId, input } = await orderWith(s, { buyerEmail: " Budi@Example.com " });
    expect(await notifyJobs(orderId)).toMatchObject([
      { key: `notify:${orderId}:created:buyer`, status: "pending", payload: { orderId, event: "created", recipient: "buyer" } },
      { key: `notify:${orderId}:created:seller`, status: "pending", payload: { orderId, event: "created", recipient: "seller" } },
    ]);
    // Replay with the same idempotency key returns the same order and enqueues nothing new.
    expect(await placeOrder(db, cartId, input)).toEqual({ orderId, replayed: true });
    expect(await notifyJobs(orderId)).toHaveLength(2);

    // No e-mail (COD buyers are never required to give one): seller job only; an empty field counts as none.
    const { orderId: plain } = await orderWith(s, { buyerEmail: "" });
    expect(await notifyJobs(plain)).toMatchObject([{ key: `notify:${plain}:created:seller` }]);
    await expect(orderWith(s, { buyerEmail: "not-an-email" })).rejects.toMatchObject({ issues: [{ message: "Alamat email tidak valid." }] });

    // A failed checkout (out of stock) leaves neither an order nor a job; an aborted transaction leaves no job.
    const big = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 99 }, "add");
    await expect(placeOrder(db, big, buyer({ buyerEmail: BUYER }))).rejects.toMatchObject({ code: "out_of_stock" });
    const before = (await platform.select().from(job)).length;
    await expect(
      platform.transaction(async (tx) => {
        await enqueueOrderNotifications(tx, s.storeId, orderId, "ship");
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect((await platform.select().from(job)).length).toBe(before);
    // Actions without a notification are a no-op.
    await platform.transaction((tx) => enqueueOrderNotifications(tx, s.storeId, orderId, "process"));
    expect((await platform.select().from(job)).length).toBe(before);
  });

  it("sends exactly one mail per event and recipient: worker re-run, lost lease and repeated action never duplicate", async () => {
    const s = await makeStore("toko-a");
    const owner = await ownerEmail(s.ownerId);
    const { orderId } = await orderWith(s);
    expect(await notifyOutcomes()).toMatchObject([{ status: "done" }, { status: "done" }]);
    expect(await mails(orderId)).toMatchObject([
      { to: BUYER, subject: `Pesanan #${orderId} di Toko toko-a diterima` },
      { to: owner, subject: `[Toko toko-a] Pesanan COD #${orderId} menunggu konfirmasi` },
    ]);
    expect(await notifyOutcomes()).toEqual([]);
    expect(await mails(orderId)).toHaveLength(2);

    // Confirm → one buyer job. Worker A runs the handler and dies before completing the job.
    await transitionOrder(s.owner, orderId, "confirm");
    const [j] = await claimBatch(platform, "A", 5);
    expect(j).toMatchObject({ kind: ORDER_NOTIFY, key: `notify:${orderId}:confirmed:buyer` });
    await getHandler(ORDER_NOTIFY)!({ db: platform, providers: fakeProviders }, j!);
    expect(await mails(orderId)).toHaveLength(3);
    // Lease expired: B reclaims and re-runs the handler; the order_notification key stops a second mail.
    await makeDue(orderId);
    expect(await notifyOutcomes("B")).toMatchObject([{ id: j!.id, status: "done", attempts: 2 }]);
    expect(await mails(orderId)).toHaveLength(3);
    expect(await platform.select().from(orderNotification).where(eq(orderNotification.orderId, orderId))).toHaveLength(3);

    // Repeating the action is rejected before any enqueue; a manual duplicate enqueue is a no-op on (kind, key).
    await expect(transitionOrder(s.owner, orderId, "confirm")).rejects.toMatchObject({ code: "invalid_transition" });
    expect(await enqueue(platform, { kind: ORDER_NOTIFY, storeId: s.storeId, key: `notify:${orderId}:confirmed:buyer`, payload: {} })).toEqual({ id: null, created: false });
    expect(await notifyJobs(orderId)).toHaveLength(3);
  });

  it("a failed send retries through the outbox and the mail still goes out once", async () => {
    const s = await makeStore("toko-a");
    const { orderId } = await orderWith(s);
    let down = true;
    const flaky = (exec: Parameters<typeof dbMailer>[0]): Mailer => {
      const real = dbMailer(exec);
      return {
        async send(mail) {
          if (down) throw new Error("smtp 451 try later password=hunter2");
          await real.send(mail);
        },
      };
    };
    setNotifyMailer(flaky);
    try {
      expect(await notifyOutcomes()).toMatchObject([
        { status: "pending", attempts: 1, error: "Error: smtp 451 try later password=[redacted]" },
        { status: "pending", attempts: 1 },
      ]);
      expect(await mails(orderId)).toHaveLength(0);
      expect(await platform.select().from(orderNotification).where(eq(orderNotification.orderId, orderId))).toHaveLength(0); // rolled back with the mail
      expect(await notifyOutcomes()).toEqual([]); // not due until the backoff elapses
      down = false;
      await makeDue(orderId);
      expect(await notifyOutcomes()).toMatchObject([{ status: "done", attempts: 2 }, { status: "done", attempts: 2 }]);
      expect(await mails(orderId)).toHaveLength(2);
      expect(await notifyJobs(orderId)).toMatchObject([{ status: "done", lastError: null }, { status: "done", lastError: null }]);
    } finally {
      setNotifyMailer(dbMailer);
    }
  });

  it("covers the lifecycle: confirmed and shipped (with tracking) go to the buyer, cancel/reject to buyer and owners only, other actions send nothing", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const ownerA = await ownerEmail(a.ownerId);
    const ownerB = await ownerEmail(b.ownerId);
    // A second owner and a staff member in store A: owners get seller mail, staff do not.
    const owner2 = await makeUser("owner2");
    const staff = await makeUser("staff");
    await platform.insert(membership).values([
      { storeId: a.storeId, userId: owner2, role: "owner" },
      { storeId: a.storeId, userId: staff, role: "staff" },
    ]);
    const owner2Email = await ownerEmail(owner2);

    const { orderId } = await orderWith(a);
    expect(await notifyOutcomes()).toHaveLength(2);
    expect((await mails(orderId)).map((m) => m.to).sort()).toEqual([BUYER, ownerA, owner2Email].sort());

    await transitionOrder(a.owner, orderId, "confirm");
    await transitionOrder(a.owner, orderId, "process");
    expect(await notifyOutcomes()).toHaveLength(1);
    expect((await mails(orderId)).at(-1)).toMatchObject({ to: BUYER, subject: `Pesanan #${orderId} dikonfirmasi oleh Toko toko-a` });

    await transitionOrder(await seller(staff, a.storeId), orderId, "ship", { trackingNumber: "JNE-0012345" });
    expect(await notifyOutcomes()).toHaveLength(1);
    const shipped = (await mails(orderId)).at(-1)!;
    expect(shipped).toMatchObject({ to: BUYER, subject: `Pesanan #${orderId} dikirim · resi JNE-0012345` });
    expect(shipped.text).toContain("Nomor resi: JNE-0012345");
    expect(shipped.html).toContain("<strong>JNE-0012345</strong>");
    await transitionOrder(a.owner, orderId, "complete");
    expect(await notifyOutcomes()).toEqual([]);
    expect(await mails(orderId)).toHaveLength(5);

    // Transfer order cancelled by staff: buyer + both owners (not the staff member, not store B's owner).
    const { orderId: t } = await orderWith(a, { paymentMethod: "manual_transfer" });
    await transitionOrder(await seller(staff, a.storeId), t, "cancel", { reason: "Pembeli berubah pikiran" });
    await runOnce(platform, { workerId: "W" });
    const cancelled = await mails(t);
    expect(cancelled.map((m) => m.to).sort()).toEqual([BUYER, ownerA, owner2Email, BUYER, ownerA, owner2Email].sort());
    expect(cancelled.filter((m) => m.subject.includes("dibatalkan")).map((m) => m.to).sort()).toEqual([BUYER, ownerA, owner2Email].sort());
    expect(cancelled.some((m) => m.text.includes("Pembeli berubah pikiran"))).toBe(false); // the seller's reason stays internal

    // COD reject → the same cancelled mails; store B's order reaches only store B's owner.
    const { orderId: r } = await orderWith(a, { buyerEmail: "" });
    await transitionOrder(a.owner, r, "reject", { reason: "Nomor tidak bisa dihubungi" });
    const { orderId: ob } = await orderWith(b);
    await runOnce(platform, { workerId: "W" });
    expect((await mails(r)).map((m) => `${m.subject} → ${m.to}`).sort()).toEqual(
      [
        `[Toko toko-a] Pesanan COD #${r} menunggu konfirmasi → ${ownerA}`,
        `[Toko toko-a] Pesanan COD #${r} menunggu konfirmasi → ${owner2Email}`,
        `[Toko toko-a] Pesanan #${r} dibatalkan → ${ownerA}`,
        `[Toko toko-a] Pesanan #${r} dibatalkan → ${owner2Email}`,
      ].sort(),
    );
    expect((await mails(ob)).map((m) => m.to).sort()).toEqual([BUYER, ownerB].sort());
    expect((await platform.select().from(mailOutbox)).some((m) => m.toEmail === ownerB && m.textBody.includes("Toko toko-a"))).toBe(false);
  });

  it("escapes every interpolated value in the HTML body and keeps the plain text readable", async () => {
    const s = await makeStore("toko-a");
    const nasty = `<b>Kaos & "Co"</b>`;
    const productId = await createProduct(s.owner, { title: nasty, status: "active", variant: { title: "XL <img src=x onerror=alert(1)>", price: 50_000, stock: 5 } });
    const variantId = (await platform.query.variant.findFirst({ where: (v, { eq }) => eq(v.productId, productId) }))!.id;
    const cartId = await setCartLine(s.sf, undefined, { variantId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, cartId, buyer({ buyerEmail: BUYER, buyerName: "Budi <script>alert(1)</script>" }));
    await runOnce(platform, { workerId: "W" });
    const [m] = await mails(orderId);
    expect(m!.text).toContain(`- ${nasty} · XL <img src=x onerror=alert(1)> × 1`);
    expect(m!.text).toContain("Halo Budi <script>alert(1)</script>");
    expect(m!.html).toContain("&lt;b&gt;Kaos &amp; &quot;Co&quot;&lt;/b&gt; · XL &lt;img src=x onerror=alert(1)&gt;");
    expect(m!.html).toContain("Halo Budi &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(m!.html).not.toContain("<script>");
    expect(m!.html).not.toContain("<img");
    expect(m!.html).not.toContain("<b>");
    expect(m!.html).not.toMatch(/https?:\/\/(?!localhost)/); // no external assets or links
  });

  it("signed status link: verifies, expires, rejects tampering and never opens another order", async () => {
    const s = await makeStore("toko-a");
    const { orderId: a } = await orderWith(s);
    const { orderId: b } = await orderWith(s, { buyerEmail: "" });
    await runOnce(platform, { workerId: "W" });

    const tokenA = signOrderLink(a);
    expect(tokenA).toMatch(new RegExp(`^${a}\\.[0-9]+\\.[A-Za-z0-9_-]{43}$`));
    expect(verifyOrderLink(tokenA)).toBe(a);
    const view = (await getOrderForLink(db, tokenA))!;
    expect(view).toMatchObject({ id: a, storeName: "Toko toko-a", status: "awaiting_confirmation", courier: "JNE Express (simulasi)", trackingNumber: null, total: 117_500 });
    expect(view.lines).toMatchObject([{ productTitle: "Kaos toko-a", variantTitle: "M", quantity: 1, lineTotal: 100_000 }]);
    expect(view.destinationAreaLabel).toContain("Menteng");
    for (const k of ["shippingAddress", "buyerPhone", "buyerEmail", "storeId", "idempotencyKey", "requestHash"]) expect(view).not.toHaveProperty(k);
    // The buyer mail carries a link that opens exactly this order.
    const [mail] = await mails(a);
    const inMail = /\/o\/([0-9]+\.[0-9]+\.[A-Za-z0-9_-]+)/.exec(mail!.text)![1]!;
    expect(verifyOrderLink(inMail)).toBe(a);
    expect(mail!.text).not.toMatch(new RegExp(`/o/${b}\\.`));

    // Expiry: just inside is fine, at/after the boundary is dead; a link signed in the past expires on time.
    const [, expStr] = tokenA.split(".");
    const exp = Number(expStr) * 1000;
    expect(verifyOrderLink(tokenA, exp - 1)).toBe(a);
    expect(verifyOrderLink(tokenA, exp)).toBeNull();
    expect(verifyOrderLink(signOrderLink(a, Date.now() - ORDER_LINK_TTL_MS - 1_000))).toBeNull();
    expect(await getOrderForLink(db, tokenA, exp + 1)).toBeNull();

    // Tampering: other order id, pushed-out expiry, altered signature, wrong shape.
    const [idPart, expPart, sig] = tokenA.split(".") as [string, string, string];
    expect(verifyOrderLink(`${b}.${expPart}.${sig}`)).toBeNull();
    expect(verifyOrderLink(`${idPart}.${Number(expPart) + 86_400}.${sig}`)).toBeNull();
    const flipped = (sig.at(-1) === "A" ? "B" : "A") + sig.slice(1);
    expect(verifyOrderLink(`${idPart}.${expPart}.${flipped}`)).toBeNull();
    expect(verifyOrderLink(`${idPart}.${expPart}.${sig.slice(0, 42)}`)).toBeNull();
    for (const bad of ["", "abc", `${a}`, `${a}.${expPart}`, `${a}.${expPart}.${sig}.extra`, `${a}.${expPart}.${"!".repeat(43)}`]) expect(verifyOrderLink(bad)).toBeNull();
    expect(await getOrderForLink(db, `${b}.${expPart}.${sig}`)).toBeNull();
    // A different secret invalidates every link (rotation).
    const saved = process.env.ORDER_LINK_SECRET;
    process.env.ORDER_LINK_SECRET = "another-secret";
    try {
      expect(verifyOrderLink(tokenA)).toBeNull();
      expect(verifyOrderLink(signOrderLink(a))).toBe(a);
    } finally {
      process.env.ORDER_LINK_SECRET = saved;
    }
    // A valid link for a deleted/unknown id shows nothing.
    expect(await getOrderForLink(db, signOrderLink(999_999))).toBeNull();
  });
});
