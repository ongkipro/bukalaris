# T-65 — Tax foundation (track `t65`, patch `T65Tax`)

Local, uncommitted work in an isolated copy on top of the wave 1 overlay (Goal Mode, D-20 to D-22). Nothing deployed, no provider called, no tax rate, base fraction, bracket or deadline anywhere in source, seeds or defaults; every fixture number is arbitrary and asserted as nothing statutory.

## What changed

New module `packages/db/src/tax/`:

| File | Role |
|---|---|
| `schema-tax.ts` | Drizzle tables `tax_setting`, `tax_entity_profile`, `tax_identity`, `tax_policy_version`, `tax_computation`, `tax_document`, `tax_document_sequence`, `tax_event` (DATA-15 tier A). Exported through `schema.ts`. |
| `compute.ts` | Pure BILL-9 computation: `resolveTaxPolicy`, `validateTaxPolicy`, `roundTaxRational` (`floor`/`half_up`/`ceil`, BigInt), `computeTax` (bracket tax, `per_payment`, `cumulative_true_up`, clamp flag, `policy_invalid`, `no_effective_policy`), `canonicalTaxInputs`/`taxInputsHash` (deterministic `inputs_sha256`), `TaxRefusal`. BigInt values are built with `BigInt()` because the web app compiles for ES2017 (BigInt literals fail its typecheck). |
| `settings.ts` | `effectiveTaxSetting`, `readTaxSettings` (`tax.read`), `appendTaxSetting` (`tax.manage`; prospective version, reason, event, `audit_log`; refuses every phase-2 switch outside test/fixture runtimes). |
| `payout.ts` | `lockAffiliatePayout` (the ADR-0009 two-key advisory lock), `effectiveTaxPolicy` (the lookup T-50 reads for `vat_output`), `payoutTaxHook`, `transitionPayoutTax`. |
| `identity.ts`, `seal.ts`, `reseal.ts` | Voluntary identity: `submitTaxIdentity`, `withdrawTaxIdentity`, `ownTaxIdentities` (own-subject RLS read), `listTaxIdentities` (`tax.read`, masked, duplicate flag); AES-256-GCM sealing with subject/version/kind/field AAD and a `key_id`, HMAC fingerprint with a distinct key, `resealTaxIdentity` (the JOB-23 building block for the `tax_identity` ring). |

Migration `packages/db/drizzle/0012_rich_shotgun.sql` (generated structural SQL, then a marked `-- ===== T-65 tax foundation` hand-written section at the end): append-only triggers, policy lifecycle/immutability/bracket/overlap guards, identity guard and the `tax_identity_reseal` definer, computation and document guards, FORCE RLS plus the `affiliate_isolation` policy on `tax_identity` and `tax_document`, explicit grants, sequence grants, and the version-1 `tax_setting` seed. **Folding note:** the conductor folds the four wave 2 migrations into one; keep the T-65 section verbatim after the generated statements.

Shared files touched (minimal): `src/schema.ts` (+1 export), `src/index.ts` (+5 exports), `src/platform/isolation-registry.ts` (10 table entries, 1 `DEFINER_FUNCTIONS` entry, comments), `drizzle-pending/t59-contract.sql` (8 `GRANT` lines so the contract test stays green), `test/rls.test.ts` (one condition: a table whose app privilege is column-level only is skipped by the "no table grant, count denied" loop), `test/privacy.test.ts` (the buyer-PII scan skips the platform's own `tax_entity_profile`), `src/demo/seed-demo.ts` (the demo reset no longer deletes from `tax_*` tables, which have a `store_id` column but are platform data).

## Decisions and defaults taken

1. **`btree_gist` was not used.** The migrator is `bukalaris_owner` (not a superuser) and the extension needs one. I used the documented BILL-9 W2 fallback: the `tax_policy_no_overlap` constraint trigger takes `pg_advisory_xact_lock(hashtextextended('tax.policy:<type>:<category>'))` before checking `daterange(effective_from, effective_to, '[)')` against other confirmed rows. A test holds one confirmation open, starts a second overlapping one, waits until `pg_locks` shows it ungranted, releases the first and asserts the second fails with `23P01` (it would pass if the lock were missing). The exclusion constraint can replace the trigger later when the DBA bootstrap grants the extension.
2. **Isolation classes.** `tax_identity` and `tax_document` are class `affiliate` (key `affiliate_id`, FORCE RLS, `affiliate_isolation`); the other six tables are class `platform` with no app grant. None is `restricted`: that needs the definer-function access layer of T-59b, so I chose `platform` with no app grant and recorded it in the registry comment. `bukalaris_app` holds `SELECT` on the ten non-sealed `tax_identity` columns and `SELECT` on `tax_document`; it has no `INSERT` on `tax_identity` (the sealed columns could not be inserted without a column grant on them), so sealed writes run through the named services on the platform pool (`TaxAffiliateScope.exec`). The affiliate application service (T-52/T-54) supplies the scope.
3. **Policy versions start as `draft`** and must pass `submitted` before `confirmed` (trigger), confirmed content is frozen, only `confirmed -> retired` with an `effective_to` set once is allowed, confirmation is not retroactive (`effective_from` on or after the confirmation date in Asia/Jakarta), `commission_withholding` needs the advisor basis, a reference, a different confirmer and both due days. No policy row is seeded.
4. **The payout hook refuses withholding outside `NODE_ENV=test`** (`tax_not_activated`), and `appendTaxSetting` refuses `withholding_enabled`, `tax_identity_required_for_payout` and `pkp_gate_enabled` outside test: TASKS slice 3 says the withholding path is for fixture/test environments and production activation is gated by ADR-0012 section 5, not by code. The database CHECKs and the `tax_setting_guard` trigger (confirmed profile) hold independently.
5. **Startup identity supersession.** A new submission supersedes only an unreviewed `submitted` version; an `approved` version (phase 2) stays approved until a reviewer replaces it. Withdrawal is refused when a `tax_computation` references the version (retention) and for reviewed versions.
6. **Syntactic identifier check** (15 or 16 digits, entities need an NPWP) follows BILL-9 W1 and is marked UNVERIFIED there; the numbers are protocol size limits and sit on the literal-scan allow-list with that reason.
7. **`tax_computation.source_id` is a `uuid`** (T-53 pre-generates the payout id, DATA-11); fixtures use random UUIDs.
8. **CHECKs are NULL-safe.** A review of my own first draft found `store_id > 0` style CHECKs passing on NULL; they use `coalesce(... , false)` / `is distinct from` and a test (`subject, class and sealed-state CHECKs`) proves it.
9. **Keys.** `KEYRING_TAX_IDENTITY` (`<key_id>:<base64 32 bytes>,...`, first entry current) and `IDENTITY_FINGERPRINT_KEY` (`<key_id>:<base64 32 bytes>`) per DEPLOY-COOLIFY; a fingerprint key equal to any sealing key is refused. An absent or malformed ring fails closed with no row.

## Commands and observed results

All on this copy: `.env` with `bukalaris_t65{,_test,_e2e}`, ports 3165/3265.

- `pnpm --filter @bukalaris/db generate`: one migration, reviewed in full; regenerated once after the NULL-safe CHECK fix (the hand-written section was re-appended unchanged).
- `pnpm lint`: clean. `pnpm typecheck`: db and web clean.
- `pnpm --filter @bukalaris/db test` (final run, after the last edit): **32 files, 485 tests, all passed** (207 s). The T-65 files alone (`t65-compute`, `t65-literal-scan`, `t65-tax`): 88 tests (25 + 12 + 51), plus the registry/contract files `rls.test.ts` and `rls-contract.test.ts` (54 tests) green with the new tables. An earlier full run failed three tests that this track caused (the demo reset deleting from `tax_document`, the buyer-PII scan seeing `tax_entity_profile.registered_address`, and the literal scan catching my own `500` in the audit-reason cap); each was fixed, not weakened.
- `pnpm build`: succeeded (route list unchanged; no route or handler file added, so `pnpm map:check` was not applicable).
- e2e: not run, no web change (no screens, per the assignment).

## Named tests (`packages/db/test`)

`t65-compute.test.ts` (pure): BILL-9 illustration (bracketed cumulative true-up, second payout 3.800.000 after 25.000), flat per-payment, zero-rate tranche; all three rounding modes at the half boundary (0.5 and 1.5) and "rounded once, not per bracket" with a `ceil` case that per-bracket rounding would fail; zero and maximum-bigint-adjacent gross and one past the maximum; clamp; tax above gross; eight `policy_invalid` shapes; as-of-date range selection (end exclusive, confirmed only, same type/category), two matches refused, no effective policy; deterministic `inputs_sha256` and recorded policy parameters.

`t65-literal-scan.test.ts` (repository scan, explicitly demanded by TASKS): no numeric literal other than 0, 1, 2 in `src/tax/**` unless on a reasoned allow-list (a new rate, fraction, bracket or day fails it; the scanner is fed examples to prove it is not vacuous); the same scan over `seller/commerce`, `payments` and `shipping` for a tax-named line with a numeric literal (so a COD-fee VAT rate cannot appear outside a policy lookup); the migration declares no default on `tax_policy_version` beyond `status` and `clawback_treatment` and seeds no policy row.

`t65-tax.test.ts` (real PostgreSQL): defaults (seed version 1, no tax rows, hook returns tax 0 with the snapshot and no computation, DB refuses a computation under a setting with withholding off); `tax_setting` CHECKs, append-only for owner and platform, capability matrix (`tax.read`, `tax.manage`, none) with no side effect on refusal, prospective/reason/notice/order rules, concurrent same-instant change leaves one version, production-mode refusal; entity profile; policy (catalog proves no defaults, draft-first lifecycle, withholding confirmation rules, malformed brackets/fractions/types, confirmed immutability, retirement, frozen submitted content, non-retroactive, overlap rejected, deterministic lock race, `vat_output` lookup returns exactly one confirmed version or none); payout hook (identity gate, not-yet-effective setting ignored, one computation per payout id with snapshot and event, illustration across two payouts and void leaving the year-to-date, replay and replay mismatch, three concurrent replays, caller-lock simulation with a blocked second call and correct year-to-date, refusals leave no row, rollback after a successful hook leaves none, production refusal, paid/rejected transitions and their replays and opposites, immutable snapshot and no delete, amount/composite-link/unique CHECKs); `tax_identity` column grants (every sealed column and `SELECT *` denied to the app role, with and without context), RLS fail closed and affiliate A cannot read B, immutability and state machine, one approved with two concurrent approvals leaving one, subject/class/sealed CHECKs; identity service (flag OFF stores nothing, no plaintext at rest, masked listing, AAD binding to subject/version/kind/field, tamper and unknown key id, keyed fingerprint and key reuse refusal, fail-closed keys, syntax, request-key replay and concurrent same-key insert, supersession, duplicate flag, withdraw erasure, referenced version retained, re-seal); documents (immutable payload, one issued per period, own-statement RLS) and `tax_event` append-only.

Registry and contract tests (`rls.test.ts`, `rls-contract.test.ts`) enforce the new entries, the column grants and the contract re-grant.

## Lessons (D-20 quality bar) and their named tests

| Lesson | Test |
|---|---|
| Money amounts never through floats; one rounding | `t65-compute` "rounded once" and "bigint maximum" cases |
| A replayed money request must not double-apply | `t65-tax` "replay returns the one computation …", "concurrent replays leave one row" |
| Concurrent requests must see each other's year-to-date | `t65-tax` "serialised under the per-affiliate lock …" |
| An uncertain outcome never records tax | transitions only move `computed` forward; "paid recognises, rejected voids …" |
| A configuration change never rewrites history | "immutable snapshot … later setting or policy never rewrites it" |
| Defaults do nothing | "startup defaults …" (three cases) |
| Sensitive values never leave unmasked | "stores no plaintext …", "cannot read any sealed or fingerprint column" |
| One secret, one purpose | "duplicate fingerprint is a keyed HMAC distinct from the sealing keys …" |
| Tenant/subject isolation fails closed | "RLS fails closed without app.affiliate_id …", document RLS case |
| A forgotten NULL in a CHECK silently admits bad rows | "subject, class and sealed-state CHECKs" (found a real defect in my first draft) |

## DEFERRED (with the exact missing decision or dependency)

- **`affiliate_payout` wiring** (`tax_setting_version_id`, `tax_computation_id`, composite FK, CHECK) and calling `payoutTaxHook` / `transitionPayoutTax` inside the payout transaction: T-53 slice 1 and 3 (needs T-52, T-37, T-60/T-62). The unique key the composite FK targets (`tax_computation_payout_ref`) and the pre-generated payout id contract exist and are tested.
- **Identity review, approval, rejection and revocation services** (`tax.identity.review`, P2 dormant), **policy authoring/confirmation service** (`tax.manage`/`tax.approve`, T-67 slice 2) and the **activation service** (ADR-0012 section 5): T-67. The database lifecycle and guards are in place and tested through direct statements. **T-50 note:** the PPN switch must author the owner-decision `vat_output` version itself (draft, submit, confirm with `confirmation_basis = 'owner_decision'`, no due days) and reads it through `effectiveTaxPolicy`; no authoring helper exists in T-65 by design (the TASKS entry lists only the lookup).
- **Owner console screens and Pajak navigation group** (T-66/T-62); **earnings statements, invoice exports, `tax_document_sequence` allocation and the `tax.statement.generate` job** (T-71): not built. The tables, document guards and sequence table exist.
- **Production keys**: `KEYRING_TAX_IDENTITY` / `IDENTITY_FINGERPRINT_KEY` values, key custody and the JOB-23 `integration.reseal` worker registration (the `resealTaxIdentity` building block is tested; the job kind, schedule and `platform_job_kind` row belong to the job's owner). `.env.example` and DEPLOY-COOLIFY were not touched.
- **PRIV-10 notice text and `identity_capture_enabled` switch-on** (OPEN-T9, privacy owner): the flag is OFF; `appendTaxSetting` already refuses switching it on without a `noticeApprovalRef`.
- **Statutory retention period** for referenced identity versions (OPEN-T18): withdrawal keeps a referenced version intact and records no duration.
- **`restricted` class for the tax tables** and definer-only access: T-59b.
- **Store (seller) identities and PKP fields**: columns exist per DATA-15; no capture flow (dormant until `pkp_gate_enabled`, T-75/T-67).

## Doc changes for the conductor

- **05-DATA-MODEL DATA-15**: tier A tables exist (status Implemented locally); add: `tax_setting.notice_approval_ref` (required when `identity_capture_enabled`), `tax_identity.fingerprint_key_id`, `tax_computation.source_id` is `uuid`, withdrawn identities keep `id_last4` and null the sealed columns, policy versions start as `draft`, the advisory-lock fallback replaced the exclusion constraint (reason: no superuser bootstrap for `btree_gist`), `tax_identity_reseal(...)` definer, and the isolation classes (`affiliate` for `tax_identity` and `tax_document`, `platform` for the rest, no app INSERT on `tax_identity`).
- **ADR-0012 sections 5 and 8, BILL-9 W1/W2/W3**: status of the foundation (Implemented locally); note that the foundation refuses withholding outside test runtimes.
- **ADR-0005 amendment / T-59 report**: registry grows by ten tables and one definer function.
- **TASKS T-65**: Done locally for slices 1 to 4 except the items under DEFERRED; Notes: migration 0012 section, keys, no `restricted` class.
- **04-SYSTEM-ARCHITECTURE JOB-23**: `resealTaxIdentity` exists; no ARCH-5 route rows change (no route added).
- **DEPLOY-COOLIFY / `.env.example`**: key-format reminder for `KEYRING_TAX_IDENTITY` and `IDENTITY_FINGERPRINT_KEY` (already listed in the table).
- **13-COMPLIANCE-PRIVACY**: `tax_entity_profile.registered_address` is the platform's own address, covered by PRIV-10 (the buyer inventory scan now skips the table).
