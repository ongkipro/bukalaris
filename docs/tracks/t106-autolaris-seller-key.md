# T-106 — AutoLaris on the seller's key: instruction, status check, callback evidence

Status: **Done locally (2026-11-16); independent review (no blocker, 3 major, 9 minor, 4 nit) fixed and confirmed; confirmation-review items (2 minor, 3 nit) fixed below.** Branch `task/t106-autolaris-seller-key` from `task/t104-provider-accounts` at `85e2ff5`, worktree `bukalaris-wt/t106-autolaris-seller-key`. Not committed, not pushed. Fake AutoLaris accounts only: no AutoLaris host was called, no real key, no deploy.

## Scope and invariants

ADR-0013 sections 3 to 6 and decision 34 (C-P4 for AutoLaris), D-21 (callback is evidence, verify by pull), D-27, D-31 to D-33, doc 16 RL-AUTOLARIS-CB, RL-PROVIDER-CHECK (T-104, unchanged), RL-PAY-RECHECK. The T-49 contract is kept for stores without their own account and for subscription invoices (T-50).

Mode boundary (deliberate ceiling): a store with a `store_payment_account` row is on its own AutoLaris account; every attempt of it is created, checked and settled on that store's key (`attemptAdapter`), never on the platform adapter, and a store that has a row but is not ready offers no QRIS/VA (it never falls back to the platform). A store without a row keeps the T-49 platform path. Removing the platform path for buyer orders (D-31 single mode) belongs to the readiness consumers (T-93, T-107).

Each invariant has a named test in `packages/db/test/t106-autolaris-seller-key.test.ts`:

1. The callback never settles: the route resolves the store from the signed reference (`resolve_payment_attempt_store`), stores the evidence and enqueues a pull; the pull runs on the owning store's key ("callback alone never settles …").
2. Settlement needs the paid code `00`, a status word on the ONE allow-list `AUTOLARIS_PAID` (UNVERIFIED) and the provider amount equal to the attempt total; an unknown word is stored on the observation (`status_word`) for review ("unknown status word never settles …").
3. Store A's attempts are checked with store A's key only ("store A's status check never uses store B's key or the platform key"); the envelope function refuses another store's key for the app AND the platform role.
4. The scheduled check (`payment.status_check`, every minute, `checkSellerPayments`) covers accepted unpaid attempts that are pending or expired less than 24 hours ago, newest first, bounded batches; an attempt whose account cannot be used is pushed back, never blocking the batch ("the scheduled check covers …").
5. One method function (`storePaymentMethods`) feeds the checkout list and the submit check (master switch, readiness incl. the production switch, platform lock, seller exclusion, fee schedule), plus a cheap in-transaction re-check (`assertChannelStillOffered`) ("excluded or locked channel refused at submit …").
6. The fee decision is frozen on the attempt (`fee_bearer`, `fee_rate_version`, `expected_fee_idr`, amounts) and guarded by `payment_attempt_guard` for every role ("fee-bearer amounts frozen …").
7. Retry keeps the old attempt, a late payment of it settles the order, a second settled attempt raises `payment_anomaly` `second_settled`, a payment after close raises `paid_after_close`; no `ledger_entry` and no platform refund for an attempt on the store's own account ("retry keeps the old attempt …").
8. A provider error leaves the order `awaiting_payment` with a retry; the database refuses a retry insert that skips the rules ("a provider error leaves the order pending …").
9. Manual confirmation: owner only (`finance.confirm_payment`, C-P5), reason and evidence, one append-only record per attempt (no UPDATE/DELETE grant, trigger for every role) ("the seller confirms a payment by hand …").
10. No seller key in any attempt, observation, job, audit row, mail, log line, view or fake call log ("canary-key literal scan …").

## Changes

- Migration `packages/db/drizzle/0020_t106_autolaris_seller_key.sql` (built as `0019`, renumbered at integration on top of T-105's `0019_t105_mengantar_seller_key.sql`): generated structure (new tables `payment_manual_confirmation`, `payment_anomaly`, `payment_channel_lock`, `payment_fee_rate`, `payment_production_switch`; `payment_attempt` gains `attempt_no`, `payment_account_id`, `environment`, `fee_bearer`, `fee_rate_version`, `expected_fee_idr`, drops `payment_attempt_order_uq` for `payment_attempt_order_no_uq (store_id, order_id, attempt_no)`, FK to `store_payment_account (store_id, id)`, `payment_attempt_account_chk`, index `payment_attempt_check_idx`; `payment_observation.status_word`; `store_payment_account` gains `enabled`, `excluded_channels`, `fee_bearer`) followed by ONE hand-written section `-- ===== T-106 …`: grants and FORCE RLS policies, append-only triggers, fee-rate version 1 seed (UNVERIFIED starting data) and the switch row (off), `payment_attempt_guard` extended to the new columns, `payment_attempt_insert_guard` with the retry rules, definer `payment_manual_confirmation_guard`, platform EXECUTE on `provider_key_envelope`, platform job kinds, `reset_demo_payments` covering the two new store tables. **Integration note:** T-105 also creates a `0019`; the coordinator renumbers this one to `0020`. Every hand-written statement is inside the T-106 section, so the generated part can be regenerated with `drizzle-kit generate` on top of T-105's snapshot and the section appended unchanged, with ONE manual edit: the generated `payment_attempt_account_fk` line ends in `NOT VALID` (AGENTS.md rule for a foreign key on a populated table; the section validates it in step 9a). The four-eyes row `providers.production_on` is inserted `ON CONFLICT DO NOTHING` and is meant to be shared with T-105's Mengantar switch (same key in `FOUR_EYES_MATRIX` and doc 07).
- `packages/db/src/payments/seller.ts` (new): fake per-key transport `FakeAutoLarisAccounts` (no network; `sellerTransport` refuses wherever the T-104 fake rule does not allow it, there is no live transport), `storeAutoLaris`, `attemptAdapter`, `currentFeeSchedule`, `storePaymentMethods`, `pickStorePaymentChannel`, `assertChannelStillOffered`, `paymentPlan`, `resolveBuyerOrder`, `buyerOrderPayment`, `requestPaymentCheck`, `retryOrderPayment`, seller preferences, `sellerPaymentAttempts`, `sellerRequestPaymentCheck`, `confirmPaymentByHand`, Owner console services only, no screen (`paymentPlatformSettings`, `setPaymentChannelLock`, `publishPaymentFeeRates`, `recordAutoLarisSandboxPass`, `requestAutoLarisProduction` + `setAutoLarisProduction` with four-eyes) and `resealPaymentCredentials`.
- `payments/attempts.ts` (attempt snapshot fields, latest-attempt read, `getPaymentAttempt`, seller settlement without ledger, anomaly helpers, `sellerSettlementEnabled`), `payments/contract.ts` (allow-list classifier, `adviceStatusWord`, versioned `FeeSchedule` replaces the fee constants, `STARTING_FEE_RATES` = seed only, `/submit` profile from the account), `payments/jobs.ts` (instruction, verify and reconcilers on the attempt's adapter; `checkSellerPayments` + `payment.status_check`; `payment.credentials.reseal`; the T-49 observe-only poll excludes seller attempts), `payments/settings.ts` (`AUTOLARIS_PAID`, `AUTOLARIS_FACTS`, limits), `payments/view.ts` (latest attempt, `attemptNo`, `sellerAccount`, `environment`, `retryable`), `payments/provider-accounts.ts` (readiness gap `production_off`), `payments/schema-payments.ts`.
- Web: SC-32 preferences form; new SC-33 `/seller/payments/transactions`; checkout channel list through the store's method function (fee label "Tanpa biaya layanan tambahan" when the seller bears it); confirmation page and `/o/<token>` payment panel (`(checkout)/checkout/payment-actions.tsx`: check now, new instruction, sandbox test-order note); callback route per-reference limit 10 / 10 min.
- Registry entries for the five tables and `payment_manual_confirmation_guard()`, `provider_key_envelope` executable by the platform role, `store_payment_account` platform `SELECT` plus column `UPDATE` on `sealed_key, key_id, sealed_at, key_fingerprint` (`platformColumns`, re-seal); T-59 contract GRANT block regenerated from `registryRows()` (+6 lines: five tables and the column grant).
- Docs: ARCH-5 row SC-33, doc 17 rows for the payment screens and the Owner console provider settings.

## Independent review (2026-11-16) and how each finding was handled

| Finding | Handling |
|---|---|
| MAJOR 1: an envelope that does not open (plain `Error` from `unsealCredential`) escaped `adapterOrNull` and aborted `checkSellerPayments` for every store; the re-seal jammed on the lowest bad row | `adapterOrNull` turns any error into "skip" and logs a code only (`logCode`/`errorCode`: domain and contract codes plus an allow-list of our own credential codes, never a message); the status check wraps each attempt, caches the null adapter per store and environment, and always moves `next_advice_at` forward in `finally`; `resealPaymentCredentials` walks by id, skips a row that does not open (code logged) and returns `{ changed, failed }`. Named test "a key that does not open never stops the status check of other stores, and the re-seal skips that row and goes on"; M4, M4b |
| MAJOR 2: the order page's bare `pay` (`orders.fulfill`, owner and staff) paid an own-account order without a record | `transitionOrder` refuses `pay` with `manual_confirmation_required` when the order has an attempt on the store's own account (deviation: `seller/commerce/orders.ts`), and the invoker trigger `order_seller_payment_guard` refuses, for the application role, `awaiting_payment` → `placed` on such an order without a `payment_manual_confirmation` row (the worker and the owner are not restricted). Named test "the seller's bare pay action is refused …"; M5a, M5b |
| MAJOR 3: `attemptAdapter` compared the account id only; a sandbox attempt could be created or checked on the production key | also refuses when the account's environment differs from the attempt's (`account_changed`). A key replaced within one environment is a recorded ceiling (`// lazy:`): no per-key id survives a ring rotation; its status check finds no bill and never settles. Named test "an attempt is never created or checked on the account's other environment"; M6 |
| Minor: platform-account fallback contradicts D-27 | recorded as "Ceiling T-106-1" in `docs/DECISIONS.md` (dated; revisit with T-93/T-107) |
| Minor: table-wide platform UPDATE on `store_payment_account` | column UPDATE on `sealed_key, key_id, sealed_at, key_fingerprint` only (`sealCredential` also writes `sealed_at`); the registry gained `platformColumns`, `test/isolation-catalog.ts` reads and compares platform column grants (expand and contract), the T-59 GRANT block carries the column grant (regenerated) |
| Minor: production switch self-attested | four-eyes: `requestAutoLarisProduction` (needs the recorded pass) → `decideApproval` by another operator → `setAutoLarisProduction({ enabled: true, approvalId })` consumes it; OFF stays one operator. Action `providers.production_on` (`providers.manage`) in `FOUR_EYES_MATRIX` (deviation: `ops/schema-ops.ts`), doc 07 matrix, doc 05 and the migration seed. Asserted in `switchProductionOn` (self-approval refused, unapproved refused, single use); M9 |
| Minor: retention classes | `payment_manual_confirmation` and `payment_anomaly` registered in `retention_class` with `row_filter false` (financial records kept with the order; the generic purge never deletes them). AutoLaris callback evidence of seller attempts lives in `payment_callback`, whose class already exists (T-49: raw body redacted once the owner records a period) |
| Minor: no test for live settlement staying off | named test "live-mode settlement on a seller key stays off while the paid words are unverified"; M7 |
| Minor: manual-confirmation guard comment vs body | the trigger now also requires `status <> 'paid'`; asserted in "the seller confirms a payment by hand …" (the guard answers 23514 before the unique index); M8 |
| Minor: docs placeholders and screen claim | TASKS outcome and "Executed verification" filled; status says services only, Owner console screen open |
| Minor: fee bearer not in `order_financials` | open point owned by T-107 (below) |
| Minor: gross-up | `AUTOLARIS_FACTS.feeGrossUp` and `sellerBorneFee` UNVERIFIED |
| Nit: fee-rate omission | `publishPaymentFeeRates` copies forward every channel the input does not name; withdraw a channel by locking it. Asserted in "fee-bearer amounts frozen …" |
| Nit: FK on a populated table | generated FK line ends `NOT VALID`, step 9a validates |
| Nit: status-word fallback to `ket` | `AUTOLARIS_FACTS.statusWordPath` UNVERIFIED; only `data.status` can settle |
| Nit: sandbox pass overwritten in place | kept; every recording has its own audit row (doc comment) |

## Confirmation review (2026-11-16) and how each item was handled

All three majors and every minor and nit of the first review were confirmed fixed. New items:

| Item | Handling |
|---|---|
| Minor 1: dead "Tandai sudah dibayar" button for an own-account order | `getOrder` drops `pay` from the actions of an order whose attempt is on the store's own account; the order page shows a link to SC-33 instead (`data-testid="own-account-confirm"`; deviation: `(seller)/seller/orders/[id]/page.tsx`, brand-free copy). Named test (M10) and an E2E assertion in `t106.spec.ts` (link present, button absent) |
| Minor 2: the instruction job turned transient errors into `failed` | only `PERMANENT_ACCOUNT_CODES` (`not_connected`, `production_off`, `account_changed`) end the attempt as failed; anything else (database, no transport, key ring) is thrown before the dispatch fence and retried with backoff. Named test (M11) |
| Nit 3: no test for the outer per-attempt catch | named test with an unserialisable provider answer (the settlement throws a TypeError) next to another store's paid attempt (M12) |
| Nit 4: stale docs | track report "Changes" names the column grant; doc 17 describes the request → approve → switch steps |
| Nit 5: approval not bound to the sandbox pass | the approved payload carries the pass time and the switch revision; a pass recorded (or the switch changed) after the approval voids it. Named test (M13) |

## Provider facts (AutoLaris)

| Fact | State | Source |
|---|---|---|
| Paid status words (`PAID`), paid code `00`, status and amount fields | UNVERIFIED; one allow-list `AUTOLARIS_PAID` (`verified: false`); a live settlement on a seller key additionally waits for `verified` | D-21 K; skill `autolaris-h2h` (Postman snapshot 2026-09-03: Advice mapping unpublished, only `02/PENDING` observed) |
| Fee rates | UNVERIFIED; `payment_fee_rate` version 1 = reference-system starting data | ADR-0013 decision 19 |
| Expiry time zone | UNVERIFIED; sent as WIB (`expiryStampWib`) | skill: "timezone resmi belum dipublikasikan" |
| Sandbox origin | UNVERIFIED; the official documentation names only `https://api-h2h.autolaris.com`; `AUTOLARIS_SANDBOX_ORIGIN` stays unset | skill reference `h2h-api.md` |
| IP allow-list | **None — owner statement (D-33, 2026-11-15)**, not checked by an agent against the provider. Conflict: the documentation snapshot says "API Key production dan whitelist maksimal 5 IP". To be proven at the first sandbox call (opt-in, owner approval) before the production switch | D-33; skill `h2h-api.md` "Production" |
| Payment-only `/submit` shape (`courir_id: 1`, account area ids) | UNVERIFIED (C-P8), per-account agreement | skill `payment-gateway.md` |
| Fee charged on a seller-borne bill (does AutoLaris add `biaya_admin` to `grand_total`?) | UNVERIFIED; `parseSubmit` still requires the provider total to equal the attempt total, so a mismatch fails closed | — |

## Mutation checks

Each mutation applied to the code by a script, the T-106 file (15 tests) run against `bukalaris_t106_test`, the file restored and its sha256 compared with the value before (all `hash-ok`), then a control run: 15/15 green.

| # | Invariant | Mutation | Named test that failed (plus collateral) |
|---|---|---|---|
| M1 | settle from the callback | `acceptPaymentCallback` also records the callback body as a paid inquiry in its transaction (`callback.ts`) | "callback alone never settles: …" (+ "canary-key literal scan …", whose flow then finds the attempt already paid) |
| M2 | accept an unlisted status word | `classifyAdvice` accepts any non-empty word with the paid code (`contract.ts`) | "unknown status word never settles: …" (+ canary scan, same reason) |
| M3 | check with the platform key | `attemptAdapter` always returns the platform adapter (`seller.ts`; instruction AND check) | "store A's status check never uses store B's key or the platform key" and 7 more (instruction on the store's key, callback, word, window, retry, provider error, recheck) |
| M3b | check with the platform key, status check only | `checkSellerPayments` pulls with the platform adapter (`jobs.ts`) | "store A's status check never uses store B's key or the platform key" (+ word, window, retry tests) |

Review-fix mutations (same procedure, the file then has 19 tests; control after restore 19/19, every file `hash-ok`):

| # | Invariant | Mutation | Named test that failed |
|---|---|---|---|
| M4 | an unopenable key never aborts the status check | `adapterOrNull` rethrows non-domain errors (`jobs.ts`) | "a key that does not open never stops the status check of other stores, and the re-seal skips that row and goes on" (+ "an attempt is never created or checked on the account's other environment") |
| M4b | the re-seal skips a bad row | the re-seal rethrows at a row that does not open (`seller.ts`) | "a key that does not open never stops …" |
| M5a | no bare pay for an own-account order (service) | the `transitionOrder` check disabled (`orders.ts`) | "the seller's bare pay action is refused …" |
| M5b | no bare pay for an own-account order (database) | `order_seller_payment_guard` condition `IF false AND …` (migration 0020) | "the seller's bare pay action is refused …" |
| M6 | an attempt stays in its environment | `attemptAdapter` without the environment comparison (`seller.ts`) | "an attempt is never created or checked on the account's other environment" |
| M7 | no live settlement while the words are unverified | `sellerSettlementEnabled` returns true for live (`attempts.ts`) | "live-mode settlement on a seller key stays off while the paid words are unverified" |
| M8 | no manual confirmation of a provider-paid attempt | the guard without `a.status <> 'paid'` (migration 0020) | "the seller confirms a payment by hand …" |
| M9 | production ON needs a consumed second-operator approval | the approval requirement and `consumeApproval` skipped (`seller.ts`) | "excluded or locked channel refused at submit …" and "an attempt is never created or checked on the account's other environment" (both drive `switchProductionOn`) |

Confirmation-review mutations (the file then has 23 tests; control 23/23, every file `hash-ok`):

| # | Invariant | Mutation | Named test that failed |
|---|---|---|---|
| M10 | the order page offers no bare pay for an own-account order | `getOrder` returns `allowedActions` unfiltered (`orders.ts`) | "the order page offers no bare pay action for an order on the store's own account, and still does for a platform-account order" |
| M11 | a transient account error lets the instruction job retry | the instruction handler marks every account error failed (`jobs.ts`) | "a transient failure while opening the store's account leaves the instruction job to retry; a permanent one ends the attempt as failed" |
| M12 | one throwing settlement never stops the batch | the per-attempt `catch` of `checkSellerPayments` removed (`jobs.ts`) | "an attempt whose settlement throws never stops another store's attempt in the same batch" |
| M13 | the production-ON approval is bound to the recorded pass | the approval payload without pass time and revision (`seller.ts`) | "a production-ON approval is bound to the recorded sandbox pass: a pass recorded after the approval voids it" |

## Migration proof on a populated copy

`create database bukalaris_t106_copy template bukalaris` (dev database: 6 stores, 64 orders, at migration 0009); migrated to 0018 with a journal copy that stops there; 24 platform-account payment attempts and their creation events inserted for the 24 `manual_transfer` orders; then 0019 applied: 20 migrations, stores 6, orders 64, attempts 24, events 24 unchanged; every attempt `attempt_no 1`, `fee_bearer buyer`, no account; every constraint of the schema `convalidated` (0 not validated), the new FK/CHECK/UNIQUE constraints validated, `payment_manual_confirmation`, `payment_anomaly`, `store_payment_account` with RLS enabled and forced, fee-rate version 1 (7 rows), switch row off, the old one-attempt unique gone. On the copy the real services ran: a ready sandbox account (seller bears the fee, OVO excluded) on demo store 7; `checkoutPaymentChannels` as `bukalaris_app` → `VABCA,QRIS,VABNI`, bearer seller, version 1; `placeOrder` as the app role → attempt 1 accepted on the store's own key (1 submit on the store account, 0 platform calls), `admin_fee_idr 0`, `expected_fee_idr 6500`; `checkSellerPayments` as `bukalaris_platform` → 1 checked, order `placed`, 0 ledger rows; a retry insert on a legacy platform attempt → refused `23514`. Copy dropped.

## Executed verification

Environment: own databases `bukalaris_t106`, `bukalaris_t106_test`, `bukalaris_t106_e2e`; E2E port 3900; public placeholders only (no `.env`). Every heavy command under `heavy-run --lock bukalaris-env`.

| Gate | Command | Result |
|---|---|---|
| Neighbours before the review | `vitest run t49-payments rls t104-provider-accounts`; then `t106 rls-contract privacy t50-payments` | 119/119; 53/53 |
| Mutations M1 to M3b | script: mutate, run `t106-autolaris-seller-key.test.ts`, restore (sha256), control | each named test failed; control 15/15 |
| Review fixes | `vitest run t106 rls rls-contract capabilities retention orders t49-payments`, then `capabilities capabilities-governance t62-routes` (after the doc 07 matrix row) and `t48-copy-guard t65-literal-scan` (after removing the brand from buyer copy, the orders message and the `observation`-as-`vat` line) | 192/193 then fixed (four-eyes matrix doc row missing) → 69/69, 16/16 |
| Mutations M4 to M9 | same script | each named test failed; control 19/19 |
| E2E T-106 alone (after a locator fix in the spec) | `playwright test e2e/t106.spec.ts e2e/t49.spec.ts --project=mobile-320 --project=desktop` | 8 passed |
| Full gate (after the first review) | `pnpm verify` | **exit 0**: system map ok (105 route files, 127 rows); lint, typecheck clean; DB 78 files / 1470 tests passed; build ok; E2E 273 passed / 2 skipped (30.1 min) |
| Confirmation-review fixes | `vitest run t106 orders t48-copy-guard`; mutation script M10–M13 | 39/39; each named test failed, control 23/23 |
| Final full gate | `pnpm verify` (log `verify-t106-final4.log`) | system map ok; lint, typecheck clean; **DB 78 files / 1474 tests passed**; build ok; **E2E 272 passed / 1 failed / 2 skipped** (28.8 min), `t106.spec.ts` green at both projects (now also asserts the order page link and the absent pay button). Failure: `[desktop] checkout2.spec.ts:150` "order submission is rate limited per cart …": `getByLabel('Nama')` still held the value 5 s after a COD submit (form reset under load), a COD path T-106 does not touch. Re-run alone: `playwright test e2e/checkout2.spec.ts --project=mobile-320 --project=desktop` 8 passed (the failing case 2.1 s and 3.7 s); a load-timing flake, not a T-106 regression |

Earlier full runs, for the record: one before the review stopped at the DB stage on `t48-copy-guard` (provider name in three buyer strings) and `t65-literal-scan` (`payment_observation_word_chk` on one line: "observation" contains "vat"); both fixed. One run was killed by the 08:25 power outage. One run after the review fixes failed `t48-copy-guard` (provider name in the new `orders.ts` message) and was stopped; one reached E2E and failed `t106.spec.ts` on a locator (`getByTestId("transactions-link").getByRole("link")`, the test id is on the link itself); fixed and re-run as above.

Rendered evidence (opened and checked at 320 px: single column, no clipping, no horizontal scroll; `evidence()` also asserts no overflow and no CSP violation): `docs/evidence/m1/{mobile-320,desktop}-t106-{preferences,checkout-channels,confirmation,order-status-expired,order-status-retry,transactions}.png`. Before hand-off the rewritten tracked baselines were restored (`git checkout -- docs/evidence`); the twelve new T-106 PNGs stay untracked for the coordinator to keep or drop.

## Deviations (outside the Allowed Paths, each minimal)

- `packages/db/src/seller/commerce/checkout.ts`: `checkoutPaymentChannels(exec, storeId, adapter)` delegates to the payments method function; `placeOrder` picks the channel through it, re-checks it in the transaction and spreads the frozen `paymentPlan` into the attempt (T-105 also edits this file: expect a small merge).
- `packages/db/src/platform/scoped.ts`: capability `finance.confirm_payment` (owner), C-P5.
- `packages/db/src/demo/seed-demo.ts`: the two new append-only store tables join `PAYMENT_TABLES` (removed by the owner-side `reset_demo_payments`, never by the platform delete loop).
- `packages/db/src/seller/commerce/orders.ts`: `transitionOrder` refuses the bare `pay` for an own-account order and `getOrder` no longer offers it (review finding 2, confirmation item 1); `apps/web/src/app/(seller)/seller/orders/[id]/page.tsx`: link to SC-33 for such an order.
- `packages/db/src/ops/schema-ops.ts`: four-eyes row `providers.production_on`; `docs/07-IAM-RBAC-ABAC.md` matrix row and `docs/05-DATA-MODEL.md` key list; `docs/DECISIONS.md` Ceiling T-106-1.
- `packages/db/test/isolation-catalog.ts`, `test/rls.test.ts`: platform column grants read and compared.
- `packages/db/src/index.ts`: one export line for the T-106 services (the opened key and the transport stay internal).
- `packages/db/src/platform/isolation-registry.ts`, `drizzle-pending/t59-contract.sql`: in the Allowed Paths by the brief.
- `apps/web/src/app/(checkout)/checkout/page.tsx` and `confirmation/page.tsx`, `(public-services)/o/[token]/*`: allowed for method list, instruction and retry.
- Tests outside the new file: `t49-payments.test.ts` adapted to the versioned fee schedule and the store-aware channel function.

## Open points

- The Owner console screen for locked channels, fee rates and the production switch is not built (`(operator)/**` is outside the Allowed Paths); the services, capability checks and audit rows exist and are tested.
- T-107: `order_financials` keeps one `expected_gateway_fee_idr`; the fee bearer frozen in `order_financials` (decision 18; it is frozen on the attempt today) and the test-order marker on the order itself (the attempt carries `environment`).
- A key replaced within one environment keeps the account id; in-flight attempts of the old key are not detected as foreign (ceiling above).
- The Owner console screen for the four-eyes production switch request/approve flow is not built (services only).
- No live AutoLaris transport and no opt-in sandbox run: decision 34's recorded sandbox pass is a manual Owner console step once the sandbox origin, the paid words and the IP statement are confirmed.
- Anomalies are shown on SC-33; no e-mail to the owners yet.
- Retry is limited by RL-PAY-RECHECK (shared counter with check now); doc 16 names no separate retry limit.
