// Console bootstrap and recovery (IAM-15 "Console bootstrap and recovery", T-60). The first `staff.manage` and
// `break_glass.approve` holders cannot be created in the product (a sensitive grant needs an approver who already holds
// `staff.manage`), so two named people run `pnpm --filter @bukalaris/db bootstrap:console` under the owner/DBA role.
// It refuses while two or more active `staff.manage` holders exist; each grant writes one `operator_grant_event` with
// source `system_bootstrap` (or `system_recovery`), no actor and no approval request.
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { platformOperator, user } from "../schema.ts";
import { DomainError } from "../platform/scoped.ts";
import { grantAsSystem } from "./capabilities-grants.ts";
import { operatorGrant, type PlatformCapability } from "./schema-ops.ts";

export const BOOTSTRAP_CAPABILITIES = ["staff.manage", "break_glass.approve"] as const satisfies readonly PlatformCapability[];

/**
 * Documented grant set of the local demo operator (`admin@bukalaris.local`, seed and demo seed): everything the
 * current console screens use, plus the two bootstrap capabilities so grant management can be exercised locally.
 * Written as `system_bootstrap` events; local development only.
 */
export const LOCAL_SEED_OPERATOR_CAPABILITIES = [
  "dashboard.read",
  "tenants.read",
  "tenants.manage",
  "shipping.manage",
  "audit.read",
  "logs.read",
  "staff.read",
  // T-62: console screens (dashboard cards, system health with job management, issue reports, settings, provider health).
  "ops.read",
  "ops.jobs.manage",
  "ops.issues.report",
  "ops.issues.manage",
  "settings.manage",
  "providers.read",
  // T-63: account governance screens (cases, accounts, optional verification, staff and access).
  "cases.read",
  "cases.write",
  "accounts.read",
  "accounts.support",
  "accounts.suspend",
  "accounts.reveal",
  "tenants.verify",
  "access.review",
  // T-37 / T-50: money, payouts, refunds, COD reconciliation, store ledger, subscription billing and PPN switch.
  "finance.read",
  "payouts.process",
  "refunds.process",
  "payouts.reconcile",
  "ledger.adjust",
  "billing.read",
  "billing.manage",
  "tax.manage",
  ...BOOTSTRAP_CAPABILITIES,
] as const satisfies readonly PlatformCapability[];

export type BootstrapInput = {
  /** E-mails of existing accounts (`user` rows) to turn into the first holders. */
  emails: string[];
  /** The RUNBOOK entry that records the two named people and why (stored in every event's reason). */
  runbook: string;
  recovery?: boolean;
};

export async function bootstrapConsole(exec: Db, input: BootstrapInput): Promise<{ userId: string; email: string; granted: PlatformCapability[] }[]> {
  const runbook = input.runbook.trim();
  if (runbook.length < 3) throw new DomainError("invalid", "Sebutkan entri RUNBOOK yang mencatat dua orang yang menjalankan perintah ini.");
  const emails = [...new Set(input.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (emails.length === 0) throw new DomainError("invalid", "Sebutkan setidaknya satu e-mail akun.");
  return exec.transaction(async (tx) => {
    // One bootstrap at a time; the count below is read under this lock.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('bukalaris.console.bootstrap'))`);
    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(operatorGrant)
      .where(and(eq(operatorGrant.capability, "staff.manage"), or(isNull(operatorGrant.expiresAt), gt(operatorGrant.expiresAt, sql`now()`))))) as [{ n: number }];
    if (n >= 2) throw new DomainError("refused", `Ditolak: sudah ada ${n} pemegang staff.manage aktif. Gunakan layar Staf di Owner console.`);
    const source = input.recovery ? "system_recovery" : "system_bootstrap";
    const out: { userId: string; email: string; granted: PlatformCapability[] }[] = [];
    for (const email of emails) {
      const [u] = await tx.select({ id: user.id }).from(user).where(eq(user.email, email));
      if (!u) throw new DomainError("not_found", `Akun ${email} tidak ditemukan; buat akunnya lebih dulu.`);
      await tx.insert(platformOperator).values({ userId: u.id }).onConflictDoNothing();
      const granted = await grantAsSystem(tx, { userId: u.id, capabilities: BOOTSTRAP_CAPABILITIES, source, reason: `${source} (RUNBOOK ${runbook})` });
      out.push({ userId: u.id, email, granted });
    }
    return out;
  });
}
