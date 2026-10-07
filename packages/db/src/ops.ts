// M2 track module (see AGENTS.md "Parallel tracks"): Log System sink, query
// service and platform capability grants (PR-11, OBS-5).
import { and, desc, eq, gte, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "./client.ts";
import { auditLog } from "./schema.ts";
import { LOG_LEVELS, operatorGrant, systemLog, type LogLevel, type PlatformCapability } from "./schema-ops.ts";
import { DomainError, type OperatorScope } from "./scoped.ts";
export { LOG_LEVELS, PLATFORM_CAPABILITIES, type LogLevel, type PlatformCapability } from "./schema-ops.ts";

// ---------------------------------------------------------------------------
// Redaction (SEC-5, OBS signal contract). Allowlist: only these structured keys
// ever reach stdout or the sink; anything else (passwords, tokens, cookies,
// addresses, phones, raw payloads) is dropped by construction, not by pattern.
// ---------------------------------------------------------------------------
export const LOG_FIELD_ALLOWLIST = [
  "module",
  "operation",
  "page_id",
  "store_id",
  "request_id",
  "code",
  "route",
  "method",
  "status",
  "outcome",
  "provider",
  "duration_ms",
  "error_name",
  "digest",
] as const;
const ALLOWED = new Set<string>(LOG_FIELD_ALLOWLIST);
const TEXT_MAX = 500;

/** Free text may still carry secrets (connection strings, phone numbers, query params); scrub known shapes and cap length. */
export function scrubText(input: unknown): string {
  const s = typeof input === "string" ? input : input == null ? "" : String(input);
  return s
    .replace(/\bparams:[\s\S]*$/i, "") // drizzle "Failed query: … params: …" carries bound values
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi, "[url]") // URLs may embed credentials/query strings
    .replace(/\b(bearer|basic)\s+[a-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[digits]") // phone numbers, card-like runs
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TEXT_MAX);
}
/** Structured identifiers (ids, codes, route templates) are kept verbatim, only normalized and capped. */
const clip = (v: unknown, max: number) => String(v).replace(/\s+/g, " ").trim().slice(0, max);

export type LogFields = Record<string, unknown>;
/** Keep allowlisted keys with scalar values; scrub string values. */
export function sanitizeFields(fields: LogFields): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED.has(k) || v == null) continue;
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = clip(v, 200);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Page/module map (ARCH-5 subset). Route templates come from Next's routePath;
// a miss is reported as "mapping unavailable", never inferred from stack text.
// ---------------------------------------------------------------------------
export const MODULE_MAP: Record<string, { pageId: string; label: string }> = {
  "admin.stores": { pageId: "SA-02", label: "Super Admin · daftar toko" },
  "admin.logs": { pageId: "SA-05", label: "Super Admin · Log System" },
  "admin.logs.detail": { pageId: "SA-06", label: "Super Admin · detail log" },
  auth: { pageId: "AU-01", label: "Masuk" },
  "seller.products": { pageId: "SC-02", label: "Seller Admin · produk" },
  "seller.members": { pageId: "SC-19", label: "Seller Admin · anggota" },
  "seller.orders": { pageId: "SC-12", label: "Seller Admin · pesanan" },
  "storefront.catalog": { pageId: "SF-01", label: "Etalase · produk" },
  "storefront.cart": { pageId: "SF-06", label: "Etalase · keranjang" },
  checkout: { pageId: "SF-07", label: "Checkout" },
  "checkout.confirmation": { pageId: "SF-08", label: "Konfirmasi pesanan" },
  "api.health": { pageId: "OPS", label: "Health/readiness" },
};
const ROUTE_PREFIXES: [string, string][] = [
  ["/admin/logs/[id]", "admin.logs.detail"],
  ["/admin/logs", "admin.logs"],
  ["/admin", "admin.stores"],
  ["/login", "auth"],
  ["/api/auth", "auth"],
  ["/seller/products", "seller.products"],
  ["/seller/members", "seller.members"],
  ["/seller/orders", "seller.orders"],
  ["/s/[store]/cart", "storefront.cart"],
  ["/s/[store]", "storefront.catalog"],
  ["/checkout/confirmation", "checkout.confirmation"],
  ["/checkout", "checkout"],
  ["/api/health", "api.health"],
  ["/api/ready", "api.health"],
];
/** Module for a Next route template such as `/app/s/[store]/page` or `/s/[store]`. Unknown → "unknown". */
export function moduleForRoute(routePath: string | undefined): string {
  const p = (routePath ?? "").replace(/^\/app/, "").replace(/\/\([^/)]+\)/g, "").replace(/\/(page|route|layout)$/, "") || "/";
  return ROUTE_PREFIXES.find(([prefix]) => p === prefix || p.startsWith(`${prefix}/`))?.[1] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Sink write (no actor: errors are recorded by the server boundary itself).
// ---------------------------------------------------------------------------
export type LogEventInput = {
  level: LogLevel;
  message: unknown;
  module?: string;
  environment?: string;
  release?: string | null;
  time?: Date;
  fields?: LogFields;
};

export function sanitizeEvent(input: LogEventInput) {
  const f = sanitizeFields(input.fields ?? {});
  const str = (k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);
  const storeId = Number(f.store_id);
  return {
    time: input.time ?? new Date(),
    level: LOG_LEVELS.includes(input.level) ? input.level : "error",
    module: clip(input.module ?? str("module") ?? "unknown", 100) || "unknown",
    operation: str("operation")?.slice(0, 100) ?? null,
    pageId: str("page_id")?.slice(0, 32) ?? MODULE_MAP[input.module ?? ""]?.pageId ?? null,
    storeId: Number.isSafeInteger(storeId) && storeId > 0 ? storeId : null,
    requestId: str("request_id")?.slice(0, 128) ?? null,
    code: str("code")?.slice(0, 100) ?? str("digest")?.slice(0, 100) ?? str("error_name")?.slice(0, 100) ?? null,
    message: scrubText(input.message) || "(tanpa pesan)",
    route: str("route")?.slice(0, 200) ?? null,
    environment: clip(input.environment ?? "development", 32) || "development",
    release: input.release ? clip(input.release, 64) : null,
    fields: f,
  };
}

/** Persist one sanitized event. Callers must treat failures as non-fatal (a diagnostic outage never breaks commerce). */
export async function recordLogEvent(exec: Executor, input: LogEventInput): Promise<number> {
  const [row] = await exec.insert(systemLog).values(sanitizeEvent(input)).returning({ id: systemLog.id });
  return row!.id;
}

// ---------------------------------------------------------------------------
// Platform capabilities (explicit grants; a seller never has an OperatorScope).
// ---------------------------------------------------------------------------
export async function hasPlatformCap(op: OperatorScope, cap: PlatformCapability): Promise<boolean> {
  const rows = await op.exec
    .select({ c: operatorGrant.capability })
    .from(operatorGrant)
    .where(and(eq(operatorGrant.userId, op.userId), eq(operatorGrant.capability, cap)));
  return rows.length > 0;
}
export async function requirePlatformCap(op: OperatorScope, cap: PlatformCapability): Promise<void> {
  if (!(await hasPlatformCap(op, cap))) throw new DomainError("forbidden", "Akses ditolak: butuh izin logs.read.");
}

// ---------------------------------------------------------------------------
// Query service (listSystemLogs / getSystemLog). Filters are allowlisted and
// bounded; every read writes an access audit row (IAM-5) to audit_log, kept
// apart from the diagnostic stream so a read never lists itself.
// ---------------------------------------------------------------------------
export const MAX_RANGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_MS = 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const optional = <T extends z.ZodType>(s: T) => z.preprocess((v) => (v === "" || v == null ? undefined : v), s.optional());

export const logFilters = z.object({
  level: optional(z.enum(LOG_LEVELS)),
  module: optional(z.string().regex(/^[a-z0-9._-]{1,100}$/i, "Modul tidak valid.")),
  requestId: optional(z.string().regex(ID_RE, "Request ID tidak valid.")),
  storeId: optional(z.coerce.number().int().positive("Store ID tidak valid.")),
  from: optional(z.coerce.date()),
  to: optional(z.coerce.date()),
  cursor: optional(z.string().regex(/^\d{1,16}$/, "Kursor tidak valid.")),
  limit: optional(z.coerce.number().int().min(1).max(200)),
});
export type LogFilters = z.infer<typeof logFilters>;

function normalizeRange(f: LogFilters) {
  const to = f.to ?? new Date();
  const from = f.from ?? new Date(to.getTime() - DEFAULT_RANGE_MS);
  if (!(from < to)) throw new DomainError("invalid_range", "Rentang waktu tidak valid: 'dari' harus sebelum 'sampai'.");
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw new DomainError("range_too_wide", "Rentang waktu maksimal 24 jam.");
  return { from, to };
}

export type LogEvent = typeof systemLog.$inferSelect;

export async function listSystemLogs(op: OperatorScope, raw: unknown) {
  await requirePlatformCap(op, "logs.read");
  const f = logFilters.parse(raw);
  const { from, to } = normalizeRange(f);
  const limit = f.limit ?? 50;
  const conds = [gte(systemLog.time, from), lte(systemLog.time, to)];
  if (f.level) conds.push(eq(systemLog.level, f.level));
  if (f.module) conds.push(eq(systemLog.module, f.module));
  if (f.requestId) conds.push(eq(systemLog.requestId, f.requestId));
  if (f.storeId) conds.push(eq(systemLog.storeId, f.storeId));
  // Cursor = id of the last row seen; ordering is (time desc, id desc), so continue strictly after it.
  if (f.cursor) {
    const c = Number(f.cursor);
    const t = sql`(select time from system_log where id = ${c})`;
    conds.push(or(lt(systemLog.time, t), and(eq(systemLog.time, t), lt(systemLog.id, c)))!);
  }
  const rows = await op.exec
    .select()
    .from(systemLog)
    .where(and(...conds))
    .orderBy(desc(systemLog.time), desc(systemLog.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  const filters = { level: f.level, module: f.module, requestId: f.requestId, storeId: f.storeId, from: from.toISOString(), to: to.toISOString() };
  await op.exec.insert(auditLog).values({
    actorUserId: op.userId,
    storeId: f.storeId ?? null,
    action: "logs.list",
    reason: JSON.stringify(filters),
  });
  return { items, nextCursor: rows.length > limit ? String(items.at(-1)!.id) : null, from, to };
}

export async function getSystemLog(op: OperatorScope, id: number) {
  await requirePlatformCap(op, "logs.read");
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const [event] = await op.exec.select().from(systemLog).where(eq(systemLog.id, id));
  await op.exec.insert(auditLog).values({ actorUserId: op.userId, storeId: event?.storeId ?? null, action: "logs.read", reason: `event:${id}` });
  if (!event) return null;
  const related = event.requestId
    ? await op.exec
        .select()
        .from(systemLog)
        .where(and(eq(systemLog.requestId, event.requestId), sql`${systemLog.id} <> ${event.id}`))
        .orderBy(desc(systemLog.time), desc(systemLog.id))
        .limit(50)
    : [];
  return { event, related, mapping: MODULE_MAP[event.module] ?? null };
}
