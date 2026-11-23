# T-117 — Seller setup checklist + new-store shipping gate (D-37)

## Execution frame

- Date: 2026-11-23.
- Worktree: `/home/ongki/Projects/bukalaris-wt/t117`.
- Branch/base: `task/t117-setup-checklist` at `2b45187` (T-112 merged).
- Requirement: T-117 spec block in `docs/TASKS.md` plus the owner-approved scope extension (activation gate for new stores, recorded as D-37 in `docs/DECISIONS.md`).
- Authority: local implementation + verification + local commit on the branch; NO push, no live provider calls, no deploy.

## What was built

- Migration `0027_t117_setup_gate` (`packages/db/drizzle/0027_t117_setup_gate.sql`): generated `store.legacy_platform_shipping boolean NOT NULL DEFAULT false` plus a hand-written `-- ===== T-117` section `UPDATE store SET legacy_platform_shipping = true;` so every store existing at migration time keeps the old platform-shipping model; new stores fail closed. The column is NOT in the app role's `appColumns` (`isolation-registry.ts`): sellers can never flip it; the platform role already holds table UPDATE.
- `assertCanActivate` (`packages/db/src/seller/commerce/catalog.ts`): physical activation now requires `shippingReadiness(...).ready` when `storeMoneyMode === "seller_owned" || !store.legacyPlatformShipping`. Digital rule unchanged (prepaid readiness or bank transfer + delivery content).
- Fixtures: `makeStore(..., { legacy = true })` (`packages/db/test/helpers.ts`), `seed.ts`, `demo/seed-demo.ts`, and the E2E fixture (`apps/web/e2e/helpers.ts` `seedFixtureStore(tag, { legacy })`) set the flag through the platform executor; `{ legacy: false }` models a post-0027 store. No exported production service sets the flag.
- `packages/db/src/payments/setup-checklist.ts`: pure `setupChecklist(input)` → ordered steps `terms → mengantar_account → pickup → webhook → autolaris → bank_account` (webhook marked recommended, blocks nothing) + `can.{physical,digital,cod,qrisVa,bankTransfer}` derived from readiness only. `sellerSetupChecklist(scope)` (capability `integrations.manage`) assembles store flag, `storeMoneyMode`, provider readiness, `shippingSync(scope).webhook.secretSet` and `sellerTermsStatus(scope).acceptedCurrent`; returns no key, hint, fingerprint or secret. Exported from `packages/db/src/index.ts`.
- UI: `apps/web/src/app/(seller)/seller/_dashboard/setup-checklist.tsx` renders the "Persiapan toko" card above the KPIs on SC-01 `/seller` for owners with `integrations.manage` on a writable store only (staff see nothing); each step carries StatusBadge (Selesai/Belum/Disarankan), a one-line "Yang masih terkunci" and a link; the footer summarizes what is activatable now. The card hides once every required step is done and leaves a small webhook note instead. `/seller/settings` gained a checklist link for owners.
- Docs: D-37 in `docs/DECISIONS.md`; RUNBOOK section "AutoLaris payment-only profile request (T-117)" (operator-ticket recording, key only ever inside the seller's own AutoLaris dashboard); SC-01 contract row in `docs/17-UX-FLOWS-SCREEN-CONTRACTS.md`; ARCH-5 rows/notes and `0027` migration references in `docs/04-SYSTEM-ARCHITECTURE.md`; T-117 status line in `docs/TASKS.md`; BUILD-LOG entry.

## Tests

`packages/db/test/t117-setup-checklist.test.ts` (835 tests):
- Table test over every combination of shipping-gap subsets (none, each single gap, the listed pairs), QRIS/VA ready/not, bankTransfer t/f, terms t/f, webhook t/f, legacy t/f, both money modes — asserts every `step.done`/`recommended` and `can.*` against the `storeReadiness`-equivalent rule.
- DB test: `sellerSetupChecklist` on a fresh non-legacy store equals `storeReadiness` at each stage (empty → terms accepted → bank account added → fake Mengantar account ready).
- Gate test: a non-legacy store with nothing done gets `shipping_not_ready` on physical create/update and `prepaid_not_ready` on digital; a legacy store still activates physical products (regression).
- Hygiene test: serialized checklist contains no key hint/fingerprint/secret/fake-account strings.

Full DB suite (run on the final tree): **86 files, 2411 tests passed**.

## Mutation checks

Backups: `cp` to `/tmp/t117-mut/` + `sha256sum` baseline `5bf794e0… catalog.ts`, `d1129ad2… setup-checklist.ts`. Restore verified each time with `sha256sum -c` → `OK` for both files; a clean `pnpm vitest run test/t117-setup-checklist.test.ts` after the final restore returned **835 passed**.

- **M1** — drop `|| !s?.legacy` from the physical gate in `catalog.ts` → named gate test "a store with no step done can activate nothing…" FAILED (physical activation no longer refused). Restored.
- **M2** — `pickup` step ignores `pickup_registered` in `setup-checklist.ts` → 65 tests FAILED (every `pickup_registered`-only gap case plus the staged DB walk). Restored.
- **M3** — `can.digital` reduced to `qrisVa.ready` only → 208 table tests FAILED (every `bankTransfer && !qrisVa` combination). Restored.

## Populated-copy proof of 0027

`create database bukalaris_t117_pop template bukalaris` on the local PG-18 server (dev DB already migrated to 0027 first). First migrate failed `permission denied for database bukalaris_t117_pop` (copied ownership); fixed by `alter database bukalaris_t117_pop owner to bukalaris_owner`, then `pnpm db:migrate` with `MIGRATION_DATABASE_URL` pointed at the copy:

- `select count(*) from store` → **6**; `select count(*) from store where legacy_platform_shipping` → **6** (every pre-existing store marked legacy).
- `product` count unchanged at **55**.
- `select count(*) from pg_constraint where not convalidated` → **0**.
- Copy dropped after recording (`dropdb bukalaris_t117_pop`).

## E2E

`apps/web/e2e/t117.spec.ts`, both configured projects (`mobile-320`, `desktop`): seeds a `legacy: false` fixture store, checks the all-"Belum" checklist (webhook "Disarankan") and "Belum ada yang bisa diaktifkan", creates a physical product and shows activation refused with "Produk fisik hanya bisa diaktifkan setelah pengiriman toko siap", accepts seller terms in the UI, adds a bank account through the T-113 superuser+step-up fixture, re-checks the card (terms + bank "Selesai", digital unlock note), then creates a digital product with an access link and activates it → "Aktif".

- Targeted run: `pnpm --filter @bukalaris/web exec playwright test e2e/t117.spec.ts` → **2 passed** (mobile-320 5.1s, desktop 5.0s).
- Full suite: `heavy-run --lock bukalaris-env -- pnpm --filter @bukalaris/web e2e` → **307 passed, 6 skipped, 0 failed (27.0m)** — no other spec broke under the new-store gate or the dashboard card.
- `evidence()` asserts zero horizontal overflow and zero CSP violations at every step.
- Note: two test-side fixes were needed, both in the spec, not the app — `login()` lands on `/seller/products` so the spec navigates to `/seller` itself, and React hydration re-applies the uncontrolled `#status` select's `defaultValue` once (wiped a pre-hydration `selectOption`; the POST body literally carried `status=draft` — proven via the trace), so the spec re-applies the selection until it survives a settle window (`selectStatusActive`).

Screenshots (all under `docs/evidence/m1/`):
- `mobile-320-t117-checklist-empty.png`, `desktop-t117-checklist-empty.png`
- `mobile-320-t117-physical-activation-blocked.png`, `desktop-t117-physical-activation-blocked.png`
- `mobile-320-t117-checklist-partial.png`, `desktop-t117-checklist-partial.png`
- `mobile-320-t117-digital-activated.png`, `desktop-t117-digital-activated.png`

## Verification log

- `node --test scripts/check-system-map.test.mjs` → 14 tests passed; `node scripts/check-system-map.mjs` → `system-map: 109 route files, 132 current rows (125 Implemented)` / `system-map: ok`.
- `pnpm -r lint` → clean; `pnpm -r typecheck` → clean (db + web).
- `pnpm --filter @bukalaris/db test` → 86 files / 2411 tests passed.
- `pnpm build` → production build OK, all routes generated.
- Targeted E2E → 2/2 passed; full `pnpm e2e` suite → see below.
- Populated-copy migration proof → above.

## Open items

- Independent review pending (per convention for sensitive work).
- `docs/evidence/m1/` baseline PNGs rewritten by the E2E run are noise and are not staged.
