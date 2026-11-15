## ADR-0005: Database-enforced tenant isolation with PostgreSQL RLS

- **Status:** Original decision (sections Context to Consequences): Accepted (implemented) — 2026-10-07, branch `m2/rls`, evidence in `docs/tracks/rls.md` (all gates green: Vitest 137, Playwright 72 + 2 skipped, verify:docker 26 policies). Amendment of 2026-10-27 (last section): **Accepted by the owner on 2026-10-28 (DECISIONS D-20, task T-59)**, not implemented yet. Implementation notes that refine §2/§4: `job` and `audit_log` carry the policy too; roles are created by a superuser bootstrap (`packages/db/docker/05-roles.sql`, DBA step in production), not by a migration, because BYPASSRLS requires a superuser; `bukalaris_owner` has BYPASSRLS so backfills in migrations see every row; no default table privileges for `bukalaris_app` (fail closed, test-enforced).
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
Owner console (`OperatorScope`), the outbox worker, cleanup jobs, Better Auth
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

## Amendment (Accepted 2026-10-28; expand step implemented locally 2026-10-28, contract step open; proposed 2026-10-27): platform-owned tables and narrow platform grants

Status: Accepted (owner, 2026-10-28, DECISIONS D-20, task T-59). The expand step is implemented locally (working tree on 2026-10-28: isolation registry, platform role and grants, migration 0011; `docs/tracks/t59-rls.md`); the contract step (revokes, T-59b/T-59c) is open. Until it lands, the original decision above and the expand-step grants are both in force.

Why: ADR-0008, ADR-0009 and ADR-0010 add tables that belong to no seller (buyer identity, affiliate, subscription). The code review of 2026-10-27 (`docs/reviews/2026-10-27-code-vs-spec-gap-report.md`, `CRSEC-03`, `CRSEC-08`, `CRSEC-13`) found that the policy model and its test only know `app.store_id`, that `bukalaris_platform` holds every grant including future tables and serves public storefront lookups, and that decision 2 above describes `system_log` wrongly: it has a `store_id` column and deliberately no RLS because it is written before a store context exists. `CRSEC-02` adds that the app role can read and write the shared auth tables. The documentation audit of 2026-10-27 (audit SPV-01, SPV-02) found that "restricted tables reachable only by named functions" cannot be enforced while one BYPASSRLS login serves public lookups: PostgreSQL grants attach to roles, not to code.

Decisions (Proposed):

1. **Per-table isolation registry** replaces the blanket "RLS iff the table has `store_id`" rule. Each table is registered exactly once as `tenant` (store policy), `buyer` (own-buyer policy), `affiliate` (own-affiliate policy), `platform` (no app-role access except explicit grants), `restricted` (platform tables reached only through the functions of decision 4), `auth` (decision 6) or `shared-read`. The invariant test asserts that every table is registered and that its policy and grants match its class, instead of inferring the class from a column name.
2. **New transaction-local contexts** `app.buyer_id` and `app.affiliate_id`, set like `app.store_id` through helpers (`withBuyer`, `withAffiliate`), fail closed on a missing setting, and are never accepted from a browser value. A table that carries `store_id` only as provenance (`buyer_order_link`, `affiliate_catalog`) follows its own class policy, and the registry records `store_id` as provenance, not as the tenancy key.
3. **Append-only logs** (`audit_log`, buyer identity events) get their own policy that allows store-less rows from defined writers; today the `audit_log` policy rejects them from the app role.
   - **Limit of the GUC contexts (independent review, 2026-10-28).** `app.store_id`, `app.buyer_id`, `app.affiliate_id` and `app.audit_writer` are transaction settings that any SQL running as `bukalaris_app` can set. They stop application bugs (a missing filter, the wrong store, a leaked pooled connection), not an attacker who can already run arbitrary SQL as the app role; against that threat the defence is the absence of a raw-SQL surface and the closed grants on restricted tables. Consequence accepted for now: such a session can also insert (never read, update or delete) store-less `audit_log` rows. Replacing the audit setting by a definer insert function is tracked as T-59c.
4. **Enforceable narrowing of the BYPASSRLS login.** A grant to `bukalaris_platform` is a grant to every statement that login can run, so "named functions" are enforced by the database, not by code review:
   - **Restricted tables** (affiliate tax identity, bank snapshots, seller and affiliate payouts, buyer identifiers and identity events, operator grant, approval and break-glass tables, tax tables) are owned by the **no-login** role `bukalaris_restricted` (class `restricted` for the platform role). `bukalaris_platform` holds **no table privilege** on any of them, and default privileges for future tables exclude it. `bukalaris_app` holds privileges only where the table's own class needs them: RLS-bound own-buyer and own-affiliate grants for the `buyer` and `affiliate` classes (the portals run on the app pool), none for platform-only tables such as payouts, bank snapshots, tax and operator tables.
   - Access is only through `SECURITY DEFINER` functions owned by `bukalaris_restricted` with `SET search_path = pg_catalog, public`, schema-qualified names, fixed statements (no dynamic SQL), explicit target arguments and no `SELECT *` return of whole tables. `EXECUTE` is revoked from `PUBLIC` and granted per function: the worker functions to `bukalaris_platform`, the narrow read functions of the buyer and affiliate services to the role that serves them. Data a seller or buyer legitimately sees about itself (for example a store's own payout list, with masked bank fields) is read through a registered function that takes the transaction-local `app.store_id` or `app.buyer_id` and returns only that owner's rows, so the app role still holds no table privilege on payouts. The grant registry lists every function with its grantee and caller.
   - **Public host and store lookups move off the BYPASSRLS pool.** The cross-store resolvers (host or slug to store, custom domain to store, cart to store, channel token prefix to store, handoff code to store, invitation token to store, order link to order) become `SECURITY DEFINER` functions owned by a second no-login role `bukalaris_resolver` (BYPASSRLS, created in the same superuser bootstrap, owner of nothing else) and granted `EXECUTE` to **`bukalaris_app`**. They return only the resolved store id, slug and status, never row data, and the request continues on the app pool with `app.store_id` set. A SQL injection in a storefront lookup therefore reaches only these functions with an injected argument, not payouts, bank snapshots or buyer identifiers. `bukalaris_platform` is then used only by `OperatorScope`, the worker and cleanup process, and the named platform services below.
   - The two no-login roles are not login roles, so ADR-0008 section 6 ("no fourth login role") stands. The exact `ALTER ... OWNER`, `GRANT` and role-SQL mechanism is recorded by T-59 in `05-roles.sql` and the DEPLOY role step; the requirements above are not optional.
   - **Alternative kept as fallback, not adopted:** a separate low-privilege lookup login (`bukalaris_lookup`, NOBYPASSRLS, `SELECT` on a small `host_directory` table kept in sync with `store`). Rejected as the primary design because it adds a fourth login credential, a duplicated directory that must be synchronised on every slug, domain and status change, and a second place where tenancy rules live; revisit only if the function-based resolvers prove unworkable in T-59.
   - **Residual risk, stated:** web and worker share the `bukalaris_platform` login, so a compromised web process holding `PLATFORM_DATABASE_URL` can call every worker function. Mitigation: functions take explicit targets, check state and are idempotent, and the platform pool is reachable only from operator and worker code (import-boundary test). A separate worker login is OPEN (recommended, not decided: adopt it at T-59 if any worker function moves money without a second state check).
5. **Correction** to decision 2: `system_log` has `store_id` and no RLS by design; the app role can insert log rows under any store id, which is an accepted ceiling to be re-evaluated in T-59.
6. **Auth tables.** The Better Auth tables `user`, `account`, `session`, `verification` and `two_factor` are registered in class `auth` and are shared by operator, seller, affiliate and buyer identities today, and the app role can read and write them (`CRSEC-02`): compromising the app role would allow overwriting an operator's password hash or clearing a second factor. Recommended, not decided (OPEN for the security owner, decided in T-59 together with the per-surface auth instances of T-51 and ADR-0008): **operator identities get a separate auth instance with its own tables** (`operator_user`, `operator_account`, `operator_session`, `operator_verification`, `operator_two_factor`, or the adapter's table-name options), class `restricted`, with no grant to `bukalaris_app`, used only on the platform pool by the Owner console. Seller, affiliate and buyer auth tables stay on the app role in class `auth`: column-level grants (no write to `two_factor` secrets or `account.password` from any code path except the auth adapter module), `verification` rows hold hashed tokens only, and the residual risk that an app-role compromise can alter seller, affiliate or buyer credentials is accepted and mitigated by the bank-change step-up, notification and hold rules (IAM-9, IAM-13). The alternative of one adapter role with a dedicated login is rejected for now (fourth login). `membership.ts` session revocation after a membership change (`revokeSessionsIfOrphaned`) is a named platform-pool operation until decided.

Callers of the platform pool after this amendment (replaces the earlier proposal to add `storefrontScope`, `sellerContext` and the post-commit platform call to the resolver list): `OperatorScope`; the worker and cleanup process; the named platform services (buyer identity resolution `buyer.resolve`, affiliate commission and payout workers, billing and tax services, the post-commit session revocation in `membership.ts`). `storefrontScope`, `sellerContext` and every cross-store resolver run on the app pool through the `bukalaris_resolver` functions. Not changed: the three login roles, tenant RLS on every seller table, the transaction-local context.

Consequences: T-59 must land before T-52 and T-57; every new table needs a registry entry in the same migration; the existing 186-test suite must stay green under the app role; a test proves that `bukalaris_app` and `bukalaris_platform` hold no privilege on restricted tables and that every restricted-table access path is a registered function. A database restore must reapply owners, grants and function privileges (12-SECURITY SEC-23).

## Implementation note — 2026-11-04, T-81 (verified locally)

D-24 accepted a bounded app-role hardening, not a new role architecture: the tenant-root `store` entry retains tenant SELECT and grants UPDATE only on `description`, `name`, `theme` and `whatsapp`. Identity (`id`, `slug`, `created_at`) and lifecycle (`status`, `suspended_at`) are not app-writable. The existing strict settings service already fits that allowlist; governed platform suspension/reactivation and its timestamp trigger are unchanged.

Migration `0017_t81_store_column_grants.sql` revokes table UPDATE before granting the four columns, atomically through the existing migrator. PostgreSQL table REVOKE also removes corresponding column grants. The registry's existing `appColumns` mechanism declares the allowlist; Docker/restore parity must compare effective column privileges, including table/PUBLIC/inherited privileges, not only table ACLs. The pending T-59 platform GRANT block regenerates identically and is not applied by T-81.

Compatibility requires all settings writers to stay within the four fields; unknown older writers must be upgraded or stopped before rollout. Prefer application rollback that retains the allowlist; emergency grant widening needs a separate explicit security decision. This control does not authenticate GUC settings, repair SQL injection, separate operator auth identities, or remove the shared platform-pool risk documented above. Fresh/populated migration and idempotence, denial/positive paths, Docker parity/health, full DB tests and independent review passed locally. A deliberate broad-grant mutation failed the named denial test; exact-source restoration and the focused restored pass were verified. This is not production rollout approval. Evidence: `tracks/t81-store-column-grants.md`.
