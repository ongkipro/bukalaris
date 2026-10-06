import "server-only";
import { db, moduleForRoute, recordLogEvent, sanitizeEvent, sanitizeFields, type LogEventInput, type LogLevel } from "@bukalaris/db";
import type { Instrumentation } from "next";
import { headers } from "next/headers";
import { REQUEST_ID_HEADER } from "./request-id";

/**
 * Structured server logging (OBS): one JSON line per event on stdout, built from
 * an allowlist of fields (see LOG_FIELD_ALLOWLIST in packages/db) so secrets,
 * cookies, addresses and phone numbers cannot leak by accident. warn and above
 * are also persisted to the Log System sink; a sink failure never fails the caller.
 */
export const RELEASE = process.env.RELEASE_REVISION ?? process.env.SOURCE_COMMIT ?? null;
export const ENVIRONMENT = process.env.APP_ENV ?? (process.env.NODE_ENV === "production" ? "production" : "development");
const SINK_LEVELS: ReadonlySet<LogLevel> = new Set(["warn", "error", "fatal"]);
const SINK_TIMEOUT_MS = 2000;

/** Correlation id of the current request (set by proxy.ts); null outside a request. */
export async function requestId(): Promise<string | null> {
  try {
    return (await headers()).get(REQUEST_ID_HEADER);
  } catch {
    return null;
  }
}

type Fields = Record<string, unknown> & { module: string };

export async function log(level: LogLevel, msg: unknown, fields: Fields): Promise<void> {
  const fieldsWithRequest = { request_id: fields.request_id ?? (await requestId()) ?? undefined, ...fields };
  void emit({ level, message: msg, module: fields.module, environment: ENVIRONMENT, release: RELEASE, fields: fieldsWithRequest });
}

/** Write a prepared event to stdout and, for warn+, to the sink. Safe outside request scope (instrumentation). */
export function emit(input: LogEventInput): Promise<void> {
  const e = sanitizeEvent(input);
  const line = {
    level: e.level,
    time: e.time.toISOString(),
    msg: e.message,
    request_id: e.requestId,
    module: e.module,
    operation: e.operation,
    page_id: e.pageId,
    store_id: e.storeId,
    code: e.code,
    env: e.environment,
    release: e.release,
    ...sanitizeFields(input.fields ?? {}),
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
  if (!SINK_LEVELS.has(e.level)) return Promise.resolve();
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("sink timeout")), SINK_TIMEOUT_MS).unref());
  return Promise.race([Promise.resolve().then(() => recordLogEvent(db(), input)), timeout]).then(() => undefined, (err: unknown) => {
    // Diagnostic outage must not break commerce (OBS-5): stdout keeps the line, note the sink failure once.
    process.stdout.write(`${JSON.stringify({ level: "warn", time: new Date().toISOString(), msg: "log sink unavailable", module: "ops.sink", code: err instanceof Error ? err.name : "unknown", request_id: e.requestId })}\n`);
  });
}

/** instrumentation.ts `onRequestError`: only the route template, method and correlation id are recorded — never URL query, headers, cookies or bodies. */
export const reportRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const header = (name: string) => {
    const v = request.headers[name] ?? request.headers[`x-middleware-request-${name}`];
    return Array.isArray(v) ? v[0] : v;
  };
  const e = err instanceof Error ? err : undefined;
  const digest = typeof err === "object" && err !== null && "digest" in err ? String((err as { digest: unknown }).digest) : undefined;
  await emit({
    level: "error",
    message: e?.message ?? String(err),
    module: moduleForRoute(context.routePath),
    environment: ENVIRONMENT,
    release: RELEASE,
    fields: {
      operation: context.routeType,
      route: context.routePath,
      method: request.method,
      request_id: header(REQUEST_ID_HEADER),
      error_name: e?.name,
      digest,
      code: (e as { code?: unknown } | undefined)?.code,
    },
  });
};
