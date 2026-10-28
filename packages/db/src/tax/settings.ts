import { desc, eq, lte, sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { requirePlatformCap } from "../ops/capabilities.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { TaxRefusal } from "./compute.ts";
import { auditLog } from "../schema.ts";
import { taxEntityProfile, taxEvent, taxSetting } from "./schema-tax.ts";

export async function effectiveTaxSetting(exec: Executor, asOf: Date) {
  const [row] = await exec.select().from(taxSetting).where(lte(taxSetting.effectiveFrom, asOf)).orderBy(desc(taxSetting.effectiveFrom)).limit(1);
  if (!row) throw new TaxRefusal("tax_not_activated");
  return row;
}
export async function readTaxSettings(op: OperatorScope) {
  await requirePlatformCap(op, "tax.read");
  return op.exec.select().from(taxSetting).orderBy(desc(taxSetting.version));
}
export interface TaxSettingChange {
  effectiveFrom: Date; reason: string; statementsEnabled: boolean; identityCaptureEnabled: boolean;
  noticeApprovalRef: string | null; taxIdentityRequiredForPayout: boolean; withholdingEnabled: boolean;
  pkpGateEnabled: boolean; activationRef: string | null; entityProfileId: number | null;
}
/** No HTTP activation endpoint is exposed. Phase-2 switches are refused outside fixture/test runtimes. */
export async function appendTaxSetting(op: OperatorScope, input: TaxSettingChange) {
  await requirePlatformCap(op, "tax.manage");
  if (!input.reason.trim() || !Number.isFinite(input.effectiveFrom.getTime()) || input.effectiveFrom.getTime() <= Date.now()) throw new DomainError("invalid", "Prospective setting and reason required");
  if ((input.withholdingEnabled || input.taxIdentityRequiredForPayout || input.pkpGateEnabled) && process.env.NODE_ENV !== "test") throw new TaxRefusal("tax_not_activated");
  if (input.identityCaptureEnabled && !input.noticeApprovalRef?.trim()) throw new DomainError("notice_required", "Approved notice reference required");
  return op.exec.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('bukalaris.tax.settings'))`);
    if (input.withholdingEnabled) {
      const [profile] = await tx.select({ status: taxEntityProfile.status }).from(taxEntityProfile).where(eq(taxEntityProfile.id, input.entityProfileId ?? -1));
      if (!input.taxIdentityRequiredForPayout || !input.activationRef?.trim() || profile?.status !== "confirmed") throw new TaxRefusal("tax_not_activated");
    }
    const [previous] = await tx.select({ version: taxSetting.version, effectiveFrom: taxSetting.effectiveFrom }).from(taxSetting).orderBy(desc(taxSetting.version)).limit(1);
    if (previous && input.effectiveFrom <= previous.effectiveFrom) throw new DomainError("invalid", "Setting versions must be ordered prospectively");
    const [row] = await tx.insert(taxSetting).values({ ...input, version: (previous?.version ?? 0) + 1, createdBy: op.userId }).returning();
    await tx.insert(taxEvent).values({ entityKind: "setting", entityId: row!.id, event: "created", actorUserId: op.userId, reason: input.reason, evidenceRef: input.noticeApprovalRef });
    await tx.insert(auditLog).values({ actorUserId: op.userId, storeId: null, action: "tax.setting.append", reason: `v${row!.version}: ${input.reason}`.slice(0, 500) });
    return row!;
  });
}
