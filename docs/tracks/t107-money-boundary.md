# T-107 — Money boundary for stores on seller-owned accounts

- Task: `docs/TASKS.md` T-107 (PR-23, Risk R4). Branch `task/t107-money-boundary` from `main` f6a1fb3 (T-105 and T-106 merged), not committed.
- Sources: ADR-0013 sections 5 and 8 (and decisions 11, 17 to 19, 24, 26, 32), ADR-0006 ledger invariants (unchanged for platform-held money), BILL-4, BILL-5, D-27, D-31, D-32 (C-P1, C-P7, C-P9, C-P10), Ceiling T-106-1.
- Everything runs on fakes: no provider call, no key, no deploy.

## The rule

One definition, stated twice and kept equal by the tests: in the database `store_money_mode(store_id)` (owner-only definer, migration `0022`) and in the services `storeMoneyMode` (`packages/db/src/ledger/boundary.ts`). A store is **`seller_owned`** as soon as it holds a seller-owned account of either provider (a `store_shipping_account` of kind `seller_owned` or a `store_payment_account`); otherwise it is `platform_held` (the ADR-0006 model that D-31 keeps in the code, unused). Each order freezes the store's mode at submit in `order_financials.money_mode` (`order_financials_money_guard` refuses any other value).

For a `seller_owned` store or order Bukalaris writes no `ledger_entry`, `payout`, `payout_destination`, `refund`, `reconciliation_batch_item`, `shipment_cost` or `late_payment_obligation`, and no platform-account `payment_attempt`. The refusal is a rule in two layers:

- services: `bookSale` (prepaid and COD sale), `settleTerminalOrder`, `openRefundForPaidOrder` skip a seller-owned order; `requestPayout`, `setPayoutDestination`, `releaseStore`, `requestLedgerAdjustment` refuse the store (`seller_owned_store`); `prepareReconciliationBatch`, `requestManualCompletion` refuse the order (`seller_owned_order`); `reserveShippingCost` refuses a platform booking (`not_bookable`); `releaseAll` skips such a store;
- database: `money_boundary_guard` (BEFORE INSERT on the eight tables above) raises `check_violation` for every role: store-level for rows without an order (payout, destination, order-less ledger entry) and for a platform-account attempt of an order; order-level (the frozen mode) for every order-linked row.

Money Bukalaris does hold keeps every ADR-0006 invariant: the T-37 tests run unchanged on platform-held stores.

## What was built

| Area | Change |
|---|---|
| Migration `0022_t107_money_boundary.sql` | Generated: `order_financials` columns `money_mode`, `payment_fee_bearer`, `cod_fee_bearer`, `expected_cod_fee_idr`, `buyer_fee_idr`, `fee_rate_version` and the check `order_financials_money_mode_chk`; table `order_seller_refund`. Hand-written `-- ===== T-107` section: the rule, `money_boundary_guard` on eight tables, `order_financials_money_guard`, FORCE RLS and grants for `order_seller_refund`, its append-only trigger and `order_seller_refund_guard` (paid seller-owned order only, sum never above the bill, serialised per order), `platform_money_position` filtered to platform-held money, the `COD` fee row in every fee-schedule version, the backfill of provably seller-paid snapshots, retention class, demo reset |
| `order_financials` (BILL-4) | A seller-owned snapshot carries both fee bearers (the store's settings read inside the order transaction), the one fee of its method (gateway fee for QRIS/VA, provider COD fee for COD), `buyer_fee_idr` (the fee whose bearer is `buyer`; bill = `payable + buyer_fee`) and the rate version; the check refuses platform margin discount, cashback, affiliate, COD fee inside `payable` and its VAT |
| Checkout (`seller/commerce/checkout.ts`) | Seller-owned store: no T-52 platform affiliate plan (T-108 owns the store programme), the fee plan and the snapshot use the same in-transaction bearers, the COD fee from the schedule in force (`COD`, 3% of the total before the fee, UNVERIFIED), the platform-account QRIS/VA fallback closed (method list empty without the store's own AutoLaris account, direct submit refused). `checkoutPaymentChannels` also returns the COD fee terms; `codFeeLabel`; `orderBill` for the buyer's pages |
| Shipping | `shippingOptions`: no platform margin and no platform-funded discount for a seller-owned store on any account; `bookShipment`: the courier collects the total plus the COD fee the buyer bears; `shipmentTimeline(…, carrier)` names Mengantar on the seller's screen |
| Orders (`seller/commerce/orders.ts`) | `orderMoney` (bill, bearers, fees, recorded refunds), `recordSellerRefund` (owner, `finance.confirm_payment`; paid seller-owned order; date not in the future nor before the order; never above the bill; history row and audit row), `buyerOrderMoneyForLink` (C-P9) |
| Dashboard (`seller/commerce/dashboard.ts`) | Test orders excluded from every sales figure; `collectedIn` / `sellerCollected`: paid (`paid_at`) seller-owned orders by method (COD, QRIS, virtual account, other) at the buyer's bill, recorded refunds beside it |
| Seller Admin | SC-13 order page: "Uang pesanan" (bill, fee and bearer, recorded refunds, "Catat refund" form), test-order badge and note, Mengantar named for the store's own account; SC-25 finance: a seller-owned store sees collected amounts (30 days and all time) with "Tidak ada Saldo Bukalaris", no balance, statement or payout form; SC-01 dashboard: "Uang diterima di akun Anda" |
| Buyer pages | Checkout: the COD option states the COD fee or "Tanpa biaya COD tambahan"; confirmation and `/o/<token>`: "Biaya COD" and "Dibayar ke kurir"; `/o/<token>`: "Refund dari penjual" (amount, day, method in the buyer's words; never the seller's note or reference) |
| Owner console (visibility only) | `/admin/money`, `/admin/payouts`, `/admin/shipping` state that they list platform-held money only; the money view and `manualCompletionCandidates` exclude seller-owned orders |
| `verify:ledger` | Invariant 9 (no seller-owned row in the platform books, no platform figure in a seller-owned snapshot, seller refunds never above the bill); rule 1 (missing sale) for platform-held orders only; the script prints the seller-owned stores and orders outside the books |
| Copy guard | `t48-copy-guard.test.ts`: every Seller Admin screen may name Mengantar and AutoLaris (ADR-0013 section 8); buyer, storefront, checkout and shared surfaces still may not |
| Registry | `order_seller_refund` (tenant, app SELECT/INSERT, platform SELECT); four definer guards with `execute: []`; T-59 contract GRANT block +1 line |
| Docs | ARCH-5 rows SC-13 and SC-25, `DECISIONS.md` (Ceiling T-106-1 narrowed, Ceiling T-107-1), this report, the T-107 block in `TASKS.md` |

## Items handed to T-107

| Source | Item | Resolution |
|---|---|---|
| T-105 open points | COD fee amount and fee-bearer gross-up (`cod_fee_bearer` "Disimpan, belum diterapkan") | Built. The fee is the `COD` row of the versioned schedule (decision 19), frozen per order; bearer `buyer`: the buyer sees it at checkout and the courier collects total + fee; bearer `seller`: the courier collects the total. The seller shipping screen label is outside the Allowed Paths and still says "Disimpan, belum diterapkan" (open point below) |
| T-105, T-106 | Test-order marker on the order (`order.test_order`) shown on the order page and excluded from sales figures | Built: badge and note on SC-13; excluded from the dashboard KPIs, top products and collected amounts |
| T-105 | Seller Admin copy boundary for Mengantar/AutoLaris; timeline "Resi terbit dari Bukalaris Kirim" | Built: the copy guard allows the brand on every Seller Admin screen; the order page names Mengantar for the store's own account (heading, waybill timeline, account line, provider error text) |
| T-106 | Both fee bearers frozen in `order_financials` | Built (decision 18) |
| T-106 | Refunds recorded on the order as made by the seller | Built (`order_seller_refund`, decision 26, C-P9) |
| Ceiling T-106-1 | Platform-account fallback for stores without their own AutoLaris account | Closed for every store holding a seller-owned account (method list, submit, database). Kept only for a store with no seller-owned account at all (the platform-managed model of D-31); removing it is a store-opening rule owned by T-93 (`DECISIONS.md`) |

## Named tests (`packages/db/test/t107-money-boundary.test.ts`)

1. "fee-bearer matrix (buyer/seller × QRIS, VA, COD): order_financials is written once with both fee bearers and the one fee of the method, no platform margin, cashback or affiliate deduction"
2. "the database freezes the store's mode and bearers: order_financials of a seller_owned order is immutable and refuses a platform figure"
3. "no ledger row for a seller_owned order: a hand-confirmed payment, a COD delivery and a cancellation after payment write no ledger entry and no platform refund"
4. "the database refuses every platform money row for a seller-owned order or store, for every role, by rule (a platform-held store is accepted)"
5. "payout request refused: payout, payout destination, release, reconciliation, manual completion and ledger adjustment refuse a seller-owned store by rule, not by missing data"
6. "the platform account is never used for a seller-owned store: without its own AutoLaris account it offers no QRIS/VA and refuses a direct submit (Ceiling T-106-1 closed for it)"
7. "dashboard totals equal the sum of paid and delivered orders by method; test orders and unpaid orders are not counted"
8. "a refund is recorded on the order as made by the seller: owner only, paid orders only, never above the buyer's bill (service and database, also under concurrency), append-only, shown on the buyer's link"
9. "seller screens name Mengantar: the waybill of the store's own account comes from Mengantar, the platform path stays white-label"
10. "verify:ledger passes with mixed data (platform ledger beside seller-owned orders) and flags a seller-owned order in the platform books"

E2E `apps/web/e2e/t107.spec.ts` (mobile-320 and desktop): the seller-owned order page with the test-order badge and a refund recorded through the form, the finance screen without balance or payouts, the dashboard figure, the buyer's link with the refund, and the Owner console money note.

## Mutation checks

Runner: `mutate.py` in the session scratchpad. Each row breaks one invariant in place, runs only the named test (`vitest run test/t107-money-boundary.test.ts -t <name>`, which re-migrates the test database, so a migration edit is live), expects it to fail, restores the file and compares its SHA-256 with the value taken before the edit (all restored, hashes equal; `git diff` of the mutated files unchanged afterwards).

| # | Invariant broken | File (change) | Named test that failed |
|---|---|---|---|
| M1 | a `sale` entry is written for a seller-owned order (Done-when mutation 1) | `ledger/ledger.ts` (`bookSale` boundary line removed) | "no ledger row for a seller_owned order …" (the COD delivery then hits the database guard) |
| M1b | the database accepts an order-linked platform row for a seller-owned order | `0021` (`money_boundary_guard` order-level test → `IF false`) | "the database refuses every platform money row …" |
| M2 | a payout request is allowed for a seller-owned store (Done-when mutation 2) | `ledger/payouts.ts` (`assertPlatformHeldStore` in `requestPayout` removed) | "payout request refused: …" |
| M2b | the database accepts a payout or payout destination of a seller-owned store | `0021` (store-level branch → `IF false`) | "the database refuses every platform money row …" (first run: the test still passed, because another guard refused the same rows with the same SQLSTATE; the test now requires the boundary's own refusal message and the guard trigger is named `a_money_boundary_guard` so it fires first; re-run: failed as required, M1b re-run too) |
| M3 | the buyer is billed the COD fee whatever the bearer | `checkout.ts` (`buyerFeeIdr: codFee`) | "fee-bearer matrix …" |
| M5 | test orders counted in the collected figures | `dashboard.ts` (`not o.test_order` removed) | "dashboard totals equal the sum of paid and delivered orders …" |
| M6 | a refund above the bill accepted by the service | `orders.ts` (bill check → `if (false)`) | "a refund is recorded on the order as made by the seller …" |
| M6b | the database accepts recorded refunds above the bill | `0021` (`order_seller_refund_guard` sum check → `IF false`) | "a refund is recorded on the order as made by the seller …" |
| M7 | the platform-account QRIS/VA fallback re-opened for a seller-owned store | `checkout.ts` (`channels: []` closure removed) | "the platform account is never used for a seller-owned store …" |
| M8 | `verify:ledger` blind to a seller-owned row in the platform books | `ledger/verify.ts` (invariant 9 `add` removed) | "verify:ledger passes with mixed data …" |
| M9 | the COD fee not computed (no gross-up) | `checkout.ts` (`codFee = 0`) | "fee-bearer matrix …" |


## Migration proof on a populated copy

`create database bukalaris_t107_pop template bukalaris` (dev database: 6 stores, 64 orders, at migration 0009). Migrated as `bukalaris_owner` through `0020` with a journal copy that stops there: 21 migrations, counts unchanged. Data as a pre-T-107 database would hold it: the dev orders predate the frozen snapshot, so the 32 orders of the two stores with the most transfer orders got a snapshot the way checkout writes one (one transaction, deferred line check); store A's orders were made margin-free (as a seller-owned store sells), store A got its own AutoLaris account (sandbox, no key) and one attempt on it per transfer order (7), store B platform attempts (7). Then the real `drizzle/` folder applied `0021`: 22 migrations; stores 6, orders 64, snapshots 32, attempts 14, ledger 0, shipping accounts 12 (unchanged); backfill: exactly the 7 own-account attempt orders became `seller_owned` (bearers `buyer`, rate version 1), the other 25 stayed `platform_held` (0 wrong); 0 unvalidated constraints in `public`; `order_seller_refund` RLS enabled and forced; `a_money_boundary_guard` on the eight tables, `order_financials_money_guard`, `order_seller_refund_guard` and its append-only trigger present; the `COD` row in fee version 1; retention class `order_seller_refund` (`row_filter false`); `platform_money_position` readable. `verify:ledger` on the copy: invariant 9 clean ("1 store on its own accounts, 7 seller-owned orders outside the platform books"); it reports 38 violations that predate T-107 and the ledger itself (32 dev orders of two other stores without any snapshot, 6 completed COD orders from before T-37 without a sale). Copy dropped. An earlier run without the margin-free step left all 32 snapshots `platform_held` (every legacy order carried a platform margin, which the backfill deliberately refuses).

## Executed verification

- Final `pnpm verify` (private env, CI-style placeholders, own databases `bukalaris_t107*`, `E2E_PORT=4300`, under `heavy-run --lock bukalaris-env`, log `verify-t107-final.log`): system map ok (105 route files, 127 rows); lint and typecheck clean; DB **80 files / 1519 tests passed**; build ok; E2E **290 passed, 4 skipped** (the opt-in `t105-sandbox.spec.ts` at both projects and the two mobile skips present on main), exit 0. `t107.spec.ts` green at mobile-320 and desktop (both tests).
- The run before it (log `verify-t107-1.log`, before the platform-booking note on SC-13) was also exit 0 with the same counts.
- `pnpm verify:ledger` against the E2E database after the run (mixed data: platform ledger of the T-37 specs beside seller-owned stores of T-104 to T-107): "5 store(s), 20 entries, 106 orders, 10 order-less entries"; "money boundary: 8 store(s) on their own accounts, 8 seller-owned order(s) outside the platform books"; "OK, no violation", exit 0.
- Targeted runs during the work: T-107 file 10/10; T-105, T-106, RLS, copy guard, dashboard files green after the test adjustments listed below.
- Rendered evidence opened and checked (320 px and 1440 px): `docs/evidence/m1/{mobile-320,desktop}-t107-{order-money,finance,dashboard,buyer-refund,admin-money}.png`. The review of the 320 px order page led to one fix: an order paid to the store's own accounts on a store without its own Mengantar account offered "Kirim dengan Bukalaris Kirim", which the boundary refuses; the page now shows a note instead (`platform-booking-closed`, asserted in the spec). Tracked baseline PNGs rewritten by the E2E run were restored (`git restore -- docs/evidence`); the new t107 PNGs and the T-103 host-mode PNGs the run created stay untracked.

## Deviations from the Allowed Paths

- New migration `0022` (renumbered from `0021` at the integration onto T-115, 2026-11-23) and schema columns/table in `ledger/schema-ledger.ts` and `seller/commerce/schema-orders.ts` (the snapshot needs the bearers; the refund record needs a table, C-P10); isolation registry and the T-59 contract GRANT block (+1 line); `index.ts` (export).
- `payments/contract.ts` (`COD_FEE_CODE`) and `payments/seller.ts` (the `COD` row is never a payment channel: channel list and seller preferences).
- `shipping/shipping.ts` (no margin or platform discount for a seller-owned store), `shipping/fulfillment.ts` (COD amount with the buyer's COD fee; the timeline carrier name).
- `ledger/booking.ts`, `ledger/console.ts`, `ledger/reconciliation.ts`, `ledger/release.ts`, `ledger/payouts.ts`, `ledger/ledger.ts`, `ledger/verify.ts`: guards and the verification only (inside `ledger/**`).
- Buyer pages: `(checkout)/checkout/page.tsx` (COD fee line in the method list), `(checkout)/checkout/confirmation/page.tsx`, `(public-services)/o/[token]/page.tsx` (COD fee, bill to the courier, seller refunds: C-P9 names T-107).
- `demo/seed-demo.ts` (the demo reset list), `docs/04` ARCH-5 rows SC-13 and SC-25, `docs/DECISIONS.md`.
- Tests outside the new file: `t48-copy-guard.test.ts` (boundary moved) and `e2e/t105.spec.ts` (the account line now names Mengantar). `t105-mengantar-seller-key.test.ts`: a prepaid order on a store with its own Mengantar account now connects its own AutoLaris account and is confirmed by hand (the platform fallback is closed for it), and the COD amount of a booking includes the buyer's COD fee; `t106-autolaris-seller-key.test.ts`: the fee schedule now carries the `COD` row.

## Open points

- The seller shipping screen (`(seller)/seller/shipping`, outside the Allowed Paths) still labels `cod_fee_bearer` "Disimpan, belum diterapkan" and says "akun kurir" for the own account; the bearer is applied since T-107. One-line copy change for the owner of SC-22.
- The COD fee rate (3%), its minimum and VAT are UNVERIFIED with Mengantar (Ceiling T-107-1 item 2); the Owner console screen for fee versions is still services only (T-106 open point).
- Buyer e-mails do not show the COD fee or the recorded seller refund yet (`ops/jobs/notify.ts`, outside the Allowed Paths); the buyer portal (ADR-0010) does not show recorded refunds yet (C-P9 names both; the signed order-status page does).
- The buyer's shipment timeline for a store on its own account still says "Resi terbit dari Bukalaris Kirim" (buyer copy names neither brand; a neutral text is a buyer-copy change, not done here).
- The platform-managed path for a store without any seller-owned account stays (D-31); store opening with an own payment method is T-93.
- A store that held platform-held ledger money before connecting its own account keeps that balance frozen (Ceiling T-107-1 item 1).

## Integration note (T-115)

T-115 adds a minimal guard in `seller/commerce/orders.ts` around `bookCodSale` and `settleTerminalOrder` for orders on the store's own courier account. T-107 does not touch those call sites: the refusal lives inside the ledger writers (`bookSale`, `settleTerminalOrder`, `openRefundForPaidOrder` in `ledger/ledger.ts`, one predicate `orderMoneyMode(...) === "seller_owned"` from `ledger/boundary.ts`) and in the database (`a_money_boundary_guard`), so it holds without T-115's guard and the two merge without overlap; the T-115 guard can later call `orderMoneyMode` instead of reading the account kind.

## Integration onto `main` after T-115 (2026-11-23)

- `main` merged into the branch (no rebase, no force push). Migration renumbered `0022_t107_money_boundary.sql`: T-115 took `0021`; `drizzle-kit generate --name t107_money_boundary` on T-115's snapshot produced the same generated statements as the old `0021` draft, and the hand-written `-- ===== T-107` section was re-appended unchanged (`diff` against the old file: identical). The two hand-written sections define no common function or trigger.
- Conflicts resolved: seller order page (both import sets; T-107's money block and Mengantar naming kept beside T-115's status history and rebook rule; T-115's figures heading now says "akun Mengantar toko"), `provider-accounts.ts` (T-115's dedicated-account check runs before the transaction, T-107's cut-over mapping stays on it), `fulfillment.ts` imports, `t48-copy-guard.test.ts` (T-107's whole-Seller-Admin rule covers T-115's account screen), `docs/04` SC-13 (both tasks' functions, tables and tests), `DECISIONS.md` (T-107 ceilings and D-35 both kept), `TASKS.md` index, T-103 screenshots taken from `main`.
- Local on this device (no Docker, so no database): `pnpm map:check` ok (107 route files, 130 rows), `pnpm lint`, `pnpm typecheck`. Database tests, E2E, the populated-copy proof on `0022` and the review record are still open.
