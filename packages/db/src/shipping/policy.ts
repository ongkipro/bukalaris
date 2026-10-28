import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../client.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { requirePlatformCap } from "../ops/capabilities.ts";
import { consumeApproval, payloadHash, requestApproval } from "../ops/capabilities-approvals.ts";
import { consoleMutation } from "../ops/console.ts";
import { cashbackRule, shippingControl } from "./schema-accounts.ts";
import { courierServicePolicy, shippingMarginRule } from "../schema.ts";
import { approvalRequest } from "../ops/schema-ops.ts";
import { marginRuleInput } from "./shipping.ts";

export const SHIPPING_DISCOUNT_DEFAULTS = { discountIdr: 0, discountBps: 0 } as const;
export const SHIPPING_CASHBACK_DEFAULTS = { enabled: false, sellerShareBps: 0, fixedSellerBonusIdr: 0 } as const;
const reason = z.string().trim().min(5, "Alasan minimal 5 karakter.").max(300);
const code = z.string().trim().regex(/^[A-Za-z0-9_-]{0,40}$/, "Kode hanya huruf, angka, - dan _.");
export const shippingSettingsInput = z.strictObject({
  revision: z.coerce.number().int().nonnegative(), preferPartner: z.boolean(),
  discountIdr: z.coerce.number().int().min(0).max(100_000), discountBps: z.coerce.number().int().min(0).max(10_000),
  reason,
});
export const cashbackRuleInput = z.strictObject({ courierCode: code, serviceCode: code, sellerShareBps: z.coerce.number().int().min(0).max(10_000), fixedSellerBonusIdr: z.coerce.number().int().min(0).max(100_000), revision: z.coerce.number().int().nonnegative(), reason });
export const courierPolicyInput = z.strictObject({ courierCode: code.refine(Boolean), serviceCode: code, codAllowed: z.boolean(), returnFree: z.boolean(), status: z.enum(["active", "disabled"]), reason });

export async function shippingPolicyOverview(op: OperatorScope) {
  await requirePlatformCap(op, "shipping.manage");
  const [settings] = await op.exec.select().from(shippingControl).where(eq(shippingControl.key, "default"));
  if (!settings) throw new DomainError("settings_unavailable", "Pengaturan pengiriman belum tersedia.");
  const [cashbackRules, services] = await Promise.all([op.exec.select().from(cashbackRule).orderBy(asc(cashbackRule.courierCode), asc(cashbackRule.serviceCode)), op.exec.select().from(courierServicePolicy).orderBy(asc(courierServicePolicy.courierCode), asc(courierServicePolicy.serviceCode))]);
  return { settings, cashbackRules, services, cashbackEffective: false as const };
}
export async function requestShippingSettings(op: OperatorScope, raw: unknown) {
  await requirePlatformCap(op, "shipping.manage");
  const { reason: why, ...payload } = shippingSettingsInput.parse(raw);
  const request = await requestApproval(op, { actionKey: "shipping.margin", targetKind: "shipping_policy", targetId: "default", payload, reason: why });
  return { approvalId: request.id };
}
export async function applyShippingSettings(op: OperatorScope, approvalId: number, raw: unknown) {
  const { reason: why, ...payload } = shippingSettingsInput.parse(raw);
  return consoleMutation(op, { capability: "shipping.manage", action: "shipping.settings", targetKind: "shipping_policy", targetId: "default", reason: why, reasonCode: "policy_change" }, async (tx) => {
    await consumeApproval(tx, op, { approvalId, actionKey: "shipping.margin", targetKind: "shipping_policy", targetId: "default", payloadSha256: payloadHash(payload) });
    const updated = await tx.update(shippingControl).set({ ...payload, revision: payload.revision + 1, approvalRequestId: approvalId, updatedBy: op.userId, updatedAt: new Date() }).where(and(eq(shippingControl.key, "default"), eq(shippingControl.revision, payload.revision))).returning({ key: shippingControl.key });
    if (!updated.length) throw new DomainError("conflict", "Pengaturan berubah; muat ulang dan ajukan ulang.");
  });
}
export async function saveCashbackRule(op: OperatorScope, raw: unknown) {
  const { reason: why, revision, ...values } = cashbackRuleInput.parse(raw);
  return consoleMutation(op, { capability: "shipping.manage", action: "shipping.cashback.draft", targetKind: "cashback_rule", targetId: `${values.courierCode}/${values.serviceCode}`, reason: why, reasonCode: "cashback_draft" }, async (tx) => {
    const [row] = await tx.select({ id: cashbackRule.id, revision: cashbackRule.revision }).from(cashbackRule).where(and(eq(cashbackRule.courierCode, values.courierCode), eq(cashbackRule.serviceCode, values.serviceCode))).for("update");
    if (row && row.revision !== revision) throw new DomainError("conflict", "Draf berubah; muat ulang sebelum menyimpan.");
    // Rules can be authored, but remain disabled. No caller can invent effective cashback or turn the OPEN-F9 switch on.
    if (row) await tx.update(cashbackRule).set({ ...values, status: "disabled", revision: revision + 1, updatedBy: op.userId, updatedAt: new Date() }).where(eq(cashbackRule.id, row.id));
    else await tx.insert(cashbackRule).values({ ...values, status: "disabled", updatedBy: op.userId });
  });
}
export async function setCourierPolicy(op: OperatorScope, raw: unknown) {
  const { reason: why, ...values } = courierPolicyInput.parse(raw);
  return consoleMutation(op, { capability: "shipping.manage", action: "shipping.courier", targetKind: "courier_service_policy", targetId: `${values.courierCode}/${values.serviceCode}`, reason: why, reasonCode: "service_policy" }, async (tx) => {
    await tx.insert(courierServicePolicy).values({ ...values, updatedBy: op.userId }).onConflictDoUpdate({ target: [courierServicePolicy.courierCode, courierServicePolicy.serviceCode], set: { ...values, updatedBy: op.userId, updatedAt: new Date() } });
  });
}
/**
 * Discounts are platform-margin funded, never a made-up provider rebate and never a seller debit. The discount amount is returned so checkout freezes it
 * in the order financial snapshot (`platform_shipping_discount_idr`): booking counts it as money collected, so a later courier price rise is absorbed by
 * the full margin first and the seller is only debited beyond it.
 */
export function applyShippingDiscount(fee: { providerCost: number; margin: number; buyerFee: number }, settings: { discountIdr: number; discountBps: number }) {
  const discount = Math.min(fee.margin, settings.discountIdr + Number(BigInt(fee.buyerFee) * BigInt(settings.discountBps) / BigInt(10_000)));
  return { providerCost: fee.providerCost, margin: fee.margin - discount, buyerFee: fee.buyerFee - discount, platformDiscount: discount };
}
export async function effectiveShippingDiscount(exec: Executor) {
  const [row] = await exec.select({ discountIdr: shippingControl.discountIdr, discountBps: shippingControl.discountBps }).from(shippingControl).where(eq(shippingControl.key, "default"));
  return row ?? SHIPPING_DISCOUNT_DEFAULTS;
}
/** The margin rule's current revision (0 while no row exists: the built-in default applies). */
const marginRevision = async (exec: Executor) => (await exec.select({ revision: shippingMarginRule.revision }).from(shippingMarginRule).where(eq(shippingMarginRule.key, "default")))[0]?.revision ?? 0;
const boundRevision = z.object({ revision: z.number().int().nonnegative() });
/** The approved payload names the revision it was requested against, so an older approval can never overwrite a newer one (DB guard `shipping_policy_guard` checks the same). */
export async function requestMarginRule(op: OperatorScope, raw: unknown) {
  await requirePlatformCap(op, "shipping.manage");
  const payload = { revision: await marginRevision(op.exec), ...marginRuleInput.parse(raw) };
  const request = await requestApproval(op, { actionKey: "shipping.margin", targetKind: "shipping_margin_rule", targetId: "default", payload, reason: "Perubahan margin ongkir pesanan baru" });
  return { approvalId: request.id };
}
export async function applyApprovedMargin(op: OperatorScope, rule: { fixedIdr: number; percentBps: number; roundTo: number }, approvalId: number) {
  return consoleMutation(op, { capability: "shipping.manage", action: "shipping.margin.update", targetKind: "shipping_margin_rule", targetId: "default", reason: `fixed=${rule.fixedIdr} bps=${rule.percentBps} roundTo=${rule.roundTo}`, reasonCode: "margin_change" }, async (tx) => {
    // The revision the approver approved is read from the approval's own stored payload; the rule row is locked so two applies serialise.
    const [approval] = await tx.select({ canonical: approvalRequest.payloadCanonical, status: approvalRequest.status }).from(approvalRequest).where(eq(approvalRequest.id, approvalId));
    const bound = approval?.status === "approved" ? boundRevision.safeParse(JSON.parse(approval.canonical)) : null; // a used, rejected or expired approval is invalid, not stale
    if (!bound?.success) throw new DomainError("approval_invalid", "Persetujuan tidak berlaku: tidak ada, kedaluwarsa, sudah dipakai, atau tidak cocok dengan tindakan ini.");
    const [current] = await tx.select({ revision: shippingMarginRule.revision }).from(shippingMarginRule).where(eq(shippingMarginRule.key, "default")).for("update");
    if ((current?.revision ?? 0) !== bound.data.revision) throw new DomainError("approval_stale", "Persetujuan ini dibuat untuk aturan margin yang sudah berubah. Ajukan perubahan baru dan minta persetujuan ulang.");
    const payload = { revision: bound.data.revision, ...rule };
    await consumeApproval(tx, op, { approvalId, actionKey: "shipping.margin", targetKind: "shipping_margin_rule", targetId: "default", payloadSha256: payloadHash(payload) });
    const values = { ...rule, approvalRequestId: approvalId, updatedBy: op.userId, revision: bound.data.revision + 1 };
    if (current) await tx.update(shippingMarginRule).set({ ...values, updatedAt: new Date() }).where(and(eq(shippingMarginRule.key, "default"), eq(shippingMarginRule.revision, bound.data.revision)));
    else await tx.insert(shippingMarginRule).values({ key: "default", ...values });
    return rule;
  });
}
