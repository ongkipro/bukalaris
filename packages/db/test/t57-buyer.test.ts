import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buyerFingerprint, buyerFingerprintsAllKeys, buyerFingerprintKeyring } from "../src/buyer/fingerprint.ts";
import { BUYER_RESOLVE, enqueueBuyerResolve } from "../src/buyer/jobs.ts";
import { normalizePhone } from "../src/buyer/normalize.ts";
import { resolveBuyerForOrder } from "../src/buyer/resolve.ts";
import { createDb, type Executor } from "../src/client.ts";
import { localRoleUrl } from "../src/local-roles.ts";
import { jobLagByKind } from "../src/ops/jobs/observability.ts";
import { kindPolicy, runOnce } from "../src/ops/jobs/jobs.ts";
import { withBuyer, withStore } from "../src/platform/tenant.ts";
import { placeOrder, getBuyerOrder } from "../src/seller/commerce/checkout.ts";
import { exportBuyerData, findBuyerOrders, redactOrders } from "../src/seller/commerce/privacy.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { admin, buyer as checkoutBody, db, makeStore, platform } from "./helpers.ts";

// T-57 slices 2 to 4: the global buyer identity tables, the platform resolver (JOB-10), the checkout intent and the isolation of all of it
// under the real login roles. `db` is bukalaris_app, `platform` is bukalaris_platform, `admin` is the compose superuser (fixtures and
// inspection only). Every phone and e-mail is synthetic.

type Store = Awaited<ReturnType<typeof makeStore>>;
type Row = Record<string, unknown>;
const q = async <T extends Row = Row>(query: ReturnType<typeof sql>): Promise<T[]> => (await admin.execute(query)) as unknown as T[];
const count = async (table: string) => Number((await q<{ n: string }>(sql`select count(*) as n from ${sql.identifier(table)}`))[0]!.n);
const code = (c: string) => ({ cause: { code: c } });

/** `0812345<5 digits>` and its canonical form. */
const phone = (n: number) => `0812345${String(n).padStart(5, "0")}`;
const canon = (n: number) => normalizePhone(phone(n))!;
const email = (name: string) => `${name}@t57.test`;
const LANDLINE = "0215551234"; // accepted by checkout, no canonical identity

async function place(s: Store, over: Record<string, unknown> = {}) {
  const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
  const placed = await placeOrder(db, cartId, checkoutBody({ buyerPhone: phone(1), ...over }));
  return placed.orderId;
}
const resolve = (s: Store, orderId: number, requestId = "test") => resolveBuyerForOrder(platform, s.storeId, orderId, requestId);
const identifiers = () => q<{ id: string; buyer_id: string; kind: string; canonical_value: string; binding_state: string; verified_at: Date | null; account_bound_at: Date | null }>(sql`select id, buyer_id, kind, canonical_value, binding_state, verified_at, account_bound_at from buyer_identifier order by id`);
const links = () => q<{ buyer_id: string; store_id: string; order_id: string; resolved_identifier_id: string; resolution_method: string; access_state: string }>(sql`select * from buyer_order_link order by order_id`);
const events = (orderId?: number) => q<{ event_type: string; buyer_id: string; related_buyer_id: string | null; actor_type: string; actor_id: string | null; request_id: string | null }>(sql`select event_type, buyer_id, related_buyer_id, actor_type, actor_id, request_id from buyer_identity_event ${orderId === undefined ? sql`` : sql`where order_id = ${orderId}`} order by id`);
const buyers = () => q<{ id: string; status: string; display_name: string | null; primary_phone_identifier_id: string | null }>(sql`select id, status, display_name, primary_phone_identifier_id from buyer order by id`);
const linkOf = async (orderId: number) => (await q<{ buyer_id: string; resolution_method: string; access_state: string; resolved_identifier_id: string }>(sql`select buyer_id, resolution_method, access_state, resolved_identifier_id from buyer_order_link where order_id = ${orderId}`))[0];
const eventTypes = async (orderId: number) => (await events(orderId)).map((e) => e.event_type);

const dropFixtures = async () => {
  await admin.execute(sql`drop trigger if exists t57_fail on buyer_identifier`);
  await admin.execute(sql`drop function if exists t57_fail_email()`);
  await admin.execute(sql`drop trigger if exists t57_slow on buyer_identifier`);
  await admin.execute(sql`drop function if exists t57_slow()`);
};
/** Widens the window between "looked for the identifier" and "inserted it" so that a missing lock shows up as a failure, not as luck. */
const slowIdentifierInsert = async () => {
  await admin.execute(sql.raw(`create function t57_slow() returns trigger language plpgsql as $$ begin perform pg_sleep(0.08); return new; end $$`));
  await admin.execute(sql.raw(`create trigger t57_slow before insert on buyer_identifier for each row execute function t57_slow()`));
};
afterEach(dropFixtures);
const adminFixtureOwner = createDb(localRoleUrl(process.env.TEST_DATABASE_URL!, "bukalaris_owner"));
afterAll(() => adminFixtureOwner.$client.end());

describe("slice 2: tables, constraints and guards (real PostgreSQL)", () => {
  const mkBuyer = async () => Number((await q<{ id: string }>(sql`insert into buyer default values returning id`))[0]!.id);
  const mkIdentifier = async (buyerId: number, kind: "phone" | "email", value: string) =>
    Number((await q<{ id: string }>(sql`insert into buyer_identifier (buyer_id, kind, canonical_value) values (${buyerId}, ${kind}, ${value}) returning id`))[0]!.id);

  it("duplicate (kind, canonical_value) is rejected across buyers, observed or revoked alike", async () => {
    const a = await mkBuyer();
    const b = await mkBuyer();
    await mkIdentifier(a, "phone", canon(1));
    await mkIdentifier(a, "email", email("dup"));
    await expect(mkIdentifier(b, "phone", canon(1))).rejects.toMatchObject(code("23505"));
    await expect(mkIdentifier(b, "email", email("dup"))).rejects.toMatchObject(code("23505"));
    await mkIdentifier(b, "phone", canon(2)); // the other kind and a different value are fine
    await q(sql`update buyer_identifier set binding_state = 'revoked', revoked_at = now() where canonical_value = ${canon(2)}`);
    const c = await mkBuyer();
    await expect(mkIdentifier(c, "phone", canon(2))).rejects.toMatchObject(code("23505")); // a revoked value is not released: reuse is OPEN
  });

  it("a buyer has at most one live phone; a revoked phone frees the slot", async () => {
    const a = await mkBuyer();
    await mkIdentifier(a, "phone", canon(10));
    await expect(mkIdentifier(a, "phone", canon(11))).rejects.toMatchObject(code("23505"));
    await q(sql`update buyer_identifier set binding_state = 'revoked', revoked_at = now() where buyer_id = ${a} and kind = 'phone'`);
    await mkIdentifier(a, "phone", canon(11));
    expect((await identifiers()).filter((i) => i.buyer_id === String(a) && i.binding_state !== "revoked")).toHaveLength(1);
    await mkIdentifier(a, "email", email("e1"));
    await mkIdentifier(a, "email", email("e2")); // any number of e-mail aliases
  });

  it("CHECK constraints reject malformed values and impossible proof states (NULL-safe)", async () => {
    const a = await mkBuyer();
    const bad = (value: string, kind = "phone") => q(sql`insert into buyer_identifier (buyer_id, kind, canonical_value) values (${a}, ${kind}, ${value})`);
    for (const value of ["081234500001", "+6281234500001", "62812345", "6381234500001", "628123450000123456"]) await expect(bad(value), value).rejects.toMatchObject(code("23514"));
    for (const value of ["Budi@T57.test", "budi@", "budi@t57", "bu di@t57.test", `${"a".repeat(250)}@t57.test`]) await expect(bad(value, "email"), value).rejects.toMatchObject(code("23514"));
    await expect(bad(email("k"), "sms")).rejects.toMatchObject(code("23514"));
    const insert = (columns: string, values: string) => q(sql.raw(`insert into buyer_identifier (buyer_id, kind, canonical_value, ${columns}) values (${a}, 'email', '${email(`c${Math.random().toString(36).slice(2, 8)}`)}', ${values})`));
    await expect(insert("binding_state, verified_at", "'observed', now()")).rejects.toMatchObject(code("23514")); // observed means no proof
    await expect(insert("binding_state, account_bound_at", "'observed', now()")).rejects.toMatchObject(code("23514"));
    await expect(insert("binding_state", "'bound'")).rejects.toMatchObject(code("23514")); // bound needs proof and binding
    await expect(insert("binding_state, verified_at", "'bound', now()")).rejects.toMatchObject(code("23514"));
    await expect(insert("binding_state, account_bound_at", "'disputed', now()")).rejects.toMatchObject(code("23514")); // a binding time never exists without a proof time
    await expect(insert("binding_state", "'revoked'")).rejects.toMatchObject(code("23514")); // revoked needs revoked_at
    await expect(insert("binding_state, revoked_at", "'observed', now()")).rejects.toMatchObject(code("23514")); // revoked_at only for revoked
    await expect(insert("binding_state", "'merged'")).rejects.toMatchObject(code("23514"));
    await insert("binding_state, verified_at, account_bound_at", "'bound', now(), now()"); // the valid shape is accepted
    await expect(q(sql`insert into buyer (status) values ('vip')`)).rejects.toMatchObject(code("23514"));
    await expect(q(sql`insert into buyer (status, closed_at) values ('closed', null)`)).rejects.toMatchObject(code("23514"));
    await expect(q(sql`insert into buyer (status, closed_at) values ('active', now())`)).rejects.toMatchObject(code("23514"));
    await expect(q(sql`insert into buyer (display_name) values ('')`)).rejects.toMatchObject(code("23514"));
  });

  it("the primary phone is a live phone identifier of the same buyer", async () => {
    const a = await mkBuyer();
    const b = await mkBuyer();
    const phoneA = await mkIdentifier(a, "phone", canon(30));
    const emailA = await mkIdentifier(a, "email", email("pa"));
    const phoneB = await mkIdentifier(b, "phone", canon(31));
    await expect(q(sql`update buyer set primary_phone_identifier_id = ${phoneB} where id = ${a}`)).rejects.toSatisfy((e: { cause?: { code?: string } }) => ["23503", "23514"].includes(e.cause?.code ?? "")); // another buyer's identifier: the guard and the compound FK both refuse
    await expect(q(sql`update buyer set primary_phone_identifier_id = ${emailA} where id = ${a}`)).rejects.toMatchObject(code("23514")); // not a phone
    await q(sql`update buyer set primary_phone_identifier_id = ${phoneA} where id = ${a}`);
    await q(sql`update buyer_identifier set binding_state = 'revoked', revoked_at = now() where id = ${phoneB}`);
    await expect(q(sql`update buyer set primary_phone_identifier_id = ${phoneB} where id = ${b}`)).rejects.toMatchObject(code("23514")); // revoked
    await expect(q(sql`delete from buyer_identifier where id = ${phoneA}`)).rejects.toMatchObject(code("23503")); // still anchors a buyer
  });

  it("an identifier never changes owner, kind or value and a revoked one stays revoked", async () => {
    const a = await mkBuyer();
    const b = await mkBuyer();
    const id = await mkIdentifier(a, "phone", canon(40));
    await expect(q(sql`update buyer_identifier set buyer_id = ${b} where id = ${id}`)).rejects.toMatchObject(code("23514"));
    await expect(q(sql`update buyer_identifier set canonical_value = ${canon(41)} where id = ${id}`)).rejects.toMatchObject(code("23514"));
    await expect(q(sql`update buyer_identifier set kind = 'email' where id = ${id}`)).rejects.toMatchObject(code("23514"));
    await q(sql`update buyer_identifier set binding_state = 'bound', verified_at = now(), account_bound_at = now() where id = ${id}`); // a legitimate transition
    await q(sql`update buyer_identifier set binding_state = 'revoked', revoked_at = now() where id = ${id}`);
    await expect(q(sql`update buyer_identifier set binding_state = 'observed', revoked_at = null where id = ${id}`)).rejects.toMatchObject(code("23514"));
  });

  it("a link needs its seller order (compound FK), a resolving identifier of the same buyer, and is unique per order", async () => {
    const s = await makeStore("t57-link-a", { stock: 20 });
    const other = await makeStore("t57-link-b", { stock: 20 });
    const orderA = await place(s, { buyerPhone: phone(50) });
    const orderB = await place(other, { buyerPhone: phone(51) });
    const a = await mkBuyer();
    const b = await mkBuyer();
    const idA = await mkIdentifier(a, "phone", canon(50));
    const idB = await mkIdentifier(b, "phone", canon(51));
    const link = (buyerId: number, storeId: number, orderId: number, identifierId: number, extra = "'phone', 'unverified'") => q(sql.raw(`insert into buyer_order_link (buyer_id, store_id, order_id, resolved_identifier_id, resolution_method, access_state) values (${buyerId}, ${storeId}, ${orderId}, ${identifierId}, ${extra})`));
    await expect(link(a, s.storeId, 999_999, idA)).rejects.toMatchObject(code("23503")); // no such order
    await expect(link(a, s.storeId, orderB, idA)).rejects.toMatchObject(code("23503")); // an order of another store under this store id
    await expect(link(a, s.storeId, orderA, idB)).rejects.toMatchObject(code("23503")); // another buyer's identifier resolved it
    await expect(link(a, s.storeId, orderA, idA, "'sms', 'unverified'")).rejects.toMatchObject(code("23514"));
    await expect(link(a, s.storeId, orderA, idA, "'phone', 'granted'")).rejects.toMatchObject(code("23514"));
    await expect(link(a, s.storeId, orderA, idA, "'phone', 'confirmed'")).rejects.toMatchObject(code("23514")); // confirmed needs confirmed_at
    await link(a, s.storeId, orderA, idA);
    await expect(link(b, s.storeId, orderA, idB)).rejects.toMatchObject(code("23505")); // one association per seller order
    expect(await count("buyer_order_link")).toBe(1);
  });

  it("a link is written once: only its access state moves", async () => {
    const s = await makeStore("t57-guard", { stock: 20 });
    const order = await place(s, { buyerPhone: phone(60) });
    const a = await mkBuyer();
    const b = await mkBuyer();
    const idA = await mkIdentifier(a, "phone", canon(60));
    const idB = await mkIdentifier(b, "phone", canon(61));
    await q(sql`insert into buyer_order_link (buyer_id, store_id, order_id, resolved_identifier_id, resolution_method) values (${a}, ${s.storeId}, ${order}, ${idA}, 'phone')`);
    await expect(q(sql`update buyer_order_link set buyer_id = ${b}, resolved_identifier_id = ${idB} where order_id = ${order}`)).rejects.toMatchObject(code("23514"));
    await expect(q(sql`update buyer_order_link set resolution_method = 'created' where order_id = ${order}`)).rejects.toMatchObject(code("23514"));
    await q(sql`update buyer_order_link set access_state = 'confirmed', confirmed_at = now() where order_id = ${order}`); // the later confirmation service
    expect((await linkOf(order))!.access_state).toBe("confirmed");
  });

  it("identity events are append-only for everybody, the owner and the superuser included, and their CHECKs name the other buyer of a conflict", async () => {
    const s = await makeStore("t57-event", { stock: 20 });
    const order = await place(s, { buyerPhone: phone(70) });
    const a = await mkBuyer();
    const b = await mkBuyer();
    await q(sql`insert into buyer_identity_event (buyer_id, store_id, order_id, event_type, actor_type) values (${a}, ${s.storeId}, ${order}, 'buyer_created', 'system')`);
    await expect(q(sql`update buyer_identity_event set event_type = 'order_linked'`)).rejects.toMatchObject(code("42501"));
    await expect(q(sql`delete from buyer_identity_event`)).rejects.toMatchObject(code("42501"));
    await expect(adminFixtureOwner.execute(sql`update buyer_identity_event set actor_type = 'buyer'`)).rejects.toMatchObject(code("42501"));
    await expect(adminFixtureOwner.execute(sql`delete from buyer_identity_event`)).rejects.toMatchObject(code("42501"));
    expect(await count("buyer_identity_event")).toBe(1);
    const insert = (type: string, related: string, storeId = String(s.storeId), orderId = String(order), actor = "'system'") => q(sql.raw(`insert into buyer_identity_event (buyer_id, store_id, order_id, event_type, related_buyer_id, actor_type) values (${a}, ${storeId}, ${orderId}, '${type}', ${related}, ${actor})`));
    await expect(insert("phone_email_conflict", "null")).rejects.toMatchObject(code("23514")); // a conflict names the other buyer
    await expect(insert("buyer_created", String(b))).rejects.toMatchObject(code("23514")); // no other event does
    await expect(insert("phone_email_conflict", String(a))).rejects.toMatchObject(code("23514")); // never itself
    await expect(insert("buyer_deleted", "null")).rejects.toMatchObject(code("23514"));
    await expect(insert("buyer_created", "null", "null", String(order))).rejects.toMatchObject(code("23514")); // an order needs its store
    await expect(insert("buyer_created", "null", String(s.storeId), "999999")).rejects.toMatchObject(code("23503")); // same-store FK
    await expect(insert("buyer_created", "null", String(s.storeId), String(order), "'bot'")).rejects.toMatchObject(code("23514"));
    await insert("phone_email_conflict", String(b));
  });

  it("an address book allows one default per buyer and a canonical phone and area", async () => {
    const a = await mkBuyer();
    const b = await mkBuyer();
    const address = (buyerId: number, isDefault: boolean, over: Record<string, string> = {}) =>
      q(sql`insert into buyer_address (buyer_id, label, recipient_name, phone_canonical, address_text, destination_area_id, is_default)
        values (${buyerId}, ${over.label ?? "Rumah"}, 'Siti Rahma', ${over.phone ?? canon(80)}, 'Jl. Merdeka No. 1, Bandung 40111', ${over.area ?? "b1b1b1b1b1b1b1b1b1b1b1b1"}, ${isDefault})`);
    await address(a, true);
    await address(a, false);
    await address(a, false, { label: "Kantor" });
    await expect(address(a, true, { label: "Kos" })).rejects.toMatchObject(code("23505")); // a second default
    await address(b, true); // another buyer has its own default
    await expect(address(b, false, { phone: "081234500080" })).rejects.toMatchObject(code("23514"));
    await expect(address(b, false, { area: "xyz" })).rejects.toMatchObject(code("23514"));
    await expect(address(b, false, { label: "" })).rejects.toMatchObject(code("23514"));
  });
});

describe("slice 3: the resolver (ADR-0010 section 4)", () => {
  it("no identifier match: one provisional buyer, observed identifiers, the phone as primary, an unverified link and audited events", async () => {
    const s = await makeStore("t57-new");
    const order = await place(s, { buyerPhone: `+62${phone(100).slice(1)}`, buyerEmail: "Budi@T57.test" });
    expect(await resolve(s, order, "job:7")).toBe("linked");
    const [b] = await buyers();
    expect(b).toMatchObject({ status: "provisional", display_name: null });
    const ids = await identifiers();
    expect(ids.map((i) => [i.kind, i.canonical_value, i.binding_state, i.verified_at, i.account_bound_at])).toEqual([
      ["phone", canon(100), "observed", null, null],
      ["email", "budi@t57.test", "observed", null, null],
    ]);
    expect(b!.primary_phone_identifier_id).toBe(ids[0]!.id);
    expect(await links()).toMatchObject([{ buyer_id: b!.id, store_id: String(s.storeId), order_id: String(order), resolved_identifier_id: ids[0]!.id, resolution_method: "created", access_state: "unverified" }]);
    const ev = await events(order);
    expect(ev.map((e) => e.event_type)).toEqual(["buyer_created", "identifier_observed", "identifier_observed", "order_linked"]);
    expect(ev.every((e) => e.actor_type === "system" && e.actor_id === "buyer.resolve" && e.request_id === "job:7" && e.related_buyer_id === null)).toBe(true);
    expect(JSON.stringify(ev)).not.toMatch(/\d{9}|@/); // no raw contact in the evidence
  });

  it("phone-only: a known phone links to the same buyer, a new e-mail is attached as an observed alias, nothing is verified", async () => {
    const a = await makeStore("t57-pa");
    const b = await makeStore("t57-pb");
    const first = await place(a, { buyerPhone: phone(110) });
    await resolve(a, first);
    const second = await place(b, { buyerPhone: `+62${phone(110).slice(1)}`, buyerEmail: email("later") });
    expect(await resolve(b, second)).toBe("linked");
    expect(await buyers()).toHaveLength(1);
    expect(await linkOf(second)).toMatchObject({ resolution_method: "phone", access_state: "unverified" });
    expect((await identifiers()).map((i) => [i.kind, i.binding_state, i.verified_at])).toEqual([["phone", "observed", null], ["email", "observed", null]]);
    expect(await eventTypes(second)).toEqual(["identifier_observed", "order_linked"]);
  });

  it("email-only: an order without a usable phone links through a known e-mail (resolution method email)", async () => {
    const s = await makeStore("t57-eo");
    const first = await place(s, { buyerPhone: LANDLINE, buyerEmail: email("only") });
    expect(await resolve(s, first)).toBe("linked");
    expect(await linkOf(first)).toMatchObject({ resolution_method: "created" });
    expect((await identifiers()).map((i) => i.kind)).toEqual(["email"]); // no phone identity from a landline
    const second = await place(s, { buyerPhone: LANDLINE, buyerEmail: email("only") });
    expect(await resolve(s, second)).toBe("linked");
    expect(await buyers()).toHaveLength(1);
    expect(await linkOf(second)).toMatchObject({ resolution_method: "email" });
    expect(await eventTypes(second)).toEqual(["order_linked"]);
  });

  it("the same buyer by both keys: one buyer, no conflict, no new identifier", async () => {
    const a = await makeStore("t57-sb-a");
    const b = await makeStore("t57-sb-b");
    const first = await place(a, { buyerPhone: phone(120), buyerEmail: email("both") });
    await resolve(a, first);
    const second = await place(b, { buyerPhone: phone(120), buyerEmail: email("both") });
    await resolve(b, second);
    expect(await buyers()).toHaveLength(1);
    expect(await identifiers()).toHaveLength(2);
    expect(await eventTypes(second)).toEqual(["order_linked"]);
    expect(await linkOf(second)).toMatchObject({ resolution_method: "phone" });
  });

  it("phone and e-mail of different buyers: the phone wins, nothing is merged or moved, phone_email_conflict names the other buyer", async () => {
    const s = await makeStore("t57-conflict", { stock: 20 });
    await resolve(s, await place(s, { buyerPhone: phone(130), buyerEmail: email("x") }));
    await resolve(s, await place(s, { buyerPhone: phone(131), buyerEmail: email("y") }));
    const [x, y] = await buyers();
    const crossing = await place(s, { buyerPhone: phone(130), buyerEmail: email("y") });
    expect(await resolve(s, crossing)).toBe("linked");
    expect(await buyers()).toHaveLength(2); // no merge, no third buyer
    expect(await linkOf(crossing)).toMatchObject({ buyer_id: x!.id, resolution_method: "phone" });
    const owned = Object.fromEntries((await identifiers()).map((i) => [i.canonical_value, i.buyer_id]));
    expect(owned).toEqual({ [canon(130)]: x!.id, [email("x")]: x!.id, [canon(131)]: y!.id, [email("y")]: y!.id }); // e-mail y stays with buyer y
    expect((await events(crossing)).map((e) => [e.event_type, e.buyer_id, e.related_buyer_id])).toEqual([["order_linked", x!.id, null], ["phone_email_conflict", x!.id, y!.id]]);
  });

  it("a victim phone typed with an attacker e-mail that has another live phone: a new buyer, email_phone_mismatch, and the victim's later orders never link to the attacker", async () => {
    const s = await makeStore("t57-victim", { stock: 20 });
    const ATTACKER = 140;
    const VICTIM = 141;
    await resolve(s, await place(s, { buyerPhone: phone(ATTACKER), buyerEmail: email("attacker") }));
    const [attackerBuyer] = await buyers();
    const forged = await place(s, { buyerPhone: phone(VICTIM), buyerEmail: email("attacker") });
    expect(await resolve(s, forged)).toBe("linked");
    const all = await buyers();
    expect(all).toHaveLength(2);
    const victimBuyer = all.find((b) => b.id !== attackerBuyer!.id)!;
    expect(await linkOf(forged)).toMatchObject({ buyer_id: victimBuyer.id, resolution_method: "created" });
    expect((await events(forged)).map((e) => [e.event_type, e.buyer_id, e.related_buyer_id])).toContainEqual(["email_phone_mismatch", victimBuyer.id, attackerBuyer!.id]);
    const owned = (await identifiers()).map((i) => [i.canonical_value, i.buyer_id]);
    expect(owned).toContainEqual([canon(VICTIM), victimBuyer.id]);
    expect(owned).not.toContainEqual([canon(VICTIM), attackerBuyer!.id]); // the attacker's account never got the victim's phone
    expect(owned).toContainEqual([email("attacker"), attackerBuyer!.id]); // and the attacker's e-mail was not moved to the victim's account
    // The victim orders later with the phone alone: the order lands in the victim's own buyer, never the attacker's.
    const later = await place(s, { buyerPhone: phone(VICTIM) });
    await resolve(s, later);
    expect(await linkOf(later)).toMatchObject({ buyer_id: victimBuyer.id, resolution_method: "phone" });
    expect((await links()).filter((l) => l.buyer_id === attackerBuyer!.id)).toHaveLength(1);
    expect((await identifiers()).every((i) => i.verified_at === null && i.account_bound_at === null && i.binding_state === "observed")).toBe(true); // nothing became login authority
  });

  it("an attacker e-mail typed with a known victim phone is attached to the victim's buyer only as an observed alias: never verified, bound or primary", async () => {
    const s = await makeStore("t57-alias", { stock: 20 });
    await resolve(s, await place(s, { buyerPhone: phone(150), buyerEmail: email("victim") }));
    const [victim] = await buyers();
    const forged = await place(s, { buyerPhone: phone(150), buyerEmail: email("attacker-alias") });
    await resolve(s, forged);
    expect(await linkOf(forged)).toMatchObject({ buyer_id: victim!.id, access_state: "unverified" });
    const alias = (await identifiers()).find((i) => i.canonical_value === email("attacker-alias"))!;
    expect(alias).toMatchObject({ buyer_id: victim!.id, binding_state: "observed", verified_at: null, account_bound_at: null });
    expect((await buyers())[0]!.primary_phone_identifier_id).not.toBe(alias.id);
    expect((await buyers())[0]).toMatchObject({ status: "provisional", display_name: null }); // checkout never writes the profile
  });

  it("an e-mail-only buyer is not given a new phone by a checkout (recommended default); a bound e-mail accepts it as an observed, non-primary phone", async () => {
    const s = await makeStore("t57-bound", { stock: 20 });
    await resolve(s, await place(s, { buyerPhone: LANDLINE, buyerEmail: email("solo") }));
    const [solo] = await buyers();
    const withPhone = await place(s, { buyerPhone: phone(160), buyerEmail: email("solo") });
    await resolve(s, withPhone);
    const created = await buyers();
    expect(created).toHaveLength(2); // a new buyer for the phone; the e-mail stays with the e-mail-only buyer
    expect(await linkOf(withPhone)).toMatchObject({ resolution_method: "created" });
    expect((await identifiers()).find((i) => i.canonical_value === email("solo"))!.buyer_id).toBe(solo!.id);
    expect(await eventTypes(withPhone)).not.toContain("email_phone_mismatch"); // that event is for a different live phone

    await q(sql`update buyer_identifier set binding_state = 'bound', verified_at = now(), account_bound_at = now() where canonical_value = ${email("solo")}`);
    const second = await place(s, { buyerPhone: phone(161), buyerEmail: email("solo") });
    await resolve(s, second);
    expect(await linkOf(second)).toMatchObject({ buyer_id: solo!.id, resolution_method: "email" });
    const adopted = (await identifiers()).find((i) => i.canonical_value === canon(161))!;
    expect(adopted).toMatchObject({ buyer_id: solo!.id, binding_state: "observed", verified_at: null });
    expect((await buyers()).find((b) => b.id === solo!.id)!.primary_phone_identifier_id).toBeNull(); // never primary without possession proof
  });

  it("the literal ADR algorithm stays one argument away: an observed e-mail-only buyer then takes the phone", async () => {
    const s = await makeStore("t57-literal", { stock: 20 });
    await resolve(s, await place(s, { buyerPhone: LANDLINE, buyerEmail: email("lit") }));
    const [solo] = await buyers();
    const order = await place(s, { buyerPhone: phone(170), buyerEmail: email("lit") });
    const [row] = (await platform.execute(sql`select public.buyer_resolve_order(${s.storeId}::bigint, ${order}::bigint, 'literal', false) as outcome`)) as unknown as { outcome: string }[];
    expect(row!.outcome).toBe("linked");
    expect(await buyers()).toHaveLength(1);
    expect(await linkOf(order)).toMatchObject({ buyer_id: solo!.id, resolution_method: "email" });
  });

  it("replay of the same order changes nothing", async () => {
    const s = await makeStore("t57-replay");
    const order = await place(s, { buyerPhone: phone(180), buyerEmail: email("rp") });
    expect(await resolve(s, order)).toBe("linked");
    const before = JSON.stringify([await buyers(), await identifiers(), await links(), await events()]);
    expect(await resolve(s, order, "again")).toBe("already_linked");
    expect(await resolve(s, order, "and again")).toBe("already_linked");
    expect(JSON.stringify([await buyers(), await identifiers(), await links(), await events()])).toBe(before);
  });

  it("an order without a usable contact creates no buyer; a redacted snapshot is never resurrected", async () => {
    const s = await makeStore("t57-none", { stock: 20 });
    const landline = await place(s, { buyerPhone: LANDLINE });
    expect(await resolve(s, landline)).toBe("no_identifier");
    const foreign = await place(s, { buyerPhone: "+14155552671" });
    expect(await resolve(s, foreign)).toBe("no_identifier");
    const redacted = await place(s, { buyerPhone: phone(190), buyerEmail: email("gone") });
    expect((await redactOrders(s.owner, { orderIds: [redacted], override: true, reason: "permintaan data pembeli" })).orders).toBe(1);
    expect(await resolve(s, redacted)).toBe("no_identifier");
    expect([await count("buyer"), await count("buyer_identifier"), await count("buyer_order_link")]).toEqual([0, 0, 0]);
  });

  it("is target-bound: an unknown order, or an order under another store id, raises and writes nothing", async () => {
    const a = await makeStore("t57-tb-a");
    const b = await makeStore("t57-tb-b");
    const order = await place(a, { buyerPhone: phone(200) });
    await expect(resolveBuyerForOrder(platform, b.storeId, order, "x")).rejects.toThrow();
    await expect(resolveBuyerForOrder(platform, a.storeId, 987_654, "x")).rejects.toThrow();
    expect([await count("buyer"), await count("buyer_identifier"), await count("buyer_order_link"), await count("buyer_identity_event")]).toEqual([0, 0, 0, 0]);
  });

  it("only the platform login can call it: the app login is denied and no login role holds a table privilege", async () => {
    const s = await makeStore("t57-grants");
    const order = await place(s, { buyerPhone: phone(210) });
    await expect(resolveBuyerForOrder(db, s.storeId, order, "app")).rejects.toMatchObject(code("42501"));
    await expect(withStore(db, s.storeId, (tx) => resolveBuyerForOrder(tx, s.storeId, order, "app"))).rejects.toMatchObject(code("42501"));
    for (const table of ["buyer", "buyer_identifier", "buyer_order_link", "buyer_identity_event", "buyer_address"]) {
      await expect(platform.execute(sql`select 1 from ${sql.identifier(table)} limit 1`), `platform select ${table}`).rejects.toMatchObject(code("42501"));
      await expect(platform.execute(sql`delete from ${sql.identifier(table)}`), `platform delete ${table}`).rejects.toMatchObject(code("42501"));
    }
    await expect(platform.execute(sql`insert into buyer (status) values ('active')`)).rejects.toMatchObject(code("42501"));
    expect(await resolve(s, order)).toBe("linked");
  });
});

describe("slice 3: concurrency (unique-index backed)", () => {
  it("concurrent orders of one phone and e-mail, in different spellings, produce exactly one buyer and one set of identifiers", async () => {
    const s = await makeStore("t57-conc", { stock: 50 });
    await slowIdentifierInsert();
    const spellings = ["081234500300", "+6281234500300", "6281234500300", "006281234500300"]; // the spellings the checkout validator lets through
    const orders: number[] = [];
    for (let i = 0; i < 8; i++) orders.push(await place(s, { buyerPhone: spellings[i % spellings.length], buyerEmail: email("conc") }));
    const settled = await Promise.allSettled(orders.map((o) => resolve(s, o, `c${o}`)));
    expect(settled.map((r) => (r.status === "fulfilled" ? r.value : String(r.reason)))).toEqual(orders.map(() => "linked"));
    expect(await buyers()).toHaveLength(1);
    expect((await identifiers()).map((i) => [i.kind, i.canonical_value])).toEqual([["phone", "6281234500300"], ["email", email("conc")]]);
    expect(await links()).toHaveLength(orders.length);
    expect(new Set((await links()).map((l) => l.buyer_id)).size).toBe(1);
    const types = (await events()).map((e) => e.event_type);
    expect(types.filter((t) => t === "buyer_created")).toHaveLength(1);
    expect(types.filter((t) => t === "identifier_observed")).toHaveLength(2);
    expect(types.filter((t) => t === "order_linked")).toHaveLength(orders.length);
  });

  it("concurrent phone-versus-email conflict: no deadlock, every identifier owned once, every order linked, one owner for the contested e-mail", async () => {
    const s = await makeStore("t57-race", { stock: 60 });
    await slowIdentifierInsert();
    for (let round = 0; round < 6; round++) {
      const p1 = phone(400 + round * 4);
      const p2 = phone(401 + round * 4);
      const contested = email(`race${round}`);
      const o1 = await place(s, { buyerPhone: p1, buyerEmail: contested });
      const o2 = await place(s, { buyerPhone: p2, buyerEmail: contested });
      const settled = await Promise.allSettled([resolve(s, o1), resolve(s, o2)]);
      expect(settled.map((r) => r.status), `round ${round}: ${JSON.stringify(settled)}`).toEqual(["fulfilled", "fulfilled"]);
      const l1 = (await linkOf(o1))!;
      const l2 = (await linkOf(o2))!;
      expect(l1.buyer_id).not.toBe(l2.buyer_id); // two phones are two buyers: the shared e-mail never merges them
      const owners = (await identifiers()).filter((i) => i.canonical_value === contested);
      expect(owners).toHaveLength(1); // exactly one owner of the contested e-mail
      expect([l1.buyer_id, l2.buyer_id]).toContain(owners[0]!.buyer_id);
      const mismatches = (await events()).filter((e) => e.event_type === "email_phone_mismatch" && [l1.buyer_id, l2.buyer_id].includes(e.buyer_id));
      expect(mismatches).toHaveLength(1);
    }
  });

  it("a crossing of four orders over two phones and two e-mails leaves every key owned once and every order linked", async () => {
    const s = await makeStore("t57-cross", { stock: 20 });
    await slowIdentifierInsert();
    const combos = [[500, "ca"], [500, "cb"], [501, "ca"], [501, "cb"]] as const;
    const orders = [];
    for (const [p, e] of combos) orders.push(await place(s, { buyerPhone: phone(p), buyerEmail: email(e) }));
    const settled = await Promise.allSettled(orders.map((o) => resolve(s, o)));
    expect(settled.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
    expect((await identifiers()).map((i) => i.canonical_value).sort()).toEqual([canon(500), canon(501), email("ca"), email("cb")].sort());
    expect(await links()).toHaveLength(4);
    const phoneOwner = Object.fromEntries((await identifiers()).filter((i) => i.kind === "phone").map((i) => [i.canonical_value, i.buyer_id]));
    for (const [i, [p]] of combos.entries()) expect((await linkOf(orders[i]!))!.buyer_id, `order ${i} follows its phone`).toBe(phoneOwner[canon(p)]); // phone first, whatever the interleaving
  });

  it("concurrent replays of the same order write the association once: one linked, the rest already_linked", async () => {
    const s = await makeStore("t57-replay-race");
    await slowIdentifierInsert();
    const order = await place(s, { buyerPhone: phone(550), buyerEmail: email("rr") });
    const settled = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => resolve(s, order, `r${i}`)));
    expect(settled.map((r) => (r.status === "fulfilled" ? r.value : String(r.reason))).sort()).toEqual(["already_linked", "already_linked", "already_linked", "already_linked", "already_linked", "linked"]);
    expect([await count("buyer"), await count("buyer_identifier"), await count("buyer_order_link")]).toEqual([1, 2, 1]);
    expect((await events(order)).filter((e) => e.event_type === "order_linked")).toHaveLength(1);
  });

  it("the unique indexes alone reject a concurrent duplicate: two raw inserts of one identifier, one wins", async () => {
    const a = Number((await q<{ id: string }>(sql`insert into buyer default values returning id`))[0]!.id);
    const b = Number((await q<{ id: string }>(sql`insert into buyer default values returning id`))[0]!.id);
    const insert = (buyerId: number) => admin.execute(sql`insert into buyer_identifier (buyer_id, kind, canonical_value) values (${buyerId}, 'phone', ${canon(600)})`);
    const settled = await Promise.allSettled([insert(a), insert(b)]);
    expect(settled.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await count("buyer_identifier")).toBe(1);
  });
});

describe("slice 3: outbox intent, crash and retry, rollback", () => {
  const failEmailInsert = async () => {
    await admin.execute(sql.raw(`create function t57_fail_email() returns trigger language plpgsql as $$ begin if new.kind = 'email' then raise exception 't57 simulated crash'; end if; return new; end $$`));
    await admin.execute(sql.raw(`create trigger t57_fail before insert on buyer_identifier for each row execute function t57_fail_email()`));
  };

  it("checkout writes one ID-only buyer.resolve intent with the order, and a replayed checkout adds none", async () => {
    const s = await makeStore("t57-intent");
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const body = checkoutBody({ buyerPhone: phone(700), buyerEmail: email("intent") });
    const first = await placeOrder(db, cartId, body);
    const again = await placeOrder(db, cartId, body);
    expect(again).toEqual({ orderId: first.orderId, replayed: true });
    const jobs = await q<{ kind: string; store_id: string; key: string; payload: Row; status: string; priority: number }>(sql`select kind, store_id, key, payload, status, priority from job where kind = ${BUYER_RESOLVE}`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ store_id: String(s.storeId), key: `order:${first.orderId}`, payload: { orderId: first.orderId }, status: "pending" });
    expect(Object.keys(jobs[0]!.payload)).toEqual(["orderId"]); // IDs only: no phone, e-mail or name travels in the outbox
    expect(JSON.stringify(jobs[0])).not.toMatch(/0812|t57\.test/);
    expect(kindPolicy(BUYER_RESOLVE)).toMatchObject({ priority: 2, replaySafe: true }); // bulk: never ahead of a payment or an order e-mail
    expect(await count("buyer")).toBe(0); // nothing resolved in the checkout request itself
  });

  it("a failed checkout leaves no intent and no association", async () => {
    const s = await makeStore("t57-rollback");
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    await admin.execute(sql`update variant set stock = 0 where id = ${s.variantId}`);
    await expect(placeOrder(db, cartId, checkoutBody({ buyerPhone: phone(710) }))).rejects.toMatchObject({ code: "out_of_stock" });
    expect(await count("order")).toBe(0);
    expect((await q(sql`select 1 from job where kind = ${BUYER_RESOLVE}`)).length).toBe(0);
  });

  it("the worker resolves the order after commit; a second run of the finished job changes nothing", async () => {
    const s = await makeStore("t57-worker");
    const order = await place(s, { buyerPhone: phone(720), buyerEmail: email("worker") });
    const outcomes = (await runOnce(platform, { workerId: "t57" })).filter((o) => o.kind === BUYER_RESOLVE);
    expect(outcomes).toMatchObject([{ status: "done" }]);
    expect(await linkOf(order)).toMatchObject({ resolution_method: "created", access_state: "unverified" });
    const before = JSON.stringify([await identifiers(), await links(), await events()]);
    await admin.execute(sql`update job set status = 'pending', next_attempt_at = now() where kind = ${BUYER_RESOLVE}`); // an audited requeue of a replay-safe kind
    await runOnce(platform, { workerId: "t57" });
    expect(JSON.stringify([await identifiers(), await links(), await events()])).toBe(before);
    expect(new Set((await events(order)).map((e) => e.request_id)).size).toBe(1); // every event of the order carries the job id of the run that wrote it
    expect((await events(order))[0]!.request_id).toMatch(/^job:\d+$/);
  });

  it("outbox crash and retry: a failing resolution leaves the guest order intact and a visible retriable job, the retry completes exactly once", async () => {
    const s = await makeStore("t57-crash");
    const order = await place(s, { buyerPhone: phone(730), buyerEmail: email("crash") });
    await failEmailInsert();
    const first = (await runOnce(platform, { workerId: "t57" })).filter((o) => o.kind === BUYER_RESOLVE);
    expect(first).toMatchObject([{ status: "pending", attempts: 1, error: expect.stringContaining("t57 simulated crash") }]);
    // Atomic: the phone was attached inside the same statement before the e-mail failed, and none of it remains.
    expect([await count("buyer"), await count("buyer_identifier"), await count("buyer_order_link"), await count("buyer_identity_event")]).toEqual([0, 0, 0, 0]);
    const [o] = await q<{ status: string; buyer_phone: string }>(sql`select status, buyer_phone from "order" where id = ${order}`);
    expect(o).toMatchObject({ status: "awaiting_confirmation", buyer_phone: phone(730) }); // the guest order is valid and untouched
    const [pending] = await q<{ status: string; attempts: number; last_error: string; due_in_s: number }>(sql`select status, attempts, last_error, extract(epoch from (next_attempt_at - now())) as due_in_s from job where kind = ${BUYER_RESOLVE}`);
    expect(pending).toMatchObject({ status: "pending", attempts: 1 });
    expect(Number(pending!.due_in_s)).toBeGreaterThan(0); // backoff, not a hot loop
    const lag = (await jobLagByKind(platform, new Date(Date.now() + 3_600_000))).find((k) => k.kind === BUYER_RESOLVE);
    expect(lag).toMatchObject({ pending: 1, dead: 0 }); // the backlog is observable per kind (OBS-6)

    await dropFixtures();
    await admin.execute(sql`update job set next_attempt_at = now() where kind = ${BUYER_RESOLVE}`);
    expect((await runOnce(platform, { workerId: "t57" })).filter((o) => o.kind === BUYER_RESOLVE)).toMatchObject([{ status: "done" }]);
    expect(await buyers()).toHaveLength(1);
    expect(await links()).toHaveLength(1);
    expect((await events()).filter((e) => e.event_type === "buyer_created")).toHaveLength(1);
  });

  it("a caller transaction that fails after the resolver leaves no partial attachment", async () => {
    const s = await makeStore("t57-txn");
    const order = await place(s, { buyerPhone: phone(740), buyerEmail: email("txn") });
    await expect(
      platform.transaction(async (tx) => {
        expect(await resolveBuyerForOrder(tx, s.storeId, order, "txn")).toBe("linked");
        throw new Error("boom after the resolver");
      }),
    ).rejects.toThrow("boom after the resolver");
    expect([await count("buyer"), await count("buyer_identifier"), await count("buyer_order_link"), await count("buyer_identity_event")]).toEqual([0, 0, 0, 0]);
    expect(await resolve(s, order)).toBe("linked");
  });

  it("the backlog of pending intents is visible before the worker runs, and a dead job is listed", async () => {
    const s = await makeStore("t57-backlog", { stock: 20 });
    await place(s, { buyerPhone: phone(750) });
    await place(s, { buyerPhone: phone(751) });
    const lag = (await jobLagByKind(platform, new Date(Date.now() + 1000))).find((k) => k.kind === BUYER_RESOLVE);
    expect(lag).toMatchObject({ pending: 2, priority: 2 });
    expect(lag!.oldestDueAgeMs).not.toBeNull();
  });

  it("enqueuing is a no-op for the same order twice (unique kind and key)", async () => {
    const s = await makeStore("t57-dup");
    const order = await place(s, { buyerPhone: phone(760) });
    const second = await withStore(db, s.storeId, (tx) => enqueueBuyerResolve(tx, s.storeId, order));
    expect(second.created).toBe(false);
    expect((await q(sql`select 1 from job where kind = ${BUYER_RESOLVE}`)).length).toBe(1);
  });
});

describe("slice 2 and 4: isolation under the real roles", () => {
  /** Buyer X shops at both stores (one phone); buyer Y only at B. */
  async function world() {
    const a = await makeStore("t57-iso-a", { stock: 20 });
    const b = await makeStore("t57-iso-b", { stock: 20 });
    const xa = await place(a, { buyerPhone: phone(800), buyerEmail: email("x") });
    const xb = await place(b, { buyerPhone: phone(800) });
    const yb = await place(b, { buyerPhone: phone(801), buyerEmail: email("y") });
    for (const [s, o] of [[a, xa], [b, xb], [b, yb]] as const) await resolve(s, o);
    const [x, y] = await buyers();
    await q(sql`insert into buyer_address (buyer_id, label, recipient_name, phone_canonical, address_text, destination_area_id, is_default) values
      (${x!.id}, 'Rumah', 'Budi X', ${canon(800)}, 'Jl. Merdeka No. 1, Bandung 40111', 'b1b1b1b1b1b1b1b1b1b1b1b1', true), (${y!.id}, 'Rumah', 'Siti Y', ${canon(801)}, 'Jl. Braga No. 9, Bandung 40111', 'b1b1b1b1b1b1b1b1b1b1b1b1', true)`);
    return { a, b, xa, xb, yb, x: Number(x!.id), y: Number(y!.id) };
  }
  const tables = ["buyer", "buyer_identifier", "buyer_order_link", "buyer_address"] as const;
  const rowsOf = async (exec: Executor, table: string): Promise<Row[]> => (await exec.execute(sql`select * from ${sql.identifier(table)}`)) as unknown as Row[];

  it("store A's context reads nothing of the global identity, and never another store's association", async () => {
    const w = await world();
    await withStore(db, w.a.storeId, async (tx) => {
      for (const t of tables) expect(await rowsOf(tx, t), `store A reads ${t}`).toEqual([]);
    });
    await expect(withStore(db, w.a.storeId, (tx) => tx.execute(sql`select 1 from buyer_identity_event`))).rejects.toMatchObject(code("42501")); // no login role reads the evidence
    await withStore(db, w.b.storeId, async (tx) => {
      for (const t of tables) expect(await rowsOf(tx, t), `store B reads ${t}`).toEqual([]);
    });
    for (const t of tables) expect(await rowsOf(db, t), `no context reads ${t}`).toEqual([]);
    await expect(db.execute(sql`select 1 from buyer_identity_event`)).rejects.toMatchObject(code("42501"));
  });

  it("a buyer reads only their own rows, across stores; buyer Y's identifier, address and links are invisible to buyer X", async () => {
    const w = await world();
    const asX = await withBuyer(db, w.x, async (tx) => ({
      buyers: await rowsOf(tx, "buyer"),
      identifiers: await rowsOf(tx, "buyer_identifier"),
      links: await rowsOf(tx, "buyer_order_link"),
      addresses: await rowsOf(tx, "buyer_address"),
    }));
    expect(asX.buyers.map((b) => String(b.id))).toEqual([String(w.x)]);
    expect(asX.identifiers.map((i) => i.canonical_value).sort()).toEqual([canon(800), email("x")].sort());
    expect(asX.links.map((l) => String(l.order_id)).sort()).toEqual([String(w.xa), String(w.xb)].sort()); // the buyer's own history spans both stores
    expect(new Set(asX.links.map((l) => String(l.store_id)))).toEqual(new Set([String(w.a.storeId), String(w.b.storeId)]));
    expect(asX.addresses).toHaveLength(1);
    expect(asX.addresses[0]).toMatchObject({ recipient_name: "Budi X" });

    const asY = await withBuyer(db, w.y, async (tx) => ({ identifiers: await rowsOf(tx, "buyer_identifier"), links: await rowsOf(tx, "buyer_order_link"), addresses: await rowsOf(tx, "buyer_address") }));
    expect(asY.identifiers.map((i) => i.canonical_value).sort()).toEqual([canon(801), email("y")].sort());
    expect(asY.links.map((l) => String(l.order_id))).toEqual([String(w.yb)]);
    expect(asY.addresses[0]).toMatchObject({ recipient_name: "Siti Y" });
    // An explicit filter on the other buyer's id still returns nothing: the policy, not the query, decides.
    const spy = await withBuyer(db, w.x, (tx) => tx.execute(sql`select * from buyer_identifier where buyer_id = ${w.y}`));
    expect(spy).toHaveLength(0);
    const spyLinks = await withBuyer(db, w.x, (tx) => tx.execute(sql`select * from buyer_order_link where store_id = ${w.b.storeId} and order_id = ${w.yb}`));
    expect(spyLinks).toHaveLength(0);
  });

  it("a buyer context together with a store context opens only the buyer's own rows and still only that store's orders", async () => {
    const w = await world();
    const seen = await withStore(db, w.a.storeId, (tx) =>
      withBuyer(tx, w.x, async (inner) => ({
        links: (await rowsOf(inner, "buyer_order_link")).length,
        joined: ((await inner.execute(sql`select o.id from buyer_order_link l join "order" o on o.store_id = l.store_id and o.id = l.order_id`)) as unknown as { id: string }[]).map((r) => String(r.id)),
      })),
    );
    expect(seen.links).toBe(2); // both links are the buyer's own
    expect(seen.joined).toEqual([String(w.xa)]); // store B's order stays behind store B's policy
  });

  it("the app login cannot write any identity row, with or without a context, and cannot forge a context it was not given", async () => {
    const w = await world();
    const attempts = [
      sql`insert into buyer (status) values ('active')`,
      sql`insert into buyer_identifier (buyer_id, kind, canonical_value) values (${w.x}, 'email', 'forged@t57.test')`,
      sql`insert into buyer_order_link (buyer_id, store_id, order_id, resolved_identifier_id, resolution_method) values (${w.x}, ${w.b.storeId}, ${w.yb}, 1, 'phone')`,
      sql`insert into buyer_address (buyer_id, label, recipient_name, phone_canonical, address_text, destination_area_id) values (${w.x}, 'x', 'Budi X', ${canon(800)}, 'Jl. Merdeka No. 1, Bandung 40111', 'b1b1b1b1b1b1b1b1b1b1b1b1')`,
      sql`update buyer set display_name = 'Pwned' where id = ${w.x}`,
      sql`update buyer_order_link set access_state = 'confirmed', confirmed_at = now()`,
      sql`delete from buyer_identifier`,
      sql`delete from buyer_address`,
    ];
    for (const attempt of attempts) {
      await expect(withBuyer(db, w.x, (tx) => tx.execute(attempt))).rejects.toMatchObject(code("42501"));
      await expect(db.execute(attempt)).rejects.toMatchObject(code("42501"));
    }
    expect((await buyers()).every((b) => b.display_name === null)).toBe(true);
  });

  it("a seller's own privacy lookups see only their store's order snapshots and expose no buyer identity", async () => {
    const w = await world();
    const found = await findBuyerOrders(w.a.owner, phone(800));
    expect(found.orders.map((o) => o.id)).toEqual([w.xa]); // store B's order of the same phone is not visible to store A
    const exported = JSON.stringify(await exportBuyerData(w.a.owner, `+62${phone(800).slice(1)}`));
    expect(exported).not.toMatch(/buyer_?[iI]d|canonical|binding|primaryPhone|"links"/);
    expect(exported).toContain(phone(800)); // the seller's own snapshot, exactly as typed
    expect((await findBuyerOrders(w.b.owner, phone(801))).orders.map((o) => o.id)).toEqual([w.yb]);
  });
});

describe("slice 4: zero buyer-visible friction, no leakage, snapshots untouched", () => {
  it("the checkout answer is the same for a contact the platform knows and one it has never seen", async () => {
    const a = await makeStore("t57-same-a", { stock: 20 });
    const b = await makeStore("t57-same-b", { stock: 20 });
    await resolve(a, await place(a, { buyerPhone: phone(900), buyerEmail: email("known") }));
    await admin.execute(sql`update buyer set display_name = 'Nama Profil Asli', status = 'active'`);
    const cartKnown = await setCartLine(b.sf, undefined, { variantId: b.variantId, quantity: 1 }, "add");
    const cartUnknown = await setCartLine(b.sf, undefined, { variantId: b.variantId, quantity: 1 }, "add");
    const known = await placeOrder(db, cartKnown, checkoutBody({ buyerPhone: phone(900), buyerEmail: email("known"), buyerName: "Orang Lain" }));
    const unknown = await placeOrder(db, cartUnknown, checkoutBody({ buyerPhone: phone(901), buyerEmail: email("fresh"), buyerName: "Orang Lain" }));
    expect(Object.keys(known).sort()).toEqual(["orderId", "replayed"]);
    expect(Object.keys(unknown).sort()).toEqual(Object.keys(known).sort());
    expect([known.replayed, unknown.replayed]).toEqual([false, false]);
    const viewKnown = await getBuyerOrder(db, known.orderId, cartKnown);
    const viewUnknown = await getBuyerOrder(db, unknown.orderId, cartUnknown);
    expect(Object.keys(viewKnown!).sort()).toEqual(Object.keys(viewUnknown!).sort());
    expect(JSON.stringify(viewKnown)).not.toMatch(/Nama Profil Asli|buyer_?[iI]d|provisional|canonical/); // no stored name, status or id of the platform profile
    expect(viewKnown).toMatchObject({ buyerName: "Orang Lain" }); // the typed snapshot, not the profile
  });

  it("resolution never rewrites the order snapshot and never writes the profile", async () => {
    const s = await makeStore("t57-snapshot", { stock: 20 });
    const first = await place(s, { buyerPhone: `+62${phone(910).slice(1)}`, buyerEmail: "Mixed.Case@T57.test", buyerName: "Nama Ketikan", shippingAddress: "Jl. Ketikan No. 5, Bandung 40111" });
    const snapshot = async (id: number) => JSON.stringify((await q(sql`select * from "order" where id = ${id}`))[0]);
    const before = await snapshot(first);
    await resolve(s, first);
    expect(await snapshot(first)).toBe(before);
    expect(before).toContain(`+62${phone(910).slice(1)}`); // as typed, not canonicalised
    expect(before).toContain("Mixed.Case@T57.test".toLowerCase()); // checkout's own lower-casing, unchanged
    await admin.execute(sql`update buyer set display_name = 'Profil Asli'`);
    const second = await place(s, { buyerPhone: phone(910), buyerName: "Nama Lain" });
    await resolve(s, second);
    expect((await buyers())[0]!.display_name).toBe("Profil Asli");
  });

  it("a seller's redaction changes the store snapshot only: the global identity is untouched and a redacted number matches no lookup", async () => {
    const s = await makeStore("t57-redact", { stock: 20 });
    const order = await place(s, { buyerPhone: phone(920), buyerEmail: email("redact") });
    await resolve(s, order);
    const before = JSON.stringify([await buyers(), await identifiers(), await links(), await events()]);
    await redactOrders(s.owner, { orderIds: [order], override: true, reason: "permintaan data pembeli" });
    expect(JSON.stringify([await buyers(), await identifiers(), await links(), await events()])).toBe(before);
    expect((await findBuyerOrders(s.owner, phone(920))).orders).toEqual([]);
    expect((await q<{ buyer_phone: string }>(sql`select buyer_phone from "order" where id = ${order}`))[0]!.buyer_phone).toBe("[dihapus]");
  });

  it("the canonical phone the synchronous checks use (affiliate self-referral, T-52) equals the resolved identifier, whatever the spelling", async () => {
    const s = await makeStore("t57-agree", { stock: 20 });
    const spellings = ["081234500930", "+6281234500930", "6281234500930", "006281234500930"];
    for (const typed of spellings) {
      const order = await place(s, { buyerPhone: typed });
      await resolve(s, order);
      const [row] = await q<{ buyer_phone: string; canonical_value: string }>(sql`select o.buyer_phone, i.canonical_value from buyer_order_link l join buyer_identifier i on i.id = l.resolved_identifier_id join "order" o on o.store_id = l.store_id and o.id = l.order_id where l.order_id = ${order}`);
      expect(normalizePhone(row!.buyer_phone), typed).toBe(row!.canonical_value);
    }
    expect(await buyers()).toHaveLength(1);
  });
});

describe("rate-limit keys and the contact fingerprint ring", () => {
  it("every spelling of one number shares one checkout counter, and the counter row holds a keyed fingerprint, never the number", async () => {
    const s = await makeStore("t57-limit", { stock: 20 });
    for (const typed of ["081234500940", "+6281234500940", "6281234500940"]) await place(s, { buyerPhone: typed });
    await place(s, { buyerPhone: "081234500941" });
    const rows = await q<{ key: string; count: number }>(sql`select key, count from rate_limit where key like 'order:phone:%' order by key`);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => Number(r.count)).sort()).toEqual([1, 3]);
    for (const r of rows) expect(r.key).toMatch(/^order:phone:t1\.[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toMatch(/8123450094/);
    expect(rows.find((r) => Number(r.count) === 3)!.key).toBe(`order:phone:${buyerFingerprint("rate.order_phone", "phone", "6281234500940")}`);
  });

  it("checkout fails closed without a valid ring: the order is refused before anything is written", async () => {
    const s = await makeStore("t57-nokey");
    const cartId = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    for (const bad of ["", "k1:AAAA", "nocolon", "k1:" + Buffer.alloc(31).toString("base64"), "bad id:" + Buffer.alloc(32, 1).toString("base64")]) {
      vi.stubEnv("KEYRING_BUYER_FINGERPRINT", bad);
      await expect(placeOrder(db, cartId, checkoutBody({ buyerPhone: phone(950) })), bad).rejects.toThrow("buyer_key_unavailable");
    }
    vi.unstubAllEnvs();
    expect(await count("order")).toBe(0);
  });

  it("fingerprints are deterministic, purpose- and kind-separated, key-bound and rotate without losing the old ones", () => {
    const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
    vi.stubEnv("KEYRING_BUYER_FINGERPRINT", `k1:${key(1)}`);
    const one = buyerFingerprint("rate.order_phone", "phone", "6281234500001");
    expect(one).toMatch(/^k1\.[0-9a-f]{64}$/);
    expect(buyerFingerprint("rate.order_phone", "phone", "6281234500001")).toBe(one);
    expect(buyerFingerprint("rate.order_phone", "phone", "6281234500002")).not.toBe(one);
    expect(buyerFingerprint("rate.order_phone", "email", "6281234500001")).not.toBe(one); // kind is part of the input
    expect(one).not.toContain("6281234500001");
    vi.stubEnv("KEYRING_BUYER_FINGERPRINT", `k2:${key(2)},k1:${key(1)}`);
    expect(buyerFingerprintKeyring().map((k) => k.keyId)).toEqual(["k2", "k1"]);
    const rotated = buyerFingerprint("rate.order_phone", "phone", "6281234500001");
    expect(rotated.startsWith("k2.")).toBe(true);
    expect(rotated.slice(3)).not.toBe(one.slice(3)); // a different key gives a different value
    expect(buyerFingerprintsAllKeys("rate.order_phone", "phone", "6281234500001")).toEqual([rotated, one]); // lookups across a rotation try both
    vi.unstubAllEnvs();
  });

  it("a key reused from another purpose, a duplicate key id or a short key is refused", () => {
    const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
    vi.stubEnv("KEYRING_TAX_IDENTITY", `t1:${key(7)}`);
    vi.stubEnv("KEYRING_BUYER_FINGERPRINT", `k1:${key(7)}`);
    expect(() => buyerFingerprintKeyring()).toThrow("buyer_key_purpose_reused");
    vi.stubEnv("KEYRING_TAX_IDENTITY", "");
    vi.stubEnv("IDENTITY_FINGERPRINT_KEY", `f1:${key(7)}`);
    expect(() => buyerFingerprintKeyring()).toThrow("buyer_key_purpose_reused");
    vi.stubEnv("IDENTITY_FINGERPRINT_KEY", "");
    vi.stubEnv("INTEGRATION_TOKEN_KEY", key(7));
    expect(() => buyerFingerprintKeyring()).toThrow("buyer_key_purpose_reused");
    vi.stubEnv("INTEGRATION_TOKEN_KEY", "");
    vi.stubEnv("KEYRING_BUYER_FINGERPRINT", `k1:${key(1)},k1:${key(2)}`);
    expect(() => buyerFingerprintKeyring()).toThrow("buyer_key_unavailable");
    vi.stubEnv("KEYRING_BUYER_FINGERPRINT", `k1:${key(1)}`);
    expect(buyerFingerprintKeyring()).toHaveLength(1);
    vi.unstubAllEnvs();
  });
});

describe("local demo reset", () => {
  it("removes the links, events and orphaned buyers of demo stores only; the platform login cannot call it", async () => {
    const demo = await makeStore("demo-t57", { stock: 20 });
    const real = await makeStore("t57-real", { stock: 20 });
    await resolve(demo, await place(demo, { buyerPhone: phone(960), buyerEmail: email("demo") }));
    const realOrder = await place(real, { buyerPhone: phone(961) });
    await resolve(real, realOrder);
    await resolve(demo, await place(demo, { buyerPhone: phone(961) })); // a buyer shared with a real store must survive
    await expect(platform.execute(sql`select reset_demo_buyers(array[${demo.storeId}]::bigint[])`)).rejects.toMatchObject(code("42501"));
    await expect(db.execute(sql`select reset_demo_buyers(array[${demo.storeId}]::bigint[])`)).rejects.toMatchObject(code("42501"));
    const [removed] = (await adminFixtureOwner.execute(sql`select reset_demo_buyers(array[${demo.storeId}, ${real.storeId}]::bigint[]) as n`)) as unknown as { n: string }[];
    expect(Number(removed!.n)).toBeGreaterThan(0);
    expect(await links()).toMatchObject([{ order_id: String(realOrder) }]); // the real store's link stays (its slug is not demo-)
    expect((await identifiers()).map((i) => i.canonical_value)).toEqual([canon(961)]); // the demo-only buyer and its identifiers went, the shared one stayed
    expect(await buyers()).toHaveLength(1);
    expect((await q<{ store_id: string }>(sql`select distinct store_id from buyer_identity_event`)).map((r) => r.store_id)).toEqual([String(real.storeId)]); // no event of the demo store remains
  });
});
