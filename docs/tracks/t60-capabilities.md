# T-60 — Platform capability grants for the Owner console (track `t60-capabilities`)

Local, uncommitted work in an isolated copy (Goal Mode, D-20, D-21, D-22). Nothing deployed, no provider called.
Result per slice: see "Status" and "DEFERRED".

## What changed

### Database package (`packages/db`)

| File | Change |
|---|---|
| `src/ops/schema-ops.ts` | Single source of truth in code: `CAPABILITY_CATALOGUE` (every IAM-15 name with phase), `FOUR_EYES_MATRIX` (24 action keys), `BREAK_GLASS_ALLOWLIST`, `SENSITIVE_CAPABILITIES`, `LAST_HOLDER_PROTECTED`. Tables: `operator_grant` (+ `expires_at`, CHECK from the catalogue), `operator_grant_event`, `four_eyes_rule`, `approval_request`, `break_glass_grant`, `session_mfa`, `operator_step_up_proof`. |
| `src/ops/capabilities.ts` | `holdsCapability`, `hasPlatformCap`, `requirePlatformCap` (writes a store-less `operator.denied` audit row, then throws `forbidden`), `operatorCapabilities` (navigation), `requireNonStaffTarget` (accounts.* guard for T-63/T-72), `pgCode`. |
| `src/ops/capabilities-approvals.ts` | `payloadHash` (canonical JSON SHA-256), `requestApproval`, `decideApproval`, `consumeApproval` (takes a `Tx`: `UPDATE ... WHERE status='approved' ... RETURNING`), `expireApprovals`; `recordSessionMfa`, `sessionMfaVerified`; `issueStepUpProof`, `consumeStepUpProof`. |
| `src/ops/capabilities-grants.ts` | `grantCapability`, `revokeCapability` (holders locked `ORDER BY user_id FOR UPDATE`), `grantAsSystem` (seed/bootstrap/recovery), `grantPayload(Hash)`. |
| `src/ops/capabilities-bootstrap.ts`, `src/bootstrap-console.ts` | `bootstrapConsole` and the CLI entry `pnpm --filter @bukalaris/db bootstrap:console -- --holder <email> [--holder …] --runbook "<RUNBOOK entry>" [--recovery]`, run with `MIGRATION_DATABASE_URL` (owner role). `LOCAL_SEED_OPERATOR_CAPABILITIES` = the documented demo grant set. |
| `src/ops/ops.ts` | `hasPlatformCap`/`requirePlatformCap` moved to `capabilities.ts` (clean cutover); re-export of capability names removed (they come from `capabilities.ts`). |
| `src/platform/platform.ts`, `src/storefront/content.ts`, `src/shipping/shipping.ts` | Capability check as the first statement: `listStores` and `getStoreDetail` need `tenants.read`; `storeAudit` and the audit section of `getStoreDetail` need `audit.read` (`audit: null` without it); `createStore`, `createStoreForOwnerEmail`, `setStoreStatus` need `tenants.manage`; `setMarginRule` and `marginRuleAudit` need `shipping.manage`. Log System keeps `logs.read`. |
| `src/seed.ts`, `src/demo/seed-demo.ts` | The demo operator gets `LOCAL_SEED_OPERATOR_CAPABILITIES` through `grantAsSystem` (events `system_bootstrap`). |
| `src/index.ts`, `package.json` | Additive exports; script `bootstrap:console`. |
| `drizzle-pending/t60-capabilities.generated.sql` | Verbatim output of `drizzle-kit generate` (structural SQL). The generated migration and snapshot were deleted and the journal is untouched. |
| `drizzle-pending/t60-capabilities.sql` | Hand-written, idempotent: four-eyes seed, backfill of the pre-T-60 operator powers, REVOKEs, `operator_grant_event_append_only`, `approval_request_guard`, `break_glass_grant_guard` triggers. Apply AFTER the generated file. |
| `test/pending.ts`, `test/pending-setup.ts`, `vitest.config.ts` (`setupFiles`) | Applies both pending files to the scratch test database as the owner role when `four_eyes_rule` does not exist yet; a no-op once a real migration exists. |
| `test/capabilities.test.ts`, `test/capabilities-governance.test.ts` | New tests (below). `test/ops.test.ts`, `test/content.test.ts`, `test/helpers.ts`, `test/rls.test.ts`: small adaptations (below). |

### Web (`apps/web`)

- `src/lib/auth.ts`: Better Auth `hooks.after` writes `session_mfa` after a successful `/two-factor/verify-totp|verify-backup-code|verify-otp` (new session at sign-in/enrolment or the current session on re-verification).
- `src/lib/context.ts`: `operator()` also requires `session_mfa` for the current session (else redirect to `/login?next=/admin`), returns the operator's active capabilities; new `allowed()` turns a `forbidden` into the page's denied state.
- `(operator)/admin`: layout navigation filtered by capability; `access-denied.tsx` (component, not a route); store list, store detail, new store and shipping pages render the denied state; store detail shows "audit.read needed" instead of audit rows.
- `e2e/capabilities.spec.ts`: logs.read-only staff, no-grant staff, MFA-bound session.

No route or handler file was added, so ARCH-5 is unchanged (`pnpm map:check` run, see below).

## Table isolation classes (for T-59's registry)

| Table | Class | Notes |
|---|---|---|
| `operator_grant` | restricted (today platform; the app role has no grant) | existing |
| `operator_grant_event` | restricted | append-only: trigger + no UPDATE/DELETE/TRUNCATE for `bukalaris_platform` |
| `four_eyes_rule` | restricted | no write for `bukalaris_platform` (migration-only) |
| `approval_request` | restricted | no DELETE/TRUNCATE for platform; guard trigger |
| `break_glass_grant` | restricted | no DELETE/TRUNCATE for platform; guard trigger |
| `session_mfa` | platform (auth-adjacent, FK to `session`) | written by the auth hook |
| `operator_step_up_proof` | platform (auth-adjacent, FK to `session`) | |

No new table has `store_id`. None is granted to `bukalaris_app` (test asserts a 42501 on all seven).

## Decisions taken

1. **P2 capabilities are catalogued but cannot be granted** (`dormant` error): IAM-15 marks them dormant until the Compliance center or tax workflows are activated. `P1.5` (`updates.*`) is grantable.
2. **Sensitive set** = every capability of a `four_eyes_rule` row plus `accounts.reveal` and `audit.export`; granting one needs an approved, unused `grant.sensitive` request bound to `{userId, capability, expiresAt}`, requested by the granter, approver neither requester nor grantee.
3. **Last-holder protection** covers `staff.manage` and `break_glass.approve`.
4. **A grant or a revoke deletes all sessions of the affected operator in the same transaction** (the task text says "grant change"); revoking also cancels the operator's open approval requests under that capability (IAM-15).
5. **`consumeApproval` is executed by the requester** (the one who asked runs what the second person approved); nobody else can ride the proof. T-37 can relax this if a flow needs a different executor.
6. **Placeholders under D-22 item 3** (conservative values, not owner decisions): approval validity 24 h per rule (`four_eyes_rule.max_validity`, changed only by a migration), step-up freshness and proof life 300 s (`STEP_UP_WINDOW_SECONDS`).
7. `four_eyes_rule.active = false` for the actions decided disabled in Phase 1 (`merge.execute`, `ownership.recover`) and the P2 or optional ones (`privacy.export`, `audit.export`, `tax.*`, `updates.publish`, the last mapped to phase `P2` because the table only has `P1`/`P2`). `mfa.reset` carries `accounts.support`; the staff-target variant (`staff.manage`) is for the service that implements it.
8. The migration backfills `tenants.read`, `tenants.manage`, `shipping.manage`, `audit.read` for operators that exist before T-60 (exactly the powers they had), with `system_bootstrap` events. `staff.manage` and `break_glass.approve` are never backfilled: the bootstrap command creates the first holders.
9. Denial audit rows go through the pool before the operation's own transaction, so they survive the refusal.
10. A trusted-device sign-in (Better Auth `trustDevice`, never sent by our login form) skips the code, so it has no `session_mfa` row and the console refuses it: strict by design.

## Tests (named, in `packages/db/test`)

`capabilities.test.ts` (36): catalogue equals the IAM-15 table (parsed from the doc); `four_eyes_rule` equals the doc matrix and the constant, includes `cod.manual_complete`/`cod.reconcile_release`/`payouts.reconcile`, excludes `billing.ppn_toggle`; matrix not writable by the platform role, hand-written SQL idempotent; CHECK rejects non-catalogue names; app role denied on all seven tables; **per operation (10 operations × 2)**: no grant and wrong capability refused with no side effect and a denial audit row, right capability works, revoked and expired grants stop on the next call; store-detail audit needs `audit.read`; seller never an operator; seller-payout vs affiliate-payout independence in both directions (service and trigger); break-glass allowlist CHECK, once-only revoke/review, never satisfies four-eyes; `operator_grant_event` source/actor CHECKs and append-only (privilege and trigger); `requireNonStaffTarget`.

`capabilities-governance.test.ts` (26): four-eyes (requester≠approver in service and CHECK, capability of requester and approver, inactive/unknown action, duplicate open request, payload/target/action binding, expiry and sweeper, concurrent approve, single-use consume, rollback un-consumes, approver capability re-check, revoke cancels requests, immutability and legal transitions); **MFA bound to the session**; **step-up proofs** (fresh code needed, bound to session/action/subject/user, single use under 3-way concurrency, rollback, expiry, session end); grant/revoke (needs `staff.manage`, events, sessions revoked in the same transaction and untouched when the revoke is refused, sensitive grants need the bound approval, grantee≠approver rolls back); **last holder** (deterministic lock-queue test, 8× concurrent `break_glass.approve`, 8× concurrent mutual `staff.manage` demotion, actor demoted mid-flight); bootstrap (events, recovery, idempotency, refusal at ≥2 active holders with expired holders ignored, no partial effect).

## Commands run and observed results

All on this copy with `.env` pointing at `bukalaris_t60capabilities{,_test,_e2e}`, `E2E_PORT=3260`.

- `pnpm --filter @bukalaris/db generate` — only to inspect; generated file moved to `drizzle-pending/`, migration + snapshot deleted, journal restored.
- `pnpm lint` — clean. `pnpm typecheck` — clean (db and web).
- `pnpm --filter @bukalaris/db test` — see "Final verification" below.
- e2e (focused, against a temporary migration `0011_t60_tmp` assembled from the two pending files, removed afterwards): `capabilities.spec.ts super-admin.spec.ts accounts.spec.ts` 18/18 passed (both viewports); `ops.spec.ts shipping.spec.ts` 11 passed, 1 skipped (existing skip). `ui.spec.ts` not run: it rewrites tracked evidence PNGs. The evidence PNGs touched by the runs above were restored to the parent's copies.

## Final verification

- `pnpm --filter @bukalaris/db test` (final run): **24 files, 294 tests; 293 passed, 1 failed**. The new files are 62 tests (36 + 26) and all passed in every full run. The one failure is `test/rls.test.ts > role attributes`, which lists every `bukalaris_%` role in the shared cluster: the cluster now also holds `bukalaris_resolver` and `bukalaris_restricted`, created by T-59's parallel work, so the test (owned by T-59) cannot equal its 3-role list; it is not caused by T-60. An earlier full run also showed one timing-sensitive test of mine hitting the 20 s default while the host load average was about 12; the concurrency and expiry describes now carry a 60 s timeout and the expiry test uses 2 s validity, and the file passed three further isolated repeats and the final full run.
- `pnpm map:check`: `system-map: 64 route files in code, 72 map rows (65 Implemented)` ok (no route added).

## DEFERRED

- **Separate operator identity tables** (D-20 item 6): needs T-59's auth-table slice; `operator_grant.user_id` still references `platform_operator(user_id)` → `user`.
- **Grant-management UI** (SA-38/SA-39), **approvals inbox** (SA-28), JOB-12 sweeper wiring: need T-62's shell. The services (`grantCapability`, `revokeCapability`, `requestApproval`, `decideApproval`, `expireApprovals`) are ready and tested.
- **Four-eyes enforcement of `shipping.margin`**: the capability check is in place; making `setMarginRule` require an approved `shipping.margin` request needs the inbox screen and would break the current one-person form. `consumeApproval` is the hook.
- **Break-glass duration CHECK** ("within the PRIV-9 maximum"): the maximum is not decided anywhere (OPEN in 13-COMPLIANCE-PRIVACY). Allowlist CHECK, two-people CHECK, window CHECK and the guard trigger exist; the maximum needs the owner's number.
- **`accounts.*` exclusion of staff**: only the guard `requireNonStaffTarget` exists (no accounts action exists yet); T-63/T-72 must call it first.
- **Platform-role grant tightening for restricted tables beyond the REVOKEs above**, restricted-class ownership and SECURITY DEFINER access: T-59.

## Doc changes for the parent

- **TASKS.md T-60**: Done locally with the evidence above; list the DEFERRED items; note the migration is pending (`drizzle-pending/`).
- **Migration**: build `0011` from `t60-capabilities.generated.sql` then `t60-capabilities.sql` (keep the statement-breakpoints), then delete `drizzle-pending/`, `test/pending.ts`, `test/pending-setup.ts` and the `setupFiles` line in `vitest.config.ts` (the tests then simply find the tables). `capabilities.test.ts` imports `HAND_WRITTEN`/`applyPending` from `./pending.ts` for the idempotency case: delete that case and the import when `pending.ts` goes.
- **05-DATA-MODEL DATA-14**: add `session_mfa` and `operator_step_up_proof`; `operator_grant.expires_at`; `operator_grant_event` also keeps the migration-backfill rows; four-eyes `max_validity` seed (24 h placeholder); `updates.publish` rule is `P2`/inactive; `mfa.reset` row keeps `accounts.support`.
- **07-IAM-RBAC-ABAC IAM-15**: P2 capabilities are not grantable until activated; the sensitive-grant payload `{userId, capability, expiresAt}`; revocation also deletes the operator's sessions; the approval executor is the requester.
- **RUNBOOK** "Console bootstrap and recovery": `pnpm --filter @bukalaris/db bootstrap:console -- --holder <email> --holder <email> --runbook "<entry naming the two people>" [--recovery]`, owner role via `MIGRATION_DATABASE_URL`; refuses at ≥2 active `staff.manage` holders; the accounts must already exist (password hash comes from Better Auth). Notifying `audit.read` holders about bootstrap events is not built.
- **AGENTS.md Commands**: add `pnpm --filter @bukalaris/db bootstrap:console`.
- **ARCH-5**: no new rows. SA-02/SA-03/SA-07 notes: capability per page (`tenants.read`, `tenants.manage`, `shipping.manage`, `logs.read`) and denied state.
- **DECISIONS**: record the D-22-style placeholders (24 h, 300 s) and the P2-not-grantable rule if the owner wants them visible.

## Shared files touched

`test/helpers.ts` (makeOperator + two imports), `test/rls.test.ts` (3 lines, T-59 supersedes), `vitest.config.ts` (`setupFiles`), `packages/db/package.json` (script), `src/index.ts` (exports), `src/schema.ts` untouched (it already re-exports `schema-ops.ts`), `src/platform/platform.ts`, `src/storefront/content.ts`, `src/shipping/shipping.ts` (capability checks), `src/seed.ts`, `src/demo/seed-demo.ts`, `apps/web/src/lib/auth.ts` (hook only).
