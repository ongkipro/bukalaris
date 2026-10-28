# T-48 review fixes (track `t48fix`, patch `T48Fix`)

Local, uncommitted work on top of the waves 1-5 overlay (T-48 `0015`, with the conductor's `NOT VALID` foreign-key correction and the tracking-continues fix already in). **Fake adapters only: no provider call, no secret, no live transport.** Migration `0016_t48_fix.sql` (generated structure, then a hand-written section `-- ===== T-48 fix`); the conductor folds it into its own migration, see "Folding notes". Every finding below has a named test that fails when the fix is removed (the mutation table is at the end).

## What changed

### 1. P2 (money): the platform shipping discount is no longer paid by the seller

The cause: the platform discount lowers `shipping_charged` and the frozen margin, but the discount amount itself was never stored. At booking `delta = booked - (charged + store discount)`, so a courier price rise that the full margin would have absorbed was debited to the seller (courier 10 500, margin 2 000, platform discount 2 000, re-quote 11 000: seller debit 500).

- `order_financials.platform_shipping_discount_idr` (new, `>= 0`, immutable with the rest of the snapshot: `financial_snapshot_guard` already refuses every UPDATE) is written by checkout from the priced fee (`applyShippingDiscount` now returns `platformDiscount`; `shippingOptions` returns `PricedFee`).
- One formula, `shippingFunding()` in `ledger/booking.ts`: `delta = booked - (charged + storeDiscount + platformDiscount)`, `debit = max(delta, 0) + storeDiscount`, `margin = max(-delta, 0)`. The platform discount counts as money collected; a rise is absorbed by the full margin first and only the excess beyond it reaches the seller. The T-46 store-funded discount is unchanged (the seller carries it; `shipment_cost_discount_chk` kept).
- `shipment_cost.platform_shipping_discount_idr` (new, `>= 0`) is copied from the frozen financials; `shipping_snapshot_guard` refuses a cost whose store or platform discount differs from them. `shipment_cost_identity_chk` is now `charged + platform_discount + debit = booked + margin`. Together with `shipment_cost_discount_chk` the funding is uniquely determined by the four frozen numbers, so the database itself refuses the old behaviour.
- **Margin semantics**: `platform_shipping_margin_idr` is the GROSS margin (what the collected amount left after the courier, before the platform-funded discount). The platform's net is `margin - platform_discount`. `platform_money_position` class `platform_shipping_margin` now sums `margin - discount` and can be negative when a courier rise exceeds the margin (the platform's loss, shown as such, never a seller debit). Without a discount nothing changes. The example: gross margin 2 000 becomes 1 500, seller debit 0, platform net -500.
- `financial_lines_check` is untouched on purpose: the platform discount is not allocated to order lines (it never touches seller proceeds), so the line sums are unaffected and the check stays exact.
- `verify:ledger` gains `shipment_cost_funding_differs`: it recomputes the funding from the frozen snapshot (discounts, charge, identity, seller debit) independently of the booking code.
- Existing rows: `platform_shipping_discount_idr = 0` (an earlier platform discount was never stored, so no historical order is reinterpreted).
- Console text "tidak pernah dari saldo seller" is now true and says so (a rise is absorbed by the full margin first).

### 2. P3: the courier COD policy is service-aware

`codAllowedCouriers` now returns a reader (`has(estimateKey)`): a policy row whose `service_code` equals the estimate key is the SERVICE-level row and wins; otherwise the COURIER-level row (`service_code = ''`) decides; no row is refused. A row allows COD only when active with `cod_allowed AND return_free`; a refusing or disabled service row overrides an allowing courier row and the reverse. A service row alone no longer allows the whole courier (the old reader allowed every service of a courier as soon as one row did). The editor label says which key to type. The same reader is used by checkout offers and by the booking re-check.

### 3. P3: the key-purpose check reads hex keys

`shippingKeyring` compares the ring with every other key through the same hex-or-base64 reading as `tokenKey` (`INTEGRATION_TOKEN_KEY` is 32 bytes in either encoding).

### 4. P3: "Bukalaris Kirim" copy

- `providerStatusLabel`: a status the product does not know is never echoed; it shows "Pembaruan terbaru dari kurir" (the raw value stays on the shipment row for the operator). The provider timeline (`shipmentTimeline`, used by `/o/[token]` and the seller order page) translates a raw status line and passes every other line through `scrubProviderText` (vendor name replaced, control characters and runs of spaces collapsed, 160 characters at most). The rejected-transition `lastError` no longer carries the raw provider status or the internal reason.
- No internal English text reaches a seller or buyer: `fulfillment.ts` and `mengantar/adapter.ts` and `mengantar/booking.ts` use the Indonesian `PARTNER_DISPATCH_LOCKED_MESSAGE`; `COD_BOOKING_MESSAGE` and the seller order page lost "(Q-17)".
- The repo-wide copy guard the T-48 report listed as DEFERRED: `test/t48-copy-guard.test.ts`. It parses sources with the TypeScript compiler and scans only user-facing strings: scope A = every string literal and JSX text of `apps/web/src` (seller, storefront, checkout, buyer, shared components) for the vendor brands (`mengantar`, `autolaris`) and internal ids (`OPEN-*`, `Q-n`, `D-nn`, `ADR-n`, spec ids such as `BILL-4`, `T-nn`, `master-key`, `fail-closed`); scope B = the message of every `new DomainError(code, message)` and `new MengantarError(code, message)` in the db package plus every string of the mail templates (`ops/jobs/notify.ts`). Allow-list, each with a reason in the file: `(operator)` (staff-only console, names the vendor on purpose), `api/` and every `route.ts` (machine endpoints), tests, and the brand rule (not the internal-id rule) for `shipping/mengantar/*` and `payments/*` messages (provider code, scrubbed by `whiteLabel` at display). A self-test proves the scanner flags every family and ignores comments, identifiers and import specifiers.

### 5. P3: the entry gate sits where bytes leave

- `PartnerClient` no longer trusts the transport's own `mode` label: anything that is not the local `FakePartnerTransport` instance meets `requireMengantarEntryGate()` before the budget is spent.
- New abstract `LivePartnerTransport`: its `send` checks the gate and only then calls `dispatch`. A live transport cannot be written that skips the gate, whatever label it carries and however it is called (there is still no implementation: live transport stays DEFERRED).
- `vitest.config.ts` no longer opens the gate for every test (and sets `unstubEnvs: true`). Tests that drive a stubbed client open it with `openMengantarGate()` (`vi.stubEnv`) per test or describe. A test proves it is closed by default: the process env has no rotation, and no config file, `.env.example`, compose file or package script assigns it.

### 6. P3: leftover batches and the demo reset

- `voidStaleReconciliationBatch(op, batchId, reason)` (owner console action, capability `payouts.reconcile`, no second person, audited with `reconciliation.void_stale`, reason code `stale_batch`): voids a `draft`/`pending_approval` batch that can never be applied: it names no shipping account (made before T-48) or its frozen hash no longer matches (the hash now includes the account). Its lines are freed, so the same COD orders are prepared again (the new batch names the account; its approval binds it). A valid batch is refused (`not_stale`); the ordinary void stays the preparer's. A pre-account draft can no longer be submitted (`legacy_batch`). SA-53 batch page shows "Batalkan batch lama" for a stale batch (`voidStaleBatchAction`).
- `reset_demo_shipping` refuses up front, with a clear message and nothing deleted, when a reconciliation batch or a surviving order references a demo account (it used to fail halfway with an FK error). Batches are never deleted; the message tells the developer to recreate the local demo database. A clean demo store resets; a non-demo store is never touched.

### 7. P3: a margin approval is bound to the rule revision

`shipping_margin_rule.revision` (new). `requestMarginRule` puts the current revision into the approved payload; `applyApprovedMargin` reads it from the approval's own stored payload, locks the rule row, refuses a stale approval (`approval_stale`; a used, rejected or expired approval stays `approval_invalid`), writes `revision + 1` conditionally. The database guard `shipping_policy_guard` requires the approved payload's revision to equal the row's (`approval_binds` containment) and the new revision to be exactly +1, so a bypass of the service is refused too. Callers (UI, e2e, fixtures) are unchanged.

### 8. P3: production noise and the registration budget

- The two Partner schedules (`shipping.account.sweep`, `shipping.account.sync`) are no-ops while no live adapter is installed: one JSON log line (`shipping.partner.skipped`), the job ends `done`, no dead jobs. The owner-queued recovery job still fails visibly (a deliberate action); the credential re-seal schedule is unchanged.
- Per-store cap and back-off: `store_shipping_account.registration_attempts` counts failed provisioning rounds (a rate limit never counts). The retry delay grows 15 min, 30 min, 1 h ... up to 6 h (`partnerRetryDelayMs`). A store whose rounds ended in three 409s (`PARTNER_CONFLICT_ROUNDS_MAX = 3`, at most 9 registrations) stops retrying automatically (claim and sweep skip it) until the owner recovers the account, which resets the counter. SA-07 shows the failed rounds and the stopped state.
- Global daily budget: `PARTNER_REGISTRATION_DAILY_BUDGET = 400` (named, conservative, below the provider's 1 000; shared database counter, Jakarta day) is enforced in `takePartnerBudget`; the provider limit stays a database CHECK.

## Tests (named; `packages/db/test`)

`t48-fix.test.ts` (22): fix 1 (example 10 500/2 000/2 000/11 000 seller debit 0 and margin 1 500; re-quote 9 500; only a rise beyond the full margin reaches the seller; store voucher plus platform discount together; the pure funding sweep over 27 combinations x 121 prices; `verify:ledger`; database refusals), fix 2 (service row alone; refusing/disabled/allowing overrides), fix 3 (hex lower and upper case, base64, other rings; positive controls), fix 5 (closed by default everywhere; a label-lying transport; the live `send`), fix 6 (void and re-prepare end to end, validity refusals, demo reset), fix 7 (service and database), fix 8 (jobs through the real handlers, back-off and cap and recovery, global budget). `t48-copy-guard.test.ts` (4): fix 4. Existing tests adapted, not weakened: priced fees carry `platformDiscount` (`shipping`, `t48-orders`), the platform-discount booking expectation (margin 2 000 gross instead of 0), unknown provider status is neutral (`fulfillment`), health DTO keys (`t48-accounts`: the allowlist plus two operator-only counters), gate-opening tests call `openMengantarGate()`; the 60-requests-a-minute bucket test now sets `refilled_at` to a future instant (it failed twice under heavy machine load because a one-second stall between two statements refilled a token; intent unchanged).

## Doc changes for the conductor

- **BILL-4** (04/05 and `docs/tracks/t48.md` line "BILL-4 funding"): `delta = booked - (charged + store discount + platform discount)`, `debit = max(delta, 0) + store discount`, `margin = max(-delta, 0)` (gross; net platform margin = margin - platform discount, may be negative); identity `charged + platform discount + debit = booked + margin`.
- **DATA-9 / 05-DATA-MODEL**: `order_financials.platform_shipping_discount_idr`, `shipment_cost.platform_shipping_discount_idr` (and the changed identity CHECK), `shipping_margin_rule.revision`, `store_shipping_account.registration_attempts`; `platform_money_position.platform_shipping_margin` is net of the platform discount.
- **ARCH-5**: SA-53 batch page gains the "Batalkan batch lama" action (`voidStaleBatchAction`); SA-07 shows failed provisioning rounds and the stopped state; JOB `shipping.account.sweep` / `sync` are no-ops without a live adapter.
- **IAM-15**: `shipping.margin` approvals carry the rule revision (margin, like the discount and routing settings).
- **PRD / copy**: COD allow-list rows are service-aware (service row wins).
- **t48.md DEFERRED**: remove "Repo-wide source/copy guard test" (done: `t48-copy-guard.test.ts`) and "Demo reset leaves accounts ... batches" (now refuses with a clear message). `t48.md` "Entry gate": the gate is also enforced inside `LivePartnerTransport.send`, and the test config no longer opens it.
- **RUNBOOK** (text to paste):
  - *After deploying T-48, void the leftover COD reconciliation batches.* A COD batch in `draft` or `pending_approval` created before T-48 names no shipping account and its approval hash no longer matches, so it can never be applied (its COD sales simply stay pending; nothing is lost). Open each one in the Owner console (Money, COD reconciliation, batch page), enter a reason and press "Batalkan batch lama". Any operator holding `payouts.reconcile` may do it (no second person: no money moves; it is audited as `reconciliation.void_stale`). Then prepare the same COD orders again from the same carrier evidence, submit, get the second person's approval and apply. A batch that is still valid is refused by this button; its preparer withdraws it with "Batalkan batch".
  - *Partner registrations.* Budget: at most 400 registrations a day (shared by all workers, Jakarta day; the provider's own limit is 1 000). A store that gets three rounds of "e-mail already registered" stops retrying automatically (9 registrations at most) and shows "Percobaan otomatis dihentikan" in SA-07; fix the cause (routing e-mail domain, provider-side account) and press the account recovery button, which resets the counter. Back-off between rounds is 15 min, 30 min, 1 h, up to 6 h. Without a live adapter (production today) the sweep and sync schedules log `shipping.partner.skipped` once per run and do nothing.
  - Test environments: `MENGANTAR_PARTNER_SECRET_ROTATED_AT` / `MENGANTAR_PARTNER_OLD_SECRET_REVOKED` stay unset in every repository config; tests that need the gate open it per test.
- **Local demo**: `reset_demo_shipping` refuses (clear message) for a demo store with a reconciliation batch; recreate the local demo database in that case.

## Folding notes

`0016_t48_fix.sql` assumes the conductor's `0015` (NOT VALID account foreign keys already validated after the backfill). It contains: generated `DROP/ADD CONSTRAINT` for `order_financials_amounts_chk`, `shipment_cost_amounts_chk`, `shipment_cost_identity_chk`; four `ADD COLUMN` (`order_financials.platform_shipping_discount_idr`, `shipment_cost.platform_shipping_discount_idr`, `shipping_margin_rule.revision`, `store_shipping_account.registration_attempts`) plus `shipping_account_attempts_chk`; then the hand-written section: `CREATE OR REPLACE` of `shipping_snapshot_guard`, `shipping_policy_guard`, `reset_demo_shipping` and the view `platform_money_position` (all in place: same names, pinned `search_path = pg_catalog, pg_temp`, no execute grant). **No new table and no new definer function, so the isolation registry is unchanged.** When folding into `0015`: put the four columns into the original `ADD COLUMN`/`CREATE TABLE` statements, replace `shipment_cost_identity_chk` and the two amounts CHECKs where `0015` defines them, and replace (not append) the bodies of the three functions and the view where `0015`/`0014` define them. The Drizzle snapshot `0016_snapshot.json` is generated from the schema files and is dropped with the migration.

Shared files touched (small): `ledger/{schema-ledger,booking,ledger,console,reconciliation,verify}.ts`, `seller/commerce/checkout.ts` (one argument), `shipping/{shipping,policy,fulfillment,copy,accounts,jobs,credentials,schema-accounts,schema-shipping}.ts`, `shipping/mengantar/{partner,adapter,booking}.ts`, `vitest.config.ts`, web: `(operator)/admin/shipping/page.tsx`, `(operator)/admin/money/cod-reconciliation/[batchId]/{page,actions}.tsx`, `(seller)/seller/orders/[id]/page.tsx`.

## Results (observed, this tree; the machine was under heavy shared load, load average 10-13)

- `pnpm lint` clean. `pnpm typecheck` clean (db and web). `pnpm build` ok (run twice: before and after the last service edit).
- `pnpm --filter @bukalaris/db test` (with `--hookTimeout=120000 --testTimeout=120000`, 2 318 s): **65 files, 1 163 tests: 1 162 passed, 1 failed**; the failure was the existing `t48-accounts` "shared database bucket ... 60 requests a minute" timing race (also failed once in an earlier subset run under load, passes alone); after hardening it (see above) `t48-accounts` alone: 18/18 passed. A first full run (2 658 s) also failed `orders` "transition matrix" (120 s timeout under load; alone: 12/12 in 50 s), and three shape expectations that this change legitimately alters (priced fees carry `platformDiscount`, health DTO keys), adapted above. New files: `t48-fix` 22 tests, `t48-copy-guard` 4 tests, all passing.
- Playwright (both viewports, own database and port): `t48.spec.ts` 6/6, `shipping.spec.ts` 4/4, `fulfillment.spec.ts` 4/4 (in a combined 14-test run 12 passed and 2 `fulfillment` cases failed once under load; `fulfillment` alone 4/4 afterwards). A first e2e run found a real message regression of this change (a replayed single-use margin approval answered "stale" instead of "Persetujuan tidak berlaku"); fixed in the service (a used/rejected/expired approval is `approval_invalid`, only an approved-but-outdated one is `approval_stale`), pinned in `t48-fix`.
- `pnpm verify:ledger` against the e2e database after the specs: `OK, no violation` (4 orders; the funding rule is also asserted by `verifyLedger` in every money test).

## Mutation checks (each broken once, named tests failed, files restored SHA-256-verified): 24 of 24 detected, control not detected

Harness outside the repository (one mutation at a time, vitest JSON report). Control M00 (identity replacement) was NOT detected, as required.

| # | Mutation | Failing named test(s) |
|---|---|---|
| M01 | booking delta ignores the platform discount (the reviewed bug) | fix 1: the 10 500/2 000/2 000/11 000 example, re-quote below cost, rise beyond margin, store+platform, formula sweep, ledger, DB refusals (7 of 7) |
| M02 | cost row stores platform discount 0 | six fix-1 tests |
| M03 | checkout does not freeze the platform discount | six fix-1 tests |
| M04 | database identity CHECK without the platform discount | six fix-1 tests |
| M05 | snapshot guard no longer compares the platform discount | fix 1 "the database refuses the old behaviour..." |
| M06 | money position view without the platform discount | fix 1 example and lower re-quote (margin class -500 / 1 000) |
| M07 | `verify:ledger` drops the platform-discount comparison | fix 1 "verify:ledger recomputes the funding..." |
| M08 | `applyShippingDiscount` reports `platformDiscount` 0 | six fix-1 tests |
| M09 | margin apply no longer refuses a stale approval (service) | fix 7 "A and B are both approved..." |
| M10 | database guard without the revision in the approved payload | fix 7 "the database refuses the same overwrite..." |
| M11 | key-purpose check reads other keys as base64 only | fix 3 hex case |
| M12 | COD reader ignores the service code | both fix 2 tests |
| M13 | `providerStatusLabel` echoes the raw status | fix 4 "a raw provider status or timeline line..." |
| M14 | timeline lines not scrubbed | the same test |
| M15 | internal English text back in the partner dispatch refusal | fix 4 "db: no DomainError or MengantarError message..." |
| M16 | client trusts the transport's `mode` label | fix 5 "a transport that merely CALLS itself 'fake'..." |
| M17 | live transport `send` without the gate | fix 5 "every live transport meets the gate inside its own send" |
| M18 | vitest config opens the gate for every test | fix 5 closed-by-default test (and the two above) |
| M19 | a batch without an account is not stale | both fix 6 void/draft tests |
| M20 | `reset_demo_shipping` no longer refuses on a batch | fix 6 demo reset |
| M21 | Partner schedules throw again in production | fix 8 no-op schedules |
| M22 | no per-store cap on repeated 409s | fix 8 back-off/cap/recovery |
| M23 | global daily budget is the provider's 1 000 | fix 8 global budget |
| M24 | fixed 15-minute retry (no back-off) | fix 8 back-off/cap/recovery |

## DEFERRED

- Live Partner transport (`LivePartnerTransport` has no implementation) and everything else already DEFERRED in `t48.md` (owner rotation, OPEN-F9, provider documentation).
- Operator-side copy: the Owner console still names the vendor and OPEN-F9 on purpose (not scanned).
- Console UI check of the "Batalkan batch lama" button and of the SA-07 stopped-state text is by typecheck/lint and the service tests only; no browser spec was added.
