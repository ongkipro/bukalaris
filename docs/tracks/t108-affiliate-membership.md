# T-108 — Affiliate membership per store and commission as a seller obligation

## Execution frame

- Date: 2026-11-25.
- Worktree: `/home/ongki/Projects/bukalaris-wt/t108`.
- Branch/base: `task/t108-affiliate-membership` on `b2ce153` (the unmerged T-117 branch, which adds migration `0027`; this task's migration is `0028`).
- Requirement: the `### T-108` block of `docs/TASKS.md` (PR-28; ADR-0015 decisions 1 to 4; D-29, D-31, D-32 C-A3/C-A4/C-A6, D-33). T-109 (payments, statement, arrears, freeze) and T-110 (screens) are not built.
- Authority: local implementation, verification and a local commit on the branch; no push, no deploy, no provider call. Local Postgres 18.6 on 127.0.0.1:5442 (CI uses 17); private databases `bukalaris_t108`, `bukalaris_t108_test`, `bukalaris_t108_e2e`.

## What was built

- **Migration `0028_t108_affiliate_membership`** (`packages/db/drizzle/`): generated tables `affiliate_membership` (store, affiliate, `pending | active | rejected | suspended`, snapshot of the application: display name, up to five channels, note; reason, reviewer, revision; `UNIQUE(store_id, affiliate_id)`) and `affiliate_commission` (one per order, `UNIQUE(order_id)`, FK to the order's snapshot and to the attribution; base, commission, snapshotted hold days; `pending | void | payable | paid | confirmed | disputed`; `delivered_at`/`payable_at`, void reason and time; CHECKs tie the stamps to the states), column `affiliate_seller_policy.auto_approve` (default off). Hand-written `-- ===== T-108` section:
  1. FORCE RLS with the store policy on both tables; grants exactly the registry (app: SELECT on both, UPDATE on four review columns of the membership; platform: SELECT, plus UPDATE on obligations for the release job).
  2. Programme bounds moved to the decided 100–5000 bps (only the 2000 placeholder is replaced); job kind `affiliate.commission.release`.
  3. `affiliate_status_guard`: C-A3 — an account may start `active` only with a verified e-mail.
  4. `affiliate_membership_guard`: state machine, immutable identity, application fields change only with a new application, a review names its reviewer, never deleted (demo reset aside).
  5. `affiliate_apply(store, note, channels)`: definer, affiliate from `app.affiliate_id` only; active account, active store, open programme, not blocked; idempotent for pending/active, re-application from rejected, refused when suspended; one SQLSTATE `BKAF1` for every refusal; auto-approval.
  6. `affiliate_own_memberships()`, `affiliate_own_commissions()`: the affiliate's own rows, no order id.
  7. `affiliate_resolve_core`, `affiliate_code_valid`: only an affiliate with an ACTIVE membership of the store (share-locked with the account) is eligible; a sandbox test order selects nobody.
  8. `affiliate_record_attribution`: writes the attribution and its obligation; base and single-floor commission from the frozen line snapshot; the order's snapshot no longer carries the affiliate.
  9. `affiliate_attribution_guard` (insert): no deduction on the snapshot, an active membership at this moment, not a test order, single floor of the line bases at their frozen rates.
  10. `affiliate_financial_check` (deferred, at COMMIT, every new snapshot): no affiliate and no commission on `order_financials`; line rates only with an attribution, and an attribution only with its equal obligation.
  11. `affiliate_commission_guard`: equal to the attribution on insert; amounts frozen; delivery stamped once on a completed order with `payable_at = delivered_at + hold_days`; `pending → void` only before delivery or strictly before `payable_at`; `pending → payable` only from `payable_at` on; `payable → paid → confirmed | disputed` reserved for T-109; never deleted.
  12. `affiliate_commission_order_sync` (AFTER UPDATE OF status on `order`): `completed` stamps delivery; `cancelled` / `returned` before delivery void.
  13. `digital_grant_affiliate_sync` (T-112) moved onto the obligation: the last grant revoked strictly inside the hold voids it.
  14. `reset_demo_affiliate` also removes memberships and obligations of demo stores.
- **Services** (`packages/db/src/affiliate/`): `membership.ts` (new) — `applyToStore` (RL-AFF-STORE-APPLY, 20 per affiliate and day, before the database), `listOwnMemberships`, `listOwnCommissions`, `listMemberships` (C-A4 projection), `reviewMembership` (approve / reject / suspend, capability `affiliate.blocks.manage`, audited), `listStoreCommissions`; `jobs.ts` — JOB-38 `affiliate.commission.release` (`releasePayableCommissions`, every minute, 500 per run, `SKIP LOCKED`); `referral.ts` — the plan no longer deducts; `seller.ts` — `autoApprove` switch; `accounts.ts` — C-A3 registration; `settings.ts` — decided bounds, `RL_AFF_STORE_APPLY`, `AFFILIATE_RELEASE_BATCH`; `risk.ts` — voided orders read from the obligation too; `schema-affiliate.ts` — the two tables and the column.
- **Checkout** (`seller/commerce/checkout.ts`, attribution hook only): the plan runs in both money modes; the finance is never changed; only the line rates go to the snapshot. `ledger/ledger.ts` `writeOrderFinancials` no longer writes `affiliate_id` (deviation outside the Allowed Paths: one field, the snapshot writer is the only place it was set); `ledger/finance.ts` `withAffiliateCommission` annotated as unused (kept, D-31).
- **Orders**: no TypeScript change — the status hook is the database trigger above (D-38 item 2), so every status writer is covered.
- **Isolation**: registry entries for both tables and six definer functions; T-59 contract GRANT block regenerated from `registryRows()` (+2 lines, the 139 existing lines reproduced byte for byte); `index.ts` export; `demo/seed-demo.ts` lists the two tables with the owner-side affiliate reset (deviation: needed for the demo reset).
- **Docs**: D-38; ARCH-5 JOB-38 row, JOB-26 marked superseded, migration range `0000…0028`; doc 16 RL-AFF-STORE-APPLY and RL-CLICK (store host) rows; T-108 status line; BUILD-LOG entry.

## Decisions (D-38, not settled by ADR-0015)

1. No deduction in either money mode; pre-`0028` attributions keep their deduction and get no obligation (no double charge); T-52's "commission ≤ sale − funded shipping discount" rule dropped with the deduction.
2. Delivery = order `completed` (physical: courier DELIVERED or four-eyes completion; digital-only: payment, same transaction as grant issuance, consistent with ADR-0016 decision 20 and the T-112 trigger). Hook in the database on the order status. At `payable_at` exactly: payable, not voidable.
3. Sandbox order = `order.test_order` (T-105 decision 11); refused in resolver and guard.
4. Membership and obligation are store records; affiliate side through definer functions; application snapshot is the C-A4 projection; review under `affiliate.blocks.manage`; rejected may re-apply (pending, even with auto-approval), suspended may not.
5. Membership gates attribution only (links and click capture unchanged); an ineligible code falls back to a member's click.
6. C-A3: verified e-mail → `active`, otherwise `pending` (T-52 review path kept).
7. Rates: default applies to opted-in products without their own rate (offer model kept, C-A6). Open question for the owner: ADR-0015 decision 2 may mean every product earns at the default.

## Tests

`packages/db/test/t108-membership.test.ts` (named tests of the Done-when in bold):

- membership: apply/review/state machine and C-A4 projection; uniform refusals and auto-approval; RL-AFF-STORE-APPLY; C-A3 registration.
- **"no attribution without active membership: none, pending, rejected and suspended each earn nothing …"**; fallback of an ineligible code; the guard and resolver refuse a non-member whoever writes.
- **"seller order_financials proceeds identical with and without attribution: platform-held COD and seller-owned bank transfer"** (whole snapshot compared, `verifyLedger` clean).
- the database refuses a deducting snapshot and an attribution without its obligation.
- **"one obligation per order under concurrent submits (same request, and different idempotency keys on one cart)"**.
- **"sandbox orders earn nothing: …"** (a real sandbox AutoLaris order of a member's code).
- void on cancel and RTS return, delivery stamp with the snapshotted hold.
- **"void and payable transitions exactly at the boundary: …"** (`payable_at = now()` and `now() + 1 µs` in one transaction; release before delivery refused).
- digital-only: delivery at payment, revoke inside the hold voids, after the hold not.
- **"store A cannot read or change store B's memberships or obligations, affiliate A cannot read affiliate B's, …"**.
- decided bounds; a pre-`0028` attribution keeps its deduction and gets no obligation.

T-52 tests updated to the new model (memberships in the fixtures through the new `member()` helper; assertions on the deduction replaced by the obligation; the shipping-discount ceiling test inverted; bounds tests use the constants): `t52-fixtures.ts`, `t52-checkout.test.ts`, `t52-schema.test.ts`, `t52-click.test.ts`. E2E `apps/web/e2e/t52.spec.ts` likewise (membership row, obligation instead of deduction).

## Mutation checks

Baseline `sha256sum` before the first mutation: `d50e7c63… drizzle/0028_t108_affiliate_membership.sql`, `9279f518… src/affiliate/jobs.ts`, `5588eda1… src/seller/commerce/checkout.ts`, plus `src/ledger/ledger.ts` before M3b. Each mutation ran `vitest run test/t108-membership.test.ts` (fresh test database migrated from the mutated files); every file was restored by copy and `sha256sum -c` reported `OK` for all four after the last one. The full suite below ran on the restored tree.

| # | Mutation (on purpose) | Named test that failed | Result |
|---|---|---|---|
| M1 | Attribute without membership: membership join removed from `affiliate_resolve_core` (code and click) and `affiliate_code_valid`, membership check removed from `affiliate_attribution_guard` | "no attribution without active membership: none, pending, rejected and suspended each earn nothing …" (+ the guard/resolver test and the fallback test) | 3 failed / 14 passed |
| M2 | Release before delivery: `pending → payable` allowed without `payable_at` in `affiliate_commission_guard`, and the job's `payable_at <= now()` filter removed | "void and payable transitions exactly at the boundary: …" (+ the cancel/return/delivery test) | 2 failed / 15 passed |
| M3a | Deduct commission from proceeds in TypeScript only (`withAffiliateCommission` back in `placeOrder`) | "seller order_financials proceeds identical with and without attribution …" — refused by the database (attribution guard / deferred check), every attributed order fails | 11 failed / 6 passed |
| M3b | The full T-52 deduction path back (TypeScript deduction, `affiliate_id` written by `writeOrderFinancials`, both database refusals off) | "seller order_financials proceeds identical with and without attribution …" fails on the assertion itself (`affiliateCommissionIdr: 10000`, `affiliateId: 1` against 0 / null) | 4 failed / 13 passed |

## Populated-copy proof of 0028

The dev database `bukalaris_t108` (at 0027) was first given data: `pnpm db:seed:demo` (4 demo stores, 64 orders) and, with the unmodified pre-T-108 code, toko-a opened at 10 %, one product opted in, two active affiliates and three COD orders with a code (3 T-52 attributions, 8.900 each, deducted from the sale). Then `create database bukalaris_t108_pop template bukalaris_t108`, `alter database … owner to bukalaris_owner`, migrate with `MIGRATION_DATABASE_URL` on the copy (`migrations applied`):

| | before | after |
|---|---|---|
| stores / orders / order_financials / line financials | 6 / 67 / 67 / 126 | 6 / 67 / 67 / 126 |
| affiliates / attributions / ledger entries | 2 / 3 / 14 | 2 / 3 / 14 |
| md5 of every `order_financials` row | `587f78cc…` | `587f78cc…` (unchanged) |
| md5 of every `affiliate_attribution` row | `617f0541…` | `617f0541…` (unchanged) |
| `affiliate_policy` max/min/window/hold/revision | 2000/100/7/3/r1 | 5000/100/7/3/r2 |
| unvalidated constraints | — | 0 |
| obligations / memberships / auto-approve stores | — | 0 / 0 / 0 (no backfill) |

Smoke on the copy with the new services: the first affiliate applied to toko-a, the owner approved, and a COD order with its code recorded attribution and obligation 8.900 (`pending`) with the sale whole (`sale_amount_idr` 89.000, `affiliate_commission_idr` 0); `verifyLedger` → no violation. Copy dropped; the dev database was then migrated to 0028.

## Verification log

All under `heavy-run --lock bukalaris-env`, private databases `bukalaris_t108*`, Postgres 18.6:

- `node scripts/check-system-map.mjs` → `system-map: 109 route files, 133 current rows (126 Implemented)` / `ok` (the first run in the chain failed on the JOB-26 status word "Superseded"; changed to "Retired: superseded by JOB-38" and re-run green). The 19 map-check unit tests passed.
- `pnpm -r lint` → clean; `pnpm -r typecheck` → clean (db + web).
- `pnpm --filter @bukalaris/db test` → **87 files, 2429 tests passed** (370 s), on the restored tree after the mutations. `t108-membership.test.ts` alone: 17 passed.
- `pnpm build` → OK.
- `pnpm --filter @bukalaris/web e2e` (full suite, port 3100, `bukalaris_t108_e2e`) → **307 passed, 6 skipped, 0 failed (26.2 min)**, `t52.spec.ts` included on both projects.
- Populated-copy proof → above.

## Open items

- Independent review pending (R4, money and auth paths).
- Owner question (D-38 item 7): does "default rate with optional override per product" mean every product earns at the default unless excluded? Today a product earns only when opted in (T-52 offer model).
- A link of a non-member still captures clicks (they never earn); T-110 may require membership when a link is created.
- T-109: payment records, the `paid / confirmed / disputed` writers (the guard already allows `payable → paid → confirmed | disputed`), arrears, the frozen programme (refusal in `affiliate_apply` and the resolver), terms acceptance.
- T-110: seller, affiliate and Owner console screens; the affiliate registration flow (C-A3 is enforced in `registerAffiliate` and the database, no screen calls it yet).
- Platform-held stores keep the whole sale in the platform's books while the seller owes the commission outside Bukalaris (D-38 accepted cost).
- `docs/evidence/m1/` baseline PNGs rewritten by the E2E run are noise and are not staged.
