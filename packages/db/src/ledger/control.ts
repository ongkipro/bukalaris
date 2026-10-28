import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../client.ts";
import { consoleMutation } from "../ops/console.ts";
import { pgCode } from "../ops/capabilities.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { payoutControl } from "../schema.ts";
import { PAYOUT_DESTINATION_HOLD_HOURS } from "./settings.ts";

// The post-restore payout freeze (RUNBOOK 14, DR-1, TASKS T-37 "payout-job freeze switch"). After a restore to an earlier point every `requested`, `processing` and
// `paid` payout and refund must be reconciled against bank evidence BEFORE money moves again. While `payout_control.frozen` is set, migration 0014 makes the
// database refuse a new payout request, every payout/refund status or claim change and the application of a COD reconciliation batch; the services below
// check it first so the caller gets a plain message, and `frozenOr` maps the trigger's refusal if the switch flips between the check and the write.
// Still possible while frozen: a seller reading the screen, a buyer submitting a refund destination, an operator noting that an outcome is unknown, ledger.release.

export const PAYOUTS_FROZEN_MESSAGE = "Penarikan dana dan transfer sedang dibekukan sementara karena pemulihan data. Tidak ada dana yang diproses sampai pembekuan dicabut; dana Anda aman.";

export type PayoutFreeze = { frozen: boolean; reason: string | null; changedAt: Date | null; changedBy: string | null };

/** The switch as stored. A missing row reads as frozen (the database guard fails closed the same way). */
export async function payoutFreeze(exec: Executor): Promise<PayoutFreeze> {
  const [row] = await exec.select().from(payoutControl).where(eq(payoutControl.id, 1));
  return row ? { frozen: row.frozen, reason: row.reason, changedAt: row.changedAt, changedBy: row.changedBy } : { frozen: true, reason: "payout_control row missing", changedAt: null, changedBy: null };
}

/** D-19: hours a new or changed payout destination is held. A named setting of `payout_control` (the database refuses a shorter hold); a missing row reads as the default. */
export async function payoutHoldHours(exec: Executor): Promise<number> {
  const [row] = await exec.select({ h: payoutControl.destinationHoldHours }).from(payoutControl).where(eq(payoutControl.id, 1));
  return row?.h ?? PAYOUT_DESTINATION_HOLD_HOURS;
}

export async function assertPayoutsNotFrozen(exec: Executor): Promise<void> {
  if ((await payoutFreeze(exec)).frozen) throw new DomainError("payouts_frozen", PAYOUTS_FROZEN_MESSAGE);
}
const messageChain = (err: unknown): string => (err instanceof Error ? `${err.message} ${messageChain(err.cause)}` : "");

/** Map the database guard's refusal (SQLSTATE 55000, `payouts_frozen`) to the domain error; every other error passes through untouched. */
export function frozenOr(err: unknown): unknown {
  return pgCode(err) === "55000" && /payouts_frozen/.test(messageChain(err)) ? new DomainError("payouts_frozen", PAYOUTS_FROZEN_MESSAGE) : err;
}

/** Run a money write and turn the database guard's frozen refusal into the domain error. */
export async function mapFrozen<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw frozenOr(err);
  }
}

/** `payouts.process`, audited with its reason. Unfreezing is a deliberate act after the restore evidence was reconciled; there is no automatic expiry. */
export async function setPayoutFreeze(op: OperatorScope, raw: unknown): Promise<PayoutFreeze> {
  const i = z.strictObject({ frozen: z.boolean(), reason: z.string().trim().min(5, "Alasan minimal 5 karakter.").max(500) }).parse(raw);
  return consoleMutation(op, { capability: "payouts.process", action: i.frozen ? "payout.freeze" : "payout.unfreeze", targetKind: "payout_control", targetId: "1", reason: i.reason, reasonCode: "payout_freeze" }, async (tx) => {
    const [row] = await tx.update(payoutControl).set({ frozen: i.frozen, reason: i.reason, changedBy: op.userId, changedAt: new Date() }).where(eq(payoutControl.id, 1)).returning();
    if (!row) throw new DomainError("not_found", "Baris kontrol penarikan tidak ditemukan.");
    return { frozen: row.frozen, reason: row.reason, changedAt: row.changedAt, changedBy: row.changedBy };
  });
}
