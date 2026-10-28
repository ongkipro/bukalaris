import { and, asc, count, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { accountStatusEvent, auditLog, membership, product, store } from "../schema.ts";
import { DomainError, type OperatorScope } from "./scoped.ts";
import { isReservedHostLabel, validClaimableLabel } from "./host.ts";
import { requirePlatformCap } from "../ops/capabilities.ts";
import { governed, reasonCode } from "../ops/accounts-governance.ts";

// Owner console tenant lifecycle (SA-02/SA-03, PR-1). Cross-store reads here are deliberate and require an OperatorScope
// plus an explicit capability (T-60, IAM-15): `tenants.read` to list, `audit.read` for store audit rows, `tenants.manage` to change.

export async function listStores(op: OperatorScope) {
  await requirePlatformCap(op, "tenants.read");
  return op.exec
    .select({
      id: store.id,
      slug: store.slug,
      name: store.name,
      status: store.status,
      products: count(product.id),
      createdAt: store.createdAt,
    })
    .from(store)
    .leftJoin(product, eq(product.storeId, store.id))
    .groupBy(store.id)
    .orderBy(asc(store.id));
}

export async function storeAudit(op: OperatorScope, storeId: number) {
  await requirePlatformCap(op, "audit.read");
  return op.exec.select().from(auditLog).where(eq(auditLog.storeId, storeId)).orderBy(desc(auditLog.id)).limit(20);
}

const transition = z.strictObject({
  status: z.enum(["active", "suspended"]),
  reason: z.string().trim().min(5, "Alasan minimal 5 karakter.").max(500),
  /** Why, as a code (a select in the UI). Defaults to the generic code for callers that only have text. */
  reasonCode: reasonCode.default("operator_decision"),
  /** An open `support_case` (id or `C-000123`). Optional for a store lifecycle change; every identity action (T-63 slice 4) requires one. */
  caseId: z.union([z.number().int().positive(), z.string().regex(/^C-\d{6,}$/)]).optional(),
});

/**
 * Suspend or reactivate a store (SA-02/SA-03, IAM-5). One compare-and-swap decides the move (`WHERE status <> target`), so two staff
 * members acting at once yield one change, one `account_status_event` and one `conflict`; the event, the audit row (with the
 * reason code and case) and the change are one transaction. Suspension is independent of billing: nothing here reads or writes a
 * subscription, an invoice or a ledger, so lifting a suspension never clears a debt and paying never lifts a suspension.
 */
export async function setStoreStatus(op: OperatorScope, storeId: number, raw: unknown): Promise<void> {
  const i = transition.parse(raw);
  await governed(
    op,
    { capability: "tenants.manage", action: `store.${i.status}`, subjectKind: "store", subjectId: String(storeId), storeId, reasonCode: i.reasonCode, reason: i.reason, case: { ref: i.caseId, required: false, target: { kind: "store", id: String(storeId) } } },
    async (tx, cited) => {
      const moved = await tx.update(store).set({ status: i.status }).where(and(eq(store.id, storeId), ne(store.status, i.status))).returning({ id: store.id });
      if (moved.length === 0) {
        const [s] = await tx.select({ id: store.id }).from(store).where(eq(store.id, storeId));
        throw s ? new DomainError("conflict", "Toko sudah dalam status itu (mungkin diubah staf lain).") : new DomainError("not_found", "Toko tidak ditemukan.");
      }
      await tx.insert(accountStatusEvent).values({
        subjectKind: "store",
        subjectId: String(storeId),
        fromStatus: i.status === "suspended" ? "active" : "suspended",
        toStatus: i.status,
        reasonCode: i.reasonCode,
        reasonNote: i.reason,
        actorUserId: op.userId,
        caseId: cited?.id ?? null,
      });
    },
  );
}

/**
 * Platform-side store creation with its first owner (used by seed and tests). Creation by `tenants.manage` staff is the approval:
 * there is no store application path and no pre-approval state, and no verification record is ever required (ADR-0011 section 5).
 * The first status event (`null -> active`) is written in the same transaction.
 */
export async function createStore(op: OperatorScope, input: { slug: string; name: string; ownerUserId: string }) {
  await requirePlatformCap(op, "tenants.manage");
  const normalizedSlug = input.slug.trim().toLowerCase();
  if (isReservedHostLabel(normalizedSlug) || !validClaimableLabel(normalizedSlug)) {
    throw new DomainError("slug_reserved", "Slug toko ini dicadangkan oleh platform.");
  }
  return op.exec.transaction(async (tx) => {
    const [s] = await tx.insert(store).values({ slug: normalizedSlug, name: input.name }).returning({ id: store.id });
    await tx.insert(membership).values({ storeId: s!.id, userId: input.ownerUserId, role: "owner" });
    await tx.insert(auditLog).values({ actorUserId: op.userId, storeId: s!.id, action: "store.create" });
    await tx.insert(accountStatusEvent).values({ subjectKind: "store", subjectId: String(s!.id), fromStatus: null, toStatus: "active", reasonCode: "store_created", actorUserId: op.userId });
    return s!.id;
  });
}
