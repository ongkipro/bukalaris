# Track report — `jobs` (M2, T-32)

Branch `m2/jobs`, worktree `~/Projects/bukalaris-wt/jobs`. Scope: durable
outbox + worker for post-commit side effects (SEC-18, TD-3, ARCH-6, D-5); the
transfer payment-instruction call moved onto it.

## What changed

| File | Change |
|---|---|
| `packages/db/src/schema-jobs.ts` | New table `job`: `id`, `kind`, `store_id` (FK store), `key`, `payload` (jsonb, CHECK ≤ 4096 bytes), `status` (`pending/running/done/failed`), `attempts`, `next_attempt_at`, `locked_until`, `locked_by`, `last_error`, timestamps. `UNIQUE (kind, key)` = idempotency key; partial index `job_claim_idx (next_attempt_at, id) WHERE status in ('pending','running')` for the claim scan; `job_store_idx`; CHECK `job_lock_chk` ties `running` to a non-null lease |
| `packages/db/src/jobs.ts` | `enqueue(tx, …)` (same transaction as the business write, duplicate `(kind,key)` is a no-op, `pg_notify` on insert), `claimBatch(db, workerId, n)` (`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` with a 60 s lease, reclaims `running` rows whose lease expired), `completeJob`/`failJob` (lease-checked; exponential backoff; terminal `failed` after `MAX_ATTEMPTS`), `runOnce` (claim one batch, run handlers sequentially), handler registry (`registerHandler`/`getHandler`), `sanitizeError`, and the `payment.instruction` handler |
| `packages/db/src/checkout.ts` | **Shared-file edit (allowed for this track):** `placeOrder` enqueues `payment.instruction` (`key = order:<id>`, payload `{ orderId }`) inside the order transaction for `manual_transfer`; the inline post-commit `ensurePaymentInstruction` is removed. Public signature and every other behaviour unchanged |
| `packages/db/src/worker.ts` | Long-running process `node src/worker.ts [--once]`: claims in a loop, idles for `WORKER_POLL_MS` (default 2000, clamped 100–30000) or until a `LISTEN bukalaris_jobs` notification, `WORKER_BATCH` (default 10); SIGTERM/SIGINT finish the batch in flight and stop claiming; JSON-line logs (`started`, `job`, `poll_failed`, `stopping`, `stopped`; never secrets or buyer data); a database that is unreachable or not yet migrated delays the worker instead of killing it (`--once` exits 1 in that case) |
| `packages/db/package.json` | script `worker`: `node --env-file-if-exists=../../.env src/worker.ts` |
| `packages/db/drizzle/0002_same_lyja.sql` + meta | Generated with `pnpm db:generate`; the orchestrator regenerates one consolidated migration at merge |
| `packages/db/test/jobs.test.ts` | 8 integration tests (below) |
| `packages/db/test/checkout.test.ts` | One assertion adapted: the transfer test now expects `paymentReference: null` right after `placeOrder`, runs `runOnce(db, { workerId: "test" })`, then expects `FAKE-AL-<id>`; the provider-failure half runs the worker with the failing provider and still expects `null` |
| `packages/db/test/orders.test.ts` | **Outside ownership (orders track), minimal:** the `placed()` helper runs `runOnce` after `placeOrder` because `getOrder` detail test asserted the synchronous transfer reference |
| `apps/web/playwright.config.ts` | **Outside ownership (web config), minimal:** `webServer` is now an array; the second entry runs the worker (`node ../../packages/db/src/worker.ts`, `DATABASE_URL = E2E_DATABASE_URL`, `WORKER_POLL_MS=1000`, readiness = stdout `"event":"started"`). Needed because `apps/web/e2e/orders.spec.ts:90` asserts `FAKE-AL-<id>` on the seller order detail, which the worker now produces |

No edits to `index.ts`, layouts, Dockerfile, root configs, `seed.ts` or e2e specs/helpers.

## Decisions and defaults

- **Atomic intent.** `enqueue` takes the caller's `tx`; a rolled-back order leaves no job. The `pg_notify` runs inside the same transaction, so it is only delivered on commit.
- **Idempotency key** = `(kind, key)`, `key = order:<orderId>` for payment instructions. A duplicate enqueue returns `{ created: false }` and keeps the first payload.
- **Payload rules.** Ids and enum-like scalars only; the handler re-reads the database. No buyer name/phone/address, no amounts, no secrets. Enforced size ceiling 4096 bytes (`job_payload_chk`).
- **Lease** 60 s (`LEASE_MS`), set with the database clock (`now()`). A `running` row whose `locked_until` has passed is claimable again; `completeJob`/`failJob` only apply when `(status = running AND locked_by = me)`, so a late worker that lost its lease changes nothing ("lost"). Provider adapters must time out below the lease; there is no heartbeat/lease extension (`// lazy` ceiling: add one if a handler ever legitimately runs longer than 60 s).
- **Backoff** `min(5 s × 2^(attempts−1), 15 min)` → 5 s, 10 s, 20 s, 40 s, 80 s, 160 s, 320 s, 640 s, 15 min; **`MAX_ATTEMPTS` = 10** (about 36 min of retries), then terminal `failed` with `last_error`. Failed rows stay for inspection; there is no requeue UI yet (ops track / later).
- **`last_error`** is the root-cause message only (Drizzle's "Failed query: <sql>" wrapper is unwrapped), whitespace folded, `token=/key=/secret=/password=/Bearer …` values redacted, truncated to 500 chars. No stack traces.
- **Claim** uses one statement: `UPDATE job … WHERE id IN (SELECT id … ORDER BY next_attempt_at, id LIMIT n FOR UPDATE SKIP LOCKED) RETURNING *`, increments `attempts` on claim. Jobs in a batch run sequentially; concurrency comes from running more worker processes.
- **Unknown kind** (handler not registered, e.g. older worker image) fails like any error and retries with backoff, so a newer worker can pick it up.
- **Payment handler** (`payment.instruction`): skips when the order is missing, not `manual_transfer`, already has a reference, or is no longer `awaiting_payment` (e.g. cancelled before the worker ran); otherwise calls `PaymentAdapter.createInstruction` with the stable `orderId` and sets `payment_reference` only `WHERE payment_reference IS NULL`. A re-run after a crash therefore never requests a second instruction. Until the worker runs, the order is the explicit pending state of D-5 (no reference; the confirmation page already says "instruksi sedang disiapkan").
- **Wake-up.** The worker `LISTEN`s on `bukalaris_jobs`; measured wake latency ~30 ms with a 30 s poll (smoke run). Polling remains the bounded ceiling if a notification is lost.
- **Resilience.** Worker start does not require the database (Playwright starts `webServer`s before `globalSetup` creates the fresh e2e database); each failed poll logs `poll_failed` and waits one poll interval.

## Worker deployment (not done here)

Same image, different command: `node packages/db/src/worker.ts` with the same
`DATABASE_URL` as the web container (the Dockerfile is owned by the release
track; this track did not edit it). Suggested target: a `worker` service in
Coolify/compose running the web image with that command, one replica to start
(more replicas are safe: `SKIP LOCKED` + lease + idempotent handlers). Stop
signal SIGTERM; the worker exits after the batch in flight. Optional env:
`WORKER_POLL_MS`, `WORKER_BATCH`. For cron-style use: `pnpm --filter @bukalaris/db worker --once`.

## Commands run (worktree root, 2026-10-06)

| Command | Result |
|---|---|
| `pnpm db:generate` | `drizzle/0002_same_lyja.sql` generated (table `job`, 2 indexes, 1 FK) |
| `pnpm db:migrate` (dev DB `bukalaris_jobs`) | `migrations applied` |
| `pnpm --filter @bukalaris/db worker --once` (dev DB) | `started` → `stopped`, exit 0 |
| long-running smoke against `*_test` (scratch script: start worker with `WORKER_POLL_MS=30000`, enqueue in a tx, SIGTERM) | job handled 34 ms / 29 ms after commit via NOTIFY; events `started,job,stopping,stopped`; exit 0 |
| worker `--once` against a non-existent database | `poll_failed … database "does_not_exist" does not exist`, exit 1 |
| `pnpm lint` | pass (0 problems) |
| `pnpm typecheck` | pass (db + web) |
| `pnpm test` | **42 passed** (34 existing + 8 `jobs.test.ts`), 5 files; run 4 times: 3 × 42/42, 1 × 41/42 (see flake below) |
| `pnpm build` | pass |
| `pnpm e2e` | **14 passed** (1.3 min), worker running as second `webServer`; `orders.spec.ts` transfer-reference assertion satisfied by the worker |

`jobs.test.ts` covers: enqueue rolled back with the business transaction / committed with it; duplicate `(kind,key)` no-op, another kind with the same key is separate, payload > 4 KB rejected by CHECK; 3 concurrent claimers over 20 jobs receive disjoint sets (8/8/4), leased jobs invisible to a 4th claimer; crash mid-job (handler ran, `completeJob` never called) → lease held: second worker sees nothing; lease expired: reclaimed, handler skips the provider (1 call total), job `done`; the late worker's `complete`/`fail` are no-ops; backoff per attempt (5 s, 10 s, …), `attempts`/`last_error`/unlocked state after each failure, terminal `failed` at attempt 10 and not claimable, unknown kind fails with a clear error; `sanitizeError` redaction/truncation; payment end-to-end: COD enqueues nothing, transfer stays pending without reference while the provider is down (attempt 1 failed, not due again until backoff), succeeds on retry (`FAKE-AL-<id>`, 2 provider calls), re-run is a no-op; cancelled-before-worker order gets no provider call and the job completes.

## Open issues / notes for the orchestrator

- **Pre-existing flaky test (orders track):** `orders.test.ts` › "two concurrent cancels (and a racing process) restock once" expects exactly one fulfilled transition, but `TRANSITIONS.cancel.from` includes `processing`, so whenever `process` wins the row lock first a following `cancel` legitimately succeeds too (2 fulfilled, 2 history rows). Failed once in 4 runs here, independent of this track (COD order, no job). Fix belongs to the orders track (e.g. assert `ok.length` ∈ {1, 2} with consistent stock/history, or race two cancels only).
- Two files outside this track's ownership were edited minimally (listed above): `apps/web/playwright.config.ts` (worker as second `webServer`) and `packages/db/test/orders.test.ts` (`placed()` runs the worker once). Both were required by the orders track's assertions of a synchronous transfer reference.
- Worker deployment (service/command in Coolify, Dockerfile target) belongs to the release/integration step; no Dockerfile change here.
- Scheduling cart cleanup and other periodic jobs is T-30 (the outbox has no cron/schedule concept; a periodic enqueuer or `--once` on a timer would be the path).
- No UI for `failed` jobs (seller or Super Admin); the `job` table is the inspection surface for now. Rows are kept indefinitely (no retention) — pair with T-33 decisions.
- Migration `0002_*` is branch-local; regenerate at merge as planned.
- The e2e run rewrote the PNGs in `docs/evidence/m1/` (byte-level re-renders); they were restored to HEAD and not committed.
