import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { chooseDestination, evidence, login, testPhone } from "./helpers";

// T-57: global buyer identity, end to end against the real worker (the third Playwright webServer resolves the `buyer.resolve` outbox
// intents). The buyer never sees the association: checkout stays registration-free and answers the same for a known and an unknown
// contact. Synthetic contacts only. The resolver matrix, concurrency and role isolation are proven by packages/db/test/t57-*.test.ts.
const url = process.env.E2E_DATABASE_URL;
if (!url || !/_e2e\b/.test(url)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
const sql = postgres(url, { max: 1, onnotice: () => {} });
test.afterAll(() => sql.end());

const canonical = (phone: string) => `62${phone.replace(/^\+?(62|0)/, "")}`;
let emailSeq = 0;
const freshEmail = (tag: string, info: { project: { name: string } }) => `t57-${tag}-${info.project.name}-${Date.now() % 1e6}-${emailSeq++}@example.com`;

async function buy(page: Page, store: "toko-a" | "toko-b", fields: { phone: string; email?: string; name?: string }) {
  await page.context().clearCookies();
  await page.goto(`/s/${store}`);
  await page.getByRole("link", { name: store === "toko-a" ? /Kaos Katun Basic/ : /Kopi Arabika/ }).click();
  await page.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await page.getByRole("link", { name: "Checkout" }).click();
  await chooseDestination(page);
  await page.getByLabel("Nama").fill(fields.name ?? "Pembeli T57");
  await page.getByLabel("Nomor HP").fill(fields.phone);
  if (fields.email) await page.getByLabel(/^Email/).fill(fields.email);
  await page.getByLabel("Alamat lengkap").fill("Jl. Identitas No. 57, Bandung 40111");
  await page.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  return Number((await page.getByTestId("order-id").textContent())!.replace("#", ""));
}

/** Everything the buyer can read on the confirmation page, with the order-specific parts blanked: what must not differ between contacts. */
const visibleShape = async (page: Page) =>
  (await page.getByRole("main").innerText()).replace(/#\d+/g, "#N").replace(/\d[\d.\s]*\d/g, "N").replace(/\s+/g, " ").trim();

const linkOf = (orderId: number) => sql`select l.buyer_id, l.store_id, l.resolution_method, l.access_state, i.kind, i.canonical_value from buyer_order_link l join buyer_identifier i on i.id = l.resolved_identifier_id where l.order_id = ${orderId}`;
/** The worker is a separate process: wait for its `buyer.resolve` job instead of sleeping. */
const resolved = async (orderId: number) => {
  await expect.poll(async () => (await linkOf(orderId)).length, { timeout: 30_000, intervals: [500, 1000] }).toBe(1);
  return (await linkOf(orderId))[0]!;
};
const identifiersOf = (buyerId: string | number) => sql`select kind, canonical_value, binding_state, verified_at, account_bound_at from buyer_identifier where buyer_id = ${buyerId} order by id`;

test("guest checkout stays registration-free (phone only, phone with e-mail) and each order is associated automatically after commit, unverified", async ({ page }, info) => {
  const phone = testPhone();
  const first = await buy(page, "toko-a", { phone });
  // Zero buyer-visible friction: no sign-up, password, OTP or login wording on the confirmation, and no redirect to an account page.
  await expect(page).toHaveURL(/\/checkout\/confirmation/);
  const text = await page.getByRole("main").innerText();
  expect(text).not.toMatch(/\b(otp|kata sandi|password|daftar|buat akun|masuk|login|akun|profil)\b/i);
  await evidence(page, info, "t57-confirmation-phone-only");

  const link = await resolved(first);
  expect(link).toMatchObject({ resolution_method: "created", access_state: "unverified", kind: "phone", canonical_value: canonical(phone) });
  const identifiers = await identifiersOf(link.buyer_id);
  expect(identifiers.map((i) => [i.kind, i.binding_state, i.verified_at, i.account_bound_at])).toEqual([["phone", "observed", null, null]]);

  const email = freshEmail("po", info);
  const second = await buy(page, "toko-a", { phone: `+62${phone.slice(1)}`, email });
  const again = await resolved(second);
  expect(again.buyer_id).toBe(link.buyer_id); // the same phone in another spelling: one buyer
  expect(again.resolution_method).toBe("phone");
  expect((await identifiersOf(link.buyer_id)).map((i) => [i.kind, i.canonical_value, i.binding_state, i.verified_at])).toEqual([
    ["phone", canonical(phone), "observed", null],
    ["email", email, "observed", null],
  ]);
  expect((await sql`select count(*)::int as n from buyer where id in (select buyer_id from buyer_identifier where canonical_value = ${canonical(phone)})`)[0]!.n).toBe(1);
  // The order snapshot is exactly what the buyer typed.
  expect((await sql`select buyer_phone from "order" where id = ${second}`)[0]!.buyer_phone).toBe(`+62${phone.slice(1)}`);
});

test("repeated checkouts at two seller stores with the same phone create exactly one buyer; each seller sees only their own order snapshot", async ({ page }, info) => {
  const [storeB] = await sql`select id from store where slug = 'toko-b'`;
  // Toko B has no pickup area in the seed (checkout2.spec asserts that): give it one for this test only, and take it away again.
  await sql`insert into store_pickup_area (store_id, area_id, area_label, address_text, updated_by) values (${storeB!.id}, 'a1a1a1a1a1a1a1a1a1a1a1a1', 'Braga, Sumur Bandung, Bandung, Jawa Barat 40111', 'Jl. Braga No. 1', 't57-e2e') on conflict (store_id) do nothing`;
  try {
    const phone = testPhone();
    const inA = await buy(page, "toko-a", { phone });
    const inB = await buy(page, "toko-b", { phone: `+62${phone.slice(1)}`, email: freshEmail("two", info) });
    const a = await resolved(inA);
    const b = await resolved(inB);
    expect(b.buyer_id).toBe(a.buyer_id);
    expect(new Set([a.store_id, b.store_id]).size).toBe(2); // one identity, two stores
    expect((await sql`select count(*)::int as n from buyer where id = ${a.buyer_id}`)[0]!.n).toBe(1);
    expect((await sql`select count(*)::int as n from buyer_order_link where buyer_id = ${a.buyer_id}`)[0]!.n).toBe(2);

    // Seller A: own snapshot only, as typed; never store B's order, spelling or any buyer identity.
    await page.context().clearCookies();
    await login(page, "owner-a@bukalaris.local");
    await page.goto(`/seller/orders/${inA}`);
    await expect(page.getByTestId("order-status")).toBeVisible();
    const detail = await page.content();
    expect(detail).toContain(phone);
    expect(detail).not.toContain(`+62${phone.slice(1)}`); // store B's spelling of the same buyer
    expect(detail).not.toContain(canonical(phone)); // the canonical key is never rendered to a seller
    await page.goto("/seller/orders");
    expect(await page.content()).not.toContain(`/seller/orders/${inB}`);
    expect((await page.request.get(`/seller/orders/${inB}`)).status()).toBe(404); // another store's order id grants nothing
    await evidence(page, info, "t57-seller-a-own-snapshot");
  } finally {
    await sql`delete from store_pickup_area where store_id = ${storeB!.id} and updated_by = 't57-e2e'`;
    // dashboard.spec asserts that Toko B has never had an order today (its "empty store" state): cancel and back-date (beyond the 30-day window) what this test placed.
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`; // fixture cleanup as the superuser: skip the ledger and status guards
      await tx`update "order" set status = 'cancelled', created_at = created_at - interval '90 days', updated_at = updated_at - interval '90 days' where store_id = ${storeB!.id}`;
    });
  }
});

test("a victim phone submitted with another buyer's e-mail neither reveals a profile nor becomes an alias of the attacker; the response is the same for known and unknown contacts", async ({ page }, info) => {
  const attackerPhone = testPhone();
  const victimPhone = testPhone();
  const attackerEmail = freshEmail("att", info);
  const established = await buy(page, "toko-a", { phone: attackerPhone, email: attackerEmail, name: "Penyerang" });
  const attacker = await resolved(established);
  const attackerShape = await visibleShape(page);

  // The victim's phone with the attacker's e-mail: same confirmation, no hint that either contact is known.
  const forged = await buy(page, "toko-a", { phone: victimPhone, email: attackerEmail, name: "Korban Palsu" });
  const forgedShape = await visibleShape(page);
  expect(forgedShape).toBe(attackerShape);
  await evidence(page, info, "t57-confirmation-forged");
  const forgedLink = await resolved(forged);
  expect(forgedLink.buyer_id).not.toBe(attacker.buyer_id); // a new buyer for the victim's phone; nothing moved
  expect((await sql`select event_type from buyer_identity_event where order_id = ${forged} order by id`).map((r) => r.event_type)).toContain("email_phone_mismatch");
  const attackerOwns = (await identifiersOf(attacker.buyer_id)).map((i) => i.canonical_value);
  expect(attackerOwns).toContain(attackerEmail);
  expect(attackerOwns).not.toContain(canonical(victimPhone)); // the attacker's account never gains the victim's phone
  expect((await sql`select count(*)::int as n from buyer_identifier where verified_at is not null or account_bound_at is not null or binding_state <> 'observed'`)[0]!.n).toBe(0); // nothing became login authority

  // The victim's own later order lands in the victim's buyer, and an order of a brand-new contact looks identical to the buyer.
  const own = await buy(page, "toko-a", { phone: victimPhone, name: "Korban Asli" });
  expect((await resolved(own)).buyer_id).toBe(forgedLink.buyer_id);
  const unknownShape = await visibleShape(page);
  expect(unknownShape).toBe(attackerShape);
  expect(unknownShape).not.toMatch(/Penyerang|Korban|\b(akun|profil)\b/i);
});
