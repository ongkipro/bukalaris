import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withAffiliate } from "../src/platform/tenant.ts";
import { TaxRefusal } from "../src/tax/compute.ts";
import { listTaxIdentities, ownTaxIdentities, submitTaxIdentity, withdrawTaxIdentity, type TaxAffiliateScope } from "../src/tax/identity.ts";
import { effectiveTaxPolicy, lockAffiliatePayout, payoutTaxHook, transitionPayoutTax } from "../src/tax/payout.ts";
import { resealTaxIdentity } from "../src/tax/reseal.ts";
import { appendTaxSetting, readTaxSettings } from "../src/tax/settings.ts";
import { taxComputation, taxDocument, taxEntityProfile, taxEvent, taxIdentity, taxPolicyVersion, taxSetting } from "../src/tax/schema-tax.ts";
import { sealTaxValue, taxIdentityFingerprint, unsealTaxValue } from "../src/tax/seal.ts";
import { admin, db, makeOperator, platform } from "./helpers.ts";

// T-65 against real PostgreSQL. Every amount, rate, bracket and day below is an arbitrary fixture, never a statutory value.
const key = () => randomBytes(32).toString("base64");
const RING = `k1:${key()}`;
const FINGERPRINT = `f1:${key()}`;
const A = 101;
const B = 102;
const rows = <T>(res: unknown): T[] => (Array.isArray(res) ? (res as T[]) : []);
const code = (err: unknown): string | undefined => (typeof err === "object" && err !== null && "cause" in err && typeof err.cause === "object" && err.cause !== null && "code" in err.cause ? String(err.cause.code) : undefined);
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e) => code(e) ?? (e instanceof TaxRefusal || e instanceof Error ? e.message : "unknown"));
const jakartaDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const waitingAdvisoryLocks = async () => rows<{ n: number }>(await admin.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`))[0]!.n;
// The package's TypeScript lib predates Promise.withResolvers; a signal to await, never a timer.
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

beforeEach(async () => {
  vi.stubEnv("KEYRING_TAX_IDENTITY", RING);
  vi.stubEnv("IDENTITY_FINGERPRINT_KEY", FINGERPRINT);
  await admin.execute(sql`truncate tax_document, tax_document_sequence, tax_event, tax_computation, tax_identity, tax_policy_version, tax_setting, tax_entity_profile restart identity cascade`);
  await admin.execute(sql`insert into tax_setting (version, effective_from, reason) values (1, 'epoch', 'startup')`);
});
afterEach(() => vi.unstubAllEnvs());

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────
async function confirmedProfile() {
  const [p] = await admin.insert(taxEntityProfile).values({ version: 1, effectiveFrom: new Date(), legalName: "Fixture Co", entityKindLabel: "fixture", npwpSealed: "x.y.z", npwpKeyVersion: "k1", pkpStatus: "non_pkp", status: "confirmed", confirmedBy: "fixture" }).returning();
  return p!;
}
async function setSetting(over: Partial<typeof taxSetting.$inferInsert> = {}) {
  const [{ n }] = (await admin.select({ n: sql<number>`max(version)::int` }).from(taxSetting)) as [{ n: number }];
  const [row] = await admin.insert(taxSetting).values({ version: n + 1, effectiveFrom: new Date(Date.UTC(2000, 0, n + 1)), reason: "fixture", ...over }).returning();
  return row!;
}
async function withholdingOn() {
  const profile = await confirmedProfile();
  return setSetting({ taxIdentityRequiredForPayout: true, withholdingEnabled: true, activationRef: "FIXTURE-ACTIVATION", entityProfileId: profile.id });
}
const policyRow = (over: Partial<typeof taxPolicyVersion.$inferInsert> = {}): typeof taxPolicyVersion.$inferInsert => ({
  taxTypeCode: "commission_withholding", categoryCode: "individual", version: 1, effectiveFrom: jakartaDate(new Date()), taxLabel: "fixture", sourceCitation: "fixture", baseFractionBps: 5000,
  rateMethod: "cumulative_true_up", brackets: [{ up_to_idr: "60000000", rate_bps: 500 }, { up_to_idr: null, rate_bps: 1500 }], rounding: "floor", recognitionEvent: "payout_paid", depositDueDay: 7, reportDueDay: 9,
  identityKindsAccepted: ["npwp", "nik"], authoredBy: "author", ...over,
});
/** draft -> submitted -> confirmed, the only way a version becomes confirmed. */
async function confirmedPolicy(over: Partial<typeof taxPolicyVersion.$inferInsert> = {}, confirm: Partial<typeof taxPolicyVersion.$inferInsert> = {}) {
  const [draft] = await platform.insert(taxPolicyVersion).values(policyRow(over)).returning();
  await platform.update(taxPolicyVersion).set({ status: "submitted" }).where(eq(taxPolicyVersion.id, draft!.id));
  const [row] = await platform.update(taxPolicyVersion).set({ status: "confirmed", confirmedBy: "approver", confirmedAt: new Date(), confirmationBasis: "advisor", advisorConfirmationRef: "FIXTURE-ADVISOR", ...confirm }).where(eq(taxPolicyVersion.id, draft!.id)).returning();
  return row!;
}
async function identityRow(affiliateId: number, over: Partial<typeof taxIdentity.$inferInsert> = {}) {
  const [row] = await admin.insert(taxIdentity).values({ subjectKind: "affiliate", affiliateId, version: 1, status: "approved", payeeClass: "individual", idKind: "npwp", idSealed: "i.i.i", idKeyVersion: "k1", registeredNameSealed: "n.n.n", idLast4: "0000", idFingerprint: randomUUID(), fingerprintKeyId: "f1", clientRequestKey: randomUUID(), ...over }).returning();
  return row!;
}
const hook = (affiliateId: number, payoutId: string, grossIdr: bigint) => platform.transaction((tx) => payoutTaxHook(tx, { affiliateId, payoutId, grossIdr, requestedAt: new Date() }));
const count = async (table: string) => rows<{ n: number }>(await admin.execute(sql`select count(*)::int as n from ${sql.identifier(table)}`))[0]!.n;

describe("T-65 startup defaults: statements ON, everything else OFF, and no tax computation exists", () => {
  it("the migration seeds exactly version 1 with the ADR-0012 defaults and no policy, profile, identity or computation row", async () => {
    const [v1] = await platform.select().from(taxSetting);
    expect(v1).toMatchObject({ version: 1, statementsEnabled: true, identityCaptureEnabled: false, taxIdentityRequiredForPayout: false, withholdingEnabled: false, pkpGateEnabled: false, activationRef: null, entityProfileId: null });
    for (const t of ["tax_policy_version", "tax_entity_profile", "tax_identity", "tax_computation", "tax_document", "tax_event"]) expect(await count(t)).toBe(0);
  });

  it("with defaults the payout hook returns tax 0, net = gross, the setting-version snapshot and inserts no computation", async () => {
    const [v1] = await platform.select().from(taxSetting);
    const res = await hook(A, randomUUID(), 1_234_567n);
    expect(res).toEqual({ taxSettingVersionId: v1!.id, taxComputationId: null, grossIdr: 1_234_567n, taxIdr: 0n, netIdr: 1_234_567n });
    expect(await count("tax_computation")).toBe(0);
    expect(await count("tax_event")).toBe(0);
  });

  it("the database refuses a computation while the referenced setting version has withholding off, even for the table owner", async () => {
    const identity = await identityRow(A);
    const policy = await confirmedPolicy();
    const [v1] = await platform.select().from(taxSetting);
    const values = { taxTypeCode: "commission_withholding", categoryCode: "individual", affiliateId: A, sourceKind: "affiliate_payout", sourceId: randomUUID(), taxYear: 2030, taxIdentityId: identity.id, policyVersionId: policy.id, taxSettingVersionId: v1!.id, grossIdr: 10n, baseIdr: 5n, ytdBaseBeforeIdr: 0n, ytdTaxBeforeIdr: 0n, taxIdr: 1n, netIdr: 9n, clamped: false, inputs: {}, inputsSha256: "0".repeat(64) };
    await expect(codeOf(admin.insert(taxComputation).values(values))).resolves.toBe("23514");
  });
});

describe("T-65 tax_setting: append-only versions, CHECKs and the service", () => {
  it("withholding needs the identity flag, an activation reference and a CONFIRMED entity profile (CHECKs and trigger)", async () => {
    const draft = (await admin.insert(taxEntityProfile).values({ version: 1, effectiveFrom: new Date() }).returning())[0]!;
    // The draft profile is confirmed in place below (draft rows may change; confirmed rows may not).
    const base = { reason: "fixture", withholdingEnabled: true, taxIdentityRequiredForPayout: true, activationRef: "REF", entityProfileId: draft.id };
    const attempt = (over: Partial<typeof taxSetting.$inferInsert>, n: number) => codeOf(admin.insert(taxSetting).values({ version: n, effectiveFrom: new Date(Date.UTC(2001, 0, n)), ...base, ...over }));
    expect(await attempt({ taxIdentityRequiredForPayout: false }, 2)).toBe("23514");
    expect(await attempt({ activationRef: null }, 3)).toBe("23514");
    expect(await attempt({ activationRef: "  " }, 4)).toBe("23514");
    expect(await attempt({ entityProfileId: null }, 5)).toBe("23514");
    expect(await attempt({}, 6)).toBe("23514"); // draft profile: refused by the trigger
    await admin.update(taxEntityProfile).set({ legalName: "Fixture Co", entityKindLabel: "fixture", npwpSealed: "a.b.c", npwpKeyVersion: "k1", pkpStatus: "non_pkp", status: "confirmed", confirmedBy: "fixture" }).where(eq(taxEntityProfile.id, draft.id));
    expect(await attempt({}, 7)).toBe("ok");
    expect(await codeOf(admin.insert(taxSetting).values({ version: 8, effectiveFrom: new Date(Date.UTC(2001, 0, 8)), reason: "x", pkpGateEnabled: true }))).toBe("23514"); // pkp gate needs a profile
  });

  it("versions are append-only: UPDATE and DELETE are refused for the owner and the platform role", async () => {
    expect(await codeOf(admin.execute(sql`update tax_setting set statements_enabled = false`))).toBe("42501");
    expect(await codeOf(admin.execute(sql`delete from tax_setting`))).toBe("42501");
    expect(await codeOf(platform.execute(sql`update tax_setting set statements_enabled = false`))).toBe("42501");
    expect(await codeOf(platform.execute(sql`delete from tax_setting`))).toBe("42501");
    expect((await platform.select().from(taxSetting))[0]!.statementsEnabled).toBe(true);
  });

  it("tax.read reads, tax.manage appends a prospective version with a reason and an event; other holders are refused with no side effect", async () => {
    const reader = await makeOperator(["tax.read"]);
    const manager = await makeOperator(["tax.manage"]);
    const nobody = await makeOperator([]);
    const change = { effectiveFrom: new Date(Date.now() + 3_600_000), reason: "switch capture on", statementsEnabled: true, identityCaptureEnabled: true, noticeApprovalRef: "NOTICE-FIXTURE", taxIdentityRequiredForPayout: false, withholdingEnabled: false, pkpGateEnabled: false, activationRef: null, entityProfileId: null };
    await expect(readTaxSettings(nobody)).rejects.toMatchObject({ code: "forbidden" });
    await expect(appendTaxSetting(reader, change)).rejects.toMatchObject({ code: "forbidden" });
    await expect(appendTaxSetting(nobody, change)).rejects.toMatchObject({ code: "forbidden" });
    expect(await count("tax_setting")).toBe(1);
    const row = await appendTaxSetting(manager, change);
    expect(row).toMatchObject({ version: 2, identityCaptureEnabled: true, createdBy: manager.userId });
    expect((await readTaxSettings(reader)).map((s) => s.version)).toEqual([2, 1]);
    expect(rows<{ n: number }>(await admin.execute(sql`select count(*)::int as n from tax_event where entity_kind = 'setting' and actor_user_id = ${manager.userId}`))[0]!.n).toBe(1);
    expect(rows<{ action: string; reason: string }>(await admin.execute(sql`select action, reason from audit_log where actor_user_id = ${manager.userId} and action = 'tax.setting.append'`))).toEqual([{ action: "tax.setting.append", reason: "v2: switch capture on" }]);
    // Not retroactive, reason required, notice reference required for capture, ordered.
    await expect(appendTaxSetting(manager, { ...change, effectiveFrom: new Date(Date.now() - 1000) })).rejects.toMatchObject({ code: "invalid" });
    await expect(appendTaxSetting(manager, { ...change, reason: "  ", effectiveFrom: new Date(Date.now() + 7_200_000) })).rejects.toMatchObject({ code: "invalid" });
    await expect(appendTaxSetting(manager, { ...change, noticeApprovalRef: null, effectiveFrom: new Date(Date.now() + 7_200_000) })).rejects.toMatchObject({ code: "notice_required" });
    await expect(appendTaxSetting(manager, { ...change, effectiveFrom: new Date(Date.now() + 1_800_000) })).rejects.toMatchObject({ code: "invalid" });
    expect(await count("tax_setting")).toBe(2);
  });

  it("two concurrent changes with the same effective instant leave exactly one new version", async () => {
    const manager = await makeOperator(["tax.manage"]);
    const effectiveFrom = new Date(Date.now() + 3_600_000);
    const change = (reason: string) => appendTaxSetting(manager, { effectiveFrom, reason, statementsEnabled: false, identityCaptureEnabled: false, noticeApprovalRef: null, taxIdentityRequiredForPayout: false, withholdingEnabled: false, pkpGateEnabled: false, activationRef: null, entityProfileId: null });
    const results = await Promise.allSettled([change("one"), change("two")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await platform.select({ v: taxSetting.version }).from(taxSetting)).map((r) => r.v).sort()).toEqual([1, 2]);
  });

  it("production mode refuses every phase-2 switch before any row is written; there is no activation by service call", async () => {
    const manager = await makeOperator(["tax.manage"]);
    const profile = await confirmedProfile();
    vi.stubEnv("NODE_ENV", "production");
    const base = { effectiveFrom: new Date(Date.now() + 3_600_000), reason: "activate", statementsEnabled: true, identityCaptureEnabled: false, noticeApprovalRef: null, taxIdentityRequiredForPayout: true, withholdingEnabled: true, pkpGateEnabled: false, activationRef: "REF", entityProfileId: profile.id };
    await expect(appendTaxSetting(manager, base)).rejects.toMatchObject({ code: "tax_not_activated" });
    await expect(appendTaxSetting(manager, { ...base, withholdingEnabled: false })).rejects.toMatchObject({ code: "tax_not_activated" }); // payout gate alone is also phase 2
    expect(await count("tax_setting")).toBe(1);
  });

  it("outside production the service still refuses withholding without the activation reference or without a confirmed profile", async () => {
    const manager = await makeOperator(["tax.manage"]);
    const draft = (await admin.insert(taxEntityProfile).values({ version: 1, effectiveFrom: new Date() }).returning())[0]!;
    const base = { effectiveFrom: new Date(Date.now() + 3_600_000), reason: "fixture", statementsEnabled: true, identityCaptureEnabled: false, noticeApprovalRef: null, taxIdentityRequiredForPayout: true, withholdingEnabled: true, pkpGateEnabled: false, activationRef: "REF", entityProfileId: draft.id };
    await expect(appendTaxSetting(manager, base)).rejects.toMatchObject({ code: "tax_not_activated" });
    await expect(appendTaxSetting(manager, { ...base, activationRef: null })).rejects.toMatchObject({ code: "tax_not_activated" });
    expect(await count("tax_setting")).toBe(1);
  });
});

describe("T-65 tax_entity_profile", () => {
  it("a draft may be incomplete; a confirmed profile needs its fields and is then immutable", async () => {
    const [draft] = await platform.insert(taxEntityProfile).values({ version: 1, effectiveFrom: new Date() }).returning();
    expect(await codeOf(platform.update(taxEntityProfile).set({ status: "confirmed" }).where(eq(taxEntityProfile.id, draft!.id)))).toBe("23514");
    expect(await codeOf(platform.update(taxEntityProfile).set({ status: "confirmed", legalName: "Fixture Co", entityKindLabel: "fixture", npwpSealed: "a.b.c", npwpKeyVersion: "k1", pkpStatus: "unknown", confirmedBy: "x" }).where(eq(taxEntityProfile.id, draft!.id)))).toBe("23514"); // PKP unknown
    await platform.update(taxEntityProfile).set({ status: "confirmed", legalName: "Fixture Co", entityKindLabel: "fixture", npwpSealed: "a.b.c", npwpKeyVersion: "k1", pkpStatus: "pkp", confirmedBy: "x" }).where(eq(taxEntityProfile.id, draft!.id));
    expect(await codeOf(platform.update(taxEntityProfile).set({ legalName: "Other" }).where(eq(taxEntityProfile.id, draft!.id)))).toBe("42501");
    expect(await codeOf(platform.execute(sql`delete from tax_entity_profile`))).toBe("42501");
  });
});

describe("T-65 tax_policy_version: no defaults, lifecycle, immutability and non-overlapping confirmed ranges", () => {
  it("no column carries a default for a rate, fraction, bracket, rounding, method, due day or effective date (catalog check)", async () => {
    const cols = rows<{ column_name: string; column_default: string | null }>(await admin.execute(sql`select column_name, column_default from information_schema.columns where table_name = 'tax_policy_version' and column_default is not null order by 1`));
    expect(cols).toEqual([{ column_name: "clawback_treatment", column_default: "'manual_review'::text" }, { column_name: "id", column_default: expect.stringContaining("nextval") }, { column_name: "status", column_default: "'draft'::text" }]);
  });

  it("a version can only start as draft and must pass through submitted before it is confirmed", async () => {
    expect(await codeOf(platform.insert(taxPolicyVersion).values({ ...policyRow(), status: "confirmed", confirmedBy: "approver", confirmedAt: new Date(), confirmationBasis: "advisor", advisorConfirmationRef: "R" }))).toBe("23514");
    const [d] = await platform.insert(taxPolicyVersion).values(policyRow()).returning();
    expect(await codeOf(platform.update(taxPolicyVersion).set({ status: "confirmed", confirmedBy: "approver", confirmedAt: new Date(), confirmationBasis: "advisor", advisorConfirmationRef: "R" }).where(eq(taxPolicyVersion.id, d!.id)))).toBe("23514");
  });

  it("commission_withholding cannot be confirmed by owner decision, by its author, without an advisor reference or without both due days", async () => {
    const attempt = async (over: Partial<typeof taxPolicyVersion.$inferInsert>, confirm: Partial<typeof taxPolicyVersion.$inferInsert>, version: number) => codeOf(confirmedPolicy({ version, ...over }, confirm));
    expect(await attempt({}, { confirmationBasis: "owner_decision" }, 1)).toBe("23514");
    expect(await attempt({}, { confirmedBy: "author" }, 2)).toBe("23514");
    expect(await attempt({}, { advisorConfirmationRef: null }, 3)).toBe("23514");
    expect(await attempt({ depositDueDay: null }, {}, 4)).toBe("23514");
    expect(await attempt({ reportDueDay: null }, {}, 5)).toBe("23514");
    expect(await attempt({}, {}, 6)).toBe("ok");
    // vat_output may be owner-confirmed in startup mode (PPN switch) with no due days, never as commission withholding.
    expect(await attempt({ taxTypeCode: "vat_output", categoryCode: "subscription", recognitionEvent: "invoice_created", depositDueDay: null, reportDueDay: null, version: 1 }, { confirmationBasis: "owner_decision", advisorConfirmationRef: null }, 1)).toBe("ok");
  });

  it("type, bracket and fraction CHECKs and the bracket trigger refuse malformed policies", async () => {
    const bad = (over: Partial<typeof taxPolicyVersion.$inferInsert>) => codeOf(platform.insert(taxPolicyVersion).values(policyRow(over)));
    expect(await bad({ taxTypeCode: "vat_output", categoryCode: "individual", recognitionEvent: "invoice_created" })).toBe("23514");
    expect(await bad({ recognitionEvent: "invoice_created" })).toBe("23514");
    expect(await bad({ baseFractionBps: 10_001 })).toBe("23514");
    expect(await bad({ baseFractionBps: -1 })).toBe("23514");
    expect(await bad({ brackets: [] })).toBe("23514");
    expect(await bad({ brackets: [{ up_to_idr: null, rate_bps: 10_001 }] })).toBe("23514");
    expect(await bad({ brackets: [{ up_to_idr: "10", rate_bps: 1 }] })).toBe("23514"); // last must be unbounded
    expect(await bad({ brackets: [{ up_to_idr: "10", rate_bps: 1 }, { up_to_idr: "10", rate_bps: 1 }, { up_to_idr: null, rate_bps: 1 }] })).toBe("23514");
    expect(await bad({ brackets: [{ up_to_idr: null, rate_bps: 1 }, { up_to_idr: null, rate_bps: 1 }] })).toBe("23514");
    expect(await bad({ rounding: "banker" })).toBe("23514");
    expect(await bad({ rateMethod: "monthly" })).toBe("23514");
    expect(await bad({ depositDueDay: 32 })).toBe("23514");
    expect(await bad({ effectiveFrom: "2030-02-01", effectiveTo: "2030-01-01" })).toBe("23514");
    expect(await bad({})).toBe("ok");
  });

  it("a confirmed version cannot be edited, deleted, re-dated or re-confirmed; only a single retirement that sets effective_to is allowed", async () => {
    const p = await confirmedPolicy();
    for (const set of [{ baseFractionBps: 1 }, { rounding: "ceil" }, { brackets: [{ up_to_idr: null, rate_bps: 1 }] }, { confirmedBy: "someone" }, { status: "draft" }, { status: "rejected" }, { effectiveFrom: "2099-01-01" }, { effectiveTo: "2099-01-01" }] as Partial<typeof taxPolicyVersion.$inferInsert>[]) {
      expect(await codeOf(platform.update(taxPolicyVersion).set(set).where(eq(taxPolicyVersion.id, p.id))), JSON.stringify(set)).toBe("42501");
    }
    expect(await codeOf(admin.execute(sql`delete from tax_policy_version`))).toBe("42501");
    expect(await codeOf(platform.execute(sql`delete from tax_policy_version`))).toBe("42501");
    await platform.update(taxPolicyVersion).set({ status: "retired", effectiveTo: "2099-01-01" }).where(eq(taxPolicyVersion.id, p.id));
    expect(await codeOf(platform.update(taxPolicyVersion).set({ status: "confirmed" }).where(eq(taxPolicyVersion.id, p.id)))).toBe("42501"); // rollback is a NEW version
  });

  it("a submitted version's content is frozen", async () => {
    const [d] = await platform.insert(taxPolicyVersion).values(policyRow()).returning();
    await platform.update(taxPolicyVersion).set({ baseFractionBps: 4000 }).where(eq(taxPolicyVersion.id, d!.id)); // draft: editable
    await platform.update(taxPolicyVersion).set({ status: "submitted" }).where(eq(taxPolicyVersion.id, d!.id));
    expect(await codeOf(platform.update(taxPolicyVersion).set({ baseFractionBps: 3000 }).where(eq(taxPolicyVersion.id, d!.id)))).toBe("42501");
    expect(await codeOf(platform.update(taxPolicyVersion).set({ status: "draft" }).where(eq(taxPolicyVersion.id, d!.id)))).toBe("23514");
  });

  it("confirmation is not retroactive: effective_from before the confirmation date is refused (BILL-9 W2)", async () => {
    expect(await codeOf(confirmedPolicy({ effectiveFrom: "2001-01-01" }))).toBe("23514");
  });

  it("wave 2 review: a back-dated confirmed_at supplied by the writer does not unlock a past effective_from (the database stamps the confirmation)", async () => {
    expect(await codeOf(confirmedPolicy({ effectiveFrom: "2001-01-01" }, { confirmedAt: new Date("2000-01-01T00:00:00Z") }))).toBe("23514");
  });

  it("wave 2 review: a bracket without rate_bps is refused by the database (NULL-safe), not only by the TypeScript module", async () => {
    expect(await codeOf(platform.insert(taxPolicyVersion).values(policyRow({ brackets: [{ up_to_idr: null }] as never })))).toBe("23514");
  });

  it("overlapping confirmed ranges for one (type, category) are rejected; adjacent, other-category and unconfirmed ranges are fine", async () => {
    await confirmedPolicy({ version: 1, effectiveFrom: "2040-01-01", effectiveTo: "2041-01-01" });
    expect(await codeOf(confirmedPolicy({ version: 2, effectiveFrom: "2040-06-01", effectiveTo: "2042-01-01" }))).toBe("23P01");
    expect(await codeOf(confirmedPolicy({ version: 3, effectiveFrom: "2039-01-01" }))).toBe("23P01"); // open-ended range reaches into the first
    expect(await codeOf(confirmedPolicy({ version: 4, effectiveFrom: "2041-01-01" }))).toBe("ok"); // half-open ranges touch
    expect(await codeOf(confirmedPolicy({ version: 5, categoryCode: "entity", effectiveFrom: "2040-06-01" }))).toBe("ok");
    const [draft] = await platform.insert(taxPolicyVersion).values(policyRow({ version: 6, effectiveFrom: "2040-06-01" })).returning();
    expect(draft!.status).toBe("draft"); // a draft never blocks anything
  });

  it("two overlapping confirmations racing in separate transactions cannot both commit (the advisory-lock fallback holds without btree_gist)", async () => {
    const mk = async (version: number) => {
      const [d] = await platform.insert(taxPolicyVersion).values(policyRow({ version, effectiveFrom: "2050-01-01" })).returning();
      await platform.update(taxPolicyVersion).set({ status: "submitted" }).where(eq(taxPolicyVersion.id, d!.id));
      return d!.id;
    };
    const [first, second] = [await mk(1), await mk(2)];
    const confirm = (tx: typeof platform, id: number) => tx.update(taxPolicyVersion).set({ status: "confirmed", confirmedBy: "approver", confirmedAt: new Date(), confirmationBasis: "advisor", advisorConfirmationRef: "R" }).where(eq(taxPolicyVersion.id, id));
    const gate = deferred();
    const confirmedByFirst = deferred();
    const t1 = platform.transaction(async (tx) => { await confirm(tx as unknown as typeof platform, first); confirmedByFirst.resolve(); await gate.promise; });
    await confirmedByFirst.promise; // t1 has confirmed and holds the policy lock
    const t2 = codeOf(platform.transaction(async (tx) => { await confirm(tx as unknown as typeof platform, second); }));
    await expect.poll(waitingAdvisoryLocks, { timeout: 10_000 }).toBe(1); // t2 is waiting for t1, not racing past it
    gate.resolve();
    await t1;
    expect(await t2).toBe("23P01");
    expect((await platform.select({ id: taxPolicyVersion.id }).from(taxPolicyVersion).where(eq(taxPolicyVersion.status, "confirmed"))).map((r) => r.id)).toEqual([first]);
  }, 30_000);

  it("the vat_output lookup returns exactly one confirmed version for the line and date, or refuses no_effective_policy", async () => {
    const vat = (over: Partial<typeof taxPolicyVersion.$inferInsert>) => ({ taxTypeCode: "vat_output", categoryCode: "subscription", recognitionEvent: "invoice_created", depositDueDay: null, reportDueDay: null, baseFractionBps: 10_000, rateMethod: "per_payment", brackets: [{ up_to_idr: null, rate_bps: 1234 }], ...over });
    const asOf = jakartaDate(new Date(Date.now() + 86_400_000 * 40));
    await expect(effectiveTaxPolicy(platform, { taxTypeCode: "vat_output", categoryCode: "subscription", asOfDate: asOf })).rejects.toMatchObject({ code: "no_effective_policy" });
    const p = await confirmedPolicy(vat({ version: 1 }), { confirmationBasis: "owner_decision", advisorConfirmationRef: null });
    await confirmedPolicy(vat({ version: 1, categoryCode: "cod_fee" }), { confirmationBasis: "owner_decision", advisorConfirmationRef: null });
    expect((await effectiveTaxPolicy(platform, { taxTypeCode: "vat_output", categoryCode: "subscription", asOfDate: asOf })).id).toBe(p.id);
    await expect(effectiveTaxPolicy(platform, { taxTypeCode: "vat_output", categoryCode: "subscription", asOfDate: "2001-01-01" })).rejects.toMatchObject({ code: "no_effective_policy" });
  });
});

describe("T-65 payout tax hook (fixture payout ids; T-53 wires it to affiliate_payout)", () => {
  it("tax_identity_required_for_payout: refusal tax_identity_missing before any computation; an approved identity then passes with tax 0", async () => {
    const s = await setSetting({ taxIdentityRequiredForPayout: true });
    await expect(hook(A, randomUUID(), 1000n)).rejects.toMatchObject({ code: "tax_identity_missing" });
    await identityRow(B); // another affiliate's identity does not count
    await expect(hook(A, randomUUID(), 1000n)).rejects.toMatchObject({ code: "tax_identity_missing" });
    await identityRow(A, { status: "submitted" }); // submitted is not approved
    await expect(hook(A, randomUUID(), 1000n)).rejects.toMatchObject({ code: "tax_identity_missing" });
    await identityRow(A, { version: 2, status: "approved" });
    expect(await hook(A, randomUUID(), 1000n)).toEqual({ taxSettingVersionId: s.id, taxComputationId: null, grossIdr: 1000n, taxIdr: 0n, netIdr: 1000n });
    expect(await count("tax_computation")).toBe(0);
  });

  it("a setting that is not effective yet is ignored: the hook reads the latest version effective at the request time", async () => {
    const [v1] = await platform.select().from(taxSetting);
    await admin.insert(taxSetting).values({ version: 2, effectiveFrom: new Date(Date.now() + 86_400_000), reason: "future", taxIdentityRequiredForPayout: true });
    expect((await hook(A, randomUUID(), 5n)).taxSettingVersionId).toBe(v1!.id);
  });

  it("withholding: one computation with the caller's payout id, amounts for the payout row, policy/identity/setting snapshot and an event", async () => {
    const setting = await withholdingOn();
    const identity = await identityRow(A);
    const policy = await confirmedPolicy();
    const payoutId = randomUUID();
    const res = await hook(A, payoutId, 1_000_000n);
    expect(res).toMatchObject({ taxSettingVersionId: setting.id, grossIdr: 1_000_000n, taxIdr: 25_000n, netIdr: 975_000n });
    const [row] = await platform.select().from(taxComputation);
    expect(row).toMatchObject({ id: res.taxComputationId, sourceId: payoutId, sourceKind: "affiliate_payout", kind: "original", status: "computed", affiliateId: A, taxIdentityId: identity.id, policyVersionId: policy.id, taxSettingVersionId: setting.id, baseIdr: 500_000n, ytdBaseBeforeIdr: 0n, clamped: false });
    expect(row!.inputsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.grossIdr).toBe(row!.taxIdr + row!.netIdr);
    expect((await platform.select().from(taxEvent))[0]).toMatchObject({ entityKind: "computation", entityId: row!.id, event: "computed", requestId: payoutId });
  });

  it("the BILL-9 illustration across two payouts: year-to-date comes from the first non-void computation", async () => {
    await withholdingOn(); await identityRow(A); await confirmedPolicy();
    expect((await hook(A, randomUUID(), 1_000_000n)).taxIdr).toBe(25_000n);
    expect((await hook(A, randomUUID(), 130_000_000n)).taxIdr).toBe(3_800_000n);
    // A void payout leaves the year-to-date: after rejecting the second payout its base no longer counts.
    const second = (await platform.select().from(taxComputation).orderBy(taxComputation.id))[1]!;
    await platform.transaction((tx) => transitionPayoutTax(tx, { affiliateId: A, payoutId: second.sourceId, outcome: "rejected", at: new Date() }));
    expect((await hook(A, randomUUID(), 130_000_000n)).taxIdr).toBe(3_800_000n);
    // Another affiliate starts from zero.
    await identityRow(B);
    expect((await hook(B, randomUUID(), 1_000_000n)).taxIdr).toBe(25_000n);
  });

  it("replay returns the one computation; a replay with another gross or affiliate is refused; concurrent replays leave one row", async () => {
    await withholdingOn(); await identityRow(A); await identityRow(B); await confirmedPolicy();
    const payoutId = randomUUID();
    const first = await hook(A, payoutId, 2_000_000n);
    expect(await hook(A, payoutId, 2_000_000n)).toEqual(first);
    await expect(hook(A, payoutId, 2_000_001n)).rejects.toMatchObject({ code: "replay_mismatch" });
    await expect(hook(B, payoutId, 2_000_000n)).rejects.toMatchObject({ code: "replay_mismatch" });
    const racing = randomUUID();
    const results = await Promise.all([hook(A, racing, 3_000_000n), hook(A, racing, 3_000_000n), hook(A, racing, 3_000_000n)]);
    expect(new Set(results.map((r) => r.taxComputationId)).size).toBe(1);
    expect(rows<{ n: number }>(await admin.execute(sql`select count(*)::int as n from tax_computation where source_id = ${racing}`))[0]!.n).toBe(1);
    expect(rows<{ n: number }>(await admin.execute(sql`select count(*)::int as n from tax_event where request_id = ${racing}`))[0]!.n).toBe(1);
    // A rejected (void) payout id cannot be revived by replay.
    await platform.transaction((tx) => transitionPayoutTax(tx, { affiliateId: A, payoutId: racing, outcome: "rejected", at: new Date() }));
    await expect(hook(A, racing, 3_000_000n)).rejects.toMatchObject({ code: "replay_mismatch" });
  });

  it("concurrent hook calls are serialised under the per-affiliate lock and the second sees the first in its year-to-date (the test simulates the caller's lock)", async () => {
    await withholdingOn(); await identityRow(A); await confirmedPolicy();
    const gate = deferred();
    const inserted = deferred();
    const t1 = platform.transaction(async (tx) => {
      await lockAffiliatePayout(tx, A); // what T-53 does before it reads the balance
      const r = await payoutTaxHook(tx, { affiliateId: A, payoutId: randomUUID(), grossIdr: 1_000_000n, requestedAt: new Date() });
      inserted.resolve();
      await gate.promise;
      return r;
    });
    await inserted.promise;
    let secondDone = false;
    const t2 = hook(A, randomUUID(), 130_000_000n).then((r) => { secondDone = true; return r; });
    await expect.poll(waitingAdvisoryLocks, { timeout: 10_000 }).toBe(1);
    expect(secondDone).toBe(false); // blocked on the lock, not computing from a stale year-to-date
    gate.resolve();
    const [r1, r2] = [await t1, await t2];
    expect([r1.taxIdr, r2.taxIdr]).toEqual([25_000n, 3_800_000n]); // without the lock the second would see year-to-date 0 and get 3_775_000
    // Lock of another affiliate is independent.
    await identityRow(B);
    expect((await hook(B, randomUUID(), 1_000_000n)).taxIdr).toBe(25_000n);
  }, 30_000);

  it("refusals abort with no row: no effective policy, identity kind the policy does not accept, policy_invalid, and a caller rollback after a successful hook", async () => {
    await withholdingOn(); await identityRow(A);
    await expect(hook(A, randomUUID(), 1000n)).rejects.toMatchObject({ code: "no_effective_policy" });
    expect(await count("tax_computation")).toBe(0);
    await confirmedPolicy({ identityKindsAccepted: ["nik"] });
    await expect(hook(A, randomUUID(), 1000n)).rejects.toMatchObject({ code: "tax_identity_missing" }); // the identity is an NPWP
    await admin.execute(sql`truncate tax_policy_version cascade`);
    await confirmedPolicy({ brackets: [{ up_to_idr: null, rate_bps: 10_000 }], baseFractionBps: 10_000, rateMethod: "cumulative_true_up" }); // fine
    // tax above gross: year-to-date base so large that the true-up exceeds this payout
    await admin.insert(taxComputation).values({ taxTypeCode: "commission_withholding", categoryCode: "individual", affiliateId: A, sourceKind: "affiliate_payout", sourceId: randomUUID(), taxYear: Number(jakartaDate(new Date()).slice(0, 4)), taxIdentityId: (await platform.select().from(taxIdentity))[0]!.id, policyVersionId: (await platform.select().from(taxPolicyVersion))[0]!.id, taxSettingVersionId: (await platform.select().from(taxSetting).where(eq(taxSetting.withholdingEnabled, true)))[0]!.id, grossIdr: 100n, baseIdr: 100n, ytdBaseBeforeIdr: 0n, ytdTaxBeforeIdr: 0n, taxIdr: 0n, netIdr: 100n, clamped: false, inputs: {}, inputsSha256: "0".repeat(64) });
    await expect(hook(A, randomUUID(), 10n)).rejects.toMatchObject({ code: "policy_invalid" });
    const before = await count("tax_computation");
    await admin.execute(sql`truncate tax_computation cascade`);
    await expect(
      platform.transaction(async (tx) => {
        await payoutTaxHook(tx, { affiliateId: A, payoutId: randomUUID(), grossIdr: 500n, requestedAt: new Date() });
        throw new Error("caller refused after the hook (for example the balance changed)");
      }),
    ).rejects.toThrow("caller refused");
    expect(before).toBe(1);
    expect(await count("tax_computation")).toBe(0);
    expect(await count("tax_event")).toBe(0);
  });

  it("withholding runs only in fixture and test runtimes: production mode refuses it with no row", async () => {
    await withholdingOn(); await identityRow(A); await confirmedPolicy();
    vi.stubEnv("NODE_ENV", "production");
    await expect(hook(A, randomUUID(), 1000n)).rejects.toMatchObject({ code: "tax_not_activated" });
    expect(await count("tax_computation")).toBe(0);
  });

  it("paid recognises, rejected voids, replays are no-ops and the opposite transition afterwards is refused; no computation means no-op", async () => {
    await withholdingOn(); await identityRow(A); await confirmedPolicy();
    const paid = randomUUID();
    const rejected = randomUUID();
    await hook(A, paid, 1_000_000n);
    await hook(A, rejected, 1_000_000n);
    const run = (payoutId: string, outcome: "paid" | "rejected") => platform.transaction((tx) => transitionPayoutTax(tx, { affiliateId: A, payoutId, outcome, at: new Date() }));
    expect((await run(paid, "paid"))!.status).toBe("recognized");
    expect((await run(paid, "paid"))!.status).toBe("recognized");
    await expect(run(paid, "rejected")).rejects.toMatchObject({ code: "invalid_transition" });
    expect((await run(rejected, "rejected"))!.status).toBe("void");
    expect((await run(rejected, "rejected"))!.status).toBe("void");
    await expect(run(rejected, "paid")).rejects.toMatchObject({ code: "invalid_transition" });
    expect(await run(randomUUID(), "paid")).toBeNull(); // a startup payout has no computation
    const [rec] = await platform.select().from(taxComputation).where(eq(taxComputation.sourceId, paid));
    expect(rec!.recognizedAt).not.toBeNull();
    expect(await codeOf(platform.transaction((tx) => transitionPayoutTax(tx, { affiliateId: B, payoutId: paid, outcome: "paid", at: new Date() })))).toBe("replay_mismatch"); // not another affiliate's payout
  });

  it("a computation is an immutable snapshot: amounts, links and deletion are refused for every role; only the forward status moves; a later setting or policy never rewrites it", async () => {
    const setting = await withholdingOn(); await identityRow(A); const policy = await confirmedPolicy();
    const res = await hook(A, randomUUID(), 1_000_000n);
    const id = res.taxComputationId!;
    expect(await codeOf(admin.execute(sql`update tax_computation set tax_idr = 1, net_idr = 999999 where id = ${id}`))).toBe("42501");
    expect(await codeOf(admin.execute(sql`update tax_computation set policy_version_id = policy_version_id + 1 where id = ${id}`))).toBe("42501");
    expect(await codeOf(admin.execute(sql`update tax_computation set inputs_sha256 = 'x' where id = ${id}`))).toBe("42501");
    expect(await codeOf(admin.execute(sql`update tax_computation set status = 'void', recognized_at = now() where id = ${id}`))).toBe("23514"); // status and recognized_at must agree
    expect(await codeOf(admin.execute(sql`update tax_computation set status = 'void' where id = ${id}`))).toBe("ok");
    expect(await codeOf(admin.execute(sql`update tax_computation set status = 'computed' where id = ${id}`))).toBe("42501"); // never backwards
    expect(await codeOf(admin.execute(sql`delete from tax_computation`))).toBe("42501");
    expect(await codeOf(platform.execute(sql`delete from tax_computation`))).toBe("42501");
    // New setting and a retired policy version leave the stored amounts and references alone.
    await admin.insert(taxSetting).values({ version: 99, effectiveFrom: new Date(Date.UTC(2010, 0, 1)), reason: "later" });
    await platform.update(taxPolicyVersion).set({ status: "retired", effectiveTo: "2099-01-01" }).where(eq(taxPolicyVersion.id, policy.id));
    const [row] = await platform.select().from(taxComputation).where(eq(taxComputation.id, id));
    expect(row).toMatchObject({ taxIdr: 25_000n, netIdr: 975_000n, taxSettingVersionId: setting.id, policyVersionId: policy.id });
  });

  it("amount CHECKs, composite identity/policy links and the per-payout unique index are enforced by the database", async () => {
    await withholdingOn();
    const mine = await identityRow(A);
    const theirs = await identityRow(B);
    const policy = await confirmedPolicy();
    const [v] = await platform.select().from(taxSetting).where(eq(taxSetting.withholdingEnabled, true));
    const row = (over: Partial<typeof taxComputation.$inferInsert> = {}) => ({ taxTypeCode: "commission_withholding", categoryCode: "individual", affiliateId: A, sourceKind: "affiliate_payout", sourceId: randomUUID(), taxYear: 2030, taxIdentityId: mine.id, policyVersionId: policy.id, taxSettingVersionId: v!.id, grossIdr: 10n, baseIdr: 5n, ytdBaseBeforeIdr: 0n, ytdTaxBeforeIdr: 0n, taxIdr: 1n, netIdr: 9n, clamped: false, inputs: {}, inputsSha256: "0".repeat(64), ...over });
    expect(await codeOf(admin.insert(taxComputation).values(row({ netIdr: 8n })))).toBe("23514"); // gross = tax + net
    expect(await codeOf(admin.insert(taxComputation).values(row({ grossIdr: -1n, taxIdr: -2n, netIdr: 1n })))).toBe("23514"); // originals are non-negative
    expect(await codeOf(admin.insert(taxComputation).values(row({ taxIdentityId: theirs.id })))).toBe("23503"); // another affiliate's identity
    expect(await codeOf(admin.insert(taxComputation).values(row({ categoryCode: "entity" })))).toBe("23503"); // policy of another category
    expect(await codeOf(admin.insert(taxComputation).values(row({ kind: "correction" })))).toBe("23514"); // correction needs its original
    const ok = row();
    expect(await codeOf(admin.insert(taxComputation).values(ok))).toBe("ok");
    expect(await codeOf(admin.insert(taxComputation).values(row({ sourceId: ok.sourceId })))).toBe("23505"); // one original per payout
  });
});

describe("T-65 tax_identity: column grants, own-subject RLS, immutability and the approved unique index", () => {
  it("bukalaris_app cannot read any sealed or fingerprint column (SELECT * included) and cannot write; safe columns are readable under the own context only", async () => {
    await identityRow(A, { idLast4: "1234" }); await identityRow(B, { idLast4: "5678" });
    for (const col of ["id_sealed", "id_key_version", "registered_name_sealed", "id_fingerprint", "fingerprint_key_id", "client_request_key", "reviewed_by", "pkp_status"]) {
      expect(await codeOf(db.execute(sql`select ${sql.identifier(col)} from tax_identity`)), col).toBe("42501");
      expect(await codeOf(withAffiliate(db, A, (tx) => tx.execute(sql`select ${sql.identifier(col)} from tax_identity`))), `${col} in own context`).toBe("42501");
    }
    expect(await codeOf(withAffiliate(db, A, (tx) => tx.execute(sql`select * from tax_identity`)))).toBe("42501");
    expect(await codeOf(withAffiliate(db, A, (tx) => tx.execute(sql`insert into tax_identity (subject_kind, affiliate_id, version, payee_class, id_kind, id_last4, client_request_key) values ('affiliate', ${A}, 9, 'individual', 'nik', '0000', 'k')`)))).toBe("42501");
    expect(await codeOf(withAffiliate(db, A, (tx) => tx.execute(sql`update tax_identity set status = 'approved'`)))).toBe("42501");
    expect(await codeOf(withAffiliate(db, A, (tx) => tx.execute(sql`delete from tax_identity`)))).toBe("42501");
  });

  it("RLS fails closed without app.affiliate_id and affiliate A cannot read affiliate B's identity", async () => {
    await identityRow(A, { idLast4: "1234" }); await identityRow(B, { idLast4: "5678" });
    expect(await db.select({ id: taxIdentity.id }).from(taxIdentity)).toEqual([]);
    expect((await ownTaxIdentities({ affiliateId: A, userId: "u", exec: db })).map((r) => r.idLast4)).toEqual(["1234"]);
    expect((await ownTaxIdentities({ affiliateId: B, userId: "u", exec: db })).map((r) => r.idLast4)).toEqual(["5678"]);
    expect(await withAffiliate(db, A, (tx) => tx.select({ id: taxIdentity.id }).from(taxIdentity).where(eq(taxIdentity.affiliateId, B)))).toEqual([]);
    expect(await codeOf(withAffiliate(db, A, (tx) => tx.execute(sql`select count(*) from tax_identity where affiliate_id = ${B}`)))).toBe("ok");
    const dto = JSON.stringify(await ownTaxIdentities({ affiliateId: A, userId: "u", exec: db }));
    expect(dto).not.toMatch(/sealed|fingerprint|i\.i\.i|n\.n\.n/);
  });

  it("the table owner and platform role cannot delete; identity versions are immutable; status moves only along the state machine", async () => {
    const row = await identityRow(A, { status: "submitted" });
    expect(await codeOf(platform.execute(sql`delete from tax_identity`))).toBe("42501");
    expect(await codeOf(admin.execute(sql`delete from tax_identity`))).toBe("42501");
    for (const set of [sql`payee_class = 'entity'`, sql`id_last4 = '9999'`, sql`client_request_key = 'x'`, sql`version = 5`, sql`affiliate_id = ${B}`, sql`id_sealed = 'a.b.c'`, sql`id_fingerprint = 'x'`]) {
      expect(await codeOf(platform.execute(sql`update tax_identity set ${set} where id = ${row.id}`)), String(set)).toBe("42501");
    }
    expect(await codeOf(platform.execute(sql`update tax_identity set status = 'approved' where id = ${row.id}`))).toBe("23514"); // review comes first
    expect(await codeOf(platform.execute(sql`update tax_identity set status = 'in_review' where id = ${row.id}`))).toBe("ok");
    expect(await codeOf(platform.execute(sql`update tax_identity set status = 'approved' where id = ${row.id}`))).toBe("ok");
    expect(await codeOf(platform.execute(sql`update tax_identity set status = 'submitted' where id = ${row.id}`))).toBe("23514");
    expect(await codeOf(platform.execute(sql`update tax_identity set status = 'revoked' where id = ${row.id}`))).toBe("ok");
  });

  it("at most one approved identity per affiliate, and concurrent approvals leave exactly one", async () => {
    await identityRow(A, { version: 1, status: "approved" });
    expect(await codeOf(identityRow(A, { version: 2, status: "approved" }))).toBe("23505");
    await identityRow(B, { version: 1, status: "in_review" }); await identityRow(B, { version: 2, status: "in_review" });
    const approve = (v: number) => codeOf(platform.execute(sql`update tax_identity set status = 'approved' where affiliate_id = ${B} and version = ${v}`));
    const results = await Promise.all([approve(1), approve(2)]);
    expect(results.sort()).toEqual(["23505", "ok"]);
    expect(rows<{ n: number }>(await admin.execute(sql`select count(*)::int as n from tax_identity where affiliate_id = ${B} and status = 'approved'`))[0]!.n).toBe(1);
  });

  it("subject, class and sealed-state CHECKs", async () => {
    expect(await codeOf(identityRow(A, { storeId: 5 }))).toBe("23514"); // exactly one subject column
    expect(await codeOf(identityRow(A, { subjectKind: "store", affiliateId: null, storeId: null }))).toBe("23514");
    expect(await codeOf(identityRow(A, { payeeClass: "entity", idKind: "nik" }))).toBe("23514"); // entities need an NPWP
    expect(await codeOf(identityRow(A, { idSealed: null }))).toBe("23514"); // sealed columns are null only when withdrawn
    expect(await codeOf(identityRow(A, { idKind: "passport" }))).toBe("23514");
    expect(await codeOf(identityRow(A, { clientRequestKey: "dup" }))).toBe("ok");
    expect(await codeOf(identityRow(A, { version: 2, clientRequestKey: "dup" }))).toBe("23505"); // request key unique per subject
  });
});

describe("T-65 voluntary identity service behind identity_capture_enabled", () => {
  const scope = (affiliateId: number): TaxAffiliateScope => ({ affiliateId, userId: `affiliate-user-${affiliateId}`, exec: platform });
  const IDENT = "123456789012345";
  const submission = (over: Partial<Parameters<typeof submitTaxIdentity>[1]> = {}) => ({ requestKey: randomUUID(), payeeClass: "individual" as const, idKind: "nik" as const, identifier: IDENT, registeredName: "Fixture Name", ...over });
  const captureOn = () => setSetting({ identityCaptureEnabled: true, noticeApprovalRef: "NOTICE-FIXTURE" });

  it("with the flag OFF nothing is stored and nothing else depends on it; no review is needed with it ON", async () => {
    await expect(submitTaxIdentity(scope(A), submission())).rejects.toMatchObject({ code: "identity_capture_disabled" });
    expect(await count("tax_identity")).toBe(0);
    await captureOn();
    const row = await submitTaxIdentity(scope(A), submission());
    expect(row).toMatchObject({ version: 1, status: "submitted", idLast4: "2345", idKind: "nik" });
    // A payout is not gated on it in startup mode.
    expect((await hook(A, randomUUID(), 10n)).taxIdr).toBe(0n);
  });

  it("stores no plaintext: sealed envelopes carry a key id, the fingerprint is keyed, and the DTO/listing never exposes either", async () => {
    await captureOn();
    const row = await submitTaxIdentity(scope(A), submission({ registeredName: "Nama Rahasia" }));
    const [raw] = await admin.select().from(taxIdentity).where(eq(taxIdentity.id, row.id));
    const stored = JSON.stringify(raw);
    expect(stored).not.toContain(IDENT);
    expect(stored).not.toContain("Nama Rahasia");
    expect([raw!.idKeyVersion, raw!.fingerprintKeyId]).toEqual(["k1", "f1"]);
    const base = { subjectKind: "affiliate" as const, subjectId: A, version: 1, idKind: "nik" };
    expect(unsealTaxValue(raw!.idSealed!, "k1", { ...base, field: "identifier" })).toBe(IDENT);
    expect(unsealTaxValue(raw!.registeredNameSealed!, "k1", { ...base, field: "registered_name" })).toBe("Nama Rahasia");
    const reader = await makeOperator(["tax.read"]);
    const listing = JSON.stringify(await listTaxIdentities(reader));
    expect(listing).not.toContain(IDENT);
    expect(listing).not.toContain("Nama Rahasia");
    expect(listing).not.toContain(raw!.idSealed!);
    expect(listing).not.toContain(raw!.idFingerprint!);
    expect(listing).toContain("2345");
    for (const e of rows<{ reason: string | null; evidence_ref: string | null; request_id: string | null }>(await admin.execute(sql`select reason, evidence_ref, request_id from tax_event`))) expect(JSON.stringify(e)).not.toContain(IDENT);
    await expect(listTaxIdentities(await makeOperator([]))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a sealed value is bound to subject, version, kind and field, authenticated, and only the keyed ring decrypts it", () => {
    const base = { subjectKind: "affiliate" as const, subjectId: A, version: 1, idKind: "npwp", field: "identifier" as const };
    const { envelope, keyId } = sealTaxValue("fixture-value", base);
    expect(unsealTaxValue(envelope, keyId, base)).toBe("fixture-value");
    for (const wrong of [{ ...base, subjectId: B }, { ...base, version: 2 }, { ...base, idKind: "nik" }, { ...base, field: "registered_name" as const }, { ...base, subjectKind: "store" as const }]) expect(() => unsealTaxValue(envelope, keyId, wrong)).toThrow();
    const [iv, ct, tag] = envelope.split(".");
    const flipped = Buffer.from(ct!, "base64"); flipped[0] = flipped[0]! ^ 1;
    expect(() => unsealTaxValue([iv, flipped.toString("base64"), tag].join("."), keyId, base)).toThrow();
    expect(() => unsealTaxValue(envelope, "unknown-key", base)).toThrow("tax_key_unavailable");
    expect(sealTaxValue("fixture-value", base).envelope).not.toBe(envelope); // fresh iv every time
  });

  it("the duplicate fingerprint is a keyed HMAC distinct from the sealing keys: deterministic per key, different across keys, never the plain hash; a reused secret is refused", () => {
    const first = taxIdentityFingerprint("nik", IDENT);
    expect(taxIdentityFingerprint("nik", IDENT)).toEqual(first);
    expect(taxIdentityFingerprint("npwp", IDENT).fingerprint).not.toBe(first.fingerprint);
    expect(first.fingerprint).not.toBe(sha256(`nik:${IDENT}`));
    vi.stubEnv("IDENTITY_FINGERPRINT_KEY", `f2:${key()}`);
    expect(taxIdentityFingerprint("nik", IDENT).fingerprint).not.toBe(first.fingerprint);
    vi.stubEnv("IDENTITY_FINGERPRINT_KEY", RING); // the sealing key also used as the fingerprint key
    expect(() => taxIdentityFingerprint("nik", IDENT)).toThrow("tax_key_purpose_reused");
    expect(() => sealTaxValue("x", { subjectKind: "affiliate", subjectId: A, version: 1, idKind: "nik", field: "identifier" })).toThrow("tax_key_purpose_reused");
  });

  it("an unavailable or malformed key fails closed: no row and no event", async () => {
    await captureOn();
    for (const bad of ["", "k1:short", "k1", ":" + key(), `k1:${key()},k1:${key()}`]) {
      vi.stubEnv("KEYRING_TAX_IDENTITY", bad);
      await expect(submitTaxIdentity(scope(A), submission())).rejects.toThrow("tax_key_unavailable");
    }
    vi.stubEnv("KEYRING_TAX_IDENTITY", RING);
    vi.stubEnv("IDENTITY_FINGERPRINT_KEY", "");
    await expect(submitTaxIdentity(scope(A), submission())).rejects.toThrow();
    expect(await count("tax_identity")).toBe(0);
    expect(await count("tax_event")).toBe(0);
  });

  it("syntax: 15 or 16 digits only, an entity needs an NPWP, a name is required; refusals write nothing", async () => {
    await captureOn();
    for (const bad of [submission({ identifier: "12345678901234" }), submission({ identifier: "12345678901234567" }), submission({ identifier: "12345678901234a" }), submission({ identifier: " 123456789012345" }), submission({ registeredName: "  " }), submission({ requestKey: " " }), submission({ payeeClass: "entity", idKind: "nik" })]) {
      await expect(submitTaxIdentity(scope(A), bad)).rejects.toMatchObject({ code: "invalid" });
    }
    expect(await count("tax_identity")).toBe(0);
    expect(await codeOf(submitTaxIdentity(scope(A), submission({ identifier: "1234567890123456" })))).toBe("ok");
  });

  it("the client request key replays to the same row; a new submission supersedes an unreviewed one with a new immutable version; concurrent same-key calls insert one row", async () => {
    await captureOn();
    const first = submission();
    const a = await submitTaxIdentity(scope(A), first);
    expect((await submitTaxIdentity(scope(A), first)).id).toBe(a.id);
    const racing = submission();
    const raced = await Promise.all([submitTaxIdentity(scope(A), racing), submitTaxIdentity(scope(A), racing), submitTaxIdentity(scope(A), racing)]);
    expect(new Set(raced.map((r) => r.id)).size).toBe(1);
    const statuses = (await platform.select({ v: taxIdentity.version, s: taxIdentity.status }).from(taxIdentity).where(eq(taxIdentity.affiliateId, A)).orderBy(taxIdentity.version)).map((r) => `${r.v}:${r.s}`);
    expect(statuses).toEqual(["1:superseded", "2:submitted"]);
    expect(rows<{ n: number }>(await admin.execute(sql`select count(*)::int as n from tax_event where entity_kind = 'identity' and event = 'submitted'`))[0]!.n).toBe(2);
    expect(rows<{ n: number }>(await admin.execute(sql`select count(*)::int as n from tax_event where entity_kind = 'identity' and event = 'superseded'`))[0]!.n).toBe(1);
    // An approved identity (phase 2) stays approved until a reviewer replaces it.
    await admin.execute(sql`update tax_identity set status = 'in_review' where affiliate_id = ${A} and version = 2`);
    await admin.execute(sql`update tax_identity set status = 'approved' where affiliate_id = ${A} and version = 2`);
    await submitTaxIdentity(scope(A), submission());
    expect((await platform.select({ s: taxIdentity.status }).from(taxIdentity).where(and(eq(taxIdentity.affiliateId, A), eq(taxIdentity.version, 2))))[0]!.s).toBe("approved");
  });

  it("a duplicate identifier across affiliates is flagged for review in the Owner listing and nobody is auto-rejected", async () => {
    await captureOn();
    await submitTaxIdentity(scope(A), submission());
    await submitTaxIdentity(scope(B), submission());
    await submitTaxIdentity(scope(B + 1), submission({ identifier: "999999999999999" }));
    const list = await listTaxIdentities(await makeOperator(["tax.read"]));
    expect(list.map((r) => [r.affiliateId, r.duplicate, r.status]).sort()).toEqual([[A, true, "submitted"], [B, true, "submitted"], [B + 1, false, "submitted"]]);
  });

  it("withdraw erases the sealed columns and the fingerprint when nothing references the version; the row stays, with an event", async () => {
    await captureOn();
    const row = await submitTaxIdentity(scope(A), submission());
    const out = await withdrawTaxIdentity(scope(A), row.id);
    expect(out.status).toBe("withdrawn");
    const [raw] = await admin.select().from(taxIdentity).where(eq(taxIdentity.id, row.id));
    expect([raw!.idSealed, raw!.registeredNameSealed, raw!.idKeyVersion, raw!.idFingerprint, raw!.fingerprintKeyId]).toEqual([null, null, null, null, null]);
    expect(raw!.idLast4).toBe("2345");
    expect((await withdrawTaxIdentity(scope(A), row.id)).status).toBe("withdrawn"); // replay
    expect(rows<{ n: number }>(await admin.execute(sql`select count(*)::int as n from tax_event where event = 'withdrawn'`))[0]!.n).toBe(1);
    // After withdrawal a new submission is version 2 and nothing is revived.
    expect((await submitTaxIdentity(scope(A), submission())).version).toBe(2);
  });

  it("a referenced version is retained, an approved one cannot be withdrawn by the payee, and nobody withdraws another affiliate's identity", async () => {
    await captureOn();
    const mine = await submitTaxIdentity(scope(A), submission());
    await expect(withdrawTaxIdentity(scope(B), mine.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await platform.select().from(taxIdentity))[0]!.idSealed).not.toBeNull();
    await withholdingOn(); const policy = await confirmedPolicy();
    await admin.execute(sql`update tax_identity set status = 'in_review' where id = ${mine.id}`);
    await admin.execute(sql`update tax_identity set status = 'approved' where id = ${mine.id}`);
    await expect(withdrawTaxIdentity(scope(A), mine.id)).rejects.toMatchObject({ code: "invalid_transition" });
    await hook(A, randomUUID(), 1000n);
    expect((await platform.select().from(taxComputation))[0]!.policyVersionId).toBe(policy.id);
    await admin.execute(sql`update tax_identity set status = 'superseded' where id = ${mine.id}`);
    await expect(withdrawTaxIdentity(scope(A), mine.id)).rejects.toMatchObject({ code: "identity_referenced" });
    // The database refuses the erasure of a referenced version even when the service is bypassed.
    expect(await codeOf(platform.execute(sql`update tax_identity set status = 'withdrawn', id_sealed = null, registered_name_sealed = null, id_key_version = null, id_fingerprint = null, fingerprint_key_id = null where id = ${mine.id}`))).toBe("23514");
    expect((await platform.select().from(taxIdentity).where(eq(taxIdentity.id, mine.id)))[0]!.idSealed).not.toBeNull();
  });

  it("re-seal moves an envelope to the ring's current key id with the AAD preserved; sealed columns have no other update path", async () => {
    await captureOn();
    const row = await submitTaxIdentity(scope(A), submission());
    expect(await codeOf(platform.execute(sql`update tax_identity set id_sealed = 'a.b.c' where id = ${row.id}`))).toBe("42501");
    expect(await codeOf(platform.execute(sql`update tax_identity set id_key_version = 'k9' where id = ${row.id}`))).toBe("42501");
    expect(await resealTaxIdentity(platform, row.id)).toBe(false); // already on the current key
    const k2 = key();
    vi.stubEnv("KEYRING_TAX_IDENTITY", `k2:${k2},${RING}`);
    expect(await resealTaxIdentity(platform, row.id)).toBe(true);
    expect(await resealTaxIdentity(platform, row.id)).toBe(false);
    const [raw] = await admin.select().from(taxIdentity).where(eq(taxIdentity.id, row.id));
    expect(raw!.idKeyVersion).toBe("k2");
    const base = { subjectKind: "affiliate" as const, subjectId: A, version: 1, idKind: "nik" };
    expect(unsealTaxValue(raw!.idSealed!, "k2", { ...base, field: "identifier" })).toBe(IDENT);
    expect(unsealTaxValue(raw!.registeredNameSealed!, "k2", { ...base, field: "registered_name" })).toBe("Fixture Name");
    vi.stubEnv("KEYRING_TAX_IDENTITY", `k2:${k2}`); // the old key may be retired once no row carries its id
    expect(unsealTaxValue(raw!.idSealed!, "k2", { ...base, field: "identifier" })).toBe(IDENT);
    expect(raw!.fingerprintKeyId).toBe("f1"); // the fingerprint key is separate and untouched
  });
});

describe("T-65 tax_document and tax_event", () => {
  const doc = (over: Partial<typeof taxDocument.$inferInsert> = {}): typeof taxDocument.$inferInsert => ({ kind: "earnings_statement", subjectKind: "affiliate", affiliateId: A, periodStart: "2030-01-01", periodEnd: "2030-02-01", revision: 1, number: `N-${randomUUID()}`, payload: { totals: 1 }, payloadSha256: "0".repeat(64), ...over });

  it("an issued payload and number are immutable; status moves only issued -> replaced or cancelled; nothing is deleted", async () => {
    const [d] = await admin.insert(taxDocument).values(doc()).returning();
    for (const set of [sql`payload = '{}'::jsonb`, sql`payload_sha256 = 'x'`, sql`number = 'other'`, sql`affiliate_id = ${B}`, sql`period_end = '2031-01-01'`]) expect(await codeOf(platform.execute(sql`update tax_document set ${set} where id = ${d!.id}`)), String(set)).toBe("42501");
    expect(await codeOf(platform.execute(sql`update tax_document set delivered_at = now() where id = ${d!.id}`))).toBe("ok"); // delivery and accountant references may be recorded later
    expect(await codeOf(platform.execute(sql`update tax_document set status = 'replaced' where id = ${d!.id}`))).toBe("ok");
    expect(await codeOf(platform.execute(sql`update tax_document set status = 'issued' where id = ${d!.id}`))).toBe("42501");
    expect(await codeOf(platform.execute(sql`delete from tax_document`))).toBe("42501");
    expect(await codeOf(admin.execute(sql`delete from tax_document`))).toBe("42501");
  });

  it("one issued document per kind, subject and period, unique numbers per kind, and tax-evidence kinds need a computation or invoice", async () => {
    await admin.insert(taxDocument).values(doc({ number: "N-1" }));
    expect(await codeOf(admin.insert(taxDocument).values(doc({ number: "N-2", revision: 2 })))).toBe("23505"); // a second ISSUED one for the same period
    expect(await codeOf(admin.insert(taxDocument).values(doc({ number: "N-1", periodStart: "2030-02-01", periodEnd: "2030-03-01" })))).toBe("23505");
    expect(await codeOf(admin.insert(taxDocument).values(doc({ kind: "withholding_slip", periodStart: "2030-02-01", periodEnd: "2030-03-01" })))).toBe("23514");
    expect(await codeOf(admin.insert(taxDocument).values(doc({ number: "N-3", periodEnd: "2030-01-01" })))).toBe("23514");
    expect(await codeOf(admin.insert(taxDocument).values(doc({ number: "N-4", affiliateId: null })))).toBe("23514");
    await admin.execute(sql`update tax_document set status = 'replaced' where number = 'N-1'`);
    expect(await codeOf(admin.insert(taxDocument).values(doc({ number: "N-5", revision: 2 })))).toBe("ok"); // replacement
  });

  it("own-statement SELECT only: affiliate B sees nothing of A's statements, no context sees nothing, the app role cannot write", async () => {
    await admin.insert(taxDocument).values([doc({ number: "A-1" }), doc({ number: "B-1", affiliateId: B })]);
    expect(await db.select({ n: taxDocument.number }).from(taxDocument)).toEqual([]);
    expect((await withAffiliate(db, A, (tx) => tx.select({ n: taxDocument.number }).from(taxDocument))).map((r) => r.n)).toEqual(["A-1"]);
    expect((await withAffiliate(db, B, (tx) => tx.select({ n: taxDocument.number }).from(taxDocument))).map((r) => r.n)).toEqual(["B-1"]);
    expect(await codeOf(withAffiliate(db, A, (tx) => tx.execute(sql`update tax_document set delivered_at = now()`)))).toBe("42501");
    expect(await codeOf(withAffiliate(db, A, (tx) => tx.insert(taxDocument).values(doc({ number: "X" }))))).toBe("42501");
  });

  it("tax_event is append-only for every role and the app role cannot touch any other tax table", async () => {
    await platform.insert(taxEvent).values({ entityKind: "setting", entityId: 1, event: "fixture" });
    for (const stmt of [sql`update tax_event set event = 'x'`, sql`delete from tax_event`]) {
      expect(await codeOf(admin.execute(stmt))).toBe("42501");
      expect(await codeOf(platform.execute(stmt))).toBe("42501");
    }
    for (const t of ["tax_setting", "tax_entity_profile", "tax_policy_version", "tax_computation", "tax_document_sequence", "tax_event"]) {
      expect(await codeOf(db.execute(sql`select 1 from ${sql.identifier(t)}`)), t).toBe("42501");
    }
  });
});
