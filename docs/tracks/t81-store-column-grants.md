# T-81 — Application store-column grants

Status: **Done locally (2026-11-04)**. Technical hardening accepted in D-24; this is not a demonstrated browser exploit. Local work only. No production migration, provider activation, push or deployment is authorized by this task.

## Boundary and invariant

`store` has nine columns. After migration, `bukalaris_app` retains its tenant-scoped SELECT and may UPDATE only `description`, `name`, `theme` and `whatsapp`. It must not UPDATE `created_at`, `id`, `slug`, `status` or `suspended_at`, even for its own store. Intended platform suspension/reactivation, timestamp synchronization and audit must keep working.

RLS remains necessary: the metadata grant must not make another store visible or writable under the current store context. Transaction-local GUCs are not protection against an attacker who already controls arbitrary SQL (ADR-0005 amendment); the protected-column denial is a separate role-wide barrier.

## Writer inventory

| Writer | Connection / scope | Written fields | Compatibility |
|---|---|---|---|
| `src/storefront/content.ts:updateStoreSettings` | `SellerScope`, app pool, `settings.manage`, strict settings input and `inStore` | `name`, `description`, `whatsapp`, `theme` | Existing code already writes exactly the proposed allowlist; no dual-write or caller change needed. |
| `src/platform/platform.ts:setStoreStatus` | `OperatorScope`, platform pool, governed `tenants.manage` transaction | `status`; `store_suspension_sync` synchronizes `suspended_at` | Platform grants and trigger remain unchanged. |
| Migration `0013_chain_a_wave3.sql` | Owner migrator; historical backfill | `suspended_at` | Existing migration remains append-only and unchanged. |

Repository search found no store UPDATE upsert. Both explicit runtime store INSERT paths are platform store-creation services, not seller settings; initial insert and subscription bootstrap are unchanged.

## Implementation

- Reused the existing `appColumns` registry mechanism; removed table-wide app UPDATE and declared the four sorted column UPDATE grants. Keep table SELECT, tenant policy and platform grants unchanged.
- Appended permission-only migration `0017_t81_store_column_grants.sql` through pinned `pnpm --filter @bukalaris/db generate --custom --name=t81_store_column_grants`. REVOKE UPDATE first, then GRANT the four columns in the existing migration transaction. PostgreSQL 17 REVOKE removes corresponding column grants too; granting first would be incorrect.
- Extended the existing shell registry check to compare effective column privileges against the registry, so the Docker/restore gate cannot pass on table-level parity alone. The RLS suite executes that actual SQL without Docker and deliberately introduces both an unauthorized column grant and a missing required grant, restoring each in `finally`.
- Regenerated all **111** pending T-59 platform GRANT statements from `registryRows()` in memory: exact match, so the pending file is unchanged. No gated production contract was applied.
- No structural schema/table, API route, UI, dependency, new role or SECURITY DEFINER function changed. Generated snapshot comparison confirms only snapshot identity/chain metadata changed; journal is append-only with increasing timestamp. Existing platform/settings application writers need no change.

## Expand/contract and recovery plan

The current seller settings implementation is already compatible with the narrowed role. The new migration does not remove data or rename fields; its revocation/regrant is atomic through the existing runner. Verify the current web writers before migration; any unknown older writer that sends protected fields must be upgraded or stopped first. Local proof is not production rollout approval.

The independent T-59 platform-role contract remains parked and gated; it is not a dependency implicitly executed by this app-role change. Its existing scratch-only contract suite may still verify compatibility.

Recovery must not silently restore table-wide app UPDATE. Prefer compatible application rollback with the four-column grant preserved. Any emergency grant widening requires an explicit security decision and invalidates T-81 protection until restored and reverified.

## Verification ledger

- Existing RLS/contract/content/lifecycle baseline: **PASS, 4 files / 75 tests, 32.50 s**, on `bukalaris_t81_test` before source changes. Pinned offline install reused all 640 packages with no manifest/lockfile changes.
- Named pre-fix regression `app cannot UPDATE protected store column status on its own or another store (T-81)`: **failed as expected**, promise resolved `[]` rather than rejecting (5.53 s). Read-only aggregate inspection afterward confirmed one active and one suspended fixture store: the own-store status UPDATE really executed.
- Deliberate post-fix mutation appended a table-wide app UPDATE grant to the new migration after the full suite completed: the same named status-denial test **failed as expected** (resolved `[]`, not a permission rejection). Restored the original migration under an EXIT trap and verified **all six source/migration SHA-256 fingerprints match**. Restored focused gate **PASS: 4 files / 82 tests, 68.15 s**. No source change remains from the mutation; its isolated test schema was recreated by the restored run.
- First post-fix focused run: **81 passed / 1 failed**, 4 files, 50.29 s. All non-identity denials, effective-column drift mutations, settings, RLS and platform/contract paths passed. The identity case used invalid `id = id` on a GENERATED ALWAYS column, so PostgreSQL returned rewrite-time `428C9` before the expected ACL rejection. Changed only that test expression to valid `id = DEFAULT`; the corrected focused rerun **PASS: 4 files / 82 tests, 43.67 s**. Lint and both DB/web typechecks then **PASS**. The initial chained lint/typecheck commands had not executed because the tests failed.
- Populated-clone first check: **blocked before applying T-81**, because `suspended_at` is absent. Catalog/journal inspection proves the original dev copy is legitimately at migration 0009 (42 tables, 10 journal entries through 2026-10-07), not the current 0016 baseline. The initial shell parity check also reported the expected old-schema differences; these are not new T-81 regressions. Prepared only the disposable copy through the unchanged accepted `dd7511e`/0016 migrator: **PASS**, 17 journal entries, original **6 stores / 55 products / 64 orders preserved**. Original dev remains untouched; no historical migration or journal entry was edited. The new T-81 migration then **PASS** through the canonical runner, as did its idempotent rerun: journal **17 → 18 → 18**, counts **6/55/64** and protected-store-field checksum unchanged, table-wide app UPDATE gone, exactly four effective UPDATE columns. Complete registry parity on the upgraded populated copy **PASS**.
- Docker gate `IMAGE_TAG=t81-store-column-grants pnpm verify:docker`: **PASS**, 154403 ms; web 318 MB, migrate 283 MB. Actual migrator applied and reran on fresh disposable DB: **133 public tables, 75/75 policies, 0 registry differences** including effective column grants. HTTP health 200, unknown storefront 404, login 200; HEALTHCHECK healthy, non-root `app`, media writable. Script removed only its generated container/volume/DB. This also proves the production web build; corrected focused DB/static rerun also passed. Full DB **PASS: 74 files / 1400 tests, 873.31 s**, on separate `bukalaris_t81_full_test`, before the controlled mutation. The subsequent explicit mutation failed and exact-source restored focused pass succeeded as recorded above. No worker/cleanup runtime proof or full E2E is implied.
- Independent read-only R4 security/migration review: **no actionable P0/P1/P2 source findings; OK with notes**. Reviewer independently traced both writers, grant/trigger compatibility, migration transaction/order, effective privilege coverage, and Bash/Node 24 CI compatibility. Runtime evidence remains the parent's responsibility. Independent closure review of `id = DEFAULT` also returned no issues: valid identity syntax, mandatory `42501` for both stores, full-row preservation assertion retained.
- Map/spec/traceability/diff guards: **PASS**, 14 map fixtures; 102 routes / 124 current rows / 117 Implemented; 50 API paths / 63 operations; 107 docs / 330 declarations / 94 tasks / 0 findings. No map row changed: this task changes an existing DB authorization boundary, not route/job ownership. TEN-3, SEC-23/threat boundary and an appended ADR-0005 implementation note carry the contract. Final guard rerun PASS with the same counts. Scoped staged review covered all 13 task files; redacted Gitleaks 8.30.1 staged scan **PASS**, 604183 bytes, no leaks. Final independent documentation-consistency review found no issues and returned OK with notes; its runtime caveats remain bounded by the parent-run evidence above.

## Source checks

- Installed Drizzle versions: `drizzle-orm` 0.45.3, `drizzle-kit` 0.31.11.
- PostgreSQL 17 `REVOKE`: <https://www.postgresql.org/docs/17/sql-revoke.html> (table-level revocation also revokes corresponding per-column privileges; table grants cannot be narrowed by revoking one column).

## Current limitations

TypeScript LSP initialization still cannot resolve a valid TypeScript installation; configure a valid `tsserver.path` before claiming LSP coverage. Package-script DB/web typechecks passed independently. No global LSP/runtime configuration change is in scope.

An optional additional staged-scope/fingerprint/schema assertion was blocked before execution by Safety Net's sensitive-basename detection in its exclusion guard. It was not retried or bypassed. The earlier working-tree fingerprint and normalized snapshot checks passed; scoped staged diff review and the separate staged secret scan passed. No environment-file read was attempted or performed.

The task's local runtime gates and independent source/closure reviews are complete. Nothing in this report is a production-readiness or deployment claim: no full application E2E, worker/cleanup container execution, production rollout or T-59 production contract was performed. Original dev is still untouched; migration proof used disposable databases. Only the T-81 source, generated migration metadata and canonical evidence documents belong to its local commit; runtime artifacts and pre-existing screenshots do not.
