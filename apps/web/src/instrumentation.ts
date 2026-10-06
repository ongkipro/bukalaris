import type { Instrumentation } from "next";

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
