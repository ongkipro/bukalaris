# T-104 — Seller provider accounts: sealed keys, environment, connection check

Status: **Done locally (2026-11-16); independent review done (no blocker), findings fixed below, confirmation of the fixes pending.** Branch `task/t104-provider-accounts` from `main` at `2b4d0a4`, worktree `bukalaris-wt/t104-provider-accounts`. Not committed, not pushed. Fake connection check only: no Mengantar or AutoLaris call of any kind, no real key, no deploy.

## Scope and invariants

ADR-0013 sections 1 to 3 (decisions 5 to 14), decision 34 left to T-105/T-106, D-27, D-33 (RL-PROVIDER-CHECK). Each invariant has a named test in `packages/db/test/t104-provider-accounts.test.ts`:

1. A key never appears in a returned value, error, log line, audit row, mail, job, rate-limit key or (E2E) HTML/RSC payload. Views are allow-lists; the application role holds **no SELECT on any sealed column**; audit rows and mails carry environment and fingerprint only; a provider error is mapped to a code without reading its message.
2. Connect, replace (incl. environment move) and remove need `integrations.manage` (owner) **and** a step-up proof of this session (`integrations.provider_key`, subject = provider) consumed in the writing transaction. Enforced twice: the service (`consumeSellerStepUp`) and the database (`provider_account_guard` refuses an application-role key/environment change without a proof consumed `= now()`).
3. Store B cannot read, use or replace store A's key under the application role: FORCE RLS on both tables, no sealed-column grant, the only envelope read is the definer `provider_key_envelope(store, provider)` which refuses any store but `app_store_id()`, and the AES-GCM additional data binds purpose, store, row and kind.
4. A failed connection check stores nothing new (save) or only records the result (check now); the previous key stays sealed and in use.
5. No provider URL exists: strict input refuses any extra field, neither table has a URL/host/origin column, the origin comes only from `environment` plus server configuration (`providerOrigin`, https origin only).

## Changes

- Migration `packages/db/drizzle/0018_t104_provider_accounts.sql` (generated structure + `-- ===== T-104` section): `store_payment_account` (environment, sealed key, `key_id`, fingerprint, masked hint, last check time and result, the decision-13 readiness inputs, `step_up_ref`); `store_shipping_account` gains kind `seller_owned`, `environment`, `key_fingerprint`, `key_hint`, `pickup_registered_at` (written by T-105), `step_up_ref` and the `shipping_account_seller_chk`; ENABLE + FORCE RLS and tenant policy on the new table; app grants (column INSERT on exactly the columns of an empty row — `store_id, kind, status, external_user_id, environment` on the shipping table, `store_id, environment, status` on the payment table — column SELECT/UPDATE, never a sealed column on SELECT); platform SELECT only on the new table; `shipping_account_guard` result codes gain `AUTH_FAILED`; invoker trigger `provider_account_guard` on both tables; definer `provider_key_envelope(bigint,text)` (app EXECUTE only); `reset_demo_shipping` also removes a demo store's payment account.
- `packages/db/src/shipping/credentials.ts`: purpose-generic keyring/seal/unseal (`shipping_credentials`, new `payment_credentials` = `KEYRING_PAYMENT_CREDENTIALS`), each ring refuses reuse of the other; AAD now includes the kind (Partner envelopes unchanged: kind defaults to `partner_managed`); `keyFingerprint` (HMAC-SHA-256 keyed per purpose through HKDF from the purpose's current ring key, `hmac:` + 16 hex), `keyHint` (< 24 chars fully masked, else first/last four).
- `packages/db/src/shipping/schema-accounts.ts`, `accounts.ts` (re-seal keeps the row's kind and rewrites a seller key's fingerprint under the new ring key; order-account type stays Partner/master), `packages/db/src/payments/schema-payments.ts`.
- `packages/db/src/payments/provider-accounts.ts`: `sellerProviderAccounts`, `saveProviderKey`, `removeProviderKey`, `checkProviderNow`, `setPaymentAccountDetails`, `shippingReadiness`, `paymentReadiness`, `storeReadiness`, `providerOrigin`, server-internal `openProviderKey`; `FakeProviderCheck` (deterministic: "INVALID" refused, "DOWN" unreachable, otherwise the existing `fakeMengantar.estimate` from the pickup area and `fakeAutoLaris.listChannels`). The fake answers only outside production (or in the e2e production build under the explicit `PROVIDER_CHECK_FAKE=1`) and only while no origin is configured for that provider and environment (`fakeCheckAllowed`); otherwise the check is refused (`provider_unavailable`, nothing stored, previous key and result kept). The live transport and the decision-34 production switch are T-105/T-106. Save re-checks inside the locked transaction that the row's revision and fingerprint are still those read before the check, else `conflict`. `fakeCheck.calls` is capped at 100. RL-PROVIDER-CHECK 5 / 600 s per store, counted before the check.
- Registry: both table entries (column grants in catalog order through a small `columnGrants` helper) and `DEFINER_FUNCTIONS["provider_key_envelope(bigint,text)"]`; `drizzle-pending/t59-contract.sql` GRANT block regenerated from `registryRows()` (one added line: `GRANT SELECT ON "store_payment_account"`; the other 111 lines byte-identical; unchanged by the review fixes, which touch app grants only).
- Seller Admin SC-32 `/seller/payments` ("Akun penyedia"): page, actions, labels, loading; per provider status, environment, masked hint, last check (WIB); save-and-check form (environment select, password-type key field with `autocomplete="new-password"` that is never prefilled, 6-digit code), check now, remove (ConfirmSubmit + code); AutoLaris data form (area ids, shipper e-mail, sender address, payment-only confirmation); readiness cards. SC-22 links to it. ARCH-5 row SC-32 added.
- `.env.example`: `KEYRING_PAYMENT_CREDENTIALS` dev placeholder and the four (unset) origin variables; test rings in `packages/db/vitest.config.ts` and `apps/web/playwright.config.ts`, which also sets `PROVIDER_CHECK_FAKE=1` for the e2e production build.

## Readiness (decisions 12 to 14)

`shippingReadiness`: gaps `key`, `check`, `pickup_area`, `pickup_registered`. `paymentReadiness`: `key`, `check`, `order_fields`, `sender_address`, `payment_only`. `storeReadiness.canOpen` = QRIS/VA ready or shipping ready (COD); `physicalProducts` = shipping ready. Not yet consumed by store opening, product activation or the checkout method list (T-93, T-105, T-106). Decision 41's dedicated-account check joins the shipping gaps in T-115.

## Mutation checks

Each mutation applied on purpose to the code after the review fixes, the T-104 test file (14 tests) run against a freshly migrated `bukalaris_t104_test`, then the files restored (sha256 verified: `provider-accounts.ts` `be61d16b…`, `0018_…sql` `eee59afd…`) and the file re-run green (14/14).

| # | Invariant | Mutation | Named test that failed |
|---|---|---|---|
| M1 | no key in a DTO | `saveProviderKey` returns `{ ...view, apiKey: value }` | "connect seals each key under its own keyring, the view shows only state, masked hint and last check, …" and "canary-key literal scan: no returned value, error, log line, audit row, mail, job, rate-limit key or check call carries the key" |
| M2 | no change without step-up | both `consumeSellerStepUp` calls removed **and** the proof condition of `provider_account_guard` disabled (`IF false AND NOT EXISTS`) | "no step-up, a used or foreign proof, a session without a fresh second factor and staff are all refused; the database refuses a key change without a consumed proof" and "the database binds the proof to the action and the provider: …" |
| M3 | store B cannot open store A's key | `provider_key_envelope` no longer compares `p_store_id` with `app_store_id()` | "store B cannot read, use or replace store A's key under the application role" (expected 42501, got ok) |
| M4 (review 1) | fake check never answers in production | `fakeCheckAllowed` returns `origin === null` (fail-open path re-opened) | "the fake check never answers in production (unless the explicit e2e flag is set) nor for a configured origin: …" |
| M5a (review 5) | guard binds the action | `pr.action_key = 'integrations.provider_key'` removed from the guard | "the database binds the proof to the action and the provider: a consumed proof of another action or another provider never authorises a key write" |
| M5b (review 5) | guard binds the provider | `pr.subject_id = v_provider` removed from the guard | same test |
| M6 (review 3) | no re-seal over a concurrent replacement | the in-transaction revision/fingerprint comparison disabled | "an environment move with an empty key field never re-seals the old key over a replacement saved while it was being checked" |

## Independent review (2026-11-16) and how each finding was handled

| Finding | Handling |
|---|---|
| MAJOR 1: the fake check failed open in a production build without an origin | `fakeCheckAllowed`: fake only when `NODE_ENV !== "production"` or `PROVIDER_CHECK_FAKE=1` (set only in `playwright.config.ts`), and never for a configured origin; otherwise `provider_unavailable`, nothing stored. Same rule as `shipping/accounts.ts` ("the fake runs only outside production"). Named test + M4 |
| Minor 2: unkeyed SHA-256 fingerprint guessable for short keys | HMAC keyed per purpose (HKDF from the current ring key). Effect: a ring rotation changes fingerprints; the shipping re-seal job writes the new fingerprint with the new envelope (tested). Existing Partner rows carry no fingerprint and are unaffected; no `seller_owned` row exists outside local databases. The payment ring has no re-seal job yet (see open points) |
| Minor 3: environment move could re-seal the old key over a concurrent replacement | inside the locked transaction the row's revision and fingerprint must equal those read before the check, else `conflict` (nothing written, proof consumption rolled back). Named test + M6 |
| Minor 4: whole-table INSERT on `store_shipping_account` | narrowed to column INSERT on the five columns of an empty row (and three on the payment table); the service inserts with explicit column lists. Migration 0018 edited in place (not applied anywhere shared) and re-proven on a populated copy; `test/isolation-catalog.ts` compares column grants as sets (registry lists SELECT before INSERT, the catalog sorts alphabetically). Contract GRANT block unchanged. Known gap recorded below |
| Minor 5: no test that the guard binds action and provider | named test: a proof consumed in the same transaction for `payout.destination`, or for the other provider, never authorises a key write (42501). M5a, M5b |
| 6: payment keyring rotation | recorded: no re-seal job for `payment_credentials` and the platform role has SELECT only on `store_payment_account`, so rotating that ring is not possible yet → owned by T-106 |
| 7: nits | `autocomplete="new-password"` on the key field; `FakeProviderCheck.calls` capped at 100; `privacy.test.ts` exemption narrowed to `store_payment_account.shipper_email` and `.sender_address`. Not done (outside the Allowed Paths): an Owner console `KIND_LABEL` entry for `seller_owned` |

## Migration proof on a populated copy

Run twice (before and after the review fixes edited 0018), each time on a fresh copy: `create database bukalaris_t104_copy template bukalaris` (dev database: 6 stores, 64 orders, at migration 0009), owner set to `bukalaris_owner`; migrated to 0017 with a journal copy that stops there (12 shipping accounts: 6 master active, 6 Partner pending); then 0018 applied: 19 migrations, stores 6, orders 64, shipping rows unchanged, every check and foreign key `convalidated = t`, both tables `relrowsecurity` and `relforcerowsecurity`, both guard triggers present. On the copy, the real services as `bukalaris_app` (an owner with an MFA-verified session and a step-up proof) connected a Mengantar and an AutoLaris key (fake check), `openProviderKey` opened them, two audit rows were written, readiness was computed; after the review fixes the app role's INSERT privilege on the shipping table was confirmed to be exactly `environment, external_user_id, kind, status, store_id`. Copy dropped afterwards (both times).

## Executed verification

Environment: own databases `bukalaris_t104*`, port 3300, public placeholders only (no `.env`).

| Gate | Command | Result |
|---|---|---|
| Map | `pnpm map:check` | ok: 104 route files, 126 current rows (119 Implemented) |
| Lint | `pnpm lint` | clean |
| Typecheck | `pnpm typecheck` | clean (db and web) |
| T-104 + neighbours (after review) | `vitest run test/t104-provider-accounts.test.ts test/rls.test.ts test/rls-contract.test.ts test/privacy.test.ts test/t48-accounts.test.ts` | 5 files, 106 tests passed |
| Full DB suite (after review) | `heavy-run --lock bukalaris-env -- pnpm test` | **77 files, 1443 tests passed** (1166 s). Before the review: 77 / 1440 |
| Build (after review) | `heavy-run --lock bukalaris-env -- pnpm build` | ok. A first run before the review failed on a type error in the new spec (header union), fixed |
| E2E (after review) | `playwright test t104.spec.ts shipping.spec.ts content.spec.ts ui.spec.ts t48.spec.ts --project=mobile-320 --project=desktop` (port 3300, `bukalaris_t104_e2e`) | 29 passed, 1 failed: `[desktop] content.spec.ts` "seller publishes image, collection, page and theme…" timed out waiting for "Tersimpan." after the settings save (the test took 1.4 min against 8.7 s on mobile; no T-104 file is on that path). Re-run `content.spec.ts t104.spec.ts` at both projects under the lock: **10 passed**. Before the review the five specs passed 30/30. Earlier history: one run failed the T-104 journey because the fake refused under `NODE_ENV=production`; now handled by `PROVIDER_CHECK_FAKE=1` in the e2e config |
| Full `pnpm e2e` | — | not run |

Rendered evidence (opened and checked at 320 px: single column, no clipping, no horizontal scroll; the `evidence()` helper also asserts no overflow and no CSP violation): `docs/evidence/m1/{mobile-320,desktop}-t104-providers-{empty,connected}.png`. The other baseline PNGs the run rewrote are noise and must not be staged.

## Deviations (outside the Allowed Paths, each minimal)

- `packages/db/src/ledger/stepup.ts`: one more value in the `SellerProofAction` union (`integrations.provider_key`).
- `packages/db/src/index.ts`: one export line (seller screen and readiness only; `openProviderKey` and the check seam stay internal).
- `apps/web/src/app/(seller)/seller/layout.tsx`: the "Akun penyedia" nav item, owner-only filter.
- `packages/db/src/demo/seed-demo.ts`: `store_payment_account` excluded from the platform-role delete loop (the owner-side `reset_demo_shipping` deletes it; the platform role has SELECT only).
- `packages/db/vitest.config.ts`, `apps/web/playwright.config.ts`: the test-only payment ring.
- Tests outside the new file: `privacy.test.ts` exempts `store_payment_account.shipper_email` and `.sender_address` (the seller's own account fields, not buyer data); `isolation-catalog.ts` compares column grants as sets; `t48-copy-guard.test.ts` allows the brand names only under `(seller)/seller/payments/` (ADR-0013 section 8; the full copy boundary moves in T-107; internal ids still refused).

## Open points

- Known gap for T-105: the application role can set the readiness-relevant columns `last_result`, `last_checked_at` and `pickup_registered_at` of its own `seller_owned` row without a step-up (only key and environment changes are guarded). The service writes them only after a check; T-105 decides whether the pickup registration and check results move to a definer or worker path.
- Payment keyring rotation: no re-seal job for `payment_credentials` and the platform role holds SELECT only on `store_payment_account`, so the ring cannot be rotated yet → T-106.
- The Owner console account label (`KIND_LABEL`) has no entry for `seller_owned` (outside the Allowed Paths).

- C-P10 lists the order account snapshot and the test-order marker under T-104, but the Done-when and Allowed Paths exclude `order`/checkout; left for T-105/T-106.
- `docs/17` says the provider-account screen contract is "written in T-104"; doc 17 is outside the Allowed Paths (and another stream edits docs). The screen as built: SC-32 above.
- `ops.ts` has no `seller.payments` Log System module; `/seller/payments` maps to `seller.overview`.
- `abandoned.ts` resume-ring purpose check does not yet include the payment ring (outside Allowed Paths).
- `DEPLOY-COOLIFY.md` env table lacks `KEYRING_PAYMENT_CREDENTIALS` and the origin variables (outside Allowed Paths).
- AutoLaris area-id format and the payment-only profile fields are UNVERIFIED (C-P8); the columns accept 1–64 `[A-Za-z0-9_-]`.

## Confirmation review (2026-11-16)

The reviewer confirmed findings 1 to 5 fixed and 6/7 recorded. One new minor finding: `PROVIDER_CHECK_FAKE=1` alone, set by mistake on a real deployment, would switch the fake on again. Fixed by the coordinating session: the flag counts only when every surface origin is loopback (`surfaceOriginsAreLoopback`, now shared with the local-mail rule in `platform/mail-transport.ts`, a file outside the Allowed Paths), with assertions in the named test "the fake check never answers in production …", and a "never set" row in `docs/DEPLOY-COOLIFY.md`.
