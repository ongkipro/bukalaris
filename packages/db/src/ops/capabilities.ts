// Owner console capability checks (T-60, IAM-8, IAM-15). A capability is a standing `operator_grant` row that has
// not expired, re-read from the database on every call (never from a cookie or a cached scope). Seller membership,
// break-glass elevations and role presets never count here: the server authorizes by explicit grant only.
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { auditLog, operatorGrant, platformOperator } from "../schema.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import type { PlatformCapability } from "./schema-ops.ts";

export {
  BREAK_GLASS_ALLOWLIST,
  CAPABILITY_CATALOGUE,
  FOUR_EYES_MATRIX,
  LAST_HOLDER_PROTECTED,
  PLATFORM_CAPABILITIES,
  SENSITIVE_CAPABILITIES,
  type FourEyesAction,
  type PlatformCapability,
} from "./schema-ops.ts";

/** Postgres SQLSTATE of a driver error, whether or not drizzle wrapped it in `cause`. */
export function pgCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" ? code : undefined;
}

/** True when `userId` holds `capability` through a standing grant that has not expired. */
export async function holdsCapability(exec: Executor, userId: string, capability: PlatformCapability): Promise<boolean> {
  const [row] = await exec
    .select({ c: operatorGrant.capability })
    .from(operatorGrant)
    .where(
      and(
        eq(operatorGrant.userId, userId),
        eq(operatorGrant.capability, capability),
        or(isNull(operatorGrant.expiresAt), gt(operatorGrant.expiresAt, sql`now()`)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export const hasPlatformCap = (op: OperatorScope, cap: PlatformCapability) => holdsCapability(op.exec, op.userId, cap);

/** A grant's `last_used_at` is written at most this often per grant, so the hot path stays a read except once per window (SA-39). */
export const GRANT_USE_RESOLUTION_SECONDS = 300;
/** The real last-use source of the access review: a console operation passed this capability check. Conditional UPDATE, no row churn. */
async function touchGrantUse(exec: Executor, userId: string, capability: PlatformCapability): Promise<void> {
  // SKIP LOCKED: the stamp never waits for a row another transaction holds (a revocation locks holders in key order), so it can neither
  // block a request nor take part in a lock cycle; a skipped stamp is simply written by the next check after the window.
  await exec.execute(sql`update operator_grant set last_used_at = now() where (user_id, capability) in (
    select user_id, capability from operator_grant where user_id = ${userId} and capability = ${capability} and (last_used_at is null or last_used_at < now() - make_interval(secs => ${GRANT_USE_RESOLUTION_SECONDS})) for update skip locked)`);
}

/**
 * First statement of every Owner console operation after the operator and TOTP check. A refusal writes a
 * store-less denial audit row (IAM-15) and throws `forbidden`; nothing else has happened yet, so there is no side effect.
 * Call it on the pool (`op.exec`), before the operation's own transaction, so the denial row survives the refusal.
 */
export async function requirePlatformCap(op: OperatorScope, cap: PlatformCapability): Promise<void> {
  if (await hasPlatformCap(op, cap)) {
    await touchGrantUse(op.exec, op.userId, cap);
    return;
  }
  await op.exec.insert(auditLog).values({ actorUserId: op.userId, action: "operator.denied", actorCapability: cap, outcome: "denied", reason: `capability ${cap}` });
  throw new DomainError("forbidden", `Akses ditolak: butuh izin ${cap}.`);
}

/**
 * Staff identities (any user with a `platform_operator` row) are never the target of an `accounts.*` or
 * `affiliate.accounts.*` action: the server answers not-found, so support cannot weaken or restore a staff member's
 * sign-in. Staff are handled only through `staff.manage` (IAM-15). The account services of T-63/T-72 call this first.
 */
export async function requireNonStaffTarget(exec: Executor, targetUserId: string): Promise<void> {
  const [row] = await exec.select({ id: platformOperator.userId }).from(platformOperator).where(eq(platformOperator.userId, targetUserId));
  if (row) throw new DomainError("not_found", "Akun tidak ditemukan.");
}

/** The operator's active capabilities, for the navigation (the pages and actions still check each operation themselves). */
export async function operatorCapabilities(exec: Executor, userId: string): Promise<PlatformCapability[]> {
  const rows = await exec
    .select({ c: operatorGrant.capability })
    .from(operatorGrant)
    .where(and(eq(operatorGrant.userId, userId), or(isNull(operatorGrant.expiresAt), gt(operatorGrant.expiresAt, sql`now()`))))
    .orderBy(asc(operatorGrant.capability));
  return rows.map((r) => r.c);
}
