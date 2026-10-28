// Outbox worker (T-32): `node src/worker.ts [--once]`. Same image as the web app,
// different command. Polls for due jobs at a bounded interval, wakes early on the
// `pg_notify` sent by `enqueue`, and on SIGTERM/SIGINT finishes the batch in
// flight, stops claiming and exits. Also runs the periodic enqueuer (JOB-21, T-74) every
// SCHEDULER_TICK_MS; any number of workers may do so, the database keeps it to one job per
// period. `--once` only drains due jobs. Logs JSON lines; never secrets or buyer data.
import { hostname } from "node:os";
import { sql } from "drizzle-orm";
import { platformDb } from "./client.ts";
import { JOB_CHANNEL, runOnce, sanitizeError } from "./ops/jobs/jobs.ts";
import "./ops/jobs/retention.ts"; // registers the retention sweeps and their daily schedules (T-74)
import { reconcileUnknownJobs } from "./ops/jobs/manage.ts";
import "./ops/console-approvals.ts"; // registers the approval.expire sweeper (JOB-12, T-62)
import { schedulerTick } from "./ops/jobs/scheduler.ts";
import "./ops/jobs/notify.ts"; // registers the order e-mail handler (T-36)
import "./ops/jobs/mail.ts"; // T-73 delivery and credential-body expiry sweep
import { configuredMailTransport, requireMailConfiguration } from "./platform/mail-transport.ts";
import "./storefront/signals.ts"; // registers the signal.* handlers (T-38)
import "./shipping/fulfillment.ts"; // registers the shipment.* handlers (T-39)
import "./shipping/jobs.ts"; // T-48 Partner provisioning sweep, bounded account reconciliation, shipping key re-seal (JOB-08, JOB-23)
import "./buyer/jobs.ts"; // registers the buyer.resolve handler (JOB-10, T-57)
import "./affiliate/jobs.ts"; // registers the affiliate.catalog.project handler (JOB-20, T-52)
import "./billing/jobs.ts"; // registers subscription.instruction / subscription.verify, their reconcilers and the hourly billing.cycle schedule (T-50)
import "./payments/jobs.ts"; // registers payment.instruction / payment.verify, their reconcilers and the JOB-25 poll + callback redaction schedules (T-49)
import "./ledger/release.ts"; // registers JOB-24 ledger.release (T-37)
import "./ledger/reconciliation.ts"; // registers JOB-33 cod.reconciliation.poll, a no-op while provider reconciliation is off (T-37)

const once = process.argv.includes("--once");
const workerId = `${hostname()}:${process.pid}`;
const pollMs = Math.min(Math.max(Number(process.env.WORKER_POLL_MS) || 2_000, 100), 30_000);
const batch = Math.min(Math.max(Number(process.env.WORKER_BATCH) || 10, 1), 100);
const tickMs = Math.min(Math.max(Number(process.env.SCHEDULER_TICK_MS) || 30_000, 1_000), 300_000);
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", event, workerId, ...fields }));

// Fail before claiming anything: production cannot silently use the local mail sink.
configuredMailTransport(requireMailConfiguration());
const db = platformDb(); // worker role: bukalaris_platform (BYPASSRLS), PLATFORM_DATABASE_URL only
let stopping = false;
let wake: () => void = () => {};
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  log("stopping", { signal });
  wake();
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

// LISTEN uses its own connection; acquired lazily so a database that is not up yet
// (fresh environment, restart) delays the worker instead of killing it.
let listener: { unlisten(): Promise<void> } | null = null;
log("started", { once, pollMs, batch, tickMs });
let lastTick = 0;

while (true) {
  let outcomes: Awaited<ReturnType<typeof runOnce>> = [];
  try {
    if (!once && !listener) listener = await db.$client.listen(JOB_CHANNEL, () => wake());
    if (!once && Date.now() - lastTick >= tickMs) {
      lastTick = Date.now();
      try {
        // The DATABASE clock, never this process's: one worker with a wrong clock must not move the cursors or the heartbeat.
        const [row] = await db.execute<{ now: string }>(sql`select now() as now`);
        const { enqueued } = await schedulerTick(db, { now: new Date(row!.now), tickIntervalMs: tickMs + pollMs }); // worst-case gap between two ticks of this loop
        if (enqueued.length) log("scheduler", { enqueued });
      } catch (err) {
        console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "scheduler_tick_failed", workerId, error: sanitizeError(err) }));
      }
      try {
        await reconcileUnknownJobs(db); // kinds with a registered reconciler settle their `unknown` jobs; the rest wait for an operator
      } catch (err) {
        console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "reconcile_failed", workerId, error: sanitizeError(err) }));
      }
    }
    outcomes = await runOnce(db, { workerId, batch });
    for (const o of outcomes) log("job", o);
  } catch (err) {
    // Database unreachable or a claim failed: nothing was marked; retry after the poll interval.
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "poll_failed", workerId, error: sanitizeError(err) }));
    if (once) process.exitCode = 1;
  }
  if (once || stopping) break;
  // Non-empty batch: more work may be due, claim again right away. Empty: idle until
  // the poll interval elapses, a notification arrives or a stop signal is received.
  if (outcomes.length === 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = () => {};
    if (stopping) break;
  }
}
await listener?.unlisten().catch(() => {});
await db.$client.end({ timeout: 5 });
log("stopped");
