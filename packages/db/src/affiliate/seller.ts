import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../client.ts";
import { auditLog, product } from "../schema.ts";
import { DomainError, requireCap, type SellerScope } from "../platform/scoped.ts";
import { withStore } from "../platform/tenant.ts";
import { pgCode } from "../ops/capabilities.ts";
import { affiliateBlock, affiliateOffer, affiliatePolicy, affiliateSellerPolicy, AFFILIATE_SOURCE } from "./schema-affiliate.ts";

// The seller's own side of the programme (T-52 slice 1; IAM-3): the store policy (closed by default, no invented rate), per-product opt-in with an optional
// override, and blocks of individual affiliates for this store only. Every function runs in the store's row-level-security context, so another store's rows are
// invisible and unwritable; the guard triggers of migration 0016 hold the state machines and the programme's rate bounds, and every write leaves the projection job.
// A rate or state change never touches an existing order: orders froze their own rates (order_line_financials).

const rateBps = z.number().int().min(0).max(10_000);
const ident = z.number().int().positive().safe();
const reason = z.string().trim().min(1, "Isi alasan.").max(300);

const record = (tx: Tx, s: SellerScope, action: string, subjectId: number | string) =>
  tx.insert(auditLog).values({ storeId: s.storeId, actorUserId: s.userId, action, subjectKind: "affiliate", subjectId: String(subjectId) });

/** The guard triggers raise `check_violation` for a refused write; the buyer-facing wording is the seller's. */
function refused(err: unknown): never {
  if (pgCode(err) === "23514") {
    const text = String((err as { cause?: { message?: string } }).cause?.message ?? (err as Error).message ?? "");
    if (/programme bounds/.test(text)) throw new DomainError("rate_out_of_bounds", "Tarif komisi di luar batas yang ditetapkan platform.");
    if (/published product/.test(text)) throw new DomainError("product_unavailable", "Hanya produk yang tayang yang bisa ditawarkan ke afiliasi.");
    if (/illegal offer transition/.test(text)) throw new DomainError("illegal_transition", "Status penawaran ini tidak dapat diubah ke status itu.");
  }
  throw err;
}

export type SellerAffiliateSettings = {
  participation: "closed" | "open";
  defaultRateBps: number | null;
  revision: number;
  /** The programme's current bounds (the seller cannot set a rate outside them). */
  bounds: { minRateBps: number; maxRateBps: number };
};

export async function affiliateSettings(scope: SellerScope): Promise<SellerAffiliateSettings> {
  requireCap(scope, "affiliate.read");
  return withStore(scope.exec, scope.storeId, async (tx) => {
    const [row] = await tx.select().from(affiliateSellerPolicy).where(eq(affiliateSellerPolicy.storeId, scope.storeId));
    const [bounds] = await tx.select({ minRateBps: affiliatePolicy.minRateBps, maxRateBps: affiliatePolicy.maxRateBps }).from(affiliatePolicy);
    return { participation: row?.participation ?? "closed", defaultRateBps: row?.defaultRateBps ?? null, revision: row?.revision ?? 0, bounds: bounds! };
  });
}

/** Open or close the store to affiliates and set the default rate (NULL = none chosen). Opening needs a default rate or per-product rates before anything earns; closing stops new attribution at once. */
export async function saveAffiliatePolicy(scope: SellerScope, raw: { participation: "closed" | "open"; defaultRateBps: number | null }): Promise<void> {
  requireCap(scope, "affiliate.offers.manage");
  const input = z.strictObject({ participation: z.enum(["closed", "open"]), defaultRateBps: rateBps.nullable() }).parse(raw);
  await withStore(scope.exec, scope.storeId, async (tx) => {
    try {
      await tx
        .insert(affiliateSellerPolicy)
        .values({ storeId: scope.storeId, participation: input.participation, defaultRateBps: input.defaultRateBps, updatedBy: scope.userId })
        .onConflictDoUpdate({ target: affiliateSellerPolicy.storeId, set: { participation: input.participation, defaultRateBps: input.defaultRateBps, updatedBy: scope.userId } });
    } catch (err) {
      refused(err);
    }
    await record(tx, scope, "affiliate.policy.save", scope.storeId);
  });
}

export type SellerOffer = { id: number; productId: number; productTitle: string; status: "active" | "paused" | "withdrawn"; rateBps: number | null; revision: number };

export async function listOffers(scope: SellerScope): Promise<SellerOffer[]> {
  requireCap(scope, "affiliate.read");
  return withStore(scope.exec, scope.storeId, (tx) =>
    tx
      .select({ id: affiliateOffer.id, productId: affiliateOffer.productId, productTitle: product.title, status: affiliateOffer.status, rateBps: affiliateOffer.rateBps, revision: affiliateOffer.revision })
      .from(affiliateOffer)
      .innerJoin(product, and(eq(product.storeId, affiliateOffer.storeId), eq(product.id, affiliateOffer.productId)))
      .where(eq(affiliateOffer.storeId, scope.storeId))
      .orderBy(asc(affiliateOffer.id)),
  );
}

/** Opt one product in (or back in after a withdrawal), with an optional rate override (NULL = the store default). A product of another store is simply not found. */
export async function optInProduct(scope: SellerScope, raw: { productId: number; rateBps: number | null }): Promise<number> {
  requireCap(scope, "affiliate.offers.manage");
  const input = z.strictObject({ productId: ident, rateBps: rateBps.nullable() }).parse(raw);
  return withStore(scope.exec, scope.storeId, async (tx) => {
    const [p] = await tx.select({ id: product.id }).from(product).where(and(eq(product.storeId, scope.storeId), eq(product.id, input.productId)));
    if (!p) throw new DomainError("not_found", "Produk tidak ditemukan.");
    try {
      const [existing] = await tx.select({ id: affiliateOffer.id }).from(affiliateOffer).where(and(eq(affiliateOffer.storeId, scope.storeId), eq(affiliateOffer.source, AFFILIATE_SOURCE), eq(affiliateOffer.productId, input.productId)));
      const offerId = existing
        ? (await tx.update(affiliateOffer).set({ status: "active", rateBps: input.rateBps, updatedBy: scope.userId }).where(and(eq(affiliateOffer.storeId, scope.storeId), eq(affiliateOffer.id, existing.id))).returning({ id: affiliateOffer.id }))[0]!.id
        : (await tx.insert(affiliateOffer).values({ storeId: scope.storeId, productId: input.productId, rateBps: input.rateBps, updatedBy: scope.userId }).returning({ id: affiliateOffer.id }))[0]!.id;
      await record(tx, scope, "affiliate.offer.optin", offerId);
      return offerId;
    } catch (err) {
      refused(err);
    }
  });
}

/** Pause, resume or withdraw an offer. Resuming validates the product and the rate again. */
export async function setOfferStatus(scope: SellerScope, raw: { offerId: number; status: "active" | "paused" | "withdrawn" }): Promise<void> {
  requireCap(scope, "affiliate.offers.manage");
  const input = z.strictObject({ offerId: ident, status: z.enum(["active", "paused", "withdrawn"]) }).parse(raw);
  await withStore(scope.exec, scope.storeId, async (tx) => {
    try {
      const rows = await tx.update(affiliateOffer).set({ status: input.status, updatedBy: scope.userId }).where(and(eq(affiliateOffer.storeId, scope.storeId), eq(affiliateOffer.id, input.offerId))).returning({ id: affiliateOffer.id });
      if (rows.length === 0) throw new DomainError("not_found", "Penawaran tidak ditemukan.");
    } catch (err) {
      refused(err);
    }
    await record(tx, scope, `affiliate.offer.${input.status}`, input.offerId);
  });
}

/** Change an offer's rate override (NULL = the store default). Existing orders keep the rate they froze. */
export async function setOfferRate(scope: SellerScope, raw: { offerId: number; rateBps: number | null }): Promise<void> {
  requireCap(scope, "affiliate.offers.manage");
  const input = z.strictObject({ offerId: ident, rateBps: rateBps.nullable() }).parse(raw);
  await withStore(scope.exec, scope.storeId, async (tx) => {
    try {
      const rows = await tx.update(affiliateOffer).set({ rateBps: input.rateBps, updatedBy: scope.userId }).where(and(eq(affiliateOffer.storeId, scope.storeId), eq(affiliateOffer.id, input.offerId))).returning({ id: affiliateOffer.id });
      if (rows.length === 0) throw new DomainError("not_found", "Penawaran tidak ditemukan.");
    } catch (err) {
      refused(err);
    }
    await record(tx, scope, "affiliate.offer.rate", input.offerId);
  });
}

export async function listBlocks(scope: SellerScope): Promise<{ affiliateId: number; reason: string; blockedAt: Date }[]> {
  requireCap(scope, "affiliate.read");
  return withStore(scope.exec, scope.storeId, (tx) =>
    tx.select({ affiliateId: affiliateBlock.affiliateId, reason: affiliateBlock.reason, blockedAt: affiliateBlock.blockedAt }).from(affiliateBlock).where(eq(affiliateBlock.storeId, scope.storeId)).orderBy(asc(affiliateBlock.blockedAt)),
  );
}

/** Block one platform affiliate for THIS store only (new attribution stops; nothing earned is rewritten). An unknown affiliate id and a repeated block answer the same way. */
export async function blockAffiliate(scope: SellerScope, raw: { affiliateId: number; reason: string }): Promise<void> {
  requireCap(scope, "affiliate.blocks.manage");
  const input = z.strictObject({ affiliateId: ident, reason }).parse(raw);
  await withStore(scope.exec, scope.storeId, async (tx) => {
    try {
      await tx.insert(affiliateBlock).values({ storeId: scope.storeId, affiliateId: input.affiliateId, reason: input.reason, blockedBy: scope.userId }).onConflictDoNothing();
    } catch (err) {
      if (pgCode(err) === "23503") throw new DomainError("not_found", "Afiliasi tidak ditemukan.");
      throw err;
    }
    await record(tx, scope, "affiliate.block", input.affiliateId);
  });
}

export async function unblockAffiliate(scope: SellerScope, affiliateId: number): Promise<void> {
  requireCap(scope, "affiliate.blocks.manage");
  const id = ident.parse(affiliateId);
  await withStore(scope.exec, scope.storeId, async (tx) => {
    const rows = await tx.delete(affiliateBlock).where(and(eq(affiliateBlock.storeId, scope.storeId), eq(affiliateBlock.affiliateId, id))).returning({ id: affiliateBlock.affiliateId });
    if (rows.length === 0) throw new DomainError("not_found", "Blokir tidak ditemukan.");
    await record(tx, scope, "affiliate.unblock", id);
  });
}
