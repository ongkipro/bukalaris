// Maintenance command (T-30): `node src/cleanup.ts` deletes idle open carts and old
// rate-limit windows, then exits. Run it from cron or a scheduler (same image as the
// worker, different command). Checked-out carts are never touched (see cleanupIdleCarts).
import { cleanupIdleCarts } from "./checkout.ts";
import { createDb } from "./client.ts";
import { sanitizeError } from "./jobs.ts";

/** Default: a week. Override with CART_IDLE_HOURS (integer hours >= 1). */
const idleHours = Number(process.env.CART_IDLE_HOURS ?? 168);
const db = createDb();
try {
  const result = await cleanupIdleCarts(db, { idleHours });
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", event: "cleanup", idleHours, ...result }));
} catch (err) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "cleanup_failed", error: sanitizeError(err) }));
  process.exitCode = 1;
} finally {
  await db.$client.end({ timeout: 5 });
}
