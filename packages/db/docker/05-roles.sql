-- Database roles for tenant isolation (ADR-0005, T-27). Cluster-level, idempotent.
--
-- LOCAL DEVELOPMENT ONLY: the passwords below equal the role names (placeholders, not
-- secrets). Applied by the compose init on a fresh volume, by the Vitest/Playwright global
-- setups (so an existing volume gets the roles too) and by scripts/db-roles.sh.
-- Production: a DBA runs the same three CREATE ROLE statements once, with generated
-- passwords, before the first migration (docs/DEPLOY-COOLIFY.md "Database roles").
-- BYPASSRLS can only be granted by a superuser, which is why roles are not created by a
-- migration: the migrator (bukalaris_owner) is deliberately not a superuser.
--
--   bukalaris_owner     owns every schema object, runs migrations. BYPASSRLS so data
--                       backfills in migrations see every row (FORCE ROW LEVEL SECURITY
--                       would otherwise hide them from the table owner).
--   bukalaris_app       the web app's request pool. NOBYPASSRLS, owns nothing, gets only
--                       the per-table privileges migration 0007 grants.
--   bukalaris_platform  Super Admin (OperatorScope), the outbox worker, cleanup and the
--                       cross-store resolvers. BYPASSRLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bukalaris_owner') THEN
    CREATE ROLE bukalaris_owner LOGIN BYPASSRLS PASSWORD 'bukalaris_owner';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bukalaris_app') THEN
    CREATE ROLE bukalaris_app LOGIN NOBYPASSRLS PASSWORD 'bukalaris_app';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bukalaris_platform') THEN
    CREATE ROLE bukalaris_platform LOGIN BYPASSRLS PASSWORD 'bukalaris_platform';
  END IF;
END $$;
