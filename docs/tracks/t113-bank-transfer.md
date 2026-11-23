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

## Named tests (`packages/db/test/t113-bank-transfer.test.ts`, 10)

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

## Open points

- Undecided proofs keep an order awaiting payment (D-36 item 3); the seller sees it on the order.
- The proof upload notifies the owners by e-mail; there is no in-app notification list for sellers yet.
- Doc 17 has no full SC contract for the bank-account list beyond the row of its table ("contract written in T-113"): the screen is SC-32 with the fields above.
- The independent review and the full CI run are still to come.
