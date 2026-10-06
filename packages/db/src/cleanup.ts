// Maintenance command (T-30): `node src/cleanup.ts` deletes idle open carts and old
// rate-limit windows, then exits. Run it from cron or a scheduler (same image as the
// worker, different command). Checked-out carts are never touched (see cleanupIdleCarts).
import { cleanupIdleCarts } from "./checkout.ts";
import { platformDb } from "./client.ts";
import { sanitizeError } from "./jobs.ts";
import { purgeSignalContext } from "./signals.ts";

/** Default: a week. Override with CART_IDLE_HOURS (integer hours >= 1). */
const idleHours = Number(process.env.CART_IDLE_HOURS ?? 168);
const db = platformDb(); // maintenance spans every store: bukalaris_platform (BYPASSRLS)
try {
  const result = await cleanupIdleCarts(db, { idleHours });
  const signals = await purgeSignalContext(db); // T-38: click context / match data older than 30 days
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", event: "cleanup", idleHours, ...result, signalContexts: signals.contexts, signalEvents: signals.events }));
} catch (err) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "cleanup_failed", error: sanitizeError(err) }));
  process.exitCode = 1;
} finally {
  await db.$client.end({ timeout: 5 });
}
