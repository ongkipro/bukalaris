# T-113 — Bank transfer to the seller's own account

- Task: `docs/TASKS.md` T-113 (PR-5, Risk R4). Branch `task/t113-bank-transfer` from `main` `20c0b3f`.
- Sources: ADR-0013 section 10 (decisions 35 to 39a) and decisions 14, 24; D-31, D-32, D-33; ADR-0005; doc 16 RL-PROOF-UPLOAD; decisions of this task: D-36.
- No provider call, no bank check, no deploy. Everything runs locally.

## What was built

| Area | Change |
|---|---|
| Migration `0023_t113_bank_transfer.sql` | Generated: `payment_method` value `bank_transfer` (`order_payment_chk`), tables `store_bank_account`, `store_bank_transfer`, `order_bank_transfer`, `payment_proof`, `bank_transfer_confirmation`. Hand-written `-- ===== T-113`: `store_money_mode` counts bank accounts (D-36) and the cut-over guard covers them; FORCE RLS and grants; guards `store_bank_account_guard` (owner step-up consumed in the transaction, five listed, removal stamp only, no edit or delete), `order_bank_transfer_guard`, `payment_proof_guard` (sent only for an unpaid bank-transfer order, decided once, files purged once), `bank_transfer_confirmation_guard`, `order_bank_transfer_paid_guard` (decision 38 for every role); append-only triggers; retention classes and the 90-day `payment_proof` period (D-33); job kind `bank_transfer.expire`; demo reset |
| Services `packages/db/src/payments/bank-transfer.ts` | `bankTransferState` (the one readiness rule), `addBankAccount`, `removeBankAccount`, `setBankTransferSettings` (owner, step-up, audit with bank and last four digits only), `freezeBankTransfer` / `assertBankTransferOffered` (checkout), `buyerBankTransfer`, `uploadPaymentProof` (RL-PROOF-UPLOAD 6/h per order and 20/h per IP, 1 to 3 images, 3 MB each, type by content), `buyerProofFile`, `sellerBankTransferOrder`, `sellerProofFile`, `confirmBankTransfer`, `rejectPaymentProof`, `expireBankTransferOrders` (scheduled), `purgeProofFiles` (cleanup) |
| Private store `packages/db/src/payments/proof-store.ts` | `PRIVATE_MEDIA_DIR` (required in production), keys `<store id>/<uuid>.<ext>`, `proofResponse` (attachment, `default-src 'none'; sandbox`, `no-store`) |
| Checkout and orders | `placeOrder` accepts `bank_transfer` only when the store has it on and lists an account (before and inside the transaction), freezes the accounts and expiry; seller-owned snapshot with no fee; `checkoutPaymentChannels.bankTransfer`; the bare "pay" is refused for a bank-transfer order (service, page actions, database) |
| Readiness | `storeReadiness` and `sellerProviderAccounts` report `bankTransfer`; it counts for `canOpen` (decision 14) |
| E-mail | the buyer's order mail lists the frozen accounts, the exact total and the deadline; the owner's mail says to confirm after checking the bank statement |
| Web | SC-32 bank accounts (add and remove with the 6-digit code, switch, payment window); checkout option; SF-08 instruction and the link to the order-status page; SF-11 instruction, proofs, upload; seller order page (SC-13) proofs (finance role), reject and confirm forms; download routes HTTP-34 (buyer, signed link) and HTTP-35 (seller finance role); `proxy.ts` leaves the downloads' own CSP in place |
| Docs | ARCH-5 rows SC-13, SC-32, SF-08, SF-11, JOB-01, JOB-02, HTTP-34, HTTP-35; D-36; `DEPLOY-COOLIFY.md` and `RUNBOOK.md` (`PRIVATE_MEDIA_DIR`); `.env.example` |

## Named tests (`packages/db/test/t113-bank-transfer.test.ts`, 12)

1. "accounts are listed and removed by the owner with a fresh step-up, audited, at most five, never edited or deleted; staff and a missing proof are refused"
2. "store A can neither read nor change store B's accounts; a listed account makes the store seller_owned (D-36) and counts as a ready prepaid method"
3. "the method is absent and refused without an account or while switched off; a direct submit to a store without one is refused"
4. "an order by bank transfer freezes the listed accounts and the end of the payment window; the bill is the exact order total with no fee"
5. "no path other than the seller's confirmation makes the order paid: not an upload, not the bare pay, not the database for any role"
6. "the seller confirms with a reason and the proof looked at: one append-only record, the proof accepted, the order paid; a second confirmation changes nothing; staff is refused"
7. "a non-image, an oversized file, more than three files, a second upload while one waits and a burst over RL-PROOF-UPLOAD are refused and store nothing; a rejected proof allows a new upload"
8. "a proof is read only through its own order's signed link or by the store's finance role: another buyer's link, store A's finance role and staff get nothing"
9. "an unpaid order past its payment window is cancelled and its stock returned; one with a proof waiting for the seller is kept"
10. "retention deletes the proof files of an order closed longer ago than the period and keeps the proof row and the confirmation record"
11. "the window bounds the upload, a decision needs a waiting order, and one step-up proof authorises one account change" (review)
12. "the database keeps a bank-transfer order's method and start state, and a failed upload leaves no file behind" (review)

E2E `apps/web/e2e/t113.spec.ts` (mobile-320 and desktop): bank account on the payments screen, checkout by bank transfer, account and exact total on the confirmation, proof upload on the signed page (order unchanged), the buyer's download is a sandboxed attachment, the public media route answers 404 for the proof, the seller downloads it and confirms with a reason, the buyer sees the order paid.

## Mutation checks

Each mutation applied in place, the named test run (the test database is re-migrated by every run, so a migration edit is live), the file restored and `sha256sum -c` passed.

| # | Invariant broken | Change | Named test that failed |
|---|---|---|---|
| M1 | offer the method without an account (Done-when mutation 1) | `bankTransferState`: `ready: enabled` | 3 ("expected true to be false") |
| M2 | mark paid without a confirmation record (Done-when mutation 2) | migration `0023`: `order_bank_transfer_paid_guard` `WHEN (false)` | 5 ("expected 'allowed' to be '42501'") |
| M3 | serve a proof from the public route (Done-when mutation 3) | storefront media route serves a proof id through the platform pool; rebuilt | E2E `t113.spec.ts` desktop ("Expected: 404, Received: 200") |
| M4 | a proof readable through another order's link | `proofFile` without the order filter | 8 ("expected { file … } to be null") |

## Migration proof on a populated copy

`create database bukalaris_t113_pop template bukalaris owner bukalaris_owner` (dev database seeded by `db:seed` and `db:seed:demo` at `0021`: 6 stores, 64 orders, 64 snapshots, 14 ledger entries). Migrated as `bukalaris_owner` to `0023` (24 journal rows): counts unchanged, no unvalidated constraint, the five new tables with RLS enabled and forced, all stores still `platform_held`, `payment_proof` period 90, the six guard triggers present. In rolled-back transactions: a bank account with a consumed step-up proof on store 1 (no platform money) made it `seller_owned`; on store 3 (platform ledger balance) it was refused with "money_cutover: … platform money in flight: balance". Copy dropped.

## Executed verification (this device: Postgres 18.6 unpacked in the user's home, Playwright Chromium in the user cache; CI uses Postgres 17)

- `pnpm map:check` ok (109 route files, 132 rows); `pnpm lint`, `pnpm typecheck` clean; `pnpm build` ok.
- T-113 file 10/10; related files (demo, T-104, T-47, RLS, contract) green after the fixture updates below.
- E2E `t113.spec.ts` at mobile-320 and desktop: 2 passed. Rendered evidence opened: `docs/evidence/m1/{mobile-320,desktop}-t113-{seller-bank-accounts,checkout-bank-transfer,confirmation-bank-transfer,order-status-proof-sent,seller-order-proof,order-status-paid}.png`. The desktop seller order page review led to two fixes: the money block no longer names AutoLaris or a gateway fee for a bank-transfer order, and the deadline no longer reads "WIB WIB".
- Tests outside the new file: `t104-provider-accounts.test.ts` (`storeReadiness` now reports `bankTransfer`); the demo reset lists the new tables (`seed-demo.ts`, `reset_demo_payments`).

## Independent review (2026-11-23) and how each finding was handled

Reviewer: Antigravity CLI (`agy`) through `ai-ask`, read-only, the change attached in three parts (Codex: 401, not logged in; Claude: weekly limit until 2026-11-25). Verdict on each part: CHANGES REQUIRED, no blocker. Findings were checked against the code before acting.

| Part | Finding | Handling | Evidence |
|---|---|---|---|
| A major | the paid guard covered only `awaiting_payment -> placed` on UPDATE | `order_bank_transfer_paid_guard` now runs on INSERT and on UPDATE of status or method: a bank-transfer order starts awaiting payment, keeps its method, and leaves awaiting payment other than by cancellation only with the confirmation (the state machine of `order_status_guard` already allowed only `placed` or `cancelled`) | test "the database keeps a bank-transfer order's method and start state …" |
| A minor | a proof could be decided after the order left awaiting payment, or rejected while a confirmation names it | `payment_proof_guard` refuses both; `rejectPaymentProof` locks the order and needs it awaiting payment | test "the window bounds the upload, a decision needs a waiting order …" |
| A minor | one step-up proof could list or remove several accounts in one transaction | unique `step_up_ref`, partial unique `removal_step_up_ref` | same test (23505) |
| A minor | `PRIVATE_MEDIA_DIR` whitespace, relative or overlapping `MEDIA_DIR` | trimmed; absolute required in production; refused when it overlaps the public store | `proof-store.ts` |
| A minor | `proofResponse` took any type | allow-list of the three image types | `proof-store.ts` |
| A minor | reasons of spaces only passed the database checks | `btrim` in both checks (migration regenerated) | migration `0023` |
| A nit | file modes, index for the purge | files `0600`, directories `0700`; index not added (the purge reads at most 200 rows a day) | `proof-store.ts` |
| B major | expiry race: a proof sent between the scan and the lock | re-checked under the order lock (proof waiting, confirmation, expiry) | `expireBankTransferOrders` |
| B major | upload after the window kept the stock reserved | the upload needs `expires_at > now()`; `canUpload` follows it | test "the window bounds the upload …" (mutation: check removed → "expected 'ok' to be 'window_closed'") |
| B major | files of a failed upload stayed on disk | written keys removed on failure (`ctx.remove`) | test "… a failed upload leaves no file behind" (mutation: cleanup skipped → "expected [] to have a length of 1") |
| B minor | audit subject kind always `store_bank_account` | `order` for confirm and reject, `store` for settings | `bank-transfer.ts` |
| B minor | first settings save raced to a unique violation | `onConflictDoNothing` then `conflict` | `bank-transfer.ts` |
| B minor | one failing order or file stopped the whole sweep | per item, logged with codes only | `bank-transfer.ts` |
| B weakened | the per-IP limit is skipped without a client IP | kept: the same rule as RL-PAY-RECHECK; the web action always passes the IP | — |
| C major | proxy CSP exception unanchored and lower-case only | anchored to the two routes, case-insensitive UUID | `proxy.ts` |
| C major | body limit and buffering | the body limit is already 11 MB (`next.config.ts`); the action now refuses more than three files or a file over 3 MB before reading any | `o/[token]/actions.ts` |
| C minor | raw token in the redirect | `encodeURIComponent` | same file |
| C minor | download error handling | both routes map only `DomainError` to 404; the seller route refuses a non-positive id | route files |
| C nit | 404 without `nosniff` | added with `text/plain` | route files |

## Open points

- Undecided proofs keep an order awaiting payment (D-36 item 3); the seller sees it on the order.
- The proof upload notifies the owners by e-mail; there is no in-app notification list for sellers yet.
- Doc 17 has no full SC contract for the bank-account list beyond the row of its table ("contract written in T-113"): the screen is SC-32 with the fields above.
- The full CI run is still to come.
