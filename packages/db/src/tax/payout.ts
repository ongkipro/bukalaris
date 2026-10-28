import { and, eq, inArray, sql } from "drizzle-orm";
import type { Executor, Tx } from "../client.ts";
import { computeTax, MAX_IDR, resolveTaxPolicy, TaxRefusal, ZERO } from "./compute.ts";
import { taxComputation, taxEvent, taxIdentity, taxPolicyVersion } from "./schema-tax.ts";
import { effectiveTaxSetting } from "./settings.ts";

/** ADR-0009 section 6: T-53 takes this same lock before its balance/allocations work. */
export async function lockAffiliatePayout(tx: Tx, affiliateId: number): Promise<void> {
  if (!Number.isSafeInteger(affiliateId) || affiliateId <= 0) throw new TaxRefusal("policy_invalid");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('bukalaris.payout.affiliate'), hashtext(${String(affiliateId)}))`);
}
export async function effectiveTaxPolicy(exec: Executor, input: { taxTypeCode: string; categoryCode: string; asOfDate: string }) {
  const policies = await exec.select().from(taxPolicyVersion).where(and(eq(taxPolicyVersion.taxTypeCode, input.taxTypeCode), eq(taxPolicyVersion.categoryCode, input.categoryCode), eq(taxPolicyVersion.status, "confirmed")));
  return resolveTaxPolicy(policies, input.taxTypeCode, input.categoryCode, input.asOfDate);
}
const payoutResult = (row: typeof taxComputation.$inferSelect) => ({ taxSettingVersionId: row.taxSettingVersionId, taxComputationId: row.id, grossIdr: row.grossIdr, taxIdr: row.taxIdr, netIdr: row.netIdr });

/** Runs only inside the caller's payout transaction, before its debit. No provider calls, no nested commit. */
export async function payoutTaxHook(tx: Tx, input: { affiliateId: number; payoutId: string; grossIdr: bigint; requestedAt: Date }) {
  await lockAffiliatePayout(tx, input.affiliateId); // Reentrant when the caller correctly holds it; safe if accidentally omitted.
  if (input.grossIdr < ZERO || input.grossIdr > MAX_IDR || !Number.isFinite(input.requestedAt.getTime())) throw new TaxRefusal("policy_invalid");
  const [existing] = await tx.select().from(taxComputation).where(and(eq(taxComputation.sourceKind, "affiliate_payout"), eq(taxComputation.sourceId, input.payoutId), eq(taxComputation.kind, "original")));
  if (existing) {
    if (existing.affiliateId !== input.affiliateId || existing.grossIdr !== input.grossIdr || existing.status === "void") throw new TaxRefusal("replay_mismatch");
    return payoutResult(existing);
  }
  const setting = await effectiveTaxSetting(tx, input.requestedAt);
  const [identity] = setting.taxIdentityRequiredForPayout ? await tx.select().from(taxIdentity).where(and(eq(taxIdentity.affiliateId, input.affiliateId), eq(taxIdentity.status, "approved"))) : [];
  if (setting.taxIdentityRequiredForPayout && !identity) throw new TaxRefusal("tax_identity_missing");
  if (!setting.withholdingEnabled) return { taxSettingVersionId: setting.id, taxComputationId: null, grossIdr: input.grossIdr, taxIdr: ZERO, netIdr: input.grossIdr };
  // Production activation is T-67 and requires the full ADR-0012 checklist, not a forged fixture setting.
  if (process.env.NODE_ENV !== "test") throw new TaxRefusal("tax_not_activated");
  const asOfDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(input.requestedAt);
  const taxYear = Number(asOfDate.slice(0, 4));
  const policy = await effectiveTaxPolicy(tx, { taxTypeCode: "commission_withholding", categoryCode: identity!.payeeClass, asOfDate });
  const [policyRow] = await tx.select({ identityKindsAccepted: taxPolicyVersion.identityKindsAccepted }).from(taxPolicyVersion).where(eq(taxPolicyVersion.id, policy.id));
  if (!policyRow!.identityKindsAccepted.includes(identity!.idKind)) throw new TaxRefusal("tax_identity_missing");
  const [ytd] = await tx.select({ base: sql<string>`coalesce(sum(${taxComputation.baseIdr}), 0)::text`, tax: sql<string>`coalesce(sum(${taxComputation.taxIdr}), 0)::text` }).from(taxComputation).where(and(eq(taxComputation.affiliateId, input.affiliateId), eq(taxComputation.taxTypeCode, policy.taxTypeCode), eq(taxComputation.taxYear, taxYear), inArray(taxComputation.status, ["computed", "recognized"])));
  const computed = computeTax([policy], { taxTypeCode: policy.taxTypeCode, categoryCode: policy.categoryCode, asOfDate, taxYear, grossIdr: input.grossIdr, ytdBaseBeforeIdr: BigInt(ytd!.base), ytdTaxBeforeIdr: BigInt(ytd!.tax) });
  const [row] = await tx.insert(taxComputation).values({ ...computed, taxTypeCode: policy.taxTypeCode, categoryCode: policy.categoryCode, affiliateId: input.affiliateId, sourceKind: "affiliate_payout", sourceId: input.payoutId, taxYear, taxIdentityId: identity!.id, taxSettingVersionId: setting.id, grossIdr: input.grossIdr, ytdBaseBeforeIdr: BigInt(ytd!.base), ytdTaxBeforeIdr: BigInt(ytd!.tax) }).returning();
  await tx.insert(taxEvent).values({ entityKind: "computation", entityId: row!.id, event: "computed", requestId: input.payoutId });
  return payoutResult(row!);
}
export async function transitionPayoutTax(tx: Tx, input: { affiliateId: number; payoutId: string; outcome: "paid" | "rejected"; at: Date }) {
  await lockAffiliatePayout(tx, input.affiliateId);
  const [row] = await tx.select().from(taxComputation).where(and(eq(taxComputation.sourceId, input.payoutId), eq(taxComputation.sourceKind, "affiliate_payout"), eq(taxComputation.kind, "original")));
  if (!row) return null; // Startup payout has no tax computation.
  if (row.affiliateId !== input.affiliateId) throw new TaxRefusal("replay_mismatch");
  const status = input.outcome === "paid" ? "recognized" : "void";
  if (row.status === status) return row;
  if (row.status !== "computed") throw new TaxRefusal("invalid_transition");
  const [changed] = await tx.update(taxComputation).set({ status, recognizedAt: status === "recognized" ? input.at : null }).where(eq(taxComputation.id, row.id)).returning();
  await tx.insert(taxEvent).values({ entityKind: "computation", entityId: row.id, event: status, requestId: input.payoutId });
  return changed!;
}
