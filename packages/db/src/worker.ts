// Outbox worker (T-32): `node src/worker.ts [--once]`. Same image as the web app,
// different command. Polls for due jobs at a bounded interval, wakes early on the
// `pg_notify` sent by `enqueue`, and on SIGTERM/SIGINT finishes the batch in
// flight, stops claiming and exits. Logs JSON lines; never secrets or buyer data.
import { hostname } from "node:os";
import { platformDb } from "./client.ts";
import { JOB_CHANNEL, runOnce, sanitizeError } from "./ops/jobs/jobs.ts";
import "./ops/jobs/notify.ts"; // registers the order e-mail handler (T-36)
import "./storefront/signals.ts"; // registers the signal.* handlers (T-38)
import "./shipping/fulfillment.ts"; // registers the shipment.* handlers (T-39)

const once = process.argv.includes("--once");
const workerId = `${hostname()}:${process.pid}`;
const pollMs = Math.min(Math.max(Number(process.env.WORKER_POLL_MS) || 2_000, 100), 30_000);
const batch = Math.min(Math.max(Number(process.env.WORKER_BATCH) || 10, 1), 100);
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", event, workerId, ...fields }));

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
log("started", { once, pollMs, batch });

while (true) {
  let outcomes: Awaited<ReturnType<typeof runOnce>> = [];
  try {
    if (!once && !listener) listener = await db.$client.listen(JOB_CHANNEL, () => wake());
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
