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
