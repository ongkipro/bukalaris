import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, eq, notExists, sql } from "drizzle-orm";
import { canonicalSlug } from "../seller/commerce/catalog.ts";
import { surfaceOriginsFromEnv } from "../platform/host.ts";
import { hit, type LimitRule } from "../seller/commerce/checkout.ts";
import type { Executor } from "../client.ts";
import { coverImages } from "./content.ts";
import { auditLog, feedToken, media, product, store, variant } from "../schema.ts";
import { DomainError, requireCap, storefrontScope, type SellerScope, type StorefrontScope } from "../platform/scoped.ts";
import { resolveFeedStore } from "../platform/resolvers.ts";
import { inStore, withStore } from "../platform/tenant.ts";

// Catalog feeds for Meta Commerce Manager and Google Merchant Center (T-40, PR-12, Q-7).
// One item per variant of an active product: item id = variant catalog id (string, D-8), group id =
// product catalog id — byte-identical to the content ids the conversion signals send (PR-20).
// The feed URL carries a per-store secret (hash stored, shown once, revocable); the fetcher is
// unauthenticated, so the token resolves the store through the platform pool and everything else
// runs in that store's RLS context on the caller's executor (ADR-0005 §4, same as channel tokens).
//
// Field names and limits follow the official specifications read on 2026-10-07:
// - Meta: developers.facebook.com/docs/commerce-platform/catalog/fields (id ≤ 100, title ≤ 200,
//   description ≤ 9 999 plain text, availability `in stock`/`out of stock`, condition `new`,
//   price "<number> <ISO 4217>", link/image_link absolute http(s), brand ≤ 100, item_group_id ≤ 100;
//   formats CSV, TSV, XML). Meta also ingests the Google RSS format, but CSV is kept as the Meta
//   feed: it is the first format Meta lists and has no namespace rules to get wrong.
// - Google: support.google.com/merchants/answer/7052112 (id ≤ 50, title ≤ 150 plain text,
//   description ≤ 5 000 plain text, availability `in_stock`/`out_of_stock`, price numeric + ISO 4217,
//   brand ≤ 70, item_group_id ≤ 50) and answer/160589 (RSS 2.0, `xmlns:g="http://base.google.com/ns/1.0"`,
//   every Merchant attribute carries the `g:` prefix, channel needs title/link/description).

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
// blfd_<8 char prefix>_<43 char secret> (6 + 32 random bytes, base64url).
const TOKEN_RE = /^blfd_([A-Za-z0-9_-]{8})_[A-Za-z0-9_-]{43}$/;
function issueToken() {
  const prefix = randomBytes(6).toString("base64url");
  const token = `blfd_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { token, prefix, hash: sha256(token) };
}

export const CURRENCY_IDR = "IDR";
/** Google title limit (150) is the tighter of the two; one title serves both feeds. */
export const FEED_TITLE_MAX = 150;
/** Google description limit (5 000) is the tighter of the two. */
export const FEED_DESCRIPTION_MAX = 5000;

// ── Public URLs ─────────────────────────────────────────────────────────────

const localRoot = (root: string) => root === "localhost" || root === "127.0.0.1" || root.endsWith(".localhost");

/**
 * Absolute base URL of a store's public storefront. Production: `https://<slug>.<STORE_ROOT_DOMAIN>`
 * (host mode, TLS at the edge). Development (`STORE_ROOT_DOMAIN` unset or a localhost root): the
 * path-mode storefront on the app origin, `<BETTER_AUTH_URL>/s/<slug>`, which also resolves from
 * a feed validator running outside the browser.
 */
export function storeBaseUrl(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.STORE_ROOT_DOMAIN;
  if (root && !localRoot(root)) return `https://${slug}.${root}`;
  return `${surfaceOriginsFromEnv(env).platformOrigin}/s/${slug}`;
}

/** Where a fetcher downloads the feeds: the Seller Admin (`APP_ORIGIN`) host, not a store host (DOM-5). */
export const feedUrls = (token: string, env: NodeJS.ProcessEnv = process.env) => {
  const origin = surfaceOriginsFromEnv(env).appOrigin;
  return { meta: `${origin}/feeds/${token}/meta.csv`, google: `${origin}/feeds/${token}/google.xml` };
};

// ── Seller settings (owner only, `marketing.manage`) ────────────────────────

export type FeedSettings = {
  token: { prefix: string; createdAt: Date } | null;
  /** Active products (what the feed covers) and how many of them have no image, so they are left out. */
  activeProducts: number;
  withoutImage: number;
};

export async function feedSettings(scope: SellerScope): Promise<FeedSettings> {
  requireCap(scope, "marketing.manage");
  return inStore(scope, async (scope) => {
    const [t] = await scope.exec
      .select({ prefix: feedToken.tokenPrefix, createdAt: feedToken.createdAt })
      .from(feedToken)
      .where(and(eq(feedToken.storeId, scope.storeId), eq(feedToken.status, "active")));
    const active = and(eq(product.storeId, scope.storeId), eq(product.status, "active"));
    const noImage = notExists(
      scope.exec.select({ one: sql`1` }).from(media).where(and(eq(media.storeId, product.storeId), eq(media.productId, product.id))),
    );
    const [all] = await scope.exec.select({ n: count() }).from(product).where(active);
    const [missing] = await scope.exec.select({ n: count() }).from(product).where(and(active, noImage));
    return { token: t ?? null, activeProducts: all!.n, withoutImage: missing!.n };
  });
}

/**
 * Issue the store's feed token, revoking the current one in the same transaction. The token is
 * returned exactly once (never stored, never logged); the seller pastes the URLs into Meta/Google.
 */
export async function createFeedToken(scope: SellerScope) {
  requireCap(scope, "marketing.manage");
  const { token, prefix, hash } = issueToken();
  return inStore(scope, async ({ exec: tx }) => {
    await tx
      .update(feedToken)
      .set({ status: "revoked", revokedAt: sql`now()` })
      .where(and(eq(feedToken.storeId, scope.storeId), eq(feedToken.status, "active")));
    const [row] = await tx
      .insert(feedToken)
      .values({ storeId: scope.storeId, tokenPrefix: prefix, tokenHash: hash, createdBy: scope.userId })
      .returning({ id: feedToken.id });
    await tx.insert(auditLog).values({ actorUserId: scope.userId, storeId: scope.storeId, action: `feed_token.create:${row!.id}` });
    return { token, prefix };
  });
}

/** Revoke the active token: both feed URLs answer 404 from now on. */
export async function revokeFeedToken(scope: SellerScope): Promise<void> {
  requireCap(scope, "marketing.manage");
  await inStore(scope, async ({ exec: tx }) => {
    const [row] = await tx
      .update(feedToken)
      .set({ status: "revoked", revokedAt: sql`now()` })
      .where(and(eq(feedToken.storeId, scope.storeId), eq(feedToken.status, "active")))
      .returning({ id: feedToken.id });
    if (!row) throw new DomainError("not_found", "Tidak ada token feed yang aktif.");
    await tx.insert(auditLog).values({ actorUserId: scope.userId, storeId: scope.storeId, action: `feed_token.revoke:${row.id}` });
  });
}

// ── Token → store (unauthenticated fetcher) ─────────────────────────────────

/**
 * Resolve a feed token from the URL to the active store it belongs to; null for a malformed,
 * unknown, revoked token or a suspended store. The caller answers 404 in every null case so the
 * response does not reveal which it was.
 */
export async function resolveFeedToken(exec: Executor, token: string): Promise<StorefrontScope | null> {
  const prefix = token.match(TOKEN_RE)?.[1];
  if (!prefix) return null;
  // Cross-store resolver (ADR-0005 §4): prefix + hash → store id of an active token through `resolve_feed_store`
  // on the caller's own pool; the store is then read in its own context.
  const storeId = await resolveFeedStore(exec, prefix, sha256(token));
  if (!storeId) return null;
  const [s] = await withStore(exec, storeId, (tx) => tx.select({ slug: store.slug }).from(store).where(eq(store.id, storeId)));
  return s ? storefrontScope(exec, s.slug) : null;
}

/**
 * Per-store fetch budget for a valid token (T-30 counters). Meta and Google fetch hourly at most;
 * 60 per hour leaves room for manual "fetch now" and validators while bounding the cost of a
 * leaked URL hammering the full-catalog render. Unknown tokens never reach this (one indexed lookup).
 */
export const FEED_FETCH_LIMIT = { limit: 60, windowSec: 3600 } as const satisfies LimitRule;

/** Count one feed fetch for the store; returns seconds to wait when over budget, else null. */
export async function limitFeedFetch(exec: Executor, scope: StorefrontScope): Promise<number | null> {
  const { count, retryAfterSec } = await hit(exec, `feed:store:${scope.storeId}`, FEED_FETCH_LIMIT);
  return count > FEED_FETCH_LIMIT.limit ? retryAfterSec : null;
}

// ── Items ───────────────────────────────────────────────────────────────────

export type FeedItem = {
  /** Variant catalog id (string). */
  id: string;
  /** Product catalog id (string). */
  groupId: string;
  title: string;
  description: string;
  /** Integer IDR. */
  price: number;
  inStock: boolean;
  link: string;
  imageLink: string;
  brand: string;
};

/** Plain text for feeds: collapse all whitespace (incl. newlines) and clip; both platforms refuse HTML. */
const plain = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
};

/**
 * Every variant of every active product that has a cover image, in product then variant order.
 * Products without an image are left out and counted (`skipped`): both platforms require
 * `image_link`, and an item that fails validation would be rejected per platform with an error
 * the seller only sees there; the settings page shows the count instead.
 */
export async function feedItems(scope: StorefrontScope): Promise<{ items: FeedItem[]; skipped: number }> {
  return inStore(scope, async (scope) => {
    const rows = await scope.exec
      .select({
        productId: product.id,
        productCatalogId: product.catalogId,
        productTitle: product.title,
        slug: product.slug,
        description: product.description,
        variantCatalogId: variant.catalogId,
        variantTitle: variant.title,
        price: variant.price,
        stock: variant.stock,
      })
      .from(variant)
      .innerJoin(product, and(eq(product.storeId, variant.storeId), eq(product.id, variant.productId)))
      .where(and(eq(product.storeId, scope.storeId), eq(product.status, "active")))
      .orderBy(asc(product.id), asc(variant.id));
    const productIds = [...new Set(rows.map((r) => r.productId))];
    const covers = await coverImages(scope, productIds);
    const base = storeBaseUrl(scope.storeSlug);
    const items: FeedItem[] = [];
    for (const r of rows) {
      const cover = covers.get(r.productId);
      if (!cover) continue;
      const title = plain(`${r.productTitle} - ${r.variantTitle}`, FEED_TITLE_MAX);
      items.push({
        id: r.variantCatalogId,
        groupId: r.productCatalogId,
        title,
        description: plain(r.description, FEED_DESCRIPTION_MAX) || title,
        price: r.price,
        inStock: r.stock > 0,
        link: `${base}/products/${canonicalSlug({ catalogId: r.productCatalogId, slug: r.slug })}`,
        imageLink: `${base}/media/${cover.id}`,
        brand: plain(scope.storeName, 70),
      });
    }
    return { items, skipped: productIds.length - covers.size };
  });
}

// ── Renderers ───────────────────────────────────────────────────────────────

export const META_CSV_COLUMNS = ["id", "item_group_id", "title", "description", "availability", "condition", "price", "link", "image_link", "brand"] as const;
/** Every field quoted (RFC 4180): a quote doubles, commas and anything else stay literal. CRLF rows. */
const csvCell = (v: string) => `"${v.replace(/"/g, '""')}"`;

export function renderMetaCsv(items: FeedItem[]): string {
  const lines = [META_CSV_COLUMNS.join(",")];
  for (const i of items) {
    lines.push(
      [i.id, i.groupId, i.title, i.description, i.inStock ? "in stock" : "out of stock", "new", `${i.price} ${CURRENCY_IDR}`, i.link, i.imageLink, i.brand]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/** XML 1.0 text: escape the five reserved characters and drop control characters the spec forbids. */
export const escapeXml = (v: string) =>
  v
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

export function renderGoogleRss(items: FeedItem[], channel: { storeName: string; storeSlug: string }): string {
  const el = (name: string, value: string) => `<${name}>${escapeXml(value)}</${name}>`;
  const out = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">`,
    `<channel>`,
    el("title", channel.storeName),
    el("link", storeBaseUrl(channel.storeSlug)),
    el("description", `Katalog produk ${channel.storeName}`),
  ];
  for (const i of items) {
    out.push(
      "<item>",
      el("g:id", i.id),
      el("g:item_group_id", i.groupId),
      el("g:title", i.title),
      el("g:description", i.description),
      el("g:link", i.link),
      el("g:image_link", i.imageLink),
      el("g:price", `${i.price} ${CURRENCY_IDR}`),
      el("g:availability", i.inStock ? "in_stock" : "out_of_stock"),
      el("g:condition", "new"),
      el("g:brand", i.brand),
      "</item>",
    );
  }
  out.push("</channel>", "</rss>");
  return out.join("\n") + "\n";
}
