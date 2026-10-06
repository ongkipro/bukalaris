# M2 track report — `catalog` (wave 2a: T-14 catalog ids + slug aliases, T-31 catalog audit)

Branch `m2/catalog`, worktree `~/Projects/bukalaris-wt/catalog`. Dev DB `bukalaris_catalog` (tests `bukalaris_catalog_test`, e2e `bukalaris_catalog_e2e`), ports 3200/3201.
Decision record: `docs/DECISIONS.md` D-8 (the only shared doc appended).

## What changed

### `packages/db`
- `src/schema.ts` — `catalogIdSeq` (`pgSequence("catalog_id_seq", { startWith: 10000 })`); `product.catalog_id` and `variant.catalog_id`: `bigint NOT NULL UNIQUE DEFAULT nextval('catalog_id_seq')`, CHECK `>= 10000`, read as a **string** through a drizzle `customType`; `order_line.variant_catalog_id text NOT NULL` (snapshot). Re-exports `schema-catalog.ts`.
- `src/schema-catalog.ts` (new) — `product_slug_alias (store_id, slug) PK → product_id` with compound FK and slug CHECK; `catalog_audit` (actor, store, product, variant?, action enum, `before`/`after` jsonb snapshots) with compound FKs to product and variant and index `(store_id, product_id, id)`.
- `src/catalog.ts` — `canonicalSlug()` now `slug ?? catalogId`; `isCatalogId()` (≥ 5 digits); every write runs in one transaction and inserts `catalog_audit` rows (`product.create`, `variant.create`, `product.update`, `variant.update`; no-op updates write nothing); `updateProduct` records the old readable slug as an alias, refuses a slug that is another product's alias (`slug_taken`), lets a product reclaim its own old slug, and serialises slug changes per store with `pg_advisory_xact_lock(store_id)`; `createProduct` applies the same alias check; new `listCatalogHistory(scope, productId, limit)` (joins actor name and variant title).
- `src/storefront.ts` — `getPublishedProduct(scope, segment)`: ≥ 5-digit number → catalog id, shorter number → legacy DB id, else slug, then alias (join to product, published only); results carry `catalogId` for product and variants; `listPublishedProducts` and `getCart` expose `catalogId` / `productCatalogId`.
- `src/checkout.ts` (checkout2 row, 2 lines) — selects `variant.catalogId` inside the order transaction and writes `order_line.variant_catalog_id`.
- `src/content.ts` (content row, 1 line) — collection/search `card` selects `catalogId` so storefront links build canonical URLs.
- `drizzle/0002_catalog_ids.sql` (generated; `order_line.variant_catalog_id` hand-edited to be added **nullable**), `drizzle/0003_catalog_guards.sql` (hand-written: backfill of `variant_catalog_id` from `variant`, `SET NOT NULL` + digit CHECK, `catalog_id_immutable()` trigger function and `BEFORE UPDATE OF catalog_id` triggers on `product` and `variant`), `meta/` snapshots + journal.
- `test/catalog.test.ts` — 4 integration tests (below).

### `apps/web`
- `src/app/seller/products/[id]/page.tsx` — header shows "ID produk" (catalog id, copy button) and the canonical URL (copy button); each variant form shows "ID varian <catalog id>" with a copy button; new "Riwayat perubahan" panel.
- `src/app/seller/products/product-history.tsx` (new) — store-scoped history list (time in Asia/Jakarta, actor, action, `field: before → after` lines; prices as rupiah, status labels in Indonesian).
- `src/app/seller/products/copy-button.tsx` (new) — clipboard button whose live region is `aria-live="polite"` (not `role="status"`, so it does not collide with the page's save banner).
- `src/app/seller/products/page.tsx` — "ID produk" column shows the catalog id (links keep the DB id).
- `src/app/s/[store]/_components/product-grid.tsx`, `s/[store]/cart/page.tsx` — links use `canonicalSlug({ catalogId, slug })`.
- `src/app/api/storefront/v1/_lib.ts`, `products/route.ts`, `products/[slug]/route.ts` (channels row, additive) — `canonical_path` uses `slug ?? catalog_id`; products and variants gain `catalog_id` (string); `id` unchanged.
- `e2e/catalog.spec.ts` (new, 1 test × 2 projects), `e2e/admin-product.spec.ts` (selector change: `product-id` is now the catalog id; the seller-side TEN-1 check uses the editor URL).
- Evidence: `docs/evidence/m1/{desktop,mobile-320}-50-seller-product-catalog-ids.png`, `…-51-seller-product-history.png`.

### Edits outside this track's row (minimal, per AGENTS.md)
| File | Change | Why |
|---|---|---|
| `packages/db/src/checkout.ts` | select `variant.catalogId`, write `variantCatalogId` into `order_line` | Order snapshot must carry the variant catalog id (string) |
| `order_line` in `schema.ts` | `variant_catalog_id text NOT NULL` | same |
| `packages/db/src/content.ts` | `card` selects `catalogId` | ProductGrid link type now needs it |
| `apps/web/src/app/api/storefront/v1/{_lib.ts,products/route.ts,products/[slug]/route.ts}` | `catalog_id` fields, canonical path by catalog id | PR-12 / T-16 contract: ids stay strings |
| `apps/web/src/app/s/[store]/loading.tsx` | **deleted** | See "Finding" below: with this Suspense boundary every `permanentRedirect()`/`notFound()` in storefront pages was streamed as HTTP 200 + `<meta http-equiv="refresh">`; the canonical 308 (M1, openapi "HTML route redirects") and product 404s need a real status |
| `docs/DECISIONS.md` | D-8 appended | allowed shared doc |

Not edited: `seller/actions.ts`, `seller/layout.tsx`, `packages/db/src/index.ts`, `scoped.ts`, `seed.ts` (no id change needed), `orders.ts`, `docs/openapi.yaml` (see open issues).

## Decisions and defaults (details in D-8)
- **Storage**: `bigint` + one dedicated sequence shared by product and variant (START 10000) → collision-free under concurrency, no MAX+1/random, ≥ 5 digits without padding, item id ≠ group id. TypeScript and all boundaries use strings.
- **Immutability**: DB trigger (`catalog_id_immutable`, errcode `integrity_constraint_violation`, constraint name surfaced to drizzle errors), not just application convention.
- **URL segment**: canonical storefront path is `/products/<slug ?? catalog_id>`. Numeric segment rule: ≥ 5 digits = catalog id, < 5 digits = legacy DB id → 308. The seller editor URL stays `/seller/products/<db id>`; the seller sees only the catalog id.
- **Aliases**: alias → product (no chains), unique per store, never reused by another product; reclaiming one's own old slug deletes the alias; store-level advisory lock closes the check/unique-index race. Numeric canonicals have no aliases (ids never change).
- **Audit snapshot**: product → `title, slug, status`; variant → `title, sku, price, stock`; rows only when something changed; stored as jsonb before/after rather than one row per field (fewer rows, one read per panel).
- Dev credentials: none read; the only connection strings used by hand are the documented compose values (`AGENTS.md`).

## Finding: storefront `loading.tsx` made 308/404 soft
Reproduced on the standalone build before the fix: `curl -o /dev/null -w '%{http_code}' /s/toko-a/products/10000` → `200` with `NEXT_REDIRECT;replace;…;308` only inside the RSC payload plus a meta refresh; `/s/toko-a/products/does-not-exist` → `200`. Cause: `apps/web/src/app/s/[store]/loading.tsx` (content track) wraps every storefront page in Suspense, so the shell flushes before the page throws. After deleting the file: `10000` → `308 → /s/toko-a/products/kaos-katun-basic`, `1` (legacy id) → `308`, `does-not-exist` → `404`, `/s/toko-b/products/10000` → `404`. Trade-off: the storefront skeleton is gone (pages are one or two indexed queries). If the skeleton is wanted back, it must live inside the home/collection pages, not above the product route.

## Verification (worktree root, 2026-10-07)
| Command | Result |
|---|---|
| `pnpm db:generate --name catalog_ids` | `drizzle/0002_catalog_ids.sql` (sequence, 2 tables, 3 columns, 2 uniques, 2 checks); `drizzle-kit generate --custom --name catalog_guards` → `0003_catalog_guards.sql` |
| `pnpm db:migrate` + `pnpm db:seed` (dev `bukalaris_catalog`) | applied; seed products 10000/10003/10005/10007, variants 10001/10002/10004/10006/10008 |
| Backfill rehearsal: `pg_dump bukalaris` → scratch DB with 4 products, 5 variants, 1 hand-inserted order line; `DATABASE_URL=<scratch> node src/migrate.ts`; scratch dropped afterwards | products 10000–10003, variants 10004–10008 (all distinct), `order_line.variant_catalog_id = 10007` = its variant; direct `UPDATE product SET catalog_id = …` rejected by trigger |
| `pnpm lint` | pass (0 warnings) |
| `pnpm typecheck` | pass (db + web) |
| `pnpm test` | 11 files, **92 passed** (88 existing + 4 in `catalog.test.ts`) |
| `pnpm build` | pass |
| `pnpm e2e` | **43 passed**, 1 skipped (pre-existing skip), 4.8 min — 41 existing + `catalog.spec.ts` × 2 projects |
| `curl` on standalone build (port 3200) | see Finding: 308/404 statuses verified |

`catalog.test.ts` covers: 8 concurrent `createProduct` + `addVariant` → 19 distinct string ids ≥ 10000 across both tables; direct `UPDATE … catalog_id` on product and variant rejected with constraint `catalog_id_immutable`; id survives title/slug change; string serialisation on storefront reads and `order_line.variantCatalogId`; canonical segment = catalog id, never DB id; catalog id / legacy id / slug / two aliases all resolve to the current canonical (no chain); alias cannot be taken by another product on create or update; owner reclaims old slug (alias deleted); clearing the slug falls back to the catalog id; aliases hidden for draft products and other stores; audit rows for create/price/stock/status with store + actor, no row for a no-op, store-scoped read (`[]` for the other store), denied cross-store write leaves no row, DB rejects a cross-store audit row (`catalog_audit_product_fk`).

`catalog.spec.ts` covers (320 px + desktop): editor shows distinct ≥ 5-digit product and variant ids with copy buttons and the canonical URL; products list shows the id; `/products/<catalog id>` and `/products/<db id>` return one 308 to the slug; two slug renames → every old slug and the id 308 directly to the final slug; browser `goto` of an old slug lands on the canonical URL; other store → 404 for alias and id; new product with an old slug gets "Slug sudah dipakai"; price/stock change → history rows "harga: Rp 250.000 → Rp 275.000", "stok: 4 → 3", slug change row, actor name; Storefront API detail returns `catalog_id` strings for product and variant and the canonical path; other store's owner gets 404 on the editor.

## Open issues / ceilings
- **Feed export** (Meta/TikTok/Google): not implemented; granularity frozen as variant = item id, product = group id (Q-7, PR-20). `catalog_id` is ready as the id source; no provider contract verified.
- `docs/openapi.yaml` (channels row) not updated with the additive `catalog_id` fields on `StorefrontProduct`/variant — the orchestrator or channels owner should add them.
- `orders.ts` `adjustStock` (checkout2 row) changes stock without a `catalog_audit` row; it has its own `stock_adjustment` ledger. The history panel shows seller edits via the product editor only.
- Migration consolidation: `0003_catalog_guards.sql` (trigger + backfill) is hand-written and must be kept verbatim; `0002` has the `order_line` column added nullable on purpose.
- Legacy `/products/<db id>` redirects can be dropped once nothing references them (nothing is deployed); `isCatalogId` keeps the two numeric namespaces disjoint for free.
- Pre-existing e2e noise: the worker polls before migrations run (`relation "job" does not exist` twice at start); unrelated to this track.
