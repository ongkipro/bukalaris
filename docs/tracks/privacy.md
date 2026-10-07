# Track report — `privacy` (M2 wave 4: T-43 buyer data export and redaction, T-33 mechanism)

Branch `m2/privacy`, worktree `~/Projects/bukalaris-wt/privacy`, databases
`bukalaris_privacy[_test|_e2e]` (own `.env`). Local only: no provider call, no deploy.
This is an engineering mechanism (SEC-19, PRIV-1, PRIV-4); it does not claim UU PDP
compliance. Retention periods remain the privacy owner's decision (Q-11).

## What changed

| File | Change |
|---|---|
| `packages/db/src/schema-privacy.ts` | `order_redaction` (PK store+order, FK → `order(store_id,id)`, actor, source `seller`/`retention`, override + reason; CHECK override ⇒ reason). Presence = idempotency marker and per-order audit |
| `packages/db/src/privacy.ts` | `BUYER_DATA_INVENTORY` + `PII_COLUMN_RE`; `normalizeBuyerKey` (phone `+62/62/0` → `0…`, e-mail lower-case); `findBuyerOrders`, `exportBuyerData`, `redactOrders` (all `SellerScope`, capability `privacy.manage`, inside `inStore` RLS context); `retentionDays()` (env `BUYER_DATA_RETENTION_DAYS`); `redactStaleOrders()` (platform pool, one `withStore` transaction per store, same `redactRows` path) |
| `packages/db/drizzle/0008_privacy.sql` + `meta/0008_snapshot.json` | Generated: `order_redaction` |
| `packages/db/drizzle/0009_privacy_rls.sql` + `meta/0009_snapshot.json` | **Hand-written** (keep verbatim at consolidation): RLS ENABLE+FORCE + `tenant_isolation` policy on `order_redaction`; grants to `bukalaris_app`: `SELECT, INSERT` on `order_redaction`, `DELETE` on `order_signal_context`, `UPDATE` on `signal_event`, `SELECT, UPDATE` on `order_notification` (RLS-protected), `UPDATE` on `mail_outbox` |
| `packages/db/src/cleanup.ts` | Calls `redactStaleOrders` only when `BUYER_DATA_RETENTION_DAYS` is set; logs `buyerRetention: { enabled: false }` otherwise (**disabled by default**) |
| `apps/web/src/app/seller/privacy/{page.tsx,actions.ts,loading.tsx}` | Owner page "Data pembeli": search by phone/e-mail (this store only), result table, "Unduh JSON", redaction fieldset with checkbox selection, override checkbox + reason for open orders, `ConfirmSubmit` dialog (explicit confirmation). Staff see a read-only notice |
| `apps/web/src/app/seller/privacy/export/route.ts` | `GET` JSON download, `Content-Disposition: attachment`, `Cache-Control: no-store`, 403 for non-owners, 400 for an invalid key |
| `docs/13-COMPLIANCE-PRIVACY.md` | PRIV-1 "Buyer personal-data inventory" section (every column, purpose, where shown, retention, redaction behaviour) + redaction/export record and backup caveat |
| `packages/db/test/privacy.test.ts` | 10 tests (inventory scan vs schema and doc, key normalization, export scope/audit, redaction fields/money/idempotency/override/isolation, retention env + job) |
| `apps/web/e2e/privacy.spec.ts` | 2 tests × 2 projects (owner search → export → refused for open order → override with reason → detail keeps money; staff denied). Evidence `docs/evidence/m1/{desktop,mobile-320}-privacy-{search,results,redacted}.png` |

### Redaction behaviour (verified by tests)

- `order.buyer_name/buyer_phone/shipping_address` → `[dihapus]`, `buyer_email` → NULL; status,
  subtotal, shipping fee/cost/margin, total, lines, history, courier, tracking number unchanged
  (`order_total_chk` still holds).
- `order_signal_context` row deleted; `signal_event.payload.user` stripped (value/contents stay).
- Buyer `order_notification.to_email` → `[dihapus]`; matching `mail_outbox` copies lose body
  (and address for buyer copies; owner copies keep their address).
- One `order_redaction` row per order and one `audit_log` `privacy.redact` row per batch with
  counts. Second run is a no-op (no audit row). Orders not `completed`/`cancelled` are refused
  unless override + reason (≥ 5 chars); override recorded per row. Max 100 ids per call, all
  must belong to the scope's store (`FOR UPDATE`), otherwise `not_found`.
- Export: only the caller's store (store filter + RLS); omits `requestHash`, `idempotencyKey`,
  `cartId` and the seller-internal `shippingProviderCost`/`shippingMargin`; audited as
  `privacy.export` with a SHA-256 key prefix, never the raw phone/e-mail.

## Review fixes in this session

- Export no longer leaks seller-internal courier cost and margin into the buyer's file
  (`privacy.ts`; assertion added in `privacy.test.ts`).
- Seller nav overflow at 1440 px failed `ui.spec.ts` (desktop): applied the identical change
  from `m2/dashboard` (633a4df) / `m2/fulfillment` (76666cf) to `admin-shell.tsx`
  (`gap-x-4 … md:flex-wrap md:overflow-visible` + doc comment). Identical hunk, merges cleanly.
- Restored re-rendered `docs/evidence/m1/*.png` that the e2e run overwrote (not track output).

## Commands and results (2026-10-07, this worktree's `.env`)

| Command | Result |
|---|---|
| `pnpm db:migrate && pnpm db:seed` | migrations applied (0008, 0009), seed done |
| `pnpm lint` | clean |
| `pnpm typecheck` | clean |
| `pnpm test` | 16 files, **147 passed** |
| `pnpm build` | success |
| `pnpm e2e` (1st) | 75 passed, 2 skipped, 1 failed (`ui.spec.ts` desktop nav overflow, known cross-track) |
| `pnpm e2e` (after nav fix + rebuild) | **76 passed, 2 skipped** |

## Defaults taken

- Capability `privacy.manage` = owner only (added to the capability map in `scoped.ts`).
- Placeholder `[dihapus]`; e-mail set to NULL (column nullable).
- Retention job disabled unless `BUYER_DATA_RETENTION_DAYS` is an integer ≥ 1 (junk fails
  loudly); it only touches closed orders whose `updated_at` is older than the window, actor
  `system:retention`, max 1000 orders per run.
- Search/lookup is not audited; export and redaction are.

## Shared / outside-ownership changes

- `packages/db/src/scoped.ts`: one capability line (`privacy.manage`), additions only.
- `packages/db/test/rls.test.ts`: grant table updated for the new grants; `order_notification`
  moves from "denied" to "0 rows outside a store context" (it was already RLS-forced).
- `apps/web/src/components/admin-shell.tsx`: nav wrap fix, identical to dashboard/fulfillment.
- `apps/web/src/app/seller/layout.tsx` nav entry was pre-populated by the orchestrator (no edit).
- `docs/tracks/rls.md`: not modified.

## Migration numbers

`0008_privacy` (generated) and `0009_privacy_rls` (hand-written grants/RLS). Orchestrator
regenerates the consolidated migration at merge; `0009` must be kept verbatim.

## Open issues

1. **Fulfillment `shipment` table** (m2/fulfillment, not in this tree) holds buyer address data:
   after merge, add its columns to `BUYER_DATA_INVENTORY`, the doc table, export and
   `redactRows` (the inventory scan test will fail on name-matched columns until then).
2. `mail_outbox` is store-less: the app role now has table-wide `UPDATE` on it. The code only
   updates rows matched from the store's RLS-scoped `order_notification` records, but the
   grant is broader than RLS. Acceptable for the dev-only sink; revisit when a real mail
   provider replaces it (add `store_id` + RLS, or move the body redaction to the platform role).
3. A Purchase signal enqueued **after** an override redaction of an open order would hash the
   placeholder `[dihapus]` as first name (phone yields no digits, so no phone hash).
   `purchasePayload` in `signals.ts` (signals track) should skip `REDACTED` values.
4. Backups taken before a redaction still contain the data; restore must re-apply
   `order_redaction` (PRIV-4) — not automated.
5. Free-text fields (`order_status_history.note`, `stock_adjustment.reason`) are not redacted;
   documented rule only.
6. Q-11 retention periods still owed by the privacy owner; T-33 enforcement stays blocked on it.
