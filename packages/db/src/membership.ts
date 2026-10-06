import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { auditLog, membership, user } from "./schema.ts";
import { DomainError, requireCap, type Role, type SellerScope } from "./scoped.ts";

// Store membership (SC-19/SC-20, PR-15). Invitations are not in M1.

export async function listMembers(scope: SellerScope) {
  return scope.exec
    .select({ userId: user.id, name: user.name, email: user.email, role: membership.role })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.storeId, scope.storeId))
    .orderBy(asc(user.email));
}

/**
 * Change a member's role (`role`) or remove the member (`null`). The store's
 * membership rows are locked first, so concurrent changes cannot remove the
 * last owner between the check and the write.
 */
export async function changeMember(scope: SellerScope, targetUserId: string, role: Role | null): Promise<void> {
  requireCap(scope, "members.manage");
  const next = z.enum(["owner", "staff"]).nullable().parse(role);
  await scope.exec.transaction(async (tx) => {
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
}
