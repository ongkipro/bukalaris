# T-108 — Affiliate membership per store and commission as a seller obligation

## Execution frame

- Date: 2026-11-25.
- Worktree: `/home/ongki/Projects/bukalaris-wt/t108`.
- Branch/base: `task/t108-affiliate-membership`, first built on `b2ce153` (the then unmerged T-117 branch), rebased by the coordinator onto `origin/main` `ebbf546` (T-117 merged; first commit now `a67e9af`). This task's migration is `0028`.
- Requirement: the `### T-108` block of `docs/TASKS.md` (PR-28; ADR-0015 decisions 1 to 4; D-29, D-31, D-32 C-A3/C-A4/C-A6, D-33). T-109 (payments, statement, arrears, freeze) and T-110 (screens) are not built.
- Authority: local implementation, verification and a local commit on the branch; no push, no deploy, no provider call. Local Postgres 18.6 on 127.0.0.1:5442 (CI uses 17); private databases `bukalaris_t108`, `bukalaris_t108_test`, `bukalaris_t108_e2e`.

## What was built

- **Migration `0028_t108_affiliate_membership`** (`packages/db/drizzle/`): generated tables `affiliate_membership` (store, affiliate, `pending | active | rejected | suspended`, snapshot of the application: display name, up to five channels, note; reason, reviewer, revision; `UNIQUE(store_id, affiliate_id)`) and `affiliate_commission` (one per order, `UNIQUE(order_id)`, FK to the order's snapshot and to the attribution; base, commission, snapshotted hold days; `pending | void | payable | paid | confirmed | disputed`; `delivered_at`/`payable_at`, void reason and time; CHECKs tie the stamps to the states), column `affiliate_seller_policy.auto_approve` (default off). Hand-written `-- ===== T-108` section:
  1. FORCE RLS with the store policy on both tables; grants exactly the registry (app: SELECT on both, UPDATE on four review columns of the membership; platform: SELECT, plus UPDATE on obligations for the release job).
  2. Programme bounds moved to the decided 100–5000 bps (only the 2000 placeholder is replaced); job kind `affiliate.commission.release`.
  3. `affiliate_status_guard`: C-A3 (D-38 C) — an account is inserted only `active` and only for a verified e-mail; the column default is `active` (generated). Existing `pending` rows untouched.
  4. `affiliate_membership_guard`: state machine, immutable identity, application fields change only with a new application, a review names its reviewer (never a `system:` one; that is written only by the auto-approval insert), never deleted (demo reset aside).
  5. `affiliate_apply(store, note, channels)`: definer, affiliate from `app.affiliate_id` only; active account, active store, open programme, not blocked; idempotent for pending/active, re-application from rejected, refused when suspended; one SQLSTATE `BKAF1` for every refusal; auto-approval.
  6. `affiliate_own_memberships()`, `affiliate_own_commissions()`: the affiliate's own rows, no order id.
  7. `affiliate_resolve_core`, `affiliate_code_valid`: only an affiliate with an ACTIVE membership of the store (share-locked with the account) is eligible; a sandbox test order selects nobody.
  7b. `affiliate_line_rate` (D-38 B): every published product of an open store earns the default; an offer row is the override or (paused/withdrawn) an exclusion.
  8. `affiliate_record_attribution`: writes the attribution and its obligation; base and single-floor commission from the frozen line snapshot; the order's snapshot no longer carries the affiliate.
  9. `affiliate_attribution_guard` (insert): no deduction on the snapshot, an active membership at this moment, not a test order, single floor of the line bases at their frozen rates.
  10. `affiliate_financial_check` (deferred, at COMMIT, every new snapshot): no affiliate and no commission on `order_financials`; line rates only with an attribution, and an attribution only with its equal obligation.
  11. `affiliate_commission_guard`: equal to the attribution on insert; amounts frozen; delivery stamped once on a completed order with `payable_at = delivered_at + hold_days`; `pending → void` only before delivery (D-38 A); `pending → payable` only from `payable_at` on; `payable → paid → confirmed | disputed` reserved for T-109; never deleted.
  12. `affiliate_commission_order_sync` (AFTER UPDATE OF status on `order`): `completed` stamps delivery; `cancelled` / `returned` before delivery void.
  13. `digital_grant_affiliate_sync` (T-112) dropped with its trigger (D-38 A): nothing after delivery voids an obligation.
  14. `reset_demo_affiliate` also removes memberships and obligations of demo stores.
- **Services** (`packages/db/src/affiliate/`): `membership.ts` (new) — `applyToStore` (RL-AFF-STORE-APPLY, 20 per affiliate and day, before the database), `listOwnMemberships`, `listOwnCommissions`, `listMemberships` (C-A4 projection), `reviewMembership` (approve / reject / suspend, capability `affiliate.blocks.manage`, audited), `listStoreCommissions`; `jobs.ts` — JOB-38 `affiliate.commission.release` (`releasePayableCommissions`, every minute, 500 per run, `SKIP LOCKED`); `referral.ts` — the plan no longer deducts; `seller.ts` — `autoApprove` switch; `accounts.ts` — C-A3 registration; `settings.ts` — decided bounds, `RL_AFF_STORE_APPLY`, `AFFILIATE_RELEASE_BATCH`; `risk.ts` — voided orders read from the obligation too; `schema-affiliate.ts` — the two tables and the column.
- **Checkout** (`seller/commerce/checkout.ts`, attribution hook only): the plan runs in both money modes; the finance is never changed; only the line rates go to the snapshot. `ledger/ledger.ts` `writeOrderFinancials` no longer writes `affiliate_id` (deviation outside the Allowed Paths: one field, the snapshot writer is the only place it was set); `ledger/finance.ts`: `withAffiliateCommission` and the engine's commission input deleted (review follow-up).
- **Orders**: no TypeScript change — the status hook is the database trigger above (D-38 item 2), so every status writer is covered.
- **Isolation**: registry entries for both tables and six definer functions (and `digital_grant_affiliate_sync()` removed); T-59 contract GRANT block regenerated from `registryRows()` (+2 lines, the 139 existing lines reproduced byte for byte); `index.ts` export; `demo/seed-demo.ts` lists the two tables with the owner-side affiliate reset (deviation: needed for the demo reset).
- **Docs**: D-38; ARCH-5 JOB-38 row, JOB-26 marked superseded, migration range `0000…0028`; doc 16 RL-AFF-STORE-APPLY and RL-CLICK (store host) rows; T-108 status line; BUILD-LOG entry.

## Decisions (D-38)

Owner-delegated, 2026-11-25 (final): **A** no void after delivery (grant revoke, refund, redaction never void; correction is T-109); **B** the store default applies to every product, an offer is the override or an exclusion (catalog projection unchanged, discovery deferred); **C** an affiliate account exists only after e-mail verification and is `active` (no `pending` accounts are created); **D** ceiling: legacy pre-`0028` deducted attributions have no payment path (T-118 decides).

Engineering decisions: no deduction in either money mode (pre-`0028` attributions keep theirs and get no obligation; the T-52 shipping-discount ceiling is dropped with the deduction); delivery = order `completed` (digital-only: payment, same transaction as grant issuance), hook as a database trigger on order status, at `payable_at` exactly payable; sandbox = `order.test_order`; membership and obligation are store records read by the affiliate through definer functions, the application snapshot is the C-A4 projection, review under `affiliate.blocks.manage`, rejected may re-apply (reviewed again even with auto-approval), suspended may not; membership gates attribution only; bounds 100–5000 bps.

## Tests

`packages/db/test/t108-membership.test.ts` (named tests of the Done-when in bold):

- membership: apply/review/state machine and C-A4 projection; uniform refusals and auto-approval, re-application after a rejection with auto-approval on (pending), a seller cannot write a `system:` reviewer; RL-AFF-STORE-APPLY; C-A3 registration (unverified refused, no `pending` insert).
- **"no attribution without active membership: none, pending, rejected and suspended each earn nothing …"**; fallback of an ineligible code; the guard and resolver refuse a non-member whoever writes.
- **"seller order_financials proceeds identical with and without attribution: platform-held COD and seller-owned bank transfer"** (whole snapshot compared, `verifyLedger` clean).
- the database refuses a deducting snapshot and an attribution without its obligation.
- **"one obligation per order under concurrent submits: …"** (one order per cart under 14 concurrent submits; one obligation per order is structural: `UNIQUE(order_id)` and the same transaction as the attribution).
- the suspension race with two real connections: a suspension held uncommitted while `placeOrder` waits on the membership row, then committed → the order is placed without attribution.
- **"every published product earns the store default without an offer row; …"** and the SQL/TypeScript rate parity over a 108-case corpus.
- **"sandbox orders earn nothing: …"** (a real sandbox AutoLaris order of a member's code).
- void on cancel and RTS return, delivery stamp with the snapshotted hold.
- **"void and payable transitions exactly at the boundary: …"** (`payable_at = now()` and `now() + 1 µs` in one transaction; release before delivery refused).
- **"post-delivery events never void: a partial and a full refund, a grant revocation and a privacy redaction …"** (each stays pending, then payable after the hold).
- **"store A cannot read or change store B's memberships or obligations, affiliate A cannot read affiliate B's, …"**.
- decided bounds; a pre-`0028` attribution keeps its deduction and gets no obligation.

T-52 tests updated to the new model (verified users and legacy `pending` rows in the fixtures; an excluded line instead of a never-opted-in one; memberships in the fixtures through the new `member()` helper; assertions on the deduction replaced by the obligation; the shipping-discount ceiling test inverted; bounds tests use the constants): `t52-fixtures.ts`, `t52-checkout.test.ts`, `t52-schema.test.ts`, `t52-click.test.ts`, `t52-policy.test.ts`, `t37-finance.test.ts`. E2E `apps/web/e2e/t52.spec.ts` likewise (membership row, obligation instead of deduction).

## Mutation checks (first round, 2026-11-25, on `b2ce153`)

Baseline `sha256sum` before the first mutation: `d50e7c63… drizzle/0028_t108_affiliate_membership.sql`, `9279f518… src/affiliate/jobs.ts`, `5588eda1… src/seller/commerce/checkout.ts`, plus `src/ledger/ledger.ts` before M3b. Each mutation ran `vitest run test/t108-membership.test.ts` (fresh test database migrated from the mutated files); every file was restored by copy and `sha256sum -c` reported `OK` for all four after the last one. The full suite below ran on the restored tree.

| # | Mutation (on purpose) | Named test that failed | Result |
|---|---|---|---|
| M1 | Attribute without membership: membership join removed from `affiliate_resolve_core` (code and click) and `affiliate_code_valid`, membership check removed from `affiliate_attribution_guard` | "no attribution without active membership: none, pending, rejected and suspended each earn nothing …" (+ the guard/resolver test and the fallback test) | 3 failed / 14 passed |
| M2 | Release before delivery: `pending → payable` allowed without `payable_at` in `affiliate_commission_guard`, and the job's `payable_at <= now()` filter removed | "void and payable transitions exactly at the boundary: …" (+ the cancel/return/delivery test) | 2 failed / 15 passed |
| M3a | Deduct commission from proceeds in TypeScript only (`withAffiliateCommission` back in `placeOrder`) | "seller order_financials proceeds identical with and without attribution …" — refused by the database (attribution guard / deferred check), every attributed order fails | 11 failed / 6 passed |
| M3b | The full T-52 deduction path back (TypeScript deduction, `affiliate_id` written by `writeOrderFinancials`, both database refusals off) | "seller order_financials proceeds identical with and without attribution …" fails on the assertion itself (`affiliateCommissionIdr: 10000`, `affiliateId: 1` against 0 / null) | 4 failed / 13 passed |

## Populated-copy proof of 0028 (redone after the review follow-up, final migration)

The first-round proof (on the first version of `0028`) is superseded: the migration changed (column default, line rate, guards, dropped T-112 trigger). Redone from a database at `0027` built with the code of `origin/main` `ebbf546` (a scratch detached worktree): `bukalaris_t108_pre` migrated `0000…0027` (28 journal rows), `db:seed`, `db:seed:demo` (4 demo stores, 64 orders), then T-52 affiliate data with the old code: toko-a open at 10 % with one product opted in, one active and one `pending` affiliate (a T-52 row), three COD orders with the code (3 attributions, 8.900 each, deducted from the sale). Then `create database bukalaris_t108_pop template bukalaris_t108_pre`, owner `bukalaris_owner`, migrate with the T-108 tree (`migrations applied`):

| | before | after |
|---|---|---|
| stores / orders / order_financials / line financials | 6 / 67 / 67 / 126 | 6 / 67 / 67 / 126 |
| affiliates (status) / attributions / ledger entries / grants | 2 (active, pending) / 3 / 14 / 0 | 2 (active, pending) / 3 / 14 / 0 |
| md5 of every `order_financials` row | `6293e729…` | `6293e729…` (unchanged) |
| md5 of every `affiliate_attribution` row | `7ef605f4…` | `7ef605f4…` (unchanged) |
| md5 of every `affiliate` row (the legacy `pending` one included) | `2a1c7209…` | `2a1c7209…` (unchanged) |
| `affiliate_policy` max/min/window/hold/revision | 2000/100/7/3/r1 | 5000/100/7/3/r2 |
| unvalidated constraints | — | 0 |
| obligations / memberships | — | 0 / 0 (no backfill) |
| `affiliate.status` default / `digital_grant_affiliate_sync` trigger / JOB-38 kind | — | `'active'` / absent / present |

Smoke on the copy with the new services: the active affiliate applied to toko-a, the owner approved, and two COD orders with its code recorded attribution and obligation (`pending`) with the sale whole: 9.500 on the opted-in product (95.000) and 5.500 on a product with NO offer row (55.000, D-38 B); `affiliate_commission_idr` 0 on both snapshots; `verifyLedger` → no violation. Both scratch databases dropped; the dev database `bukalaris_t108` (still on the first `0028`) was replaced by a copy of the migrated `pop`; the scratch worktree was removed.

## Review follow-up (independent review 2026-11-25: CHANGES REQUIRED)

| Finding | Fix |
|---|---|
| M-1: a commission was voided after delivery (grant revoke inside the hold), against ADR-0015 decision 4 | D-38 A (owner-delegated): `digital_grant_affiliate_sync` dropped; `affiliate_commission_guard` refuses `pending → void` once delivery is stamped. Test "post-delivery events never void: a partial and a full refund, a grant revocation and a privacy redaction …"; the boundary test now asserts the delivered row is not voidable |
| Default rate applied only to opted-in products | D-38 B (owner-delegated): `affiliate_line_rate` redefined in `0028`; `effectiveOfferRate` takes an absent offer; tests "every published product earns the store default …" and the 108-case SQL/TS parity; T-52 "not opted in" test now uses a withdrawn offer |
| C-A3 left `pending` registrations | D-38 C: `registerAffiliate` refuses `email_unverified`; the guard inserts only `active` for a verified e-mail; column default `active`; fixtures model legacy `pending` rows explicitly (`legacyPending`) |
| Legacy deducted attributions have no payment path | D-38 D: recorded as a deliberate ceiling (T-118) |
| No test of a suspension racing an in-flight checkout | New two-connection test: suspension held uncommitted, `placeOrder` observed waiting on the row lock (`pg_locks`), commit → order placed, nothing earned |
| "concurrent submits" test overstated what it proves | Renamed: one order per cart under concurrency; one obligation per order is structural (`UNIQUE(order_id)`, same transaction) |
| `reviewed_by` could carry a `system:` value from a seller review | Guard refuses a `system:` reviewer on any review UPDATE and requires `system:auto_approve` on an active INSERT; tested |
| Re-application after rejection with auto-approval on was untested | Tested: it comes back `pending` |
| ARCH-5 JOB-01 range | "(JOB-07 to JOB-38)" |
| Unused deduction helper kept | `withAffiliateCommission` and the finance engine's `affiliateCommission` input deleted; `writeOrderFinancials` no longer writes the column (default 0); T-52/T-37 unit tests adjusted |
| BUILD-LOG duplicated T-117 "Evidence" line | Removed |

New mutation checks (baseline `sha256sum` of the final `0028`: `06986455c83b79e0071a99f8c7c2a3703e36edc35975aab2ed6d48218ef1f51a`; each run `vitest run test/t108-membership.test.ts` on a fresh test database; restored by copy, `sha256sum -c` → `OK` after each):

| # | Mutation | Named test that failed | Result |
|---|---|---|---|
| MA | Post-delivery void restored: the old void clause in `affiliate_commission_guard` and the T-112 grant trigger's void branch | "post-delivery events never void: …" (and the boundary test) | 2 failed / 18 passed |
| MB | A product without an offer row earns 0 (`IF NOT FOUND OR v_status <> 'active'` in `affiliate_line_rate`) | "every published product earns the store default without an offer row; …" (and the parity test) | 2 failed / 18 passed |

The first-round mutations M1–M3 target code the follow-up did not change in substance (resolver membership join, release condition, deduction refusals); they were not re-run.

## Verification log

Final tree, rebased on `origin/main` `ebbf546`. Everything ran under `heavy-run --lock bukalaris-env` against the private `bukalaris_t108*` databases on Postgres 18.6:

- `pnpm map:check` → 19 map-check unit tests passed; `system-map: 109 route files, 133 current rows (126 Implemented)` / `ok`.
- `pnpm -r lint` → clean. `pnpm -r typecheck` → clean (db + web).
- `pnpm --filter @bukalaris/db test` → **87 files, 1604 tests passed** (235 s). The total is lower than the first round's 2429 because the T-117 merged on `main` runs its 832-case table as one test. `t108-membership.test.ts` has 20 tests.
- `pnpm build` → OK.
- First full E2E run, `E2E_PORT=4208 pnpm --filter @bukalaris/web e2e` → 295 passed, 6 skipped, **14 failed**. All 14 were `t52.spec.ts` (7 tests × 2 projects). The cause was its fixture: it inserted an `active` membership with reviewer `t52-e2e`, and the tightened membership guard refuses that. The fixture now writes the auto-approval shape (`system:auto_approve`). Targeted `t52.spec.ts` afterwards → **14 passed**.
- Second full E2E run → **308 passed, 6 skipped, 1 failed (25.6 min)**. The one failure was `[desktop] checkout2.spec.ts:150` (cart rate-limit form: a `toHaveValue` timeout). That spec is a known intermittent (BUILD-LOG, T-106/T-107) and touches no affiliate code. `checkout2.spec.ts` alone on a fresh E2E database passed twice in a row (8 passed, 8 passed). A `--repeat-each=3` run failed its 2nd and 3rd repetitions of tests :88 and :150. Repetitions in one run share the seeded database, so that run proves nothing either way.
- Populated-copy proof of the final `0028`: see above.
- First round (on `b2ce153`, before the review): DB 87 files / 2429 tests, E2E 307 passed / 6 skipped.

## Open items

- Re-review of the follow-up and CI pending.
- A link of a non-member still captures clicks (they never earn); T-110 may require membership when a link is created.
- T-109: payment records, the `paid / confirmed / disputed` writers (the guard already allows `payable → paid → confirmed | disputed`), the manual correction after delivery (D-38 A), arrears, the frozen programme (refusal in `affiliate_apply` and the resolver), terms acceptance.
- T-110: seller, affiliate and Owner console screens; the affiliate registration flow (C-A3 is enforced in `registerAffiliate` and the database; no screen calls it yet).
- The `affiliate_catalog` discovery projection still lists offer rows only (D-38 B; discovery deferred).
- Ceiling D-38 D: legacy deducted attributions stay unpaid until T-118.
- `docs/evidence/m1/` baseline PNGs rewritten by the E2E run are noise and are not staged.

## Confirmation review (2026-11-25)

Second independent review of `a8fb5e6`: **APPROVE** (every earlier finding fixed in code or tests; `t108-membership` + six `t52-*` files, 183 tests passed). Remaining items, fixed in the next commit:

- **ADR-0016 decision 20** contradicted D-38 A: a dated "superseded in part" note added.
- **Offer-insert race** (more likely under D-38 B, where most products have no offer row): a seller inserting an override between `planAffiliateCommission` and `recordAffiliateAttribution` changed the re-checked rate and failed the order. `affiliate_offer_guard` (re-created in `0028`, same name, signature and grants) now locks the store's `affiliate_seller_policy` row `FOR UPDATE` on INSERT, the row `affiliate_line_rate` share-locks during checkout, so the insert waits. Test "a new override offer waits for an in-flight checkout …" (two real connections, waits observed in `pg_locks`).
- **`system:` reviewer check** now `lower(btrim(...)) LIKE 'system:%'`; test "a review naming a system reviewer is refused whatever its case or spacing".
- **Mutation checks of the auth rules** (baseline sha256 `646dffe6…` of `0028`, restored, `sha256sum -c` OK): **MC** lock removed → the offer-race test FAILED; **MD** case-sensitive check → the system-reviewer test FAILED; **ME** database e-mail-verification gate removed → the C-A3 test FAILED.
- **D-38 B** now states that a store already open under the T-52 opt-in rule earns the default on every published product from `0028`.
- Not done (nit): the SQL/TS parity corpus still uses an active store and the default minimum bound only; store status and the bounds are covered by the other line-rate tests.

`t108-membership.test.ts`: 22 passed.
