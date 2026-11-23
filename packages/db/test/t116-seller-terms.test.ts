import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueSellerStepUp } from "../src/ledger/stepup.ts";
import { decideApproval } from "../src/ops/capabilities-approvals.ts";
import { addBankAccount, BANK_ACCOUNT_STEP_UP } from "../src/payments/bank-transfer.ts";
import { FakeProviderCheck, saveProviderKey, setProviderCheckTransport } from "../src/payments/provider-accounts.ts";
import { recordAutoLarisSandboxPass, requestAutoLarisProduction, setAutoLarisProduction } from "../src/payments/seller.ts";
import { bindSession, type SellerScope } from "../src/platform/scoped.ts";
import { acceptSellerTerms, currentSellerTerms, publishSellerTermsVersion, recordSellerTermsReview, sellerTermsStatus } from "../src/platform/terms.ts";
import { withStore } from "../src/platform/tenant.ts";
import { auditLog, membership, storeTermsAcceptance } from "../src/schema.ts";
import { recordMengantarSandboxPass, requestMengantarProductionOn, setMengantarProductionCalls } from "../src/shipping/live-setting.ts";
import { confirmDedicatedAccount } from "../src/shipping/sync.ts";
import { setPickupAddress } from "../src/shipping/shipping.ts";
import { admin, db, DEFAULT_OPERATOR_CAPABILITIES, makeOperator, makeStore, makeUser, platform, seller } from "./helpers.ts";
import { sessionOf } from "./t37-fixtures.ts";

// T-116 (PR-27, ADR-0013 section 8 & D-33, ADR-0015 decision 8, ADR-0016 decision 23):
// Versioned seller terms, per-store append-only acceptance, server gate before saving a provider key or
// bank account, adviser-review gate before turning on the T-105 / T-106 production switches, and non-blocking
// re-acceptance when a new version is published.

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code ?? String(e));
const pgCode = (p: Promise<unknown>) => p.then(() => "allowed", (e: { cause?: { code?: string }; code?: string }) => e.cause?.code ?? e.code);

beforeEach(() => setProviderCheckTransport(new FakeProviderCheck()));
afterEach(() => setProviderCheckTransport(null));

async function ownerOf(s: Awaited<ReturnType<typeof makeStore>>): Promise<SellerScope> {
  return bindSession(s.owner, await sessionOf(s.ownerId));
}

describe("T-116 versioned seller terms and acceptance gate", () => {
  it("seeded version 1 is a draft and states every required point of ADR-0013, ADR-0015 and ADR-0016", async () => {
    const terms = await currentSellerTerms(db);
    expect(terms.version).toBe(1);
    expect(terms.isDraft).toBe(true);
    expect(terms.review).toBeNull();
    // All required disclosures in plain Indonesian text:
    expect(terms.body).toMatch(/masuk langsung ke rekening/i);
    expect(terms.body).toMatch(/tidak mencocokkan|merekonsiliasi/i);
    expect(terms.body).toMatch(/uang pengiriman.*Mengantar/is);
    expect(terms.body).toMatch(/bertanggung jawab atas akun Mengantar dan AutoLaris/i);
    expect(terms.body).toMatch(/tidak menjangkau atau menghapus salinan data pembeli/i);
    expect(terms.body).toMatch(/produk digital.*hak yang sah/is);
  });

  it("saving a provider key or bank account without acceptance is refused on the server; accepting unlocks both", async () => {
    const s = await makeStore("t116-gate");
    const me = await ownerOf(s);
    const keyProof = await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar" });
    expect(await code(saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: "T116-KEY-0123456789abcdef", proofId: keyProof }))).toBe("terms_not_accepted");
    const bankProof = await issueSellerStepUp(me, BANK_ACCOUNT_STEP_UP);
    expect(await code(addBankAccount(me, { bankCode: "BCA", accountNumber: "1234567890", holderName: "Pemilik Toko", proofId: bankProof }))).toBe("terms_not_accepted");
    // Neither step-up proof was consumed by the refused writes.
    expect((await admin.execute(sql`select consumed_at from store_step_up_proof where id = ${keyProof}`))[0]).toEqual({ consumed_at: null });
    expect((await admin.execute(sql`select consumed_at from store_step_up_proof where id = ${bankProof}`))[0]).toEqual({ consumed_at: null });

    // Staff cannot accept on behalf of the owner.
    const staffId = await makeUser("t116-staff");
    await platform.insert(membership).values({ storeId: s.storeId, userId: staffId, role: "staff" });
    expect(await code(acceptSellerTerms(await seller(staffId, s.storeId), { version: 1, agreed: true }))).toBe("forbidden");

    // Owner accepts v1: recorded, audited, idempotent, and both saves now succeed.
    expect(await acceptSellerTerms(me, { version: 1, agreed: true })).toEqual({ version: 1, created: true });
    expect(await acceptSellerTerms(me, { version: 1, agreed: true })).toEqual({ version: 1, created: false });
    const st = await sellerTermsStatus(me);
    expect(st).toMatchObject({ acceptedVersion: 1, acceptedCurrent: true, needsReacceptance: false });
    const audits = await admin.select({ action: auditLog.action, reason: auditLog.reason }).from(auditLog).where(and(eq(auditLog.storeId, s.storeId), eq(auditLog.action, "seller_terms.accept")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.reason).toContain("version=1");

    await saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: "T116-KEY-0123456789abcdef", proofId: keyProof });
    await addBankAccount(me, { bankCode: "BCA", accountNumber: "1234567890", holderName: "Pemilik Toko", proofId: bankProof });
  });

  it("store A's acceptance does not satisfy store B, and an acceptance cannot be edited or deleted", async () => {
    const a = await makeStore("t116-a");
    const b = await makeStore("t116-b");
    const meA = await ownerOf(a);
    const meB = await ownerOf(b);
    await acceptSellerTerms(meA, { version: 1, agreed: true });

    expect((await sellerTermsStatus(meB)).acceptedCurrent).toBe(false);
    expect(await withStore(db, b.storeId, (tx) => tx.select().from(storeTermsAcceptance))).toEqual([]);
    const bProof = await issueSellerStepUp(meB, { action: "integrations.provider_key", subjectId: "autolaris" });
    expect(await code(saveProviderKey(meB, { provider: "autolaris", environment: "sandbox", apiKey: "T116-KEY-B-0123456789abcd", proofId: bProof }))).toBe("terms_not_accepted");

    // Append-only in the database for every role, and non-owners cannot insert even directly.
    expect(await pgCode(admin.execute(sql`update store_terms_acceptance set accepted_at = now() - interval '1 day' where store_id = ${a.storeId}`))).toBe("42501");
    expect(await pgCode(admin.execute(sql`delete from store_terms_acceptance where store_id = ${a.storeId}`))).toBe("42501");
    expect(await pgCode(admin.execute(sql`update seller_terms_version set title = 'Edited title here' where version = 1`))).toBe("42501");
    expect(await pgCode(admin.execute(sql`delete from seller_terms_version where version = 1`))).toBe("42501");
    const staffId = await makeUser("t116-staff-db");
    await platform.insert(membership).values({ storeId: b.storeId, userId: staffId, role: "staff" });
    expect(await pgCode(withStore(db, b.storeId, (tx) => tx.insert(storeTermsAcceptance).values({ storeId: b.storeId, version: 1, acceptedBy: staffId })))).toBe("42501");
  });

  it("a new terms version asks for acceptance again without blocking anything already running", async () => {
    const s = await makeStore("t116-reaccept");
    const me = await ownerOf(s);
    await acceptSellerTerms(me, { version: 1, agreed: true });
    await saveProviderKey(me, { provider: "mengantar", environment: "sandbox", apiKey: "T116-RUN-KEY-0123456789ab", proofId: await issueSellerStepUp(me, { action: "integrations.provider_key", subjectId: "mengantar" }) });
    await confirmDedicatedAccount(me, { confirmed: true });

    const op = await makeOperator([...DEFAULT_OPERATOR_CAPABILITIES, "settings.manage"]);
    const { version } = await publishSellerTermsVersion(op, {
      title: "Syarat Penjual Bukalaris Versi 2",
      body: "Pembaruan teks syarat penjual dengan ketentuan akun milik penjual, catatan platform, uang pengiriman, data pembeli dan hak konten digital.",
      reason: "Pembaruan redaksi setelah tinjauan internal",
    });
    expect(version).toBe(2);

    const status = await sellerTermsStatus(me);
    expect(status).toMatchObject({ acceptedVersion: 1, acceptedCurrent: false, needsReacceptance: true });
    expect(status.current.isDraft).toBe(true);

    // Already-running operations (e.g. registering pickup address on the already-connected account) are NOT blocked.
    await setPickupAddress(me, { addressText: "Jl. Braga No. 10, Bandung", contactName: "Budi Pemilik", contactPhone: "081234567890" });
    // Saving a new key or bank account requires accepting v2; stale version 1 is refused.
    expect(await code(acceptSellerTerms(me, { version: 1, agreed: true }))).toBe("terms_version_stale");
    const bankProof = await issueSellerStepUp(me, BANK_ACCOUNT_STEP_UP);
    expect(await code(addBankAccount(me, { bankCode: "BRI", accountNumber: "9876543210", holderName: "Budi Pemilik", proofId: bankProof }))).toBe("terms_not_accepted");

    await acceptSellerTerms(me, { version: 2, agreed: true });
    await addBankAccount(me, { bankCode: "BRI", accountNumber: "9876543210", holderName: "Budi Pemilik", proofId: bankProof });
    expect((await sellerTermsStatus(me)).history.map((h) => h.version)).toEqual([2, 1]);
  });

  it("adviser review (name, date, version) gates both T-105 and T-106 production switches; reviews are append-only", async () => {
    const op = await makeOperator([...DEFAULT_OPERATOR_CAPABILITIES, "providers.manage", "providers.read", "settings.manage"]);
    const second = await makeOperator([...DEFAULT_OPERATOR_CAPABILITIES, "providers.manage", "providers.read"]);
    await recordMengantarSandboxPass(op, { revision: 0, note: "2026-11-23 sandbox Mengantar lolos" });
    await recordAutoLarisSandboxPass(op, { evidence: "sandbox AutoLaris lolos", reason: "sandbox pass recorded" });

    // Without a recorded adviser review, both switches stay closed.
    expect(await code(requestMengantarProductionOn(op, { revision: 1, reason: "Pilot dimulai" }))).toBe("terms_review_missing");
    expect(await code(setMengantarProductionCalls(op, { revision: 1, enabled: true, reason: "Pilot dimulai" }))).toBe("terms_review_missing");
    expect(await code(requestAutoLarisProduction(op, { reason: "Pilot dimulai" }))).toBe("terms_review_missing");
    expect(await code(setAutoLarisProduction(op, { enabled: true, reason: "Pilot dimulai" }))).toBe("terms_review_missing");

    // Future date refused; valid adviser review lifts draft status and unlocks both production switches.
    expect(await code(recordSellerTermsReview(op, { version: 1, adviserName: "Konsultan Hukum", reviewedOn: "2099-01-01", note: "Tinjauan masa depan" }))).toBe("invalid_date");
    await recordSellerTermsReview(op, { version: 1, adviserName: "Advokat Privasi & Niaga", reviewedOn: "2026-11-23", note: "Teks v1 sesuai posisi kerja D-33 dan ADR-0013" });
    const reviewed = await currentSellerTerms(db);
    expect(reviewed.isDraft).toBe(false);
    expect(reviewed.review).toMatchObject({ version: 1, adviserName: "Advokat Privasi & Niaga", reviewedOn: "2026-11-23" });
    expect(await pgCode(admin.execute(sql`update seller_terms_review set adviser_name = 'Lain' where version = 1`))).toBe("42501");
    expect(await pgCode(admin.execute(sql`delete from seller_terms_review where version = 1`))).toBe("42501");

    const mReq = await requestMengantarProductionOn(op, { revision: 1, reason: "Pilot dimulai" });
    await decideApproval(second, mReq.approvalId, "approve");
    await setMengantarProductionCalls(op, { revision: 1, enabled: true, reason: "Pilot dimulai", approvalId: mReq.approvalId });

    const aReq = await requestAutoLarisProduction(op, { reason: "Pilot dimulai" });
    await decideApproval(second, aReq.approvalId, "approve");
    await setAutoLarisProduction(op, { enabled: true, reason: "Pilot dimulai", approvalId: aReq.approvalId });

    // Clean up platform switches for subsequent tests.
    await setMengantarProductionCalls(op, { revision: 2, enabled: false, reason: "Selesai pengujian" });
    await setAutoLarisProduction(op, { enabled: false, reason: "Selesai pengujian" });
    await admin.execute(sql`delete from provider_live_setting`);
    await admin.execute(sql`update payment_production_switch set enabled = false, sandbox_pass_at = null, sandbox_pass_evidence = null, updated_by = null, revision = 0`);
  });
});
