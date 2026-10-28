import { createHash, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../../client.ts";
import { shippingPartnerBudget } from "../schema-accounts.ts";
import { requireMengantarEntryGate } from "./gate.ts";

export const PARTNER_BUDGET_KEY = "partner:mengantar";
export const PARTNER_REQUESTS_PER_MINUTE = 60;
/** The provider's own hard limit (also a database CHECK): never reached on purpose, see `PARTNER_REGISTRATION_DAILY_BUDGET`. */
export const PARTNER_REGISTRATIONS_PER_DAY = 1_000;
/**
 * Our OWN daily registration budget of the shared Partner account (T-48 fix 8, D-22 named conservative default): the per-store 409 retry loop can never burn
 * the provider's 1,000 a day, and a day of new stores still fits. Counted by the shared database counter (every worker), reset at Jakarta midnight.
 */
export const PARTNER_REGISTRATION_DAILY_BUDGET = 400;
export const PARTNER_EMAIL_ATTEMPTS = 3;
export const PARTNER_PAGE_LIMIT = 50;
export const PARTNER_MAX_PAGES = 4;
export const PARTNER_PROVISION_LEASE_MS = 60_000;
/** D-22 named conservative defaults (no provider fact): retry a failed provisioning after 15 minutes, at most 10 stores per sweep. */
export const PARTNER_RETRY_DELAY_MS = 15 * 60_000;
/** Back-off grows 15 min, 30 min, 1 h, ... up to this cap while a store keeps failing. */
export const PARTNER_BACKOFF_MAX_MS = 6 * 3_600_000;
/** Per-store cap: after this many provisioning rounds that each ended in three 409s the store stops retrying automatically (9 registrations at most) until the owner recovers the account. */
export const PARTNER_CONFLICT_ROUNDS_MAX = 3;
/** Delay before the next provisioning round after `failedRounds` consecutive failures (>= 1). */
export const partnerRetryDelayMs = (failedRounds: number) => Math.min(PARTNER_RETRY_DELAY_MS * 2 ** Math.max(0, Math.min(failedRounds - 1, 10)), PARTNER_BACKOFF_MAX_MS);
export const PARTNER_SWEEP_BATCH = 10;
const TERMINAL_CODES = ["SELLER_DEACTIVATED", "API_KEY_DISABLED"] as const; // the provider ended this account for good: no retry, no recovery
const SELLER_ENDED = "SELLER_DEACTIVATED";
export class PartnerError extends Error {
  readonly code: "EMAIL_ALREADY_REGISTERED" | "SELLER_DEACTIVATED" | "API_KEY_DISABLED" | "RATE_LIMITED" | "INVALID_RESPONSE" | "PROVIDER_UNAVAILABLE";
  readonly retryAfterSec: number;
  constructor(code: PartnerError["code"], retryAfterSec = 0) {
    super(`shipping_partner:${code}`); this.name = "PartnerError"; this.code = code; this.retryAfterSec = retryAfterSec;
  }
}
export type PartnerRequest = { method: "POST"; path: string; type: string; body: string; headers: { "partner-id": string; timestamp: string; signature: string } };
export type PartnerResponse = { status: number; body: unknown; retryAfter?: string };
/** `mode` is a label for display and tests only: NO security decision reads it (the gate is enforced by identity, see `PartnerClient.#call`, and inside every live `send`). */
export interface PartnerTransport { readonly mode: "fake" | "live"; send(request: PartnerRequest): Promise<PartnerResponse> }
/**
 * Base of every transport that can leave the process. The entry gate (Partner Secret rotated AND the old secret revoked) is checked HERE, inside `send`,
 * before `dispatch` can put a byte on the wire: a live transport cannot be written that skips it, whatever label it carries and however it is called.
 * There is no implementation yet (live transport is DEFERRED until the owner's rotation and the provider's documentation).
 */
export abstract class LivePartnerTransport implements PartnerTransport {
  readonly mode = "live" as const;
  async send(request: PartnerRequest): Promise<PartnerResponse> {
    requireMengantarEntryGate();
    return this.dispatch(request);
  }
  protected abstract dispatch(request: PartnerRequest): Promise<PartnerResponse>;
}
export type PartnerCredentials = { sellerId: string; apiKey: string; alreadyRegistered?: boolean | undefined };
export type PartnerSeller = { sellerId: string; externalUserId: string; active: boolean };
const credentials = z.object({ sellerId: z.string().min(1).max(120), apiKey: z.string().min(1).max(2000), alreadyRegistered: z.boolean().optional() });

/** ADR-0007: exact JSON bytes are signed once, then those SAME bytes go to the transport. TYPE is explicit; live protocol evidence stays gated. */
export function signPartnerBody(path: string, type: string, body: string, timestamp: string, secret: string): string {
  return createHash("sha256").update(`POST:${path}:${type}:${body}:${timestamp}:${secret}`).digest("hex");
}

export async function takePartnerBudget(exec: Executor, registration: boolean): Promise<void> {
  // One row lock protects the partner-wide token bucket and Jakarta registration day across every worker.
  const wait = await exec.transaction(async (tx) => {
    await tx.execute(sql`insert into public.shipping_partner_budget (key, tokens, refilled_at, day_start, registrations)
      values (${PARTNER_BUDGET_KEY}, ${PARTNER_REQUESTS_PER_MINUTE}, now(), date_trunc('day', now() at time zone 'Asia/Jakarta') at time zone 'Asia/Jakarta', 0) on conflict (key) do nothing`);
    const rows = await tx.execute<{ tokens: number; registrations: number; wait: number }>(sql`
      select least(${PARTNER_REQUESTS_PER_MINUTE}, tokens + floor(extract(epoch from (now() - refilled_at)))::int) as tokens,
        case when day_start < date_trunc('day', now() at time zone 'Asia/Jakarta') at time zone 'Asia/Jakarta' then 0 else registrations end as registrations,
        greatest(0, ceil(extract(epoch from (blocked_until - now()))))::int as wait
      from public.shipping_partner_budget where key = ${PARTNER_BUDGET_KEY} for update`);
    const b = rows[0]!;
    if (b.wait > 0) return b.wait;
    if (b.tokens < 1) return 1;
    if (registration && b.registrations >= Math.min(PARTNER_REGISTRATION_DAILY_BUDGET, PARTNER_REGISTRATIONS_PER_DAY)) return 86_400;
    await tx.execute(sql`update public.shipping_partner_budget set tokens = ${b.tokens - 1}, registrations = ${b.registrations + (registration ? 1 : 0)},
      day_start = date_trunc('day', now() at time zone 'Asia/Jakarta') at time zone 'Asia/Jakarta',
      refilled_at = refilled_at + floor(extract(epoch from (now() - refilled_at))) * interval '1 second' where key = ${PARTNER_BUDGET_KEY}`);
    return 0;
  });
  if (wait) throw new PartnerError("RATE_LIMITED", wait);
}

export class PartnerClient {
  readonly #secret: string;
  readonly #id: string;
  readonly #exec: Executor;
  readonly #transport: PartnerTransport;
  constructor(exec: Executor, transport: PartnerTransport, options: { partnerId?: string; partnerSecret?: string } = {}) {
    this.#exec = exec; this.#transport = transport;
    this.#id = options.partnerId ?? "fake-partner";
    this.#secret = options.partnerSecret ?? "fake-only-not-a-provider-secret";
  }
  get mode() { return this.#transport.mode; }
  async #call(path: string, input: Record<string, unknown>, registration = false): Promise<unknown> {
    // By identity, never by the transport's own `mode` label: anything that is not the local fake meets the gate before the budget is spent (and again inside its `send`).
    if (!(this.#transport instanceof FakePartnerTransport)) requireMengantarEntryGate();
    await takePartnerBudget(this.#exec, registration);
    const body = JSON.stringify(input), timestamp = String(Math.floor(Date.now() / 1000)), type = "application/json";
    let response: PartnerResponse;
    try {
      response = await this.#transport.send({ method: "POST", path, type, body, headers: { "partner-id": this.#id, timestamp, signature: signPartnerBody(path, type, body, timestamp, this.#secret) } });
    } catch { throw new PartnerError("PROVIDER_UNAVAILABLE"); } // never propagate provider/transport exception text (may contain keys).
    if (response.status === 429) {
      const seconds = /^\d+$/.test(response.retryAfter ?? "") ? Number(response.retryAfter) : Math.ceil((Date.parse(response.retryAfter ?? "") - Date.now()) / 1000);
      const delay = Number.isFinite(seconds) ? Math.max(1, Math.min(seconds, 86_400)) : 60;
      await this.#exec.update(shippingPartnerBudget).set({ blockedUntil: new Date(Date.now() + delay * 1000) }).where(eq(shippingPartnerBudget.key, PARTNER_BUDGET_KEY));
      throw new PartnerError("RATE_LIMITED", delay);
    }
    const code = response.body && typeof response.body === "object" && "code" in response.body ? response.body.code : null;
    if (typeof code === "string" && (TERMINAL_CODES as readonly string[]).includes(code)) throw new PartnerError(code as (typeof TERMINAL_CODES)[number]);
    if (code === "EMAIL_ALREADY_REGISTERED" && response.status === 409) throw new PartnerError("EMAIL_ALREADY_REGISTERED");
    if (response.status < 200 || response.status >= 300) throw new PartnerError("PROVIDER_UNAVAILABLE");
    return response.body;
  }
  async register(externalUserId: string, email: string): Promise<PartnerCredentials> {
    const value = credentials.safeParse(await this.#call("/api/partner/v1/sellers", { externalUserId, email }, true));
    if (!value.success) throw new PartnerError("INVALID_RESPONSE");
    return value.data;
  }
  async currentKey(sellerId: string): Promise<PartnerCredentials> {
    const value = credentials.safeParse(await this.#call("/api/partner/v1/sellers/api-key", { sellerId }));
    if (!value.success || value.data.sellerId !== sellerId) throw new PartnerError("INVALID_RESPONSE");
    return value.data;
  }
  async list(page: number): Promise<{ sellers: PartnerSeller[]; hasMore: boolean }> {
    const result = z.object({ sellers: z.array(z.object({ sellerId: z.string().min(1).max(120), externalUserId: z.string().regex(/^store:[1-9]\d*$/), active: z.boolean() })).max(PARTNER_PAGE_LIMIT), hasMore: z.boolean() }).safeParse(await this.#call("/api/partner/v1/sellers/list", { page, limit: PARTNER_PAGE_LIMIT }));
    if (!result.success) throw new PartnerError("INVALID_RESPONSE");
    return result.data;
  }
}

/** Local deterministic provider state; no fetch, URL or external effect. remote identity is idempotent even after a lost response. */
export class FakePartnerTransport implements PartnerTransport {
  readonly mode = "fake" as const;
  readonly sellers = new Map<string, { sellerId: string; apiKey: string; email: string; active: boolean }>();
  readonly conflicts = new Set<string>();
  /** Fake-only knobs: the next N registrations answer 409, a fixed key (credential canaries), one transport failure carrying text, one 429. */
  conflictNext = 0;
  fixedApiKey: string | null = null;
  failNextWith: string | null = null;
  rateLimitNext: string | null = null;
  registrations = 0;
  calls: { path: string; externalUserId?: string; email?: string }[] = []; // deliberately no headers or credential responses
  async send(request: PartnerRequest): Promise<PartnerResponse> {
    const input = JSON.parse(request.body) as { externalUserId: string; email: string; sellerId: string; page: number; limit: number };
    if (this.failNextWith) { const text = this.failNextWith; this.failNextWith = null; throw new Error(text); }
    if (this.rateLimitNext) { const retryAfter = this.rateLimitNext; this.rateLimitNext = null; return { status: 429, body: {}, retryAfter }; }
    this.calls.push({ path: request.path, ...(input.externalUserId && { externalUserId: input.externalUserId }), ...(input.email && { email: input.email }) });
    if (request.path === "/api/partner/v1/sellers/list") {
      const all = [...this.sellers].map(([externalUserId, s]) => ({ externalUserId, sellerId: s.sellerId, active: s.active }));
      const start = (input.page - 1) * input.limit;
      return { status: 200, body: { sellers: all.slice(start, start + input.limit), hasMore: start + input.limit < all.length } };
    }
    if (request.path === "/api/partner/v1/sellers/api-key") {
      const seller = [...this.sellers.values()].find((s) => s.sellerId === input.sellerId);
      return seller?.active ? { status: 200, body: { sellerId: seller.sellerId, apiKey: seller.apiKey } } : { status: 403, body: { code: SELLER_ENDED } };
    }
    const old = this.sellers.get(input.externalUserId);
    if (old) return { status: 200, body: { sellerId: old.sellerId, apiKey: old.apiKey, alreadyRegistered: true } };
    if (this.conflicts.has(input.email) || this.conflictNext-- > 0) return { status: 409, body: { code: "EMAIL_ALREADY_REGISTERED" } };
    const created = { sellerId: `fake-${input.externalUserId}`, apiKey: this.fixedApiKey ?? `fake-${randomBytes(24).toString("hex")}`, email: input.email, active: true };
    this.sellers.set(input.externalUserId, created); this.registrations++;
    return { status: 201, body: { sellerId: created.sellerId, apiKey: created.apiKey } };
  }
}
