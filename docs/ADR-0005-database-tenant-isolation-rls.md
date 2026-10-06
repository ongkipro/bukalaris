## ADR-0005: Database-enforced tenant isolation with PostgreSQL RLS

- **Status:** Proposed (design for T-27; implement after wave 2b merges)
- **Date:** 2026-10-07
- **Author:** M2 orchestrator
- **Deciders:** Bukalaris architecture + security owners
- **Owner:** Bukalaris security owner
- **Supersedes:** the RLS ceiling in DECISIONS D-4

## Context

Tenant isolation is enforced in application code: every store-owned query goes
through scope objects from `packages/db/src/scoped.ts` and child rows carry
compound `(store_id, …)` foreign keys (D-4). TEN-3 and 05-DATA-MODEL require
defence in depth: the database must refuse cross-store rows even if a future
query forgets its `store_id` predicate. Today the app connects as the table
owner, which bypasses RLS.

Access paths that legitimately cross stores exist and must keep working:
Super Admin (`OperatorScope`), the outbox worker, cleanup jobs, Better Auth
tables, the cart-capability lookup (`openCartStore` resolves a store from a
cart id), channel-token authentication (resolves a store from a token prefix),
order-status links and handoff exchange.

## Decision

1. **Three roles.** `bukalaris_owner` owns schema and runs migrations only.
   `bukalaris_app` (LOGIN, NOBYPASSRLS, not owner) serves all tenant-scoped
   requests. `bukalaris_platform` (LOGIN, BYPASSRLS) is used only by
   `OperatorScope`, the worker/cleanup process and the small set of
   cross-store resolvers listed above. Two connection pools in the web app
   (`DATABASE_URL` → app, `PLATFORM_DATABASE_URL` → platform); the worker uses
   only the platform URL. Migrations use `MIGRATION_DATABASE_URL` (owner).
2. **Policies.** Every table with a `store_id` column gets `ENABLE` + `FORCE
   ROW LEVEL SECURITY` and one policy `USING (store_id =
   current_setting('app.store_id', true)::bigint) WITH CHECK (same)`. The
   `store` table itself: `id = current_setting('app.store_id', true)::bigint`.
   A missing setting yields NULL and therefore zero rows (fail closed).
   Tables without `store_id` (Better Auth, `platform_operator`,
   `operator_grant`, `system_log`, `job`, `rate_limit`, `mail_outbox`) stay
   without RLS and are only reachable through code paths that already
   authorize them; `GRANT`s to `bukalaris_app` are limited to what those paths need.
3. **Context setting.** Scope constructors keep their signatures; every
   store-scoped operation runs inside a transaction that first executes
   `select set_config('app.store_id', $1, true)` (transaction-local, so pooled
   connections never leak context). A helper `inStore(scope, fn)` wraps this;
   services that already open transactions call it instead of
   `exec.transaction`. Reads outside a transaction are moved into one.
4. **Cross-store resolvers** (cart → store, token → store, handoff code →
   store, order link → order) run on the platform pool, return only the
   resolved store id/slug and never row data of another store, then the
   request continues on the app pool with that store context.
5. **Proof.** The whole Vitest suite runs with the app pool as the
   `bukalaris_app` role. New tests: a store-owned query without context
   returns 0 rows; an insert with a foreign `store_id` is rejected by the
   policy; the platform pool is not reachable from storefront/seller code
   (lint rule or import boundary test).

## Alternatives considered

- *Session variables without transactions* — rejected: postgres.js pools
  connections, so a session-level setting could leak to another request.
- *One role with a `app.bypass` flag* — rejected: a single SQL injection could
  set the flag; BYPASSRLS on a separate login confines the blast radius.
- *Schema-per-tenant* — rejected: migrations ×N, no shared catalog for the
  future marketplace (ADR-0001).

## Consequences

- **Positive:** a forgotten `store_id` predicate returns nothing instead of
  leaking; cross-store writes fail in the database; the privileged surface is
  an explicit, small list of functions.
- **Negative:** two pools and three credentials to operate; every store-scoped
  read pays one `set_config` round trip inside a transaction; Docker/Coolify
  config gains `PLATFORM_DATABASE_URL` and `MIGRATION_DATABASE_URL`.
- **Neutral:** application-level scoping (D-4) stays; RLS is the second wall.
