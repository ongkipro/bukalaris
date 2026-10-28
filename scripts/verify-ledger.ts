// `pnpm verify:ledger` (ADR-0006 decision 9, DATA-7, D-21 item 3): READ-ONLY recomputation of every store from `ledger_entry` alone. Connects with the platform
// pool (PLATFORM_DATABASE_URL, role bukalaris_platform) and runs inside a READ ONLY transaction. Exit 0 = every invariant holds, 1 = violations, 2 = error.
import { platformDb } from "../packages/db/src/client.ts";
import { verifyLedger } from "../packages/db/src/ledger/verify.ts";

const db = platformDb();
try {
  const r = await verifyLedger(db);
  console.log(`verify:ledger: ${r.stores.length} store(s), ${r.entries} entries, ${r.orders} orders, ${r.orderLessEntries} order-less entries (payout, payout_reversal, adjustment)`);
  for (const s of r.stores) {
    const kinds = Object.entries(s.byKind).map(([k, v]) => `${k}=${v.count}`).join(" ");
    console.log(`  store ${s.storeId}: available ${s.availableIdr}, pending ${s.pendingIdr} (${kinds})`);
  }
  for (const v of r.violations) console.error(`VIOLATION ${v.code} store=${v.storeId ?? "-"}: ${v.detail}`);
  console.log(r.violations.length === 0 ? "verify:ledger: OK, no violation" : `verify:ledger: ${r.violations.length} violation(s)`);
  process.exitCode = r.violations.length === 0 ? 0 : 1;
} catch (err) {
  console.error("verify:ledger: failed", err instanceof Error ? err.message : err);
  process.exitCode = 2;
} finally {
  await db.$client.end();
}
