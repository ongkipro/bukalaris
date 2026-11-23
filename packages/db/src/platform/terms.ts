import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../client.ts";
import { consoleMutation } from "../ops/console.ts";
import { auditLog, sellerTermsReview, sellerTermsVersion, storeTermsAcceptance } from "../schema.ts";
import { DomainError, requireCap, type OperatorScope, type SellerScope } from "./scoped.ts";
import { withStore } from "./tenant.ts";

// T-116 (PR-27, ADR-0013 section 8 & D-33, ADR-0015 decision 8, ADR-0016 decision 23):
// Versioned seller terms for the seller-owned model, adviser-review tracking and per-store owner
// acceptance. Invariants, each with a named test in test/t116-seller-terms.test.ts:
// - Saving a provider key or adding a bank account requires the store owner's acceptance of the
//   current terms version (`assertSellerTermsAccepted`).
// - Store A's acceptance never satisfies store B (store-scoped under FORCE RLS).
// - Acceptances, published versions and adviser reviews are append-only in the database.
// - A new terms version asks for acceptance again without blocking anything already running.
// - Without a recorded adviser review for the current version, the terms stay marked as draft and
//   neither the T-105 (Mengantar) nor T-106 (AutoLaris) production switch can be turned on.

export interface SellerTermsReviewView {
  version: number;
  adviserName: string;
  reviewedOn: string;
  note: string;
  recordedAt: Date;
}

export interface SellerTermsView {
  version: number;
  title: string;
  body: string;
  publishedAt: Date;
  review: SellerTermsReviewView | null;
  /** True until an adviser review is recorded for this version. */
  isDraft: boolean;
}

export interface SellerTermsStatus {
  current: SellerTermsView;
  acceptedVersion: number | null;
  acceptedAt: Date | null;
  acceptedCurrent: boolean;
  /** True when the store accepted an older version and a newer one is now published (nothing running is blocked). */
  needsReacceptance: boolean;
  history: { version: number; acceptedBy: string; acceptedAt: Date }[];
}

/** The latest published seller-terms version and its latest adviser review (null = still draft). */
export async function currentSellerTerms(exec: Executor): Promise<SellerTermsView> {
  const [v] = await exec
    .select()
    .from(sellerTermsVersion)
    .orderBy(desc(sellerTermsVersion.version))
    .limit(1);
  if (!v) throw new DomainError("terms_unavailable", "Syarat penjual belum tersedia.");
  const [r] = await exec
    .select()
    .from(sellerTermsReview)
    .where(eq(sellerTermsReview.version, v.version))
    .orderBy(desc(sellerTermsReview.id))
    .limit(1);
  const review: SellerTermsReviewView | null = r
    ? { version: r.version, adviserName: r.adviserName, reviewedOn: r.reviewedOn, note: r.note, recordedAt: r.createdAt }
    : null;
  return { version: v.version, title: v.title, body: v.body, publishedAt: v.createdAt, review, isDraft: review === null };
}

/** Current terms and this store's acceptance history (store-scoped under FORCE RLS). */
export async function sellerTermsStatus(scope: SellerScope): Promise<SellerTermsStatus> {
  return withStore(scope.exec, scope.storeId, async (tx) => {
    const current = await currentSellerTerms(tx);
    const rows = await tx
      .select({ version: storeTermsAcceptance.version, acceptedBy: storeTermsAcceptance.acceptedBy, acceptedAt: storeTermsAcceptance.acceptedAt })
      .from(storeTermsAcceptance)
      .where(eq(storeTermsAcceptance.storeId, scope.storeId))
      .orderBy(desc(storeTermsAcceptance.version));
    const latest = rows[0] ?? null;
    const acceptedCurrent = rows.some((r) => r.version === current.version);
    return {
      current,
      acceptedVersion: latest?.version ?? null,
      acceptedAt: latest?.acceptedAt ?? null,
      acceptedCurrent,
      needsReacceptance: !acceptedCurrent && latest !== null,
      history: rows,
    };
  });
}

const acceptInput = z.strictObject({
  version: z.coerce.number().int().positive(),
  agreed: z.literal(true, { error: "Centang pernyataan persetujuan terlebih dahulu." }),
});

/**
 * Record the store owner's acceptance of the current seller-terms version (owner only, append-only, audited).
 * Accepting an already-accepted current version is idempotent and writes no duplicate row.
 */
export async function acceptSellerTerms(scope: SellerScope, raw: unknown): Promise<{ version: number; created: boolean }> {
  requireCap(scope, "integrations.manage");
  const input = acceptInput.parse(raw);
  return withStore(scope.exec, scope.storeId, async (tx) => {
    const current = await currentSellerTerms(tx);
    if (input.version !== current.version) {
      throw new DomainError("terms_version_stale", `Versi syarat penjual sudah diperbarui ke versi ${current.version}. Muat ulang halaman untuk membaca versi terbaru.`);
    }
    const [inserted] = await tx
      .insert(storeTermsAcceptance)
      .values({ storeId: scope.storeId, version: current.version, acceptedBy: scope.userId })
      .onConflictDoNothing()
      .returning({ version: storeTermsAcceptance.version });
    if (inserted) {
      await tx.insert(auditLog).values({
        storeId: scope.storeId,
        actorUserId: scope.userId,
        actorCapability: "integrations.manage",
        action: "seller_terms.accept",
        subjectKind: "store",
        subjectId: String(scope.storeId),
        accessLevel: "write",
        outcome: "allowed",
        reason: `version=${current.version}; draft=${current.isDraft}`,
      });
    }
    return { version: current.version, created: Boolean(inserted) };
  });
}

/**
 * Server-side gate before saving a provider key (`saveProviderKey`) or adding a bank account (`addBankAccount`).
 * Runs inside the caller's store context (`withStore`), so store A's acceptance never satisfies store B.
 */
export async function assertSellerTermsAccepted(tx: Executor, storeId: number): Promise<void> {
  const current = await currentSellerTerms(tx);
  const [row] = await tx
    .select({ id: storeTermsAcceptance.id })
    .from(storeTermsAcceptance)
    .where(and(eq(storeTermsAcceptance.storeId, storeId), eq(storeTermsAcceptance.version, current.version)))
    .limit(1);
  if (!row) {
    throw new DomainError(
      "terms_not_accepted",
      `Setujui syarat penjual versi ${current.version} terlebih dahulu di halaman Akun penyedia sebelum menyimpan kunci penyedia atau rekening bank.`,
    );
  }
}

/**
 * Production gate for T-105 (Mengantar) and T-106 (AutoLaris): the current seller-terms version must carry a
 * recorded adviser review (name, date, version) before production calls on seller keys can be switched on.
 */
export async function assertSellerTermsReviewed(exec: Executor): Promise<void> {
  const current = await currentSellerTerms(exec);
  if (current.isDraft) {
    throw new DomainError(
      "terms_review_missing",
      `Syarat penjual versi ${current.version} masih berstatus draf. Catat tinjauan penasihat privasi/hukum sebelum mengaktifkan mode produksi.`,
    );
  }
}

const publishInput = z.strictObject({
  title: z.string().trim().min(5, "Judul minimal 5 karakter.").max(200),
  body: z.string().trim().min(50, "Isi syarat minimal 50 karakter.").max(20_000),
  reason: z.string().trim().min(5, "Alasan minimal 5 karakter.").max(500),
});

/** Owner console: publish a new terms version (append-only, starts as draft until reviewed). Existing stores keep running. */
export async function publishSellerTermsVersion(op: OperatorScope, raw: unknown): Promise<{ version: number }> {
  const input = publishInput.parse(raw);
  return consoleMutation(
    op,
    { capability: "settings.manage", action: "seller_terms.publish", targetKind: "seller_terms_version", targetId: "latest", reason: input.reason, reasonCode: "terms_publish" },
    async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('seller_terms_version', 0))`);
      const [latest] = await tx.select({ version: sellerTermsVersion.version }).from(sellerTermsVersion).orderBy(desc(sellerTermsVersion.version)).limit(1);
      const next = (latest?.version ?? 0) + 1;
      await tx.insert(sellerTermsVersion).values({ version: next, title: input.title, body: input.body, createdBy: op.userId });
      return { version: next };
    },
  );
}

const reviewInput = z.strictObject({
  version: z.coerce.number().int().positive(),
  adviserName: z.string().trim().min(2, "Nama penasihat minimal 2 karakter.").max(200),
  reviewedOn: z.iso.date("Tanggal tinjauan harus tanggal kalender yang valid (YYYY-MM-DD)."),
  note: z.string().trim().min(5, "Catatan tinjauan minimal 5 karakter.").max(500),
});

/** Owner console: record the privacy/legal adviser review for a terms version (name, date, version), lifting its draft status. */
export async function recordSellerTermsReview(op: OperatorScope, raw: unknown): Promise<{ id: number }> {
  const input = reviewInput.parse(raw);
  const todayWib = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
  if (input.reviewedOn > todayWib) throw new DomainError("invalid_date", "Tanggal tinjauan tidak boleh di masa depan.");
  return consoleMutation(
    op,
    { capability: "settings.manage", action: "seller_terms.review", targetKind: "seller_terms_version", targetId: String(input.version), reason: `${input.adviserName} (${input.reviewedOn}): ${input.note}`.slice(0, 500), reasonCode: "terms_review" },
    async (tx) => {
      const [v] = await tx.select({ version: sellerTermsVersion.version }).from(sellerTermsVersion).where(eq(sellerTermsVersion.version, input.version));
      if (!v) throw new DomainError("not_found", `Syarat penjual versi ${input.version} tidak ditemukan.`);
      const [row] = await tx
        .insert(sellerTermsReview)
        .values({ version: input.version, adviserName: input.adviserName, reviewedOn: input.reviewedOn, note: input.note, recordedBy: op.userId })
        .returning({ id: sellerTermsReview.id });
      return { id: row!.id };
    },
  );
}
