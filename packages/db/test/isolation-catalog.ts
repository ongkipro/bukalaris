import { sql } from "drizzle-orm";
import type { Db } from "../src/client.ts";
import { DEFINER_FUNCTIONS, expectedPolicy, ISOLATION_REGISTRY, type TableEntry } from "../src/platform/isolation-registry.ts";

// Reads what the database really holds (pg_catalog, not information_schema: the latter only lists grants
// involving the current role) and compares it with the isolation registry. rls.test.ts runs it on the
// live test database, rls-contract.test.ts on a scratch copy after the contract step; both also feed it
// deliberately wrong input to prove the checker is not vacuous.

export interface Policy {
  name: string;
  cmd: string;
  allRoles: boolean;
  permissive: boolean;
  using: string | null;
  check: string | null;
}
export interface Rel {
  name: string;
  owner: string;
  rls: boolean;
  forced: boolean;
  policies: Policy[];
  /** DML privileges ("SELECT,INSERT" canonical order) of each login role, "" for none. */
  app: string;
  platform: string;
  resolver: string;
  /** Privileges of app or platform outside the four DML ones (TRUNCATE, REFERENCES, TRIGGER, ...). */
  other: string[];
  /** `column:PRIVILEGE` entries of the app role. */
  appColumns: string[];
}

const DML = sql.raw(`array['SELECT', 'INSERT', 'UPDATE', 'DELETE']`);
const dml = (role: string) => sql.raw(`(select coalesce(string_agg(a.privilege_type, ',' order by array_position(array['SELECT', 'INSERT', 'UPDATE', 'DELETE'], a.privilege_type::text)), '') from aclexplode(c.relacl) a where a.grantee = '${role}'::regrole and a.privilege_type = any (array['SELECT', 'INSERT', 'UPDATE', 'DELETE']))`);

export async function readRelations(exec: Db): Promise<Rel[]> {
  const rows = (await exec.execute(sql`
    select c.relname as name, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
      coalesce((select json_agg(json_build_object('name', p.polname, 'cmd', p.polcmd, 'allRoles', p.polroles = '{0}', 'permissive', p.polpermissive,
        'using', pg_get_expr(p.polqual, p.polrelid), 'check', pg_get_expr(p.polwithcheck, p.polrelid)) order by p.polname) from pg_policy p where p.polrelid = c.oid), '[]'::json) as policies,
      ${dml("bukalaris_app")} as app, ${dml("bukalaris_platform")} as platform, ${dml("bukalaris_resolver")} as resolver,
      coalesce((select array_agg(distinct a.privilege_type) from aclexplode(c.relacl) a where a.grantee in ('bukalaris_app'::regrole, 'bukalaris_platform'::regrole) and a.privilege_type <> all (${DML})), '{}') as other,
      coalesce((select array_agg(att.attname || ':' || a.privilege_type order by att.attname, a.privilege_type) from pg_attribute att, aclexplode(att.attacl) a
        where att.attrelid = c.oid and att.attacl is not null and a.grantee = 'bukalaris_app'::regrole), '{}') as app_columns
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`)) as unknown as (Omit<Rel, "appColumns"> & { app_columns: string[] })[];
  return rows.map(({ app_columns, ...r }) => ({ ...r, appColumns: app_columns }));
}

/** Tables of the database against tables of the registry, in both directions. */
export function completenessProblems(dbTables: string[], registered: string[] = Object.keys(ISOLATION_REGISTRY)): string[] {
  return [
    ...dbTables.filter((t) => !registered.includes(t)).map((t) => `${t}: table is not in the isolation registry`),
    ...registered.filter((t) => !dbTables.includes(t)).map((t) => `${t}: registry entry without a table`),
  ];
}

const has = (granted: string, wanted: string) => wanted.split(",").filter(Boolean).every((p) => granted.split(",").includes(p));

/**
 * What a table must look like for its class. `expand`: bukalaris_platform holds at least its registry privileges
 * (the old table-wide grants may still be there). `contract`: exactly those.
 */
export function tableProblems(rel: Rel, entry: TableEntry, mode: "expand" | "contract"): string[] {
  const out: string[] = [];
  const t = rel.name;
  const owner = entry.class === "restricted" ? "bukalaris_restricted" : "bukalaris_owner";
  if (rel.owner !== owner) out.push(`${t}: owner is ${rel.owner}, class ${entry.class} needs ${owner}`);

  const policy = expectedPolicy(entry);
  if (!policy) {
    if (rel.rls || rel.forced || rel.policies.length > 0) out.push(`${t}: class ${entry.class} must carry no row-level security (rls=${rel.rls}, forced=${rel.forced}, policies=${rel.policies.map((p) => p.name)})`);
  } else {
    if (!rel.rls) out.push(`${t}: row-level security is not enabled`);
    if (!rel.forced) out.push(`${t}: row-level security is not FORCEd`);
    const want = { name: policy.name, cmd: "*", allRoles: true, permissive: true, using: policy.using, check: policy.withCheck };
    if (JSON.stringify(rel.policies) !== JSON.stringify([want])) out.push(`${t}: policies ${JSON.stringify(rel.policies)} differ from ${JSON.stringify([want])}`);
  }

  if (rel.app !== entry.app) out.push(`${t}: bukalaris_app holds "${rel.app}", registry says "${entry.app}"`);
  const wantColumns = Object.entries(entry.appColumns ?? {}).flatMap(([c, ps]) => ps.split(",").map((p) => `${c}:${p}`));
  if (JSON.stringify(rel.appColumns) !== JSON.stringify(wantColumns)) out.push(`${t}: bukalaris_app column grants ${JSON.stringify(rel.appColumns)} differ from ${JSON.stringify(wantColumns)}`);
  if (entry.class === "shared-read" && rel.app !== "SELECT") out.push(`${t}: shared-read is SELECT only for the app role`);

  if (entry.class === "restricted") {
    if (rel.platform !== "") out.push(`${t}: bukalaris_platform holds "${rel.platform}" on a restricted table`);
  } else if (mode === "expand" ? !has(rel.platform, entry.platform) : rel.platform !== entry.platform) {
    out.push(`${t}: bukalaris_platform holds "${rel.platform}", registry says "${entry.platform}"${mode === "expand" ? " (at least)" : ""}`);
  }
  if (rel.other.length > 0) out.push(`${t}: app or platform holds ${rel.other} (only SELECT, INSERT, UPDATE, DELETE exist in the model)`);
  return out;
}

export interface DefinerRow {
  identity: string;
  owner: string;
  config: string[];
  /** Grantees of EXECUTE other than the owner; "PUBLIC" when the default ACL still applies. */
  execute: string[];
  body: string;
}

export async function readDefiners(exec: Db): Promise<DefinerRow[]> {
  const rows = (await exec.execute(sql`
    select p.proname || '(' || replace(oidvectortypes(p.proargtypes), ' ', '') || ')' as identity, pg_get_userbyid(p.proowner) as owner,
      coalesce(p.proconfig, '{}') as config, p.prosrc as body,
      case when p.proacl is null then array['PUBLIC'] else coalesce((select array_agg(distinct case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) from aclexplode(p.proacl) a
        where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner), '{}') end as execute
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef order by 1`)) as unknown as DefinerRow[];
  return rows;
}

export function definerProblems(rows: DefinerRow[], registry = DEFINER_FUNCTIONS): string[] {
  const out: string[] = [];
  for (const id of Object.keys(registry)) if (!rows.some((r) => r.identity === id)) out.push(`${id}: registered function does not exist`);
  for (const r of rows) {
    const reg = registry[r.identity];
    if (!reg) {
      out.push(`${r.identity}: SECURITY DEFINER function is not registered`);
      continue;
    }
    const kind = reg.kind ?? "resolver";
    const searchPath = kind === "resolver" ? "search_path=pg_catalog, public" : "search_path=pg_catalog, pg_temp";
    if (r.owner !== reg.owner) out.push(`${r.identity}: owner is ${r.owner}, registry says ${reg.owner}`);
    if (!r.config.includes(searchPath)) out.push(`${r.identity}: search_path is not fixed to ${searchPath.slice(12)} (${r.config})`);
    if (JSON.stringify([...r.execute].sort()) !== JSON.stringify([...reg.execute].sort())) out.push(`${r.identity}: EXECUTE held by ${r.execute}, registry says ${reg.execute}`);
    if (!reg.dynamicSql && /\bexecute\b|\bformat\s*\(/i.test(r.body)) out.push(`${r.identity}: body uses dynamic SQL`);
    // Resolvers qualify with public.; the pinned-pg_temp kinds may also use pg_catalog. and the unnest() function, so a
    // temporary table can never stand in for any relation they read.
    const qualified = kind === "resolver" ? /^public\./ : /^(public|pg_catalog)\./;
    // Relations read or written: FROM/JOIN, INSERT INTO, UPDATE <rel> (not `DO UPDATE SET` or `FOR UPDATE`), DELETE FROM (matched by FROM).
    for (const m of r.body.matchAll(/\b(?:from|join|insert\s+into|(?<!do\s)(?<!for\s)update)\s+([a-z_."]+)/gi)) {
      const src = m[1]!;
      if (/^(old|new)\./i.test(src)) continue; // trigger pseudo-records after IS DISTINCT FROM, not relations
      if (!qualified.test(src) && !(kind !== "resolver" && src.toLowerCase() === "unnest")) out.push(`${r.identity}: ${src} is not schema-qualified`);
    }
  }
  return out;
}

/** bukalaris_resolver reads exactly the tables its registered functions read, SELECT only. */
export function resolverProblems(rels: Rel[], registry = DEFINER_FUNCTIONS): string[] {
  const reads = new Set(Object.values(registry).filter((f) => f.owner === "bukalaris_resolver").flatMap((f) => f.reads ?? []));
  return rels.flatMap((r) => (r.resolver === (reads.has(r.name) ? "SELECT" : "") ? [] : [`${r.name}: bukalaris_resolver holds "${r.resolver}", functions read it: ${reads.has(r.name)}`]));
}
