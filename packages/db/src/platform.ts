import { asc, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { auditLog, membership, product, store } from "./schema.ts";
import { DomainError, type OperatorScope } from "./scoped.ts";

// Super Admin tenant lifecycle (SA-02/SA-03, PR-1). Cross-store reads here are
// deliberate and require an OperatorScope.

export async function listStores(op: OperatorScope) {
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
  return op.exec.select().from(auditLog).where(eq(auditLog.storeId, storeId)).orderBy(desc(auditLog.id)).limit(20);
}

const transition = z.strictObject({
  status: z.enum(["active", "suspended"]),
  reason: z.string().trim().min(5, "Alasan minimal 5 karakter.").max(500),
});

/** Suspend or reactivate a store with a mandatory reason and audit record (IAM-5). */
export async function setStoreStatus(op: OperatorScope, storeId: number, raw: unknown): Promise<void> {
  const { status, reason } = transition.parse(raw);
  await op.exec.transaction(async (tx) => {
    const [s] = await tx.update(store).set({ status }).where(eq(store.id, storeId)).returning({ id: store.id });
    if (!s) throw new DomainError("not_found", "Toko tidak ditemukan.");
    await tx.insert(auditLog).values({ actorUserId: op.userId, storeId, action: `store.${status}`, reason });
  });
}

/** Platform-side store creation with its first owner (used by seed and tests). */
export async function createStore(op: OperatorScope, input: { slug: string; name: string; ownerUserId: string }) {
  return op.exec.transaction(async (tx) => {
    const [s] = await tx.insert(store).values({ slug: input.slug, name: input.name }).returning({ id: store.id });
    await tx.insert(membership).values({ storeId: s!.id, userId: input.ownerUserId, role: "owner" });
    await tx.insert(auditLog).values({ actorUserId: op.userId, storeId: s!.id, action: "store.create" });
    return s!.id;
  });
}
