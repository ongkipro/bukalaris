# Shared by verify-docker.sh and db-restore-rehearsal.sh (sourced after _lib.sh). The expected state of a database
# comes from the isolation registry (packages/db/src/platform/isolation-registry.ts, printed by
# packages/db/src/isolation-print.ts), never from a hard-coded policy or grant count (SEC-23, T-59).

registry_values() { node "$ROOT/packages/db/src/isolation-print.ts" "$1"; }

# registry_problems <database>: one line per difference between the catalog of <database> and the registry —
# table class (owner, row-level security and policy shape), per-role table grants of bukalaris_app and
# bukalaris_platform, the SELECT grants of bukalaris_resolver, every SECURITY DEFINER function (owner, EXECUTE
# grantees, fixed search_path) and the five roles. Empty output = in line. bukalaris_platform may hold MORE than
# the registry until the contract step ran (drizzle-pending/t59-contract.sql); STRICT_PLATFORM=1 demands exactly the registry.
registry_problems() {
  local db="$1" tables columns fns roles strict="${STRICT_PLATFORM:-0}"
  tables="$(registry_values tables)"; fns="$(registry_values functions)"; roles="$(registry_values roles)"
  # Keep the existing CLI/table format stable; read the column map from the same registry.
  columns="$(node --input-type=module - "$ROOT/packages/db/src/platform/isolation-registry.ts" <<'JS'
import { pathToFileURL } from 'node:url';
const { ISOLATION_REGISTRY } = await import(pathToFileURL(process.argv[2]).href);
console.log(JSON.stringify(Object.fromEntries(Object.entries(ISOLATION_REGISTRY).map(([table, entry]) => [table, entry.appColumns ?? {}]))).replaceAll("'", "''"));
JS
)"
  psql_in "$db" <<SQL
with reg(t, class, app, platform, policy, resolver) as (values $tables),
reg_columns as (
  select t.key as t, c.key as col, unnest(string_to_array(c.value, ',')) as p
  from jsonb_each('$columns'::jsonb) t cross join lateral jsonb_each_text(t.value) c
),
dml(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')),
cat as (
  select c.oid, c.relname as t, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
    (select count(*) from pg_policy p where p.polrelid = c.oid) as npol,
    (select coalesce(string_agg(a.privilege_type, ',' order by array_position(array['SELECT','INSERT','UPDATE','DELETE'], a.privilege_type::text)), '') from aclexplode(c.relacl) a where a.grantee = 'bukalaris_app'::regrole and a.privilege_type in (select p from dml)) as app,
    (select coalesce(string_agg(a.privilege_type, ',' order by array_position(array['SELECT','INSERT','UPDATE','DELETE'], a.privilege_type::text)), '') from aclexplode(c.relacl) a where a.grantee = 'bukalaris_platform'::regrole and a.privilege_type in (select p from dml)) as platform,
    (select coalesce(string_agg(a.privilege_type, ','), '') from aclexplode(c.relacl) a where a.grantee = 'bukalaris_resolver'::regrole and a.privilege_type in (select p from dml)) as resolver
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
)
select 'table ' || coalesce(reg.t, cat.t) || ': ' || case
  when reg.t is null then 'not in the isolation registry'
  when cat.t is null then 'registry entry without a table'
  when cat.owner <> case reg.class when 'restricted' then 'bukalaris_restricted' else 'bukalaris_owner' end then 'owner is ' || cat.owner
  when cat.app <> reg.app then 'bukalaris_app holds "' || cat.app || '", registry "' || reg.app || '"'
  when reg.class = 'restricted' and cat.platform <> '' then 'bukalaris_platform holds "' || cat.platform || '" on a restricted table'
  when $strict = 1 and cat.platform <> reg.platform then 'bukalaris_platform holds "' || cat.platform || '", registry "' || reg.platform || '"'
  when not (string_to_array(reg.platform, ',') <@ string_to_array(cat.platform, ',')) then 'bukalaris_platform lacks part of "' || reg.platform || '" (holds "' || cat.platform || '")'
  when cat.resolver <> reg.resolver then 'bukalaris_resolver holds "' || cat.resolver || '", registry "' || reg.resolver || '"'
  when reg.policy = '' and (cat.rls or cat.forced or cat.npol > 0) then 'unexpected row-level security or policy'
  when reg.policy <> '' and not (cat.rls and cat.forced and cat.npol = 1 and exists (select 1 from pg_policy p where p.polrelid = cat.oid and p.polname = reg.policy)) then 'row-level security is not enabled, forced and exactly policy ' || reg.policy
end
from reg full join cat on cat.t = reg.t
where reg.t is null or cat.t is null or cat.owner <> case reg.class when 'restricted' then 'bukalaris_restricted' else 'bukalaris_owner' end
  or cat.app <> reg.app or (reg.class = 'restricted' and cat.platform <> '')
  or ($strict = 1 and cat.platform <> reg.platform) or not (string_to_array(reg.platform, ',') <@ string_to_array(cat.platform, ','))
  or cat.resolver <> reg.resolver or (reg.policy = '' and (cat.rls or cat.forced or cat.npol > 0))
  or (reg.policy <> '' and not (cat.rls and cat.forced and cat.npol = 1 and exists (select 1 from pg_policy p where p.polrelid = cat.oid and p.polname = reg.policy)))
union all
-- Effective privileges include table grants, role membership and PUBLIC, not just attacl.
select 'column ' || reg.t || '.' || a.attname || ': bukalaris_app ' || cp.p || ' differs from registry'
from reg join cat on cat.t = reg.t
join pg_attribute a on a.attrelid = cat.oid and a.attnum > 0 and not a.attisdropped
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) cp(p)
where has_column_privilege('bukalaris_app', cat.oid, a.attnum, cp.p) <>
  (cp.p = any(string_to_array(reg.app, ',')) or exists (
    select 1 from reg_columns rc where rc.t = reg.t and rc.col = a.attname and rc.p = cp.p
  ))
union all
select 'function ' || coalesce(reg.id, cat.id) || ': ' || case
  when reg.id is null then 'SECURITY DEFINER function is not in the registry'
  when cat.id is null then 'registered function does not exist'
  when cat.owner <> reg.owner then 'owner is ' || cat.owner
  when cat.execute <> reg.execute then 'EXECUTE held by ' || cat.execute || ', registry ' || reg.execute
  else 'search_path is not fixed to ' || case when reg.kind = 'resolver' then 'pg_catalog, public' else 'pg_catalog, pg_temp' end
end
from (values $fns) as reg(id, owner, execute, kind)
full join (
  select p.proname || '(' || replace(oidvectortypes(p.proargtypes), ' ', '') || ')' as id, pg_get_userbyid(p.proowner) as owner,
    case when p.proacl is null then 'PUBLIC' else coalesce((select string_agg(distinct case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, ',' order by case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) from aclexplode(p.proacl) a where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner), '') end as execute,
    coalesce(p.proconfig, '{}') as config
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
) cat on cat.id = reg.id
where reg.id is null or cat.id is null or cat.owner <> reg.owner or cat.execute <> reg.execute or not (case when reg.kind = 'resolver' then 'search_path=pg_catalog, public' else 'search_path=pg_catalog, pg_temp' end = any (cat.config))
union all
select 'role ' || coalesce(reg.name, r.rolname) || ': ' || case when reg.name is null then 'unexpected bukalaris role' when r.rolname is null then 'role is missing' else 'login or BYPASSRLS differs' end
from (values $roles) as reg(name, login, bypass)
full join (select rolname, rolcanlogin, rolbypassrls from pg_roles where rolname like 'bukalaris\_%') r on r.rolname = reg.name
where reg.name is null or r.rolname is null or r.rolcanlogin::text <> reg.login or r.rolbypassrls::text <> reg.bypass
SQL
}

# registry_policy_count: the number of policies the registry expects in schema public.
registry_policy_count() { registry_values tables | grep -c -E "', '[a-z]+_isolation', '[A-Z]*'\)" || true; }
