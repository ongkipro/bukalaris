import type { Instrumentation } from "next";

/** SEC-22: a production server without its own order-link secret refuses to serve (no fallback to BETTER_AUTH_SECRET). */
export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "production" && !process.env.ORDER_LINK_SECRET) throw new Error("ORDER_LINK_SECRET is not set");
}

/**
 * Server error boundary (OBS-5): every uncaught error in rendering, route
 * handlers, server actions or the proxy becomes one sanitized event on stdout
 * and in the Log System sink (see reportRequestError in lib/log.ts). The
 * reporter needs Node (stdout, Postgres), so the edge compile of this file
 * stays empty.
 */
export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportRequestError } = await import("./lib/log");
  await reportRequestError(...args);
};
