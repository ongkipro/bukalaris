import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { requirePlatformCap } from "../ops/capabilities.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { withAffiliate } from "../platform/tenant.ts";
import { lockAffiliatePayout } from "./payout.ts";
import { taxComputation, taxEvent, taxIdentity } from "./schema-tax.ts";
import { effectiveTaxSetting } from "./settings.ts";
import { sealTaxValue, taxIdentityFingerprint } from "./seal.ts";

/** Supplied by the authenticated affiliate service (T-52), never constructed from request data. */
export interface TaxAffiliateScope { readonly affiliateId: number; readonly userId: string; readonly exec: Executor }
export const TAX_IDENTITY_SAFE_COLUMNS = { id: taxIdentity.id, affiliateId: taxIdentity.affiliateId, version: taxIdentity.version, status: taxIdentity.status, payeeClass: taxIdentity.payeeClass, idKind: taxIdentity.idKind, idLast4: taxIdentity.idLast4, submittedAt: taxIdentity.submittedAt };
export async function ownTaxIdentities(scope: TaxAffiliateScope) {
  return withAffiliate(scope.exec, scope.affiliateId, (tx) => tx.select(TAX_IDENTITY_SAFE_COLUMNS).from(taxIdentity).where(eq(taxIdentity.affiliateId, scope.affiliateId)).orderBy(desc(taxIdentity.version)));
}
export async function listTaxIdentities(op: OperatorScope) {
  await requirePlatformCap(op, "tax.read");
  return op.exec.select({ ...TAX_IDENTITY_SAFE_COLUMNS, duplicate: sql<boolean>`exists(select 1 from public.tax_identity other where other.id_kind = tax_identity.id_kind and other.id_fingerprint = tax_identity.id_fingerprint and other.fingerprint_key_id = tax_identity.fingerprint_key_id and other.affiliate_id <> tax_identity.affiliate_id and other.status in ('submitted','in_review','approved'))` }).from(taxIdentity).orderBy(desc(taxIdentity.submittedAt));
}
export interface TaxIdentitySubmission { requestKey: string; payeeClass: "individual" | "entity"; idKind: "npwp" | "nik"; identifier: string; registeredName: string }
/** Uses the named platform executor supplied by the affiliate application service, not the app login. */
export async function submitTaxIdentity(scope: TaxAffiliateScope, input: TaxIdentitySubmission) {
  if (!/^\d{15,16}$/.test(input.identifier) || !input.registeredName.trim() || !input.requestKey.trim() || (input.payeeClass === "entity" && input.idKind !== "npwp")) throw new DomainError("invalid", "Invalid tax identity syntax");
  return scope.exec.transaction(async (tx) => {
    await lockAffiliatePayout(tx, scope.affiliateId);
    const setting = await effectiveTaxSetting(tx, new Date());
    if (!setting.identityCaptureEnabled) throw new DomainError("identity_capture_disabled", "Voluntary capture is disabled");
    const [existing] = await tx.select(TAX_IDENTITY_SAFE_COLUMNS).from(taxIdentity).where(and(eq(taxIdentity.affiliateId, scope.affiliateId), eq(taxIdentity.clientRequestKey, input.requestKey)));
    if (existing) return existing;
    const [latest] = await tx.select({ version: taxIdentity.version }).from(taxIdentity).where(eq(taxIdentity.affiliateId, scope.affiliateId)).orderBy(desc(taxIdentity.version)).limit(1);
    const version = (latest?.version ?? 0) + 1;
    const binding = { subjectKind: "affiliate" as const, subjectId: scope.affiliateId, version, idKind: input.idKind };
    const identifier = sealTaxValue(input.identifier, { ...binding, field: "identifier" });
    const name = sealTaxValue(input.registeredName.trim(), { ...binding, field: "registered_name" });
    const fingerprint = taxIdentityFingerprint(input.idKind, input.identifier);
    const superseded = await tx.update(taxIdentity).set({ status: "superseded" }).where(and(eq(taxIdentity.affiliateId, scope.affiliateId), eq(taxIdentity.status, "submitted"))).returning({ id: taxIdentity.id });
    for (const old of superseded) await tx.insert(taxEvent).values({ entityKind: "identity", entityId: old.id, event: "superseded", actorUserId: scope.userId });
    const [row] = await tx.insert(taxIdentity).values({ subjectKind: "affiliate", affiliateId: scope.affiliateId, version, payeeClass: input.payeeClass, idKind: input.idKind, idSealed: identifier.envelope, idKeyVersion: identifier.keyId, registeredNameSealed: name.envelope, idLast4: input.identifier.slice(-4), idFingerprint: fingerprint.fingerprint, fingerprintKeyId: fingerprint.keyId, clientRequestKey: input.requestKey }).returning(TAX_IDENTITY_SAFE_COLUMNS);
    await tx.insert(taxEvent).values({ entityKind: "identity", entityId: row!.id, event: "submitted", actorUserId: scope.userId, requestId: input.requestKey });
    return row!;
  });
}
export async function withdrawTaxIdentity(scope: TaxAffiliateScope, identityId: number) {
  return scope.exec.transaction(async (tx) => {
    await lockAffiliatePayout(tx, scope.affiliateId);
    const [row] = await tx.select(TAX_IDENTITY_SAFE_COLUMNS).from(taxIdentity).where(and(eq(taxIdentity.id, identityId), eq(taxIdentity.affiliateId, scope.affiliateId)));
    if (!row) throw new DomainError("not_found", "Identity not found");
    if (row.status === "withdrawn") return row;
    if (!["submitted", "superseded", "rejected", "revoked"].includes(row.status)) throw new DomainError("invalid_transition", "Reviewed identity cannot be withdrawn");
    const [reference] = await tx.select({ id: taxComputation.id }).from(taxComputation).where(eq(taxComputation.taxIdentityId, row.id)).limit(1);
    // Referenced versions are retained unchanged pending the approved statutory retention policy.
    if (reference) throw new DomainError("identity_referenced", "Tax evidence references this identity");
    const [withdrawn] = await tx.update(taxIdentity).set({ status: "withdrawn", idSealed: null, idKeyVersion: null, registeredNameSealed: null, idFingerprint: null, fingerprintKeyId: null }).where(and(eq(taxIdentity.id, row.id), ne(taxIdentity.status, "withdrawn"))).returning(TAX_IDENTITY_SAFE_COLUMNS);
    await tx.insert(taxEvent).values({ entityKind: "identity", entityId: row.id, event: "withdrawn", actorUserId: scope.userId });
    return withdrawn!;
  });
}
