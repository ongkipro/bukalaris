# Bukalaris implementation decisions

Repository-level decisions taken while implementing. Costly-to-reverse
architecture choices get an ADR (`docs/ADR-*.md`); this file records the rest,
including deliberate ceilings. Newest last.

## D-1 — M1 stack and pinned versions (2026-10-06, T-1)

Decision: pnpm workspace (`pnpm@11.22.0`), Node 24 (engines `>=20.9.0`, Next 16
minimum). Exact pins, checked against the npm registry on 2026-10-06:

| Package | Version | Note |
|---|---|---|
| next / eslint-config-next | 16.3.8 | App Router, Turbopack default, `proxy.ts` replaces middleware |
| react / react-dom | 19.2.8 | Version paired by `create-next-app@16.3.8` |
| typescript | 6.0.3 | 7.x (native) only exposes an `unstable/*` API; typescript-eslint 8.71 supports `<6.1` |
| eslint | 9.39.5 | eslint-config-next plugins not yet verified on ESLint 10 |
| tailwindcss / @tailwindcss/postcss | 4.3.3 | |
| shadcn (+ @base-ui/react 1.8.0, cn 0.4.0) | 4.21.1 | `base-nova` style from `shadcn init -d` |
| drizzle-orm / drizzle-kit | 0.45.3 / 0.31.11 | Stable lines; 1.0 is still RC |
| postgres (postgres.js) | 3.4.9 | Pure JS driver, no native build |
| better-auth | 1.7.7 | See ADR-0004 |
| zod | 4.6.5 | |
| vitest | 5.0.3 | |
| @playwright/test | 1.63.0 | |
| PostgreSQL (compose) | 17-alpine | Local dev; host port 5442 |

Telemetry is disabled for Next (`NEXT_TELEMETRY_DISABLED=1` in scripts and
Dockerfile) and Better Auth (`telemetry.enabled: false`). Fonts use the system
stack instead of `next/font/google`, so builds need no external font fetch.

## D-2 — One Next.js app for M1; Astro storefront deferred (deliberate ceiling)

Context: Architecture proposes `apps/bos`, `apps/app`, `apps/checkout`,
`apps/storefront` (Astro) and `apps/worker`.

Decision for M1: a single Next.js app `apps/web` hosts Super Admin (`/admin`),
Seller Admin (`/seller`), a minimal storefront (`/s/<slug>`, also reachable via
`<slug>.<STORE_ROOT_DOMAIN>` host rewrite in `src/proxy.ts`) and hosted
`/checkout`. Shared business rules live in `packages/db` so a later split
reuses them unchanged.

Ceiling and upgrade path: no separate origins/cookie namespaces per surface
(IAM "separate operator and merchant session namespaces" is not met), no Astro
renderer, no checkout handoff/session (ARCH-7), single responsive theme. Split
surfaces into their own apps when M2 introduces custom domains, the external
channel handoff or the second theme; the core services move with no rule fork.

## D-3 — Store is the tenant root in M1

The data model shows TENANT ||--o{ STORE. M1 has exactly one store per seller
organisation and no tenant-level data, so `store` is the tenant root and
`store_id` is the ownership key on every seller-owned row. Upgrade path: add a
`tenant` table and `store.tenant_id` when a seller needs more than one store
under one billing/ownership root.

## D-4 — Tenant enforcement in M1: scoped data access + compound FKs; RLS deferred

Decision: Every store-owned query lives in `packages/db/src/*.ts` and takes a
scope object (`SellerScope`, `StorefrontScope`, `OperatorScope`) produced only
by `packages/db/src/scoped.ts`: from verified membership (`sellerContext`),
from active-store host/slug resolution (`storefrontScope`), or from a
`platform_operator` row (`operatorScope`). Queries filter by `scope.storeId`.
Child rows use compound `(store_id, parent_id)` foreign keys, so a write that
mixes stores fails in PostgreSQL even if application code is wrong.

Ceiling: no PostgreSQL row-level security and a single DB role for app and
migrations (05-DATA-MODEL recommends both). Upgrade path: add a non-owner
runtime role, `SET LOCAL app.store_id` per transaction inside the scope
helpers, RLS policies on store-owned tables, and run the existing isolation
tests under that role.

## D-5 — Checkout stock and payment policy defaults (Q-10 open)

Safe reversible defaults until the finance owner decides Q-10:
- No cart reservation; stock is decremented atomically at order submit
  (`UPDATE … WHERE stock >= qty` in the order transaction). No expiry,
  cancellation or restock flow exists in M1.
- COD orders are `placed`; manual transfer orders are `awaiting_payment` and
  get a payment instruction from the (fake) AutoLaris adapter after commit. A
  failed instruction leaves the order `awaiting_payment` with no reference
  (explicit pending state, NFR-5). Nothing marks an order paid in M1.
- Shipping fee comes from the server-side (fake) Mengantar quote; the client
  only names the courier option.

## D-6 — Cart, idempotency and order-outcome access

- The cart is a server row keyed by a random UUID kept in an HttpOnly cookie
  named per store (`bl_cart_<storeId>`, REVIEW R-8); the UUID is the buyer's
  capability. Carts of different stores coexist in path mode; in host mode the
  host-only cookie is already per store. A cart belongs to one store
  (FK-enforced); a foreign-store or checked-out cart id is never reused.
- `/checkout?store=<slug>` only selects which store's cart cookie to read; the
  store must be active and the cart row must belong to it, otherwise checkout
  shows nothing.
- `order.cart_id` is unique (one order per checked-out cart); idempotency key
  is unique per store and stored with a SHA-256 request hash. A replay with the
  same key and payload returns the same order; a different payload is rejected.
- The confirmation page requires the checked-out cart id cookie
  (`bl_order_cart`); an order number alone shows nothing.
- Ceiling: same-origin cookies only — no checkout handoff/session for external
  storefronts (ARCH-7, T-19).

## D-7 — Test databases

Integration tests use `bukalaris_test` (truncated per test). Playwright uses
`bukalaris_e2e`, which `apps/web/e2e/global-setup.ts` wipes, migrates and
seeds on every run, and runs against the standalone server build. Neither
touches the dev database `bukalaris`. Guards refuse URLs without `_test` /
`_e2e` before truncating or wiping.

## D-8 — External catalog identity, URL segment and slug aliases (2026-10-07, T-14)

Decision: `product.catalog_id` and `variant.catalog_id` are `bigint NOT NULL UNIQUE`
columns defaulted from one dedicated sequence `catalog_id_seq` (START 10000) shared by
both tables, separate from the identity primary keys, backfilled for existing rows by
the `ADD COLUMN … DEFAULT nextval()` rewrite (distinct per row), and frozen by a
`BEFORE UPDATE OF catalog_id` trigger (`catalog_id_immutable`, migration 0003).
TypeScript reads the column through a `customType` as a **string**; the Storefront API,
order-line snapshot (`order_line.variant_catalog_id text`) and future feeds/events carry
it as a string too (PR-12, PR-20 content ids: variant id = item, product id = group).

Why bigint + sequence over text/random: the sequence is collision-free under concurrency
without MAX+1 or retries, is cheap to index, and the shared sequence guarantees an item id
never equals a group id. Why ≥ 10000: the memory rule asks for at least five digits with
no zero padding; starting the sequence there gives that for free and makes a numeric URL
segment unambiguous — ≥ 5 digits is a catalog id, fewer digits is a legacy database id.

URL: the canonical product path is `/products/<slug ?? catalog_id>`. The database id no
longer appears in storefront URLs; a legacy `/products/<db id>` (only ever generated
locally — nothing is deployed) still resolves and 308s to the canonical path. The seller
editor keeps `/seller/products/<db id>` (short, routine navigation) and displays the
catalog id as "ID produk" with a copy button.

Slug aliases: renaming a product's readable slug inserts the old slug into
`product_slug_alias (store_id, slug) → product_id`. An alias resolves straight to its
product, so one 308 reaches the canonical URL (no chains); a slug that is an alias of
another product cannot be taken (`slug_taken`), and a product reclaiming its own old slug
deletes the alias. Slug changes within a store are serialised with
`pg_advisory_xact_lock(store_id)` so the alias check and the unique index cannot race.

Ceilings: no alias for the numeric canonical (ids never change, so none is needed); no
feed export yet (granularity frozen as variant item / product group per Q-7); the
hand-written trigger and backfill live in `0003_catalog_guards.sql` and must be kept
verbatim when migrations are consolidated.

## D-9 — Migrations are append-only from 2026-10-07

Until wave 2a, post-M1 migrations were regenerated into one file at each merge
because nothing was deployed. `0003_catalog_guards.sql` is hand-written
(immutability trigger, backfill), so from now on migrations are append-only:
a branch's generated migrations are dropped at merge only when they contain no
hand-written SQL, and the merged schema is regenerated as the next number on
top of `main`. From the first deployment on, adding a NOT NULL column to a
populated table follows expand → backfill → contract (15-DELIVERY-MIGRATIONS
DEL-2); `0004` adds NOT NULL order columns without defaults, which is only
acceptable because no database with orders exists yet (dev DB checked: 0 orders).

## D-10 — App role may update the store-less `mail_outbox` for redaction (2026-10-07, T-43)

Decision (accepted ceiling): `0009_wave4_rls.sql` grants `UPDATE ON mail_outbox
TO bukalaris_app` so a seller's buyer-data redaction (`redactOrders` in
`packages/db/src/privacy.ts`) can strip the body, and for buyer copies the
address, of mails already written to the dev mail sink. `mail_outbox` has no
`store_id` and no RLS policy, so this grant is table-wide, wider than the tenant
boundary. The code only touches rows matched through the store's RLS-protected
`order_notification` records and platform-wide order ids, inside the store's
`inStore` context; no other app code updates `mail_outbox`.

Why acceptable now: `mail_outbox` is the local/dev sink (OPS-01 `/dev/outbox`),
no real mail provider exists, nothing is deployed, and redaction must reach
every copy of the buyer's contact data (SEC-19, PRIV-4).

Revisit when a real mail provider is chosen: add `store_id` + `FORCE ROW LEVEL
SECURITY` to `mail_outbox` (or its replacement), or move the body redaction to
the platform role, then revoke the table-wide app `UPDATE`.
