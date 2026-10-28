// Worker registrations of the T-48 jobs (JOB-08, JOB-23). Imported by `worker.ts` only, like `billing/jobs.ts` and `payments/jobs.ts`:
// a module that merely needs the account services must not add schedules to the process.
import { registerHandler, registerPlatformHandler } from "../ops/jobs/jobs.ts";
import { registerSchedule } from "../ops/jobs/scheduler.ts";
import { partnerClientAvailable, provisionShippingAccount, resealShippingCredentials, SHIPPING_ACCOUNT_PROVISION, SHIPPING_ACCOUNT_SWEEP, SHIPPING_ACCOUNT_SYNC, SHIPPING_CREDENTIAL_RESEAL, sweepPendingAccounts, syncShippingAccounts } from "./accounts.ts";

// A store-scoped recovery job (queued by the Owner console) and three platform schedules: the automatic provisioning sweep (every store gets its account),
// the bounded `sellers/list` reconciliation (JOB-08) and the key re-seal under the leading ring key (JOB-23). All replay-safe: each is idempotent on its own rows.
/** While no live Partner adapter is installed (production today) the two Partner SCHEDULES (sweep, sync) do nothing and say so once, instead of throwing every minute or hour into dead jobs (T-48 fix 8). An owner-queued recovery job is a deliberate action and still fails visibly. */
function partnerOffline(kind: string): boolean {
  if (partnerClientAvailable()) return false;
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", event: "shipping.partner.skipped", kind, reason: "no_live_adapter" }));
  return true;
}
registerHandler(SHIPPING_ACCOUNT_PROVISION, async ({ db }, j) => { await provisionShippingAccount(db, j.storeId); }, { replaySafe: true });
registerSchedule({ kind: SHIPPING_ACCOUNT_SWEEP, period: "minute", catchUp: 0 });
registerPlatformHandler(SHIPPING_ACCOUNT_SWEEP, async ({ db }) => { if (!partnerOffline(SHIPPING_ACCOUNT_SWEEP)) await sweepPendingAccounts(db); }, { replaySafe: true });
registerSchedule({ kind: SHIPPING_ACCOUNT_SYNC, period: "hour", catchUp: 0 });
registerPlatformHandler(SHIPPING_ACCOUNT_SYNC, async ({ db }) => { if (!partnerOffline(SHIPPING_ACCOUNT_SYNC)) await syncShippingAccounts(db); }, { replaySafe: true });
registerSchedule({ kind: SHIPPING_CREDENTIAL_RESEAL, period: "hour", catchUp: 0 });
registerPlatformHandler(SHIPPING_CREDENTIAL_RESEAL, async ({ db }) => { await resealShippingCredentials(db); }, { replaySafe: true });
