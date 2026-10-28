// Thin entry point: `pnpm --filter @bukalaris/db bootstrap:console -- --holder a@x --holder b@x --runbook "<entry>" [--recovery]`.
// Runs as the owner/DBA role (MIGRATION_DATABASE_URL), never through the web app (IAM-15).
import { parseArgs } from "node:util";
import { createDb } from "./client.ts";
import { bootstrapConsole } from "./ops/capabilities-bootstrap.ts";

const { values } = parseArgs({
  options: { holder: { type: "string", multiple: true }, runbook: { type: "string" }, recovery: { type: "boolean" } },
});
const db = createDb(process.env.MIGRATION_DATABASE_URL, "MIGRATION_DATABASE_URL");
try {
  const done = await bootstrapConsole(db, { emails: values.holder ?? [], runbook: values.runbook ?? "", recovery: values.recovery });
  for (const h of done) console.log(`${h.email}: ${h.granted.length ? `granted ${h.granted.join(", ")}` : "already held every bootstrap capability"}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.$client.end();
}
