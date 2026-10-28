import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { captureReferralClick } from "../src/affiliate/click.ts";
import { createCode, createLink, registerAffiliate } from "../src/affiliate/accounts.ts";
import { affiliate, affiliateAttribution, affiliateCatalog, affiliateClick } from "../src/affiliate/schema-affiliate.ts";
import { optInProduct, saveAffiliatePolicy } from "../src/affiliate/seller.ts";
import { placeOrder, type ClientContext } from "../src/seller/commerce/checkout.ts";
import { createProduct } from "../src/seller/commerce/catalog.ts";
import { setCartLine } from "../src/storefront/storefront.ts";
import { orderFinancials, orderLineFinancials, variant } from "../src/schema.ts";
import { admin, buyer, db, makeUser, platform, type makeStore } from "./helpers.ts";
import "../src/affiliate/jobs.ts";

// Shared fixtures of the T-52 tests. Every phone, code and rate is a synthetic test value.

export type S = Awaited<ReturnType<typeof makeStore>>;
let phoneSeq = 0;
/** A valid, never-repeated Indonesian mobile in the local spelling. */
export const freshPhone = () => `0812${String(++phoneSeq).padStart(8, "0")}`;
export const resetFixtures = () => {
  phoneSeq = 0;
};

type AccountStatus = "pending" | "active" | "rejected" | "suspended" | "closed";
/** Move an account along its legal path with the superuser connection (the state machine trigger still runs). */
export async function setAccountStatus(affiliateId: number, status: AccountStatus) {
  const path: Record<AccountStatus, AccountStatus[]> = { pending: [], active: ["active"], rejected: ["rejected"], suspended: ["active", "suspended"], closed: ["active", "closed"] };
  for (const step of path[status]) await admin.execute(sql`update affiliate set status = ${step}, status_reason = ${["rejected", "suspended", "closed"].includes(step) ? "test fixture" : null} where id = ${affiliateId}`);
}

export async function makeAffiliate(over: { phone?: string; status?: AccountStatus; name?: string } = {}) {
  const userId = await makeUser("aff");
  const phone = over.phone ?? freshPhone();
  const affiliateId = await registerAffiliate(platform, { userId, displayName: over.name ?? "Afiliasi Satu", phone });
  await setAccountStatus(affiliateId, over.status ?? "active");
  return { affiliateId, userId, phone };
}
export type A = Awaited<ReturnType<typeof makeAffiliate>>;

/** Open the store to affiliates with a default rate (bps). */
export const openStore = (s: S, defaultRateBps: number | null = 1_000, participation: "open" | "closed" = "open") => saveAffiliatePolicy(s.owner, { participation, defaultRateBps });
export const optIn = (s: S, productId = s.productId, rateBps: number | null = null) => optInProduct(s.owner, { productId, rateBps });
export const code = (a: A, text: string) => createCode(db, a.affiliateId, { code: text });
export const link = (a: A, s: S, offerId: number | null = null) => createLink(db, a.affiliateId, { storeId: s.storeId, offerId });

/** A second active product with one variant, in the same store. */
export async function addProduct(s: S, price: number, title = "Topi", stock = 50) {
  const productId = await createProduct(s.owner, { title, status: "active", variant: { title: "All", price, stock, weightGrams: 500 } });
  return { productId, variantId: (await platform.query.variant.findFirst({ where: (v, { eq: is }) => is(v.productId, productId) }))!.id };
}

/** Capture a real click (as the route does) and return its id. */
export async function click(token: string, clientIp?: string) {
  const out = await captureReferralClick(db, { token, decision: "capture", clientIp });
  if (!out?.clickId) throw new Error(`no click captured (${out?.mode ?? "no link"})`);
  return out.clickId;
}

/** A back-dated or hand-made click row, written with the superuser (the capture function always stamps the server clock). */
export async function plantClick(a: A, s: S, linkId: number, when: { capturedAt: Date; expiresAt: Date }, id = `c${randomUUID().replaceAll("-", "")}`) {
  await admin.insert(affiliateClick).values({ id, linkId, affiliateId: a.affiliateId, storeId: s.storeId, capturedAt: when.capturedAt, expiresAt: when.expiresAt });
  return id;
}

export const cartOf = (s: S, variantId = s.variantId, quantity = 1) => setCartLine(s.sf, undefined, { variantId, quantity }, "add");
export type Buy = { phone?: string; code?: string; clicks?: string[]; cart?: string; variantId?: number; quantity?: number; over?: Record<string, unknown>; ctx?: ClientContext };
/** One guest checkout through the real service, as the hosted checkout does. */
export async function buy(s: S, o: Buy = {}) {
  const cartId = o.cart ?? (await cartOf(s, o.variantId, o.quantity));
  const input = buyer({ buyerPhone: o.phone ?? freshPhone(), ...(o.code !== undefined ? { affiliateCode: o.code } : {}), ...o.over });
  const res = await placeOrder(db, cartId, input, undefined, { ...o.ctx, referral: { clickIds: o.clicks ?? [] } });
  return { ...res, cartId, input };
}

export const fin = async (orderId: number) => (await platform.select().from(orderFinancials).where(eq(orderFinancials.orderId, orderId)))[0]!;
export const finLines = (orderId: number) => platform.select().from(orderLineFinancials).where(eq(orderLineFinancials.orderId, orderId)).orderBy(orderLineFinancials.lineNo);
export const attributions = () => platform.select().from(affiliateAttribution).orderBy(affiliateAttribution.id);
export const attributionOf = async (orderId: number) => (await platform.select().from(affiliateAttribution).where(eq(affiliateAttribution.orderId, orderId)))[0];
export const catalogRows = () => platform.select().from(affiliateCatalog).orderBy(affiliateCatalog.offerId);
export const accountOf = async (id: number) => (await platform.select().from(affiliate).where(eq(affiliate.id, id)))[0]!;
export const stockOf = async (variantId: number) => (await platform.select({ stock: variant.stock }).from(variant).where(eq(variant.id, variantId)))[0]!.stock;
export const counter = async (kind: string, affiliateId: number | null = null) =>
  Number(((await admin.execute(sql`select coalesce(sum(n), 0)::bigint as n from affiliate_counter where kind = ${kind} and affiliate_id is not distinct from ${affiliateId}`)) as unknown as { n: string }[])[0]!.n);
/** The code of an error as the services throw it: a DomainError code or a Postgres error code. */
export const errCode = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code ?? String(e));
