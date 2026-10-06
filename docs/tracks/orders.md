# Track report — `orders` (M2)

Branch `m2/orders`, worktree `~/Projects/bukalaris-wt/orders`. Scope: seller
orders (SC-12/SC-13), order lifecycle, inventory (SC-04), capabilities, tests.

## What changed

| File | Change |
|---|---|
| `packages/db/src/schema.ts` (`order` table only) | `ORDER_STATUSES`/`OrderStatus` export; status enum + `order_status_chk` widened to `awaiting_payment, placed, processing, shipped, completed, cancelled`; new columns `paid_at`, `tracking_number`, `updated_at`; CHECK `order_shipped_chk` (shipped/completed need a tracking number); index `order_store_status_idx (store_id, status, id)` for the filtered list |
| `packages/db/src/schema-orders.ts` | New tables `order_status_history` (store, order, from/to, actor, note) and `stock_adjustment` (store, variant, signed delta ≠ 0, reason, actor, optional order) with compound store FKs |
| `packages/db/src/orders.ts` | `listOrders` (newest first, status filter, keyset cursor on `id`), `getOrder` (lines + history with actor name + allowed actions; idempotency key/request hash stripped), `TRANSITIONS`/`allowedActions`, `transitionOrder` (pay/process/ship/complete/cancel), `listInventory`, `listStockAdjustments`, `adjustStock` |
| `packages/db/src/scoped.ts` | **Shared-file edit (minimal):** capability map gains `orders.read`, `orders.fulfill`, `inventory.write` — all `["owner", "staff"]` |
| `packages/db/drizzle/0001_bored_sir_ram.sql` + meta | Generated with `pnpm db:generate`; the orchestrator regenerates one consolidated migration at merge |
| `packages/db/test/orders.test.ts` | 12 integration tests (see below) |
| `apps/web/src/app/seller/orders/page.tsx` | SC-12 list: status filter links, table, "Pesanan lebih lama" cursor link, empty states |
| `apps/web/src/app/seller/orders/[id]/page.tsx` | SC-13 detail: actions block (state-specific), buyer, payment, line snapshot, totals, status history |
| `apps/web/src/app/seller/orders/{actions.ts,run.ts,status.ts,confirm-submit.tsx}` | Server action, redirect `run()` helper (copy of the one in `seller/actions.ts`, which belongs to the accounts track), Indonesian labels, confirm-before-submit client button |
| `apps/web/src/app/seller/inventory/{page.tsx,actions.ts}` | SC-04: variant list with stock, signed-delta + reason form per variant, recent adjustment log |
| `apps/web/e2e/orders.spec.ts` | 2 Playwright tests × 2 projects (320px, desktop) |
| `docs/evidence/m1/{mobile-320,desktop}-3[0-4]-*.png` | Browser evidence (the shared `evidence()` helper hardcodes the `m1` folder; not edited) |

No edits to layouts, `index.ts`, root configs, `seller/actions.ts`, `checkout.ts`
or the e2e helpers.

## Defaults and decisions taken (Q-10 still open)

- Lifecycle: `awaiting_payment --pay--> placed --process--> processing --ship--> shipped --complete--> completed`; `awaiting_payment | placed | processing --cancel--> cancelled`. Nothing leaves `shipped`, `completed` or `cancelled` except shipped → completed. Cancelling a shipped order (returns/refunds) is out of scope.
- "Mark paid" is a manual seller confirmation for `manual_transfer` only (the only method that produces `awaiting_payment`); it sets `paid_at` and moves to `placed`, and the history note says so. It is not provider reconciliation.
- Ship requires a courier tracking number (3–80 chars), stored on the order and in the history note; enforced by CHECK as well.
- Cancel requires a reason (5–500 chars). Every transition runs in one transaction: `SELECT … FOR UPDATE` on the order row → status check → update → (cancel: `stock = stock + qty` per line + one `stock_adjustment` row per line linked to the order) → history row with actor. The row lock makes double cancel / cancel racing process reject with `invalid_transition` and restock exactly once.
- Inventory adjustment: `UPDATE variant SET stock = stock + d WHERE store_id = ? AND id = ? AND stock + d >= 0`; zero rows → `not_found` or `insufficient_stock`; success writes a `stock_adjustment` row with actor and reason. Delta is a signed integer ≠ 0, reason ≥ 3 chars.
- Pagination: keyset on the identity `id` (monotonic, unique) descending, 20 per page; `nextCursor` = last id.
- Capabilities: `orders.read`, `orders.fulfill`, `inventory.write` for owner and staff (07-IAM: "Own store" for both). Inventory *reads* reuse `catalog.read`.
- The buyer's "placed" event has no history row (checkout is not in this track's files); the detail page renders it from `order.created_at`.
- Destructive confirmation uses `window.confirm` in a tiny client component; the server re-validates regardless.

## Commands run (worktree root, 2026-10-06)

| Command | Result |
|---|---|
| `pnpm db:generate` | `0001_bored_sir_ram.sql` generated |
| `pnpm lint` | pass (0 problems) |
| `pnpm typecheck` | pass (db + web, `next typegen` ok) |
| `pnpm test` | **34 passed** (22 existing + 12 in `orders.test.ts`), 4 files |
| `pnpm build` | pass; `/seller/orders`, `/seller/orders/[id]`, `/seller/inventory` dynamic |
| `pnpm e2e` | **14 passed** (10 existing + 4 new: 2 specs × mobile-320/desktop), 1.3 min |

`orders.test.ts` covers: list/filter/cursor; detail snapshot and secret
stripping; cross-store denial for read, list and all five transitions;
happy path with per-step actor audit; full transition matrix (6 statuses ×
5 actions, allowed and rejected, history count = allowed count); cancel
restocks once + double cancel + cancel-after-ship rejected; 3 rounds of two
concurrent cancels racing a process (one winner, stock consistent, one
history row); staff can read/fulfil; inventory list isolation + signed
adjustments with reason/actor; cross-store adjustment denied; 12 concurrent
decrements on stock 5 → exactly 5 succeed, stock 0, 5 log rows; staff can adjust.

`orders.spec.ts` covers: buyer COD order → seller list → filter → detail →
process → ship (tracking shown, cancel disappears) → complete (4 history
entries) → other store's owner gets 404; transfer order → mark paid → cancel
dialog dismissed (no change) → accepted → inventory back to the starting
stock with a "+2 · pesanan #n" log entry → manual +3 → over-decrement shows
"Stok tidak cukup" and leaves stock unchanged. Each step checks no
horizontal overflow at 320px.

## Open issues / notes for the orchestrator

- Evidence PNGs for this track live in `docs/evidence/m1/` (30–34) because the shared helper hardcodes that folder.
- Migration `0001_*` is branch-local; regenerate at merge as planned.
- `run()` is duplicated in `seller/orders/run.ts`; fold back into one place once the accounts track's edits to `seller/actions.ts` land.
- Dev database for clicking around was not seeded/migrated in this session (only the disposable `_test`/`_e2e` databases were used).
