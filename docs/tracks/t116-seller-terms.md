# T-116 — Seller terms, notices and privacy statements for the seller-owned model

- Task: `docs/TASKS.md` T-116 (PR-27, Risk R3). Branch `task/t116-seller-terms` from `main` `06a2b64`.
- Sources: ADR-0013 section 8 and D-33, ADR-0015 decision 8, ADR-0016 decision 23, `13-COMPLIANCE-PRIVACY.md`, `17-UX-FLOWS-SCREEN-CONTRACTS.md`.
- Everything runs locally; texts stay marked as draft until an adviser review is recorded in `seller_terms_review`.

## What was built

| Area | Change |
|---|---|
| Migration `0024_t116_seller_terms.sql` | Generated: `seller_terms_version` (shared-read, append-only), `seller_terms_review` (shared-read, append-only), `store_terms_acceptance` (tenant under FORCE RLS, append-only, unique `(store_id, version)`). Hand-written `-- ===== T-116`: RLS and grants, `seller_terms_immutable_guard`, `store_terms_acceptance_guard` (owner membership verified on INSERT; UPDATE/DELETE refused except demo reset), version 1 seed (plain Indonesian text covering all required disclosures, no adviser review row → draft), retention class `store_terms_acceptance`, `reset_demo_payments` updated |
| Services `packages/db/src/platform/terms.ts` | `currentSellerTerms`, `sellerTermsStatus`, `acceptSellerTerms` (owner `integrations.manage`, audited, idempotent on same version, stale version refused), `assertSellerTermsAccepted` (gates `saveProviderKey` and `addBankAccount`), `assertSellerTermsReviewed` (gates T-105 Mengantar and T-106 AutoLaris production switches), `publishSellerTermsVersion` and `recordSellerTermsReview` (Owner console, `settings.manage`, audited) |
| Gates wired | `payments/provider-accounts.ts` (`saveProviderKey`), `payments/bank-transfer.ts` (`addBankAccount`), `shipping/live-setting.ts` (`requestMengantarProductionOn`, `setMengantarProductionCalls`), `payments/seller.ts` (`requestAutoLarisProduction`, `setAutoLarisProduction`) |
| UI | SC-32 `/seller/payments`: versioned plain-text terms, draft/reviewed badge, acceptance status and owner acceptance form (`acceptSellerTermsAction`); SC-24 `/seller/privacy`: provider-copy redaction notice (`privacy-provider-notice`) and reminder inside the redaction fieldset; SC-22 `/seller/shipping`: shipping-money notice for own accounts; SC-10 `/seller/settings`: terms status notice linking to SC-32; SF-07 `/checkout`, SF-08 `/checkout/confirmation`, SF-11 `/o/[token]`: payee notice naming the store (`payee-notice`, no provider brand) |
| Docs | `docs/04-SYSTEM-ARCHITECTURE.md` (ARCH-5 rows SC-10, SC-22, SC-24, SC-32, SF-07, SF-08, SF-11), `docs/13-COMPLIANCE-PRIVACY.md`, `docs/17-UX-FLOWS-SCREEN-CONTRACTS.md`, `docs/TASKS.md` |

## Named tests (`packages/db/test/t116-seller-terms.test.ts`, 5)

1. "seeded version 1 is a draft and states every required point of ADR-0013, ADR-0015 and ADR-0016"
2. "saving a provider key or bank account without acceptance is refused on the server; accepting unlocks both"
3. "store A's acceptance does not satisfy store B, and an acceptance cannot be edited or deleted"
4. "a new terms version asks for acceptance again without blocking anything already running"
5. "adviser review (name, date, version) gates both T-105 and T-106 production switches; reviews are append-only"

E2E `apps/web/e2e/t116.spec.ts` (mobile-320 and desktop): unaccepted draft terms on SC-32, bank account refused without acceptance, owner accepts, bank account saved, settings notice, SC-24 privacy notice, buyer checkout/confirmation/`/o/[token]` payee notice naming the store.

## Mutation checks

Each mutation applied in place, the named test run, file restored and `sha256sum -c` verified OK.

| # | Invariant broken | Change | Named test that failed |
|---|---|---|---|
| M1 | allow a key save without acceptance (Done-when mutation) | `saveProviderKey`: `assertSellerTermsAccepted` removed | 2 ("expected 'ok' to be 'terms_not_accepted'") |
| M2 | allow a bank account save without acceptance | `addBankAccount`: `assertSellerTermsAccepted` removed | 2 ("expected 'ok' to be 'terms_not_accepted'") |
| M3 | allow Mengantar production ON without adviser review | `requestMengantarProductionOn`: `assertSellerTermsReviewed` removed | 5 ("expected 'ok' to be 'terms_review_missing'") |

## Migration proof on a populated copy

`create database bukalaris_t116_pop template bukalaris owner bukalaris_owner` (dev database seeded at `0021`: 6 stores, 64 orders, 64 snapshots, 14 ledger entries). Migrated as `bukalaris_owner` to `0024` (25 journal rows): counts unchanged, 0 unvalidated constraints, `store_terms_acceptance` FORCE RLS enabled, version 1 seeded, 0 reviews (draft), all three guard triggers present. Copy dropped.

## Executed verification (local: Postgres 18.6, Playwright Chromium; CI uses Postgres 17)

- `pnpm map:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build` clean.
- DB tests: `rls.test.ts`, `rls-contract.test.ts`, `t116`, `t104`, `t105`, `t106`, `t107`, `t113`, `t115`, `t48-copy-guard`, `demo` all green (existing T-104..T-115 test fixtures updated to accept terms v1 and record adviser review in production-switch tests).
- E2E at mobile-320 and desktop: `t116`, `t104`, `t105`, `t115`, `privacy` passed. Rendered evidence opened (`docs/evidence/m1/{mobile-320,desktop}-t116-*.png`).

## Independent review (2026-11-23)

Reviewer: Antigravity CLI (`agy`) via `ai-ask`, read-only (full diff + new files attached; Codex 401, Claude weekly limit). Verdict: **APPROVE**, no blocker or major, no weakened checks. Minor/nit findings handled:
1. Minor: hardcoded "(draf: ...)" inside immutable v1 `body` would stay after review → removed from seed v1 `body`; draft state is shown dynamically by `isDraft` and the UI banner.
2. Minor: SC-22 shipping-money notice only in the `own` branch → kept: the `else` branch is the legacy `Bukalaris Kirim` platform-managed path where the seller does not settle with Mengantar directly.
3. Minor: `Promise.all` on a single `tx` in `sellerTermsStatus` → switched to sequential `await`.
4. Nit: `reviewedOn` regex allowed invalid calendar dates like `2026-02-31` → switched to `z.iso.date()`.

## Open points

- Seller terms v1 remains marked as draft until a privacy/legal adviser review is recorded via `recordSellerTermsReview` (gates T-105 and T-106 production switches; Q-11 stays open).
- An Owner console UI form for publishing a new terms version / recording an adviser review can join a console settings task later; the audited services `publishSellerTermsVersion` and `recordSellerTermsReview` are ready now.
