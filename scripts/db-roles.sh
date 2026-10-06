#!/usr/bin/env bash
# Local only: bring an EXISTING compose database up to the three-role setup of ADR-0005 (T-27).
# A fresh volume gets this from the compose init files; the test/e2e setups do it for their
# disposable databases. Run once per dev database created before T-27, then `pnpm db:migrate`:
#   scripts/db-roles.sh                 # database of MIGRATION_DATABASE_URL (env or .env)
#   scripts/db-roles.sh bukalaris_rls   # explicit local database name
# Creates the roles (placeholder passwords, packages/db/docker/05-roles.sql), makes
# bukalaris_owner the database owner and transfers every table, sequence and function in
# public/drizzle to it, so migration 0007 (grants + policies) can run as the owner.
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

db="${1:-$(db_name_of "$(env_or_dotenv MIGRATION_DATABASE_URL)")}"
[ -n "$db" ] || die "usage: scripts/db-roles.sh <database> (or set MIGRATION_DATABASE_URL)"
refuse_unless_local_name "$db"
require_db_container

psql_in postgres <"$ROOT/packages/db/docker/05-roles.sql" >/dev/null
psql_in postgres -c "alter database \"$db\" owner to bukalaris_owner" >/dev/null
psql_in "$db" <<'SQL' >/dev/null
DO $$
DECLARE r record;
BEGIN
  -- public too: a database whose public schema was dropped and recreated by another role
  -- (e.g. a reset) leaves the owner without CREATE there, and migration 0007 fails with 3F000.
  ALTER SCHEMA public OWNER TO bukalaris_owner;
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname = 'drizzle') THEN ALTER SCHEMA drizzle OWNER TO bukalaris_owner; END IF;
  FOR r IN SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('public', 'drizzle') LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO bukalaris_owner', r.schemaname, r.tablename);
  END LOOP;
  FOR r IN SELECT sequence_schema, sequence_name FROM information_schema.sequences WHERE sequence_schema IN ('public', 'drizzle') LOOP
    EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO bukalaris_owner', r.sequence_schema, r.sequence_name);
  END LOOP;
  FOR r IN SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) OWNER TO bukalaris_owner', r.nspname, r.proname, r.args);
  END LOOP;
END $$;
SQL
owned=$(psql_in "$db" -c "select count(*) from pg_tables where schemaname in ('public','drizzle') and tableowner <> 'bukalaris_owner'")
[ "$owned" = 0 ] || die "$owned tables in $db are still not owned by bukalaris_owner"
log "$db: roles present, database and all public/drizzle objects owned by bukalaris_owner; next: pnpm db:migrate"
