# T-107 Independent Review (2026-11-16)

**Verdict on T-107 (ea1f9b8):** no blockers, but three major issues should be fixed before merge. I only read code and ran nothing (no tests, no DB); everything below comes from reading the code and docs.

## Major

**M1. A store with only its own AutoLaris still takes physical orders that can never be booked.**
- Where: `shipping/shipping.ts:248`, `ledger/booking.ts:67`.
- Such a store is `seller_owned`, but `selectShippingAccount` still returns the platform account. `shippingOptions` therefore offers COD and prepaid options at margin 0.
- `placeOrder` freezes the order as `seller_owned`. Then `bookShipment` hands off to the worker, and `reserveShippingCost` refuses `not_bookable`.
- Result: a buyer can pay the seller's own AutoLaris, or place a COD order, and the order can never ship through Bukalaris. Before T-107 this was bookable. ADR-0013 decisions 13, 14 and 40 say a method must never be shown and then fail after the order exists. The new SC-13 note "platform-booking-closed" only describes the dead end.
- Fix: when a `seller_owned` store has no `seller_owned` shipping account, return no shipping options and refuse the submit. Add this case to the test matrix; today `ownStore` always connects both providers or only Mengantar.

**M2. Store-level refusals read the store's current state, which breaks platform money already in flight.**
- Where: migration `0021:54-72`, `verify.ts:130`, `transfer.ts:338`.
- A store's mode never goes back (account rows are never deleted), but its earlier platform-held rows remain.
- Rejecting a payout posts an order-less `payout_reversal`. The guard refuses it, so a payout requested before the store connected an account can no longer be rejected. The debit stays and the money is stranded.
- `verify:ledger` invariant 9 reports every earlier payout, payout destination and adjustment of a converted store. So `pnpm verify:ledger` fails on legitimate old data.
- `requestLedgerAdjustment` is refused too, so the Owner has no way to fix it. Ceiling T-107-1 item 1 understates all of this.
- Fix (preferred): refuse to connect an own account while the store has open platform money (balance ≠ 0, a payout `requested`/`processing`, an open refund, or a non-terminal platform-held order). That makes the switch a clean cut-over. Otherwise at least exempt `payout_reversal` in the guard and only check rows created after the store converted.

**M3. T-115 uses a different "seller_owned" rule, and the migrations clash.**
- T-115's `sellerHeldMoney` (its `orders.ts`) decides by the order's shipping account kind plus an own-account attempt. T-107 decides by the frozen `money_mode`.
- Divergent case: an older own-Mengantar COD order that the backfill left `platform_held` (it had a margin or a ledger row). T-115 skips `bookCodSale`, while `verify:ledger` rule 1 still expects a sale for `platform_held`, so it reports `missing_sale`.
- Fix at integration: make `sellerHeldMoney` call `orderMoneyMode(...) === "seller_owned"`.
- Both branches add `0021_*` and `meta/0021_snapshot.json`. The second one to land must be regenerated with `generate` (the snapshot chain), not renamed by hand.
- Both branches change `isolation-registry.ts`. Regenerate the T-59 GRANT block from `registryRows()`.

## Minor

1. **The buyer never sees the COD fee amount before ordering.**
   - The checkout shows only the rate (`codFeeLabel`, `checkout.ts:179`), and the checkout "Total" leaves the fee out.
   - The exact courier amount first appears on the confirmation page and `/o`. Buyer e-mails omit it (listed as an open point).
   - This misses "same total on checkout, confirmation, /o".
2. **The "gross-up" is a simple add-on.**
   - The code computes fee = 3% × payable (`sellerOwnedMoney`, `checkout.ts:492`).
   - If Mengantar charges its fee on the collected amount (plus VAT), the seller does not net the full total, which ADR decision 18 promises.
   - Fix: use payable·r/(1−r), or state the assumed base explicitly in Ceiling T-107-1.
3. **Test gaps.**
   - The DB refusal test (`t107…test.ts:175-191`) never inserts into `payout`, `reconciliation_batch_item` or `shipment_cost`. If the trigger were missing on those tables, no test would fail.
   - Its title says "a platform-held store is accepted", but it only asserts `storeMoneyMode`.
   - `order_financials_money_guard` on INSERT (mode or bearer differing from the store's) has no test and no mutation.
4. **One SQLSTATE for everything.** The guard raises `check_violation` (23514), which other checks also raise. `applyLedgerAdjustment` (`console.ts:112`) maps a boundary refusal to "would_go_negative" when the store converts between request and approval. Use a dedicated SQLSTATE, or match on the message.
5. **Stale label on the seller shipping screen.** SC-22 still says `cod_fee_bearer` is "Disimpan, belum diterapkan", but it now changes buyer bills. It is a one-line fix at integration.
6. **The collected total overstates receipts.** "Total diterima di akun Anda" (`collected.tsx:25`) is the buyer's bill. It includes the COD fee that goes to Mengantar and does not deduct a gateway fee the seller bore. Label it "dibayar pembeli" instead.
7. **Submit race.** `placeOrder` reads the mode outside the transaction (`checkout.ts:348`). If the store connects an account at that moment, the guard raises 23514 and the buyer gets a generic error. It fails closed, so no money leaks.

## Nits

- The track report says the T-103 host-mode PNGs "stay untracked", but six are in the commit. Main has its own T-103 evidence commit (ccd9036), so expect a binary conflict.
- The TASKS status says "not committed", but the work is committed.
- The mutation numbering skips M4.
- The `order_financials` line in `isolation-registry.ts` is mis-indented.
- The backfill sets COD orders to `fee_rate_version = 1` while their COD fee is 0.
- Dashboard refunds are counted by `created_at`, not `refunded_on`.

## Checked and sound

- **Mode rule:** it matches ADR-0013 decision 13 and D-31. Requiring the store's own AutoLaris for prepaid orders when it only has its own Mengantar is the correct reading, not a regression. Ceiling T-106-1 was explicitly temporary.
- **Mode can't revert:** removing a key keeps the account row and accounts are only created after a successful check, so the mode never goes back. Seller money cannot enter the ledger, because order-linked guards read the frozen `money_mode`, not the store's current state.
- **Payment attempts:** the attempt guard covers only `owner_kind='order'`, so subscription invoices are unaffected. Retry is only allowed on the store's own account.
- **Trigger order and coverage:** the `a_` prefix fires before `a_shipping_snapshot_guard` and every other guard on these tables. BEFORE INSERT triggers fire for every role. UPDATE paths are already closed by the existing guards.
- **Definer functions:** all four pin `search_path`, revoke from PUBLIC and are registered with `execute: []`. The `reset_demo_payments` change only adds one DELETE.
- **Migration and backfill:** the CHECK on the populated table is safe (defaults pass). The backfill only ever moves rows towards `seller_owned`, and only when proven (own-account attempt or own-Mengantar COD, no platform rows). The `order_financials_guard` trigger is disabled and re-enabled around it.
- **order_financials CHECK:** it forbids platform margin, cashback, affiliate and COD fee for `seller_owned`, and enforces `buyer_fee = fee whose bearer is buyer`. Rounding is integer half-up.
- **order_seller_refund:** forced RLS, append-only, owner-only capability (no step-up, which is consistent with decision 24), an audit row plus a history row, and the sum bound enforced in both the service and the DB (advisory lock plus FOR UPDATE). It never touches the ledger.
- **Fee schedule:** publishing a new version copies the `COD` row forward, and `COD` is excluded from every channel list.
- **Owner console:** `platform_money_position` and the manual-completion queue are filtered to platform-held money. The other queues are ledger-driven, so seller-owned orders are already excluded.
- **Seller screens:** test orders are excluded from KPIs, top products and collected amounts.
- **Allowed Paths:** the listed deviations are necessary and declared. The pricing change in `shipping.ts` goes beyond "guards only", but it is justified.
