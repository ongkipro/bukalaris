# Track `dashboard` — Seller performance dashboard (T-41, PR-22, SC-01)

Branch `m2/dashboard`, worktree `~/Projects/bukalaris-wt/dashboard`, databases
`bukalaris_dashboard[_test|_e2e]`. Implements T-41: `/seller` is now the store overview
instead of a redirect to `/seller/products`.

## What changed

| File | Change |
|---|---|
| `packages/db/src/dashboard.ts` | `sellerDashboard(scope: SellerScope, period, now?)`: requires `orders.read` (owner + staff), runs inside `inStore` (RLS tenant), every query filtered by `scope.storeId`. Five aggregates in parallel: KPI row, COD work queue, funnel from `signal_event`, enabled-destination probe, top 5 products. `periodRange` / `startOfJakartaDay` compute `[from, to)` for today / 7 / 30 Jakarta calendar days (fixed UTC+7, no DST). Unknown period throws before any query. |
| `packages/db/test/dashboard.test.ts` | 6 tests: WIB boundaries (00:00 WIB = 17:00 UTC, 23:59 vs 00:01), every KPI reconciled against an independent plain-TS computation over the raw `order` rows for all three periods, empty period + staff access, top products (per product across variants, cancelled excluded, limit 5, sum reconciles with goods revenue and order lines), funnel (distinct event ids across two destinations, period filter, disabled state), cross-store isolation under RLS. |
| `apps/web/src/app/seller/page.tsx` | SC-01 page: period switcher (`?period=`, plain links), WIB range text, COD work-queue tile (all periods, links to `/seller/orders?status=awaiting_confirmation`), KPI tiles (orders, goods revenue, shipping collected apart from goods, AOV, COD confirmed and rejected/cancelled rates), top-products table with bars, funnel with step-to-step rates. Explicit empty state per period; funnel note when no ad destination is enabled. Unknown `period` falls back to today. |
| `apps/web/src/app/seller/_dashboard/{kpi,bar,period-switcher}.tsx` | Presentation helpers. `Bar` uses 21 literal width classes because the nonce CSP (T-29) forbids inline `style=`. `rate()` shows "—" when the denominator is 0. |
| `apps/web/e2e/dashboard.spec.ts` | Empty store (Toko B), owner with a fresh COD order, keyboard period switch, nav active state only on exact `/seller`, unknown period fallback, staff access. Evidence `97-dashboard-empty`, `98-dashboard-today`, `99-dashboard-7d` (desktop + mobile-320). |

## Definitions (kept in `dashboard.ts`, asserted by tests)

- Counted order = created in the period and not `cancelled` (a COD reject is a cancel).
- Goods revenue = `sum(subtotal)` of counted orders. Shipping collected = `sum(shipping_fee)` of counted orders, shown apart from goods and labelled as not store revenue (Q-12). All amounts are integer IDR; AOV is `Math.round`.
- COD confirmed rate = COD orders with `confirmed_at` / COD orders created in the period. COD rejected rate = cancelled COD / COD created in the period. An order confirmed and then cancelled counts in both.
- Work queue = COD orders in `awaiting_confirmation` / `on_hold` from any period, so an old unanswered order never hides (the DB CHECK `order_cod_state_chk` makes those statuses COD-only).
- Funnel = `count(distinct event_id)` per event name in the period (one row per destination per event). It is empty, with a note, when no destination is enabled, because nothing gets recorded then.
- Top products = grouped by `variant.product_id` over non-cancelled lines in the period, ordered by line revenue then units, limit 5.

## Commands and results (this worktree, 2026-10-07)

| Command | Result |
|---|---|
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | 16 files, **144 passed** (144) |
| `pnpm build` | exit 0 (`/seller` dynamic) |
| `pnpm e2e` (1st run) | 75 passed, 2 skipped, **1 failed**: `[desktop] ui.spec.ts` "shell: … scrollable nav": the Seller nav strip overflowed at 1440 px (see "Shared changes") |
| `pnpm e2e` (after fix, rebuilt) | **76 passed, 2 skipped** (skips are the existing ops DB-down and HSTS-proxy cases), both projects |
| `EXPLAIN` 30-day KPI query on `bukalaris_dashboard_e2e` (22 orders) | Index Scan using `order_store_status_idx`, `store_id` cond, `created_at` filter |

## Shared changes (outside the track's own files)

1. `apps/web/src/components/nav-link.tsx` (allowed by the ownership table): `/seller` is active only on itself, because every seller page is under `/seller/`.
2. `apps/web/e2e/helpers.ts`, one line: `login()` now asks for `next=/seller/products` instead of `next=/seller`. Before T-41, `/seller` redirected to products and `login()` waits for that landing path. Now `/seller` is the dashboard, so the helper asks for the landing page directly. Every other spec keeps its behaviour. This is the minimum; the alternative was editing every spec that expects to land on products.
3. `apps/web/src/components/admin-shell.tsx` (`ui` track file), one class change: the nav strip wraps from `md` up (`md:flex-wrap md:overflow-visible`) and keeps the horizontal scroll strip below `md`. Root cause: the wave-4 nav pre-population (commit 1fd2880, 13 seller entries) overflowed the strip at 1440 px next to the store context. The scrollbar is hidden, so on desktop the last items (Pemasaran, Pengaturan, Lihat toko) were reachable only by trackpad or shift-scroll, and `ui.spec.ts` asserts no desktop overflow. This affects `main` and every wave-4 branch, not just this track. The 320 px behaviour and the `ui.spec` assertions are unchanged.

## Defaults taken

- Default period is today; periods are calendar days in Asia/Jakarta, including today.
- Rates over zero orders show "—", not 0 %.
- No `(store_id, created_at)` index added: at seeded volumes the planner uses `order_store_status_idx` (verified above).
- Re-rendered `docs/evidence/m1/*` screenshots from other specs were restored. Only the six new dashboard PNGs are committed.

## Open issues

- At real volume the period scan filters `created_at` after the `store_id` index condition. If the KPI query gets slow, add `index(order_store_created_idx).on(storeId, createdAt)`; the orchestrator owns the consolidated migration.
- Funnel Purchase counts events, not orders. COD Purchase is enqueued at placement, so it can differ from the order KPIs; the page says so.
- The desktop shell evidence for other pages (`70-ui-*`, etc.) still shows the old single-row nav until those specs are re-rendered on `main`.
