import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../client.ts";
import { requirePlatformCap } from "../ops/capabilities.ts";
import { consoleMutation } from "../ops/console.ts";
import { consumeApproval, payloadHash, requestApproval } from "../ops/capabilities-approvals.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { providerLiveSetting } from "./schema-shipping.ts";

// T-105 (ADR-0013 decision 34, C-P4): the Mengantar production switch in the Owner console (SA-07). Off by default (no row = off); it can be
// switched on only after a sandbox pass was recorded, and every change is an audited console mutation with its reason. Only calls on sellers'
// PRODUCTION keys depend on it (`shipping/seller.ts`); sandbox accounts and the local fake do not. The AutoLaris row is T-106's.

export type LiveSettingView = { provider: "mengantar"; sandboxPassedAt: Date | null; sandboxPassNote: string | null; productionEnabled: boolean; revision: number; updatedAt: Date | null };

export async function mengantarLiveSetting(op: OperatorScope): Promise<LiveSettingView> {
  await requirePlatformCap(op, "shipping.manage");
  const [row] = await op.exec
    .select({ sandboxPassedAt: providerLiveSetting.sandboxPassedAt, sandboxPassNote: providerLiveSetting.sandboxPassNote, productionEnabled: providerLiveSetting.productionEnabled, revision: providerLiveSetting.revision, updatedAt: providerLiveSetting.updatedAt })
    .from(providerLiveSetting)
    .where(eq(providerLiveSetting.provider, "mengantar"));
  return { provider: "mengantar", sandboxPassedAt: row?.sandboxPassedAt ?? null, sandboxPassNote: row?.sandboxPassNote ?? null, productionEnabled: row?.productionEnabled ?? false, revision: row?.revision ?? 0, updatedAt: row?.updatedAt ?? null };
}

const revision = z.coerce.number().int().nonnegative();
const passInput = z.strictObject({ revision, note: z.string().trim().min(10, "Tulis bukti uji sandbox minimal 10 karakter (tanggal, hasil, tempat bukti disimpan).").max(500) });
const reason = z.string().trim().min(5, "Alasan minimal 5 karakter.").max(300);
const switchInput = z.strictObject({ revision, enabled: z.boolean(), reason, approvalId: z.coerce.number().int().positive().optional() });
const requestInput = z.strictObject({ revision, reason });
/**
 * The four-eyes action and payload of switching ON, shared with T-106's AutoLaris switch (target id = the provider, same payload shape). The
 * payload names the recorded sandbox pass and the row revision it was requested at, so an approval never survives a new sandbox pass.
 */
export const PRODUCTION_ON_ACTION = "providers.production_on" as const;
const productionOnPayload = (row: { sandboxPassedAt: Date | null; revision: number }) => ({ provider: "mengantar", enabled: true, sandboxPassAt: row.sandboxPassedAt?.toISOString() ?? null, revision: row.revision });

async function lockedRow(tx: Tx, userId: string, expected: number) {
  await tx.insert(providerLiveSetting).values({ provider: "mengantar", updatedBy: userId }).onConflictDoNothing();
  const [row] = await tx.select().from(providerLiveSetting).where(eq(providerLiveSetting.provider, "mengantar")).for("update");
  if (row!.revision !== expected) throw new DomainError("conflict", "Pengaturan berubah; muat ulang halaman sebelum menyimpan.");
  return row!;
}

/** Records the sandbox pass (the evidence note says where the run is recorded). A new pass replaces the previous one; the switch is unchanged. */
export async function recordMengantarSandboxPass(op: OperatorScope, raw: unknown): Promise<void> {
  const input = passInput.parse(raw);
  await consoleMutation(op, { capability: "shipping.manage", action: "provider.sandbox_pass", targetKind: "provider_live_setting", targetId: "mengantar", reason: input.note, reasonCode: "sandbox_pass" }, async (tx) => {
    await lockedRow(tx, op.userId, input.revision);
    await tx.update(providerLiveSetting).set({ sandboxPassedAt: sql`now()`, sandboxPassNote: input.note, sandboxPassBy: op.userId, revision: input.revision + 1, updatedBy: op.userId, updatedAt: sql`now()` }).where(eq(providerLiveSetting.provider, "mengantar"));
  });
}

/** Step 1 of switching ON (four-eyes, review minor 1): needs a recorded sandbox pass; a second operator approves it in the approvals screen. */
export async function requestMengantarProductionOn(op: OperatorScope, raw: unknown): Promise<{ approvalId: number }> {
  await requirePlatformCap(op, "shipping.manage");
  const input = requestInput.parse(raw);
  const current = await mengantarLiveSetting(op);
  if (current.revision !== input.revision) throw new DomainError("conflict", "Pengaturan berubah; muat ulang halaman sebelum mengajukan.");
  if (!current.sandboxPassedAt) throw new DomainError("sandbox_pass_missing", "Catat dulu uji sandbox yang lolos sebelum membuka panggilan produksi.");
  const request = await requestApproval(op, { actionKey: PRODUCTION_ON_ACTION, targetKind: "provider_production_switch", targetId: "mengantar", payload: productionOnPayload(current), reason: input.reason });
  return { approvalId: request.id };
}

/**
 * Switches calls on sellers' production Mengantar keys on or off. ON needs a recorded sandbox pass (also a database check) and an approval of a
 * second operator consumed once by the requester, bound to the recorded sandbox pass and the revision it was requested at (a new pass or any
 * later change refuses it); OFF is immediate (the safe direction).
 */
export async function setMengantarProductionCalls(op: OperatorScope, raw: unknown): Promise<void> {
  const input = switchInput.parse(raw);
  await consoleMutation(op, { capability: "shipping.manage", action: input.enabled ? "provider.production.on" : "provider.production.off", targetKind: "provider_live_setting", targetId: "mengantar", reason: input.reason, reasonCode: "production_switch" }, async (tx) => {
    const row = await lockedRow(tx, op.userId, input.revision);
    if (input.enabled && !row.sandboxPassedAt) throw new DomainError("sandbox_pass_missing", "Catat dulu uji sandbox yang lolos sebelum membuka panggilan produksi.");
    if (input.enabled) {
      if (!input.approvalId) throw new DomainError("approval_invalid", "Membuka panggilan produksi memerlukan persetujuan operator kedua.");
      await consumeApproval(tx, op, { approvalId: input.approvalId, actionKey: PRODUCTION_ON_ACTION, targetKind: "provider_production_switch", targetId: "mengantar", payloadSha256: payloadHash(productionOnPayload(row)) });
    }
    await tx.update(providerLiveSetting).set({ productionEnabled: input.enabled, revision: input.revision + 1, updatedBy: op.userId, updatedAt: sql`now()` }).where(eq(providerLiveSetting.provider, "mengantar"));
  });
}
