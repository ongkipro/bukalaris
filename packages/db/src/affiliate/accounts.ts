import { randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../client.ts";
import { normalizePhone } from "../buyer/normalize.ts";
import { pgCode, requireNonStaffTarget, requirePlatformCap } from "../ops/capabilities.ts";
import { auditLog } from "../schema.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { withAffiliate } from "../platform/tenant.ts";
import { normalizeAffiliateCode } from "./code.ts";
import { affiliate, affiliateCode, affiliateLink, AFFILIATE_STATUSES, AFFILIATE_SOURCE } from "./schema-affiliate.ts";

// Platform affiliate identity (T-52 slice 1; IAM-13, ADR-0009 section 1 and 3): a separate account type, registered pending, reviewed in the Owner console, never a seller
// membership and never owned by a store. The portal, its login and the review screens are T-54; these are the services they call. The state machine itself lives
// in the database (`affiliate_status_guard`), so no caller can skip a step.

export type AffiliateStatus = (typeof AFFILIATE_STATUSES)[number];

/**
 * Register an affiliate account for an authenticated affiliate-surface user. `exec` is the platform pool (the app role holds no INSERT on `affiliate`). The phone is the
 * canonical Indonesian mobile of the T-57 normalisation, kept protected: it is only ever compared server-side for the self-referral guard.
 */
export async function registerAffiliate(exec: Executor, input: { userId: string; displayName: string; phone: string }): Promise<number> {
  const parsed = z.strictObject({ userId: z.string().min(1).max(128), displayName: z.string().trim().min(2).max(80), phone: z.string().max(40) }).parse(input);
  const phone = normalizePhone(parsed.phone);
  if (!phone) throw new DomainError("bad_phone", "Isi nomor HP/WhatsApp Indonesia yang valid.");
  try {
    const [row] = await exec.insert(affiliate).values({ userId: parsed.userId, displayName: parsed.displayName, contactPhone: phone }).returning({ id: affiliate.id });
    return row!.id;
  } catch (err) {
    if (pgCode(err) === "23505") throw new DomainError("conflict", "Akun ini sudah terdaftar sebagai afiliasi.");
    throw err;
  }
}

/**
 * Owner console review (`affiliate.accounts.review`, with a reason for every refusal, suspension and closure): approve, reject, suspend, reactivate or close. A suspended
 * account loses its links, codes and attribution at once (they are derived from this row), and nothing earned is touched. A staff identity is never a target.
 */
export async function reviewAffiliate(op: OperatorScope, input: { affiliateId: number; to: AffiliateStatus; reason?: string }): Promise<void> {
  await requirePlatformCap(op, "affiliate.accounts.review");
  const reason = input.reason?.trim() ?? "";
  if (["rejected", "suspended", "closed"].includes(input.to) && !reason) throw new DomainError("reason_required", "Isi alasan.");
  await op.exec.transaction(async (tx) => {
    const [row] = await tx.select({ userId: affiliate.userId, status: affiliate.status }).from(affiliate).where(eq(affiliate.id, input.affiliateId));
    if (!row) throw new DomainError("not_found", "Afiliasi tidak ditemukan.");
    await requireNonStaffTarget(tx, row.userId);
    try {
      await tx.update(affiliate).set({ status: input.to, statusReason: reason || null, reviewedBy: op.userId, reviewedAt: new Date() }).where(eq(affiliate.id, input.affiliateId));
    } catch (err) {
      if (pgCode(err) === "23514") throw new DomainError("illegal_transition", `Status ${row.status} tidak dapat diubah ke ${input.to}.`);
      throw err;
    }
    await tx.insert(auditLog).values({ actorUserId: op.userId, action: `affiliate.account.${input.to}`, subjectKind: "affiliate", subjectId: String(input.affiliateId), reason: reason || null, actorCapability: "affiliate.accounts.review" });
  });
}

// ── The affiliate's own selectors. `affiliateId` comes from the verified affiliate session of the portal (T-54), never from a request field; every statement runs in that affiliate's
// row-level-security context, so another affiliate's links and codes do not exist for it. Only an active account may create (database trigger).

/** Create a link to a store's front page, or to one opted-in offer of that store. Returns the public token. */
export async function createLink(exec: Executor, affiliateId: number, input: { storeId: number; offerId?: number | null; expiresAt?: Date | null }): Promise<{ id: number; token: string }> {
  const token = randomBytes(12).toString("base64url");
  return withAffiliate(exec, affiliateId, async (tx) => {
    try {
      const [row] = await tx
        .insert(affiliateLink)
        .values({ affiliateId, token, storeId: input.storeId, offerId: input.offerId ?? null, source: AFFILIATE_SOURCE, expiresAt: input.expiresAt ?? null })
        .returning({ id: affiliateLink.id });
      return { id: row!.id, token };
    } catch (err) {
      if (pgCode(err) === "23503") throw new DomainError("not_found", "Toko atau produk tidak ditemukan.");
      if (pgCode(err) === "23514") throw new DomainError("not_active", "Akun afiliasi belum aktif.");
      throw err;
    }
  });
}

/** Create a typed code (upper-case letters and digits, 4 to 24; globally unique after normalisation). */
export async function createCode(exec: Executor, affiliateId: number, input: { code: string; expiresAt?: Date | null }): Promise<{ id: number; code: string }> {
  const code = normalizeAffiliateCode(input.code);
  if (!code) throw new DomainError("bad_code", "Kode 4–24 huruf atau angka.");
  return withAffiliate(exec, affiliateId, async (tx) => {
    try {
      const [row] = await tx.insert(affiliateCode).values({ affiliateId, code, expiresAt: input.expiresAt ?? null }).returning({ id: affiliateCode.id });
      return { id: row!.id, code };
    } catch (err) {
      if (pgCode(err) === "23505") throw new DomainError("code_taken", "Kode ini sudah dipakai. Pilih kode lain.");
      if (pgCode(err) === "23514") throw new DomainError("not_active", "Akun afiliasi belum aktif.");
      throw err;
    }
  });
}

export function revokeLink(exec: Executor, affiliateId: number, linkId: number): Promise<void> {
  return withAffiliate(exec, affiliateId, async (tx) => {
    const rows = await tx.update(affiliateLink).set({ status: "revoked", revokedAt: new Date() }).where(and(eq(affiliateLink.affiliateId, affiliateId), eq(affiliateLink.id, linkId), eq(affiliateLink.status, "active"))).returning({ id: affiliateLink.id });
    if (rows.length === 0) throw new DomainError("not_found", "Tautan tidak ditemukan.");
  });
}

export function revokeCode(exec: Executor, affiliateId: number, codeId: number): Promise<void> {
  return withAffiliate(exec, affiliateId, async (tx) => {
    const rows = await tx.update(affiliateCode).set({ status: "revoked", revokedAt: new Date() }).where(and(eq(affiliateCode.affiliateId, affiliateId), eq(affiliateCode.id, codeId), eq(affiliateCode.status, "active"))).returning({ id: affiliateCode.id });
    if (rows.length === 0) throw new DomainError("not_found", "Kode tidak ditemukan.");
  });
}

export function listOwnLinks(exec: Executor, affiliateId: number) {
  return withAffiliate(exec, affiliateId, (tx) => tx.select({ id: affiliateLink.id, token: affiliateLink.token, storeId: affiliateLink.storeId, offerId: affiliateLink.offerId, status: affiliateLink.status, expiresAt: affiliateLink.expiresAt }).from(affiliateLink).orderBy(asc(affiliateLink.id)));
}
