import { and, asc, eq } from "drizzle-orm";
import { platformDb } from "./client.ts";
import { z } from "zod";
import { auditLog, membership, user } from "./schema.ts";
import { revokeSessionsIfOrphaned } from "./accounts.ts";
import { DomainError, requireCap, type Role, type SellerScope } from "./scoped.ts";
import { inStore } from "./tenant.ts";

// Store membership (SC-19/SC-20, PR-15). Invitations live in accounts.ts.

export async function listMembers(scope: SellerScope) {
  return inStore(scope, async (scope) => {
    return scope.exec
      .select({ userId: user.id, name: user.name, email: user.email, role: membership.role })
      .from(membership)
      .innerJoin(user, eq(user.id, membership.userId))
      .where(eq(membership.storeId, scope.storeId))
      .orderBy(asc(user.email));
  });
}

/**
 * Change a member's role (`role`) or remove the member (`null`). The store's
 * membership rows are locked first, so concurrent changes cannot remove the
 * last owner between the check and the write.
 */
export async function changeMember(scope: SellerScope, targetUserId: string, role: Role | null): Promise<void> {
  requireCap(scope, "members.manage");
  const next = z.enum(["owner", "staff"]).nullable().parse(role);
  await inStore(scope, async ({ exec: tx }) => {
    const rows = await tx
      .select({ userId: membership.userId, role: membership.role })
      .from(membership)
      .where(eq(membership.storeId, scope.storeId))
      .orderBy(asc(membership.userId))
      .for("update");
    if (!rows.some((r) => r.userId === targetUserId)) throw new DomainError("not_found", "Anggota tidak ditemukan.");
    const owners = rows.filter((r) => (r.userId === targetUserId ? next === "owner" : r.role === "owner"));
    if (owners.length === 0) throw new DomainError("last_owner", "Toko harus punya minimal satu pemilik.");

    const where = and(eq(membership.storeId, scope.storeId), eq(membership.userId, targetUserId));
    if (next) await tx.update(membership).set({ role: next }).where(where);
    else await tx.delete(membership).where(where);
    await tx.insert(auditLog).values({
      actorUserId: scope.userId,
      storeId: scope.storeId,
      action: next ? `member.role:${targetUserId}:${next}` : `member.remove:${targetUserId}`,
    });
  });
  // Membership checks run per request, so the change already applies to the next request;
  // a user left with no membership (and not an operator) also loses every session (IAM-9).
  // Cross-store by nature (other stores' memberships are invisible in this store's RLS
  // context), so it runs after the commit on the platform pool. lazy: not atomic with the
  // removal; a crash in between leaves sessions that every request denies anyway.
  if (!next && (await revokeSessionsIfOrphaned(platformDb(), targetUserId)) > 0)
    await platformDb().insert(auditLog).values({ actorUserId: scope.userId, storeId: scope.storeId, action: `session.revoke:${targetUserId}` });
}
