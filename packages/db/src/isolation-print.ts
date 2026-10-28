// `node packages/db/src/isolation-print.ts <tables|functions|roles>`: prints the isolation registry as the body of a SQL
// VALUES list, for scripts/_registry.sh (verify:docker and the restore rehearsal compare the catalog of a database
// with it; nothing there counts policies by hand). No database access, no side effect.
import { DEFINER_FUNCTIONS, registryRows, ROLES } from "./platform/isolation-registry.ts";

const reads = new Set(Object.values(DEFINER_FUNCTIONS).flatMap((f) => (f.owner === "bukalaris_resolver" ? (f.reads ?? []) : [])));
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
const list = (rows: string[][]) => rows.map((r) => `(${r.map(lit).join(", ")})`).join(",\n");

const mode = process.argv[2];
if (mode === "tables") console.log(list(registryRows().map((r) => [r.table, r.class, r.app, r.platform, r.policy, reads.has(r.table) ? "SELECT" : ""])));
else if (mode === "functions") console.log(list(Object.entries(DEFINER_FUNCTIONS).map(([id, f]) => [id, f.owner, [...f.execute].sort().join(","), f.kind ?? "resolver"])));
else if (mode === "roles") console.log(list(Object.entries(ROLES).map(([name, a]) => [name, String(a.login), String(a.bypassrls)])));
else throw new Error("usage: isolation-print.ts <tables|functions|roles>");
