-- Database roles for tenant isolation (ADR-0005, T-27, T-59). Cluster-level, idempotent.
--
-- LOCAL DEVELOPMENT ONLY: the passwords below equal the role names (placeholders, not
-- secrets). Applied by the compose init on a fresh volume, by the Vitest/Playwright global
-- setups (so an existing volume gets the roles too) and by scripts/db-roles.sh.
-- Production: a DBA runs the same CREATE ROLE and GRANT statements once, with generated
-- passwords for the three login roles, before the first migration (docs/DEPLOY-COOLIFY.md "Database roles").
-- BYPASSRLS can only be granted by a superuser, which is why roles are not created by a
-- migration: the migrator (bukalaris_owner) is deliberately not a superuser.
--
--   bukalaris_owner     owns every schema object, runs migrations. BYPASSRLS so data
--                       backfills in migrations see every row (FORCE ROW LEVEL SECURITY
--                       would otherwise hide them from the table owner).
--   bukalaris_app       the web app's request pool. NOBYPASSRLS, owns nothing, gets only
--                       the per-table privileges the migrations grant.
--   bukalaris_platform  Owner console (OperatorScope), the outbox worker, cleanup and the
--                       named platform services. BYPASSRLS.
--   bukalaris_restricted  NO LOGIN. Owns the restricted-class tables of the isolation registry; neither
--                       login role holds a privilege on them, they are reached only through
--                       SECURITY DEFINER functions it owns. NOBYPASSRLS, owns nothing else.
--   bukalaris_resolver  NO LOGIN, BYPASSRLS. Owns the cross-store resolver functions (host, store, cart,
--                       token, handoff, invitation and order lookups) that the app role executes; reads
--                       only what the migrations grant it. Owns nothing else.
-- The two no-login roles are not login roles, so no fourth credential exists (ADR-0008 section 6).
-- bukalaris_owner is made a member of both so the migrator can create their objects and hand them over
-- (ALTER ... OWNER TO needs membership); no login role can act as them otherwise.
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
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bukalaris_restricted') THEN
    CREATE ROLE bukalaris_restricted NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bukalaris_resolver') THEN
    CREATE ROLE bukalaris_resolver NOLOGIN BYPASSRLS;
  END IF;
  IF NOT pg_has_role('bukalaris_owner', 'bukalaris_restricted', 'MEMBER') THEN
    GRANT bukalaris_restricted TO bukalaris_owner;
  END IF;
  IF NOT pg_has_role('bukalaris_owner', 'bukalaris_resolver', 'MEMBER') THEN
    GRANT bukalaris_resolver TO bukalaris_owner;
  END IF;
END $$;
