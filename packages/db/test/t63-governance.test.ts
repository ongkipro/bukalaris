import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { acknowledgeRisk, activeVerificationReveals, riskQueue, listVerifications, reviewVerification, revealVerificationField, storeStatusHistory, submitVerification } from "../src/ops/accounts-governance-stores.ts";
import { addCaseNote, getCase, listCases, moveCase, openCase } from "../src/ops/accounts-governance-cases.ts";
import { consoleAccessEvents } from "../src/ops/console.ts";
import { setStoreStatus } from "../src/platform/platform.ts";
import { placeOrder } from "../src/seller/commerce/checkout.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { accountStatusEvent, accountVerification, auditLog, order, shipment, supportCase, supportCaseNote } from "../src/schema.ts";
import { sellerContext, storefrontScope } from "../src/platform/scoped.ts";
import { admin, buyer, db, makeOperator, makeStore, platform } from "./helpers.ts";

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string }; name?: string }) => e.code ?? e.cause?.code ?? e.name);
const sqlState = (p: Promise<unknown>) => p.then(() => "ok", (e: { cause?: { code?: string }; code?: string }) => e.cause?.code ?? e.code);

beforeEach(async () => {
  await admin.execute(sql`truncate support_case, support_case_note, account_status_event, account_verification, store_risk_ack, support_action, access_review_decision, support_recovery_link, personal_data_access_event restart identity cascade`);
});

const STAFF = ["cases.read", "cases.write", "tenants.read", "tenants.manage", "tenants.verify", "accounts.reveal", "audit.read"] as const;

describe("DATA-14 core: cases and notes (SA-20)", () => {
  it("opens a case with a number, a scrubbed title and its audit row; a case is never deleted", async () => {
    const op = await makeOperator(STAFF);
    const c = await openCase(op, { title: "Telepon 081234567890 tidak bisa masuk", reason: "pelapor menghubungi dukungan" });
    expect(c.caseNumber).toBe(`C-${String(c.id).padStart(6, "0")}`);
    const [row] = await admin.select().from(supportCase).where(eq(supportCase.id, c.id));
    expect(row!.title).not.toMatch(/\d{8,}/);
    const audits = await admin.select().from(auditLog).where(and(eq(auditLog.actorUserId, op.userId), eq(auditLog.action, "case.open")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorCapability: "cases.write", subjectKind: "case", outcome: "allowed", accessLevel: "write", purposeCode: "case_opened" });
    await expect(sqlState(platform.execute(sql`delete from support_case`))).resolves.toBe("42501"); // no DELETE privilege
    await expect(sqlState(admin.execute(sql`delete from support_case`))).resolves.toBe("42501"); // and the guard trigger binds the owner too
  });

  it("notes are scrubbed of contact, URL, token and number shapes before storage and again on the way out", async () => {
    const op = await makeOperator(STAFF);
    const { id } = await openCase(op, { title: "kasus uji", reason: "uji penyaringan catatan" });
    await addCaseNote(op, id, "Hubungi budi@contoh.id atau +62 812-3456-7890, lihat https://x.id/reset?token=abc123 dan password: hunter2 rekening 1234567890123");
    const [stored] = await admin.select().from(supportCaseNote).where(eq(supportCaseNote.caseId, id));
    for (const leak of ["budi@contoh.id", "812-3456", "https://", "abc123", "hunter2", "1234567890123"]) expect(stored!.body).not.toContain(leak);
    const view = await getCase(op, id);
    expect(JSON.stringify(view)).not.toMatch(/budi@|hunter2|1234567890123/);
  });

  it("note rows are append-only under the real platform role and against the owner (UPDATE and DELETE refused)", async () => {
    const op = await makeOperator(STAFF);
    const { id } = await openCase(op, { title: "kasus uji", reason: "uji append-only" });
    await addCaseNote(op, id, "catatan pertama");
    await expect(sqlState(platform.execute(sql`update support_case_note set body = 'diubah'`))).resolves.toBe("42501");
    await expect(sqlState(platform.execute(sql`delete from support_case_note`))).resolves.toBe("42501");
    await expect(sqlState(admin.execute(sql`update support_case_note set body = 'diubah'`))).resolves.toBe("42501"); // trigger: superuser is not exempt
    await expect(sqlState(admin.execute(sql`delete from support_case_note`))).resolves.toBe("42501");
  });

  it("moves follow the legal transitions as a compare-and-swap: two staff moving the same case yield one change", async () => {
    const op = await makeOperator(STAFF);
    const other = await makeOperator(STAFF);
    const { id } = await openCase(op, { title: "kasus uji", reason: "uji transisi kasus" });
    await expect(code(moveCase(op, id, { from: "open", to: "resolved", resolutionCode: "done", reason: "loncat langsung" }))).resolves.toBe("illegal_transition");
    const results = await Promise.all([op, other].map((o) => code(moveCase(o, id, { from: "open", to: "in_progress", reason: "mulai ditangani" }))));
    expect(results.sort()).toEqual(["conflict", "ok"]);
    await expect(code(moveCase(op, id, { from: "in_progress", to: "resolved", reason: "selesai tanpa kode" }))).resolves.toBe("resolution_required");
    await moveCase(op, id, { from: "in_progress", to: "resolved", resolutionCode: "answered", reason: "sudah dijawab" });
    await moveCase(op, id, { from: "resolved", to: "closed", reason: "ditutup" });
    // closed: no note, no move, and the database refuses a direct reopen (closed implies resolved and never changes again)
    await expect(code(addCaseNote(op, id, "terlambat"))).resolves.toBe("case_closed");
    await expect(sqlState(admin.execute(sql`update support_case set status = 'open' where id = ${id}`))).resolves.toBe("23514");
    expect((await listCases(op, { status: "closed" })).items.map((i) => i.id)).toEqual([id]);
  });

  it("cases.write is required to open, cases.read to read; refusals leave a denial row and no case", async () => {
    const reader = await makeOperator(["cases.read"]);
    await expect(code(openCase(reader, { title: "kasus uji", reason: "tanpa izin menulis" }))).resolves.toBe("forbidden");
    expect(await admin.select().from(supportCase)).toHaveLength(0);
    const denials = await admin.select().from(auditLog).where(and(eq(auditLog.actorUserId, reader.userId), eq(auditLog.action, "operator.denied")));
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ actorCapability: "cases.write", outcome: "denied" });
    const none = await makeOperator([]);
    await expect(code(listCases(none))).resolves.toBe("forbidden");
  });

  it("an audit row that cannot be written aborts the action (no case, no note)", async () => {
    const op = await makeOperator(STAFF);
    await admin.execute(sql`create or replace function t63_audit_fail() returns trigger language plpgsql as $$ begin if new.action like 'case.%' then raise exception 'audit down' using errcode = '53100'; end if; return new; end $$`);
    await admin.execute(sql`create trigger t63_audit_fail before insert on audit_log for each row execute function t63_audit_fail()`);
    try {
      await expect(code(openCase(op, { title: "kasus uji", reason: "audit gagal" }))).resolves.toBe("53100");
      expect(await admin.select().from(supportCase)).toHaveLength(0);
    } finally {
      await admin.execute(sql`drop trigger if exists t63_audit_fail on audit_log`);
      await admin.execute(sql`drop function if exists t63_audit_fail()`);
    }
  });
});

describe("store lifecycle (SA-02, SA-03): one event per transition, optional case, concurrency", () => {
  it("creation writes the first event; suspend and reactivate write exactly one event each, with reason code, actor and case", async () => {
    const s = await makeStore("toko-uji");
    const op = await makeOperator(STAFF);
    const c = await openCase(op, { kind: "risk", subjectKind: "store", subjectId: String(s.storeId), title: "laporan pembeli", reason: "kasus untuk penangguhan" });
    await setStoreStatus(op, s.storeId, { status: "suspended", reasonCode: "payment_dispute", reason: "sengketa pembayaran berulang", caseId: c.caseNumber });
    await setStoreStatus(op, s.storeId, { status: "active", reasonCode: "case_resolved", reason: "kasus selesai", caseId: c.id });
    const history = await storeStatusHistory(op, s.storeId);
    expect(history.map((h) => [h.fromStatus, h.toStatus, h.reasonCode])).toEqual([["suspended", "active", "case_resolved"], ["active", "suspended", "payment_dispute"], [null, "active", "store_created"]]);
    expect(history[1]).toMatchObject({ actorUserId: op.userId, caseId: c.id });
    const audits = await admin.select().from(auditLog).where(and(eq(auditLog.storeId, s.storeId), eq(auditLog.actorUserId, op.userId)));
    expect(audits.map((a) => a.action).sort()).toEqual(["store.active", "store.suspended"]);
    expect(audits.find((a) => a.action === "store.suspended")).toMatchObject({ caseId: c.caseNumber, purposeCode: "payment_dispute", actorCapability: "tenants.manage", outcome: "allowed" });
  });

  it("a case that is closed, unknown or about another store is refused with no change and no event", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const op = await makeOperator(STAFF);
    const closed = await openCase(op, { title: "kasus lama", reason: "kasus untuk ditutup" });
    await moveCase(op, closed.id, { from: "open", to: "in_progress", reason: "dikerjakan" });
    await moveCase(op, closed.id, { from: "in_progress", to: "resolved", resolutionCode: "done", reason: "selesai" });
    const other = await openCase(op, { subjectKind: "store", subjectId: String(b.storeId), title: "toko lain", reason: "kasus toko lain" });
    for (const caseId of [closed.id, 999999, other.id]) {
      await expect(code(setStoreStatus(op, a.storeId, { status: "suspended", reason: "alasan cukup panjang", caseId }))).resolves.toMatch(/case_required|case_mismatch/);
    }
    expect((await storeStatusHistory(op, a.storeId)).map((h) => h.toStatus)).toEqual(["active"]);
  });

  it("two staff members suspending at once yield one transition, one event and one conflict; the loser changes nothing", async () => {
    const s = await makeStore("toko-balap");
    const x = await makeOperator(STAFF);
    const y = await makeOperator(STAFF);
    const res = await Promise.all([x, y].map((o) => code(setStoreStatus(o, s.storeId, { status: "suspended", reason: "penangguhan serentak" }))));
    expect(res.sort()).toEqual(["conflict", "ok"]);
    expect((await storeStatusHistory(x, s.storeId)).filter((h) => h.toStatus === "suspended")).toHaveLength(1);
    expect((await admin.select().from(auditLog).where(eq(auditLog.action, "store.suspended"))).filter((a) => a.storeId === s.storeId)).toHaveLength(1);
    await expect(code(setStoreStatus(x, 999999, { status: "suspended", reason: "toko tidak ada" }))).resolves.toBe("not_found");
  });

  it("an audit row that cannot be written aborts the transition: the store stays as it was and no event exists", async () => {
    const s = await makeStore("toko-audit");
    const op = await makeOperator(STAFF);
    await admin.execute(sql`create or replace function t63_audit_fail() returns trigger language plpgsql as $$ begin if new.action = 'store.suspended' then raise exception 'audit down' using errcode = '53100'; end if; return new; end $$`);
    await admin.execute(sql`create trigger t63_audit_fail before insert on audit_log for each row execute function t63_audit_fail()`);
    try {
      await expect(code(setStoreStatus(op, s.storeId, { status: "suspended", reason: "audit sedang mati" }))).resolves.toBe("53100");
    } finally {
      await admin.execute(sql`drop trigger if exists t63_audit_fail on audit_log`);
      await admin.execute(sql`drop function if exists t63_audit_fail()`);
    }
    expect((await platform.query.store.findFirst({ where: (t, { eq: e }) => e(t.id, s.storeId) }))!.status).toBe("active");
    expect((await storeStatusHistory(op, s.storeId)).map((h) => h.toStatus)).toEqual(["active"]);
  });

  it("a grant revoked while the change is in flight aborts the transition (capability re-check inside the transaction)", async () => {
    const s = await makeStore("toko-cabut");
    const op = await makeOperator(STAFF);
    // The revocation commits between the change and its audit row: a trigger on the history insert stands in for the other request.
    await admin.execute(sql`create or replace function t63_revoke() returns trigger language plpgsql as $$ begin delete from operator_grant where user_id = ${sql.raw(`'${op.userId}'`)} and capability = 'tenants.manage'; return new; end $$`);
    await admin.execute(sql`create trigger t63_revoke after insert on account_status_event for each row when (new.to_status = 'suspended') execute function t63_revoke()`);
    try {
      await expect(code(setStoreStatus(op, s.storeId, { status: "suspended", reason: "grant dicabut di tengah jalan" }))).resolves.toBe("forbidden");
    } finally {
      await admin.execute(sql`drop trigger if exists t63_revoke on account_status_event`);
      await admin.execute(sql`drop function if exists t63_revoke()`);
    }
    expect((await platform.query.store.findFirst({ where: (t, { eq: e }) => e(t.id, s.storeId) }))!.status).toBe("active");
  });

  it("every status event is append-only: UPDATE and DELETE are refused for the platform role and for the owner", async () => {
    const s = await makeStore("toko-riwayat");
    const op = await makeOperator(STAFF);
    await setStoreStatus(op, s.storeId, { status: "suspended", reason: "uji riwayat" });
    for (const stmt of [sql`update account_status_event set reason_code = 'x_y'`, sql`delete from account_status_event`]) {
      await expect(sqlState(platform.execute(stmt))).resolves.toBe("42501");
      await expect(sqlState(admin.execute(stmt))).resolves.toBe("42501");
    }
    expect((await admin.select().from(accountStatusEvent)).length).toBeGreaterThanOrEqual(2);
  });

  it("the migration backfills one event for a store that predates the history", async () => {
    const s = await makeStore("toko-lama");
    await admin.execute(sql`truncate account_status_event`);
    // The backfill statement of migration 0013 (same text), run again on the emptied history.
    await admin.execute(sql`insert into account_status_event (subject_kind, subject_id, from_status, to_status, reason_code, reason_note, actor_user_id)
      select 'store', s.id::text, null, s.status, 'migration_backfill', 'x', null from store s where not exists (select 1 from account_status_event e where e.subject_kind = 'store' and e.subject_id = s.id::text)`);
    expect((await admin.select().from(accountStatusEvent)).map((e) => [e.subjectId, e.reasonCode])).toEqual([[String(s.storeId), "migration_backfill"]]);
  });
});

describe("SA-16 optional verification record: informational, versioned, masked", () => {
  const SECRET = { verifiedName: "Budi Santoso", contactEmail: "budi.santoso@contoh.id", contactPhone: "081234567890" };

  it("a store without any verification record is created, suspended, reactivated and still resolves for sellers and storefront", async () => {
    const s = await makeStore("toko-tanpa-verifikasi");
    const op = await makeOperator(STAFF);
    expect(await admin.select().from(accountVerification)).toHaveLength(0);
    await setStoreStatus(op, s.storeId, { status: "suspended", reason: "uji tanpa verifikasi" });
    expect(await storefrontScope(db, "toko-tanpa-verifikasi")).toBeNull();
    await setStoreStatus(op, s.storeId, { status: "active", reason: "uji tanpa verifikasi" });
    expect(await storefrontScope(db, "toko-tanpa-verifikasi")).not.toBeNull();
    expect((await sellerContext(db, s.ownerId)).ok).toBe(true);
  });

  it("nothing references the record: no foreign key points at account_verification, so no state of it can gate anything", async () => {
    const fks = (await admin.execute(sql`select conrelid::regclass::text as t from pg_constraint where contype = 'f' and confrelid = 'account_verification'::regclass`)) as unknown as { t: string }[];
    expect(fks).toEqual([]);
    // and a rejected record leaves the store fully operational
    const s = await makeStore("toko-ditolak");
    const op = await makeOperator(STAFF);
    const v = await submitVerification(op, s.storeId, { kind: "identity", ...SECRET, reason: "pengajuan atas nama seller" });
    await reviewVerification(op, v.id, { to: "rejected", reasonCode: "evidence_missing", reason: "bukti belum ada" });
    expect(await storefrontScope(db, "toko-ditolak")).not.toBeNull();
    expect((await sellerContext(db, s.ownerId)).ok).toBe(true);
    const cart = await setCartLine((await storefrontScope(db, "toko-ditolak"))!, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    expect((await placeOrder(db, cart, buyer())).orderId).toBeGreaterThan(0);
  });

  it("versions are immutable once submitted; a new submission is a new version and only one version can be current", async () => {
    const s = await makeStore("toko-versi");
    const op = await makeOperator(STAFF);
    const v1 = await submitVerification(op, s.storeId, { kind: "identity", ...SECRET, reason: "versi pertama" });
    const v2 = await submitVerification(op, s.storeId, { kind: "identity", verifiedName: "Budi S.", reason: "versi kedua" });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    await expect(sqlState(admin.execute(sql`update account_verification set verified_name = 'lain' where id = ${v1.id}`))).resolves.toBe("23514");
    await expect(sqlState(platform.execute(sql`delete from account_verification`))).resolves.toBe("42501");
    await reviewVerification(op, v1.id, { to: "verified", reasonCode: "checked", reason: "dokumen cocok" });
    await reviewVerification(op, v2.id, { to: "verified", reasonCode: "checked", reason: "versi baru cocok" });
    const rows = await admin.select().from(accountVerification).orderBy(accountVerification.version);
    expect(rows.map((r) => [r.version, r.status])).toEqual([[1, "revoked"], [2, "verified"]]); // superseded, never two current
    await expect(code(reviewVerification(op, v1.id, { to: "verified", reasonCode: "checked", reason: "kembali lagi" }))).resolves.toBe("illegal_transition");
  });

  it("concurrent submissions get distinct versions (advisory lock plus unique index)", async () => {
    const s = await makeStore("toko-serentak");
    const op = await makeOperator(STAFF);
    const out = await Promise.all([1, 2, 3].map((i) => submitVerification(op, s.storeId, { kind: "business", registrationNumber: `NIB-${i}23`, reason: `pengajuan ${i}` })));
    expect(out.map((o) => o.version).sort()).toEqual([1, 2, 3]);
  });

  it("the listing carries masked contact only (HTML, RSC and JSON are all this DTO) and records a masked access event; contact is never in the audit rows", async () => {
    const s = await makeStore("toko-masker");
    const op = await makeOperator(STAFF);
    await submitVerification(op, s.storeId, { kind: "identity", ...SECRET, registrationNumber: "NIB-8899-77", reason: "pengajuan" });
    const list = await listVerifications(op, s.storeId);
    const json = JSON.stringify(list);
    for (const leak of ["Budi", "Santoso", "budi.santoso", "contoh.id", "081234567890", "1234567890", "NIB-8899"]) expect(json).not.toContain(leak);
    expect(list[0]).toMatchObject({ maskedName: "B*** S***", maskedEmail: "b***@c***.id", maskedPhone: "***7890", hasRegistrationNumber: true });
    const events = await consoleAccessEvents(op);
    expect(events[0]).toMatchObject({ actorUserId: op.userId, targetKind: "store", fieldClass: "verification_evidence", accessLevel: "masked", purposeCode: "verification_review" });
    expect(JSON.stringify(await admin.select().from(auditLog))).not.toMatch(/budi\.santoso|081234567890/);
  });

  it("a field reveal needs accounts.reveal, an open case, purpose verification_review; the value is returned only with its full access event", async () => {
    const s = await makeStore("toko-reveal");
    const op = await makeOperator(STAFF);
    const v = await submitVerification(op, s.storeId, { kind: "identity", ...SECRET, reason: "pengajuan" });
    const c = await openCase(op, { kind: "verification", subjectKind: "store", subjectId: String(s.storeId), title: "tinjau verifikasi", reason: "kasus tinjauan" });
    await expect(code(revealVerificationField(op, v.id, { field: "contactEmail", caseRef: 999999, reason: "tanpa kasus terbuka" }))).resolves.toBe("case_required");
    expect(await consoleAccessEvents(op)).toEqual([]);
    const lacking = await makeOperator(["tenants.verify", "cases.read"]);
    await expect(code(revealVerificationField(lacking, v.id, { field: "contactEmail", caseRef: c.id, reason: "tanpa izin reveal" }))).resolves.toBe("forbidden");
    const out = await revealVerificationField(op, v.id, { field: "contactEmail", caseRef: c.caseNumber, reason: "memastikan kontak seller" });
    expect(out.value).toBe(SECRET.contactEmail);
    const [e] = await consoleAccessEvents(op);
    expect(e).toMatchObject({ actorUserId: op.userId, targetKind: "verification", targetId: String(v.id), fieldClass: "email", accessLevel: "full", purposeCode: "verification_review", caseId: c.caseNumber });
    expect(e!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    // inside the window the page can show the value again (a full access event per read); once the window ends it is masked again
    expect((await activeVerificationReveals(op, s.storeId)).map((r) => [r.versionId, r.field, r.value])).toEqual([[v.id, "contactEmail", SECRET.contactEmail]]);
    await admin.execute(sql`alter table personal_data_access_event disable trigger personal_data_access_event_append_only`);
    await admin.execute(sql`update personal_data_access_event set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where access_level = 'full'`);
    await admin.execute(sql`alter table personal_data_access_event enable trigger personal_data_access_event_append_only`);
    expect(await activeVerificationReveals(op, s.storeId)).toEqual([]);
    const colleague = await makeOperator(STAFF);
    expect(await activeVerificationReveals(colleague, s.storeId)).toEqual([]);
  });
});

describe("SA-18 risk queue: flags derived from authoritative state, acknowledge with reason and expiry", () => {
  async function awaitingBalanceShipment(slug: string) {
    const s = await makeStore(slug);
    const cart = await setCartLine(s.sf, undefined, { variantId: s.variantId, quantity: 1 }, "add");
    const { orderId } = await placeOrder(db, cart, buyer());
    await admin.insert(shipment).values({ storeId: s.storeId, orderId, requestedBy: s.ownerId, status: "awaiting_balance", providerOrderId: "po-t63", courierCode: "jne", originAreaId: "a1", destinationAreaId: "b1", weightKg: 1 });
    return { ...s, orderId };
  }

  it("a flag appears from the shipment state and disappears when the state does; unavailable sources are named, never zero", async () => {
    const s = await awaitingBalanceShipment("toko-risiko");
    const op = await makeOperator(STAFF);
    let q = await riskQueue(op);
    expect(q.flags.map((f) => [f.storeId, f.key, f.count])).toEqual([[s.storeId, "shipment_awaiting_balance", 1]]);
    expect(q.unavailableRules.map((r) => r.key)).toEqual(expect.arrayContaining(["subscription_past_due", "shipping_account_unusable", "payout_age", "affiliate_fraud"]));
    await admin.update(shipment).set({ status: "booked" }).where(eq(shipment.orderId, s.orderId));
    q = await riskQueue(op);
    expect(q.flags).toEqual([]);
    expect(await admin.select({ n: sql<number>`count(*)::int` }).from(order).where(eq(order.id, s.orderId))).toEqual([{ n: 1 }]); // derived: nothing was written by reading
  });

  it("an acknowledgement hides the flag until its expiry (count reported), and the source still raises it afterwards", async () => {
    const s = await awaitingBalanceShipment("toko-ack");
    const op = await makeOperator(STAFF);
    await expect(code(acknowledgeRisk(op, s.storeId, { flagKey: "shipment_awaiting_balance", reason: "saldo diisi besok", expiresAt: new Date(Date.now() - 1000) }))).resolves.toBe("invalid");
    await acknowledgeRisk(op, s.storeId, { flagKey: "shipment_awaiting_balance", reason: "seller sudah dihubungi", expiresAt: new Date(Date.now() + 3_600_000) });
    const hidden = await riskQueue(op);
    expect(hidden.flags).toEqual([]);
    expect(hidden.hiddenAcknowledged).toBe(1);
    expect((await riskQueue(op, { showAcknowledged: true })).flags[0]).toMatchObject({ key: "shipment_awaiting_balance", acknowledged: { until: expect.any(Date) } });
    await admin.execute(sql`alter table store_risk_ack disable trigger store_risk_ack_append_only`);
    await admin.execute(sql`update store_risk_ack set expires_at = now() - interval '1 second', created_at = now() - interval '2 hours'`);
    await admin.execute(sql`alter table store_risk_ack enable trigger store_risk_ack_append_only`);
    expect((await riskQueue(op)).flags).toHaveLength(1);
    await expect(sqlState(platform.execute(sql`update store_risk_ack set reason = 'x'`))).resolves.toBe("42501");
  });

  it("tenants.read opens the queue; acknowledging needs tenants.manage; the DTO carries no personal data", async () => {
    const s = await awaitingBalanceShipment("toko-izin");
    const reader = await makeOperator(["tenants.read"]);
    const q = await riskQueue(reader);
    expect(JSON.stringify(q)).not.toMatch(/@|081234567890|Budi/);
    await expect(code(acknowledgeRisk(reader, s.storeId, { flagKey: "shipment_awaiting_balance", reason: "tanpa izin kelola", expiresAt: new Date(Date.now() + 60_000) }))).resolves.toBe("forbidden");
    await expect(code(riskQueue(await makeOperator([])))).resolves.toBe("forbidden");
  });
});
