import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../client.ts";
import { pgCode } from "../ops/capabilities.ts";
import { hit } from "../platform/rate-limit.ts";
import { DomainError, requireCap, type SellerScope } from "../platform/scoped.ts";
import { withAffiliate, withStore } from "../platform/tenant.ts";
import { auditLog } from "../schema.ts";
import { affiliateCommission, affiliateMembership, COMMISSION_STATUSES, MEMBERSHIP_STATUSES } from "./schema-affiliate.ts";
import { RL_AFF_STORE_APPLY } from "./settings.ts";

// Store membership of the affiliate programme and the seller's commission obligations (T-108, ADR-0015 decisions 1 and 4, C-A4). The state machines live in
// the database (`affiliate_membership_guard`, `affiliate_commission_guard`, migration 0028): these services only name the move. An application is written by
// `affiliate_apply()` in the affiliate's own context; the seller reads and reviews its own store's rows under the store policy; the affiliate reads its own rows
// through two definer functions (never another affiliate's, never an order id). Screens are T-110; payments, statement and arrears are T-109.

export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

const ident = z.number().int().positive().safe();
const application = z.strictObject({
  storeId: ident,
  note: z.string().trim().max(500).optional(),
  channels: z.array(z.string().trim().min(1).max(200)).max(5).optional(),
});

// ── The affiliate's side. `affiliateId` comes from the verified affiliate session (T-110), never from a request field. ────────────────────────────────

/**
 * Apply to one store's programme (RL-AFF-STORE-APPLY: 20 applications per affiliate and day, counted before the database is asked, so a refused attempt
 * spends the budget too). Every refusal (closed or unknown store, blocked, suspended membership, inactive account) is the same `unavailable`, with no hint
 * about the store's decision. Idempotent for a pending or active membership; a rejected one is applied for again.
 */
export async function applyToStore(exec: Executor, affiliateId: number, raw: { storeId: number; note?: string; channels?: string[] }): Promise<{ membershipId: number; status: MembershipStatus }> {
  const id = ident.parse(affiliateId);
  const input = application.parse(raw);
  const budget = await hit(exec, `aff-apply:${id}`, RL_AFF_STORE_APPLY);
  if (budget.count > RL_AFF_STORE_APPLY.limit) throw new DomainError("rate_limited", "Terlalu banyak pengajuan hari ini. Coba lagi besok.");
  const channels = input.channels ?? [];
  try {
    return await withAffiliate(exec, id, async (tx) => {
      const rows = (await tx.execute(sql`select * from public.affiliate_apply(${input.storeId}::bigint, ${input.note ?? null}::text, ${channels.length ? sql`array[${sql.join(channels.map((c) => sql`${c}`), sql`, `)}]::text[]` : sql`'{}'::text[]`})`)) as unknown as { r_membership_id: string; r_status: MembershipStatus }[];
      return { membershipId: Number(rows[0]!.r_membership_id), status: rows[0]!.r_status };
    });
  } catch (err) {
    if (pgCode(err) === "BKAF1") throw new DomainError("unavailable", "Program afiliasi toko ini tidak tersedia untuk Anda.");
    throw err;
  }
}

export type OwnMembership = { membershipId: number; storeId: number; storeSlug: string; storeName: string; status: MembershipStatus; createdAt: Date; reviewedAt: Date | null };

export async function listOwnMemberships(exec: Executor, affiliateId: number): Promise<OwnMembership[]> {
  const rows = (await withAffiliate(exec, ident.parse(affiliateId), (tx) => tx.execute(sql`select * from public.affiliate_own_memberships()`))) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    membershipId: Number(r.r_membership_id),
    storeId: Number(r.r_store_id),
    storeSlug: String(r.r_store_slug),
    storeName: String(r.r_store_name),
    status: r.r_status as MembershipStatus,
    createdAt: new Date(r.r_created_at as string),
    reviewedAt: r.r_reviewed_at ? new Date(r.r_reviewed_at as string) : null,
  }));
}

/** The affiliate's own obligations across stores: amounts and state, never the order (PRIV-7). */
export type OwnCommission = { commissionId: number; storeId: number; status: CommissionStatus; commissionBaseIdr: number; commissionIdr: number; createdAt: Date; payableAt: Date | null };

export async function listOwnCommissions(exec: Executor, affiliateId: number): Promise<OwnCommission[]> {
  const rows = (await withAffiliate(exec, ident.parse(affiliateId), (tx) => tx.execute(sql`select * from public.affiliate_own_commissions()`))) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    commissionId: Number(r.r_commission_id),
    storeId: Number(r.r_store_id),
    status: r.r_status as CommissionStatus,
    commissionBaseIdr: Number(r.r_commission_base_idr),
    commissionIdr: Number(r.r_commission_idr),
    createdAt: new Date(r.r_created_at as string),
    payableAt: r.r_payable_at ? new Date(r.r_payable_at as string) : null,
  }));
}

// ── The seller's side: its own store only (store policy). ────────────────────────────────────────────────────────────────────────────────────────

/** C-A4: what a seller sees of an applicant: display name, listed promotion channels and the application note. No e-mail, phone or tax identity. */
export type Applicant = {
  membershipId: number;
  affiliateId: number;
  displayName: string;
  channels: string[];
  applicationNote: string | null;
  status: MembershipStatus;
  statusReason: string | null;
  appliedAt: Date;
  reviewedAt: Date | null;
};

export async function listMemberships(scope: SellerScope, opts: { status?: MembershipStatus } = {}): Promise<Applicant[]> {
  requireCap(scope, "affiliate.read");
  const status = opts.status ? z.enum(MEMBERSHIP_STATUSES).parse(opts.status) : undefined;
  const m = affiliateMembership;
  return withStore(scope.exec, scope.storeId, (tx) =>
    tx
      .select({ membershipId: m.id, affiliateId: m.affiliateId, displayName: m.displayName, channels: m.channels, applicationNote: m.applicationNote, status: m.status, statusReason: m.statusReason, appliedAt: m.createdAt, reviewedAt: m.reviewedAt })
      .from(m)
      .where(and(eq(m.storeId, scope.storeId), status ? eq(m.status, status) : undefined))
      .orderBy(asc(m.id)),
  );
}

const review = z.discriminatedUnion("to", [
  z.strictObject({ membershipId: ident, to: z.literal("active") }),
  z.strictObject({ membershipId: ident, to: z.enum(["rejected", "suspended"]), reason: z.string().trim().min(1, "Isi alasan.").max(300) }),
]);

/**
 * Approve (pending or suspended -> active), reject (pending) or suspend (active) one membership of this store. A suspension stops new attribution at once
 * and rewrites nothing that was earned. Capability: the owner's affiliate management (`affiliate.blocks.manage`, the same power as blocking an affiliate).
 */
export async function reviewMembership(scope: SellerScope, raw: { membershipId: number; to: "active" | "rejected" | "suspended"; reason?: string }): Promise<void> {
  requireCap(scope, "affiliate.blocks.manage");
  const input = review.parse(raw);
  const reason = input.to === "active" ? null : input.reason;
  await withStore(scope.exec, scope.storeId, async (tx) => {
    try {
      const rows = await tx
        .update(affiliateMembership)
        .set({ status: input.to, statusReason: reason, reviewedBy: scope.userId, reviewedAt: new Date() })
        .where(and(eq(affiliateMembership.storeId, scope.storeId), eq(affiliateMembership.id, input.membershipId)))
        .returning({ id: affiliateMembership.id });
      if (rows.length === 0) throw new DomainError("not_found", "Pengajuan afiliasi tidak ditemukan.");
    } catch (err) {
      if (pgCode(err) === "23514") throw new DomainError("illegal_transition", "Status keanggotaan ini tidak dapat diubah ke status itu.");
      throw err;
    }
    await tx.insert(auditLog).values({ storeId: scope.storeId, actorUserId: scope.userId, action: `affiliate.membership.${input.to}`, subjectKind: "affiliate_membership", subjectId: String(input.membershipId), reason });
  });
}

/** The store's commission obligations (what the seller owes), newest first. The statement with payments is T-109. */
export type StoreCommission = { commissionId: number; orderId: number; affiliateId: number; status: CommissionStatus; commissionBaseIdr: number; commissionIdr: number; createdAt: Date; payableAt: Date | null; voidReason: string | null };

export async function listStoreCommissions(scope: SellerScope): Promise<StoreCommission[]> {
  requireCap(scope, "affiliate.read");
  const c = affiliateCommission;
  return withStore(scope.exec, scope.storeId, (tx) =>
    tx
      .select({ commissionId: c.id, orderId: c.orderId, affiliateId: c.affiliateId, status: c.status, commissionBaseIdr: c.commissionBaseIdr, commissionIdr: c.commissionIdr, createdAt: c.createdAt, payableAt: c.payableAt, voidReason: c.voidReason })
      .from(c)
      .where(eq(c.storeId, scope.storeId))
      .orderBy(desc(c.id)),
  );
}
